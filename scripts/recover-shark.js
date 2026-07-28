// ============================================================
// Recupera vendas Shark perdidas:
//  - órfãs (pagas na adquirente, sem registro local) → cria payment + credita
//  - PENDING no banco mas PAID na Shark (webhook perdido) → aprova + credita
// Usa o código JÁ COMPILADO em dist/ — rodar de /var/www/zucroapi:
//
//   Ver o que seria recuperado (não altera nada):
//     node scripts/recover-shark.js <user_id> <postback_url|-> @/root/orphans.txt
//
//   Aprovar de verdade (credita saldo + dispara postbacks):
//     node scripts/recover-shark.js <user_id> <postback_url|-> @/root/orphans.txt --apply
//
// Os txids podem vir de um arquivo (@/caminho, um por linha) ou direto como argumentos.
// Idempotente: pula o que já está RECEIVED e cobrança não paga na Shark.
// Respeita o rate limit da Shark (pausa entre consultas + retry em 429).
// ============================================================
require('dotenv').config();

const { prisma } = require('../dist/config/database');
const { sharkRequest } = require('../dist/providers/sharkbanking/shark.client');
const { getEffectiveRates, calculatePixFeeSellerPays } = require('../dist/providers/efibank/fee.calculator');
const { creditPaymentOnReceive } = require('../dist/modules/payments/credit.service');
const { sendChargePostback } = require('../dist/utils/postback');
const fs = require('fs');

const SLEEP_MS = 2500; // pausa entre consultas pra não estourar o rate limit da Shark
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSharkTx(txId) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await sharkRequest('GET', `/payment/${txId}`, null, { auth: 'api' });
    if (res.status !== 429) return res;
    const wait = attempt * 10;
    console.log(`  [429] rate limit da Shark — aguardando ${wait}s antes de tentar de novo...`);
    await sleep(wait * 1000);
  }
  return { success: false, status: 429, data: { message: 'rate limit persistente' } };
}

const ratesCache = new Map();
async function getRatesForUser(userId) {
  if (ratesCache.has(userId)) return ratesCache.get(userId);
  const customRates = await prisma.userCustomRate.findUnique({ where: { user_id: userId } });
  const rates = await getEffectiveRates(
    customRates ? { pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined } : null,
  );
  ratesCache.set(userId, rates);
  return rates;
}

async function sendUserWebhook(userId, event, data) {
  const webhooks = await prisma.webhook.findMany({
    where: { user_id: userId, status: 'active' },
  });
  for (const webhook of webhooks) {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          ...(webhook.secret && { 'X-Webhook-Secret': webhook.secret }),
        },
        body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
      });
      await prisma.webhookLog.create({
        data: {
          webhook_id: webhook.id,
          event_type: event,
          payload: data,
          response_code: response.status,
          response_body: await response.text().catch(() => ''),
          success: response.ok,
        },
      });
      console.log(`  [POSTBACK] webhook cadastrado ${webhook.url}: HTTP ${response.status}`);
    } catch (error) {
      console.error(`  [POSTBACK] erro em ${webhook.url}:`, error.message);
    }
  }
}

async function notifyAndPostback(payment, grossValue, feeCalc, externalRef) {
  await sendChargePostback(payment, 'charge.paid');
  await sendUserWebhook(payment.user_id, 'payment.received', {
    payment_id: payment.id,
    value: grossValue,
    net_value: feeCalc.netValue,
    status: 'RECEIVED',
    billing_type: 'PIX',
    provider: 'sharkbanking',
    external_reference: externalRef || null,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => a !== '--apply');

  const [userId, postbackArg, ...idArgs] = positional;
  if (!userId || !postbackArg || idArgs.length === 0) {
    console.log('Uso: node scripts/recover-shark.js <user_id> <postback_url|-> <txids... | @arquivo> [--apply]');
    process.exit(1);
  }
  const postbackUrl = postbackArg === '-' ? null : postbackArg;

  let txIds = [];
  for (const a of idArgs) {
    if (a.startsWith('@')) {
      txIds.push(
        ...fs.readFileSync(a.slice(1), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean),
      );
    } else {
      txIds.push(a.trim());
    }
  }
  txIds = [...new Set(txIds)];

  const seller = await prisma.user.findUnique({ where: { id: userId } });
  if (!seller) {
    console.error(`Seller ${userId} não encontrado`);
    process.exit(1);
  }
  console.log(`Seller: ${seller.name || ''} <${seller.email}> | saldo atual: R$ ${Number(seller.balance).toFixed(2)}`);
  console.log(`Modo: ${apply ? 'APLICAR (vai creditar e disparar postbacks)' : 'SIMULAÇÃO (nada será alterado)'}`);
  console.log(`Transações a verificar: ${txIds.length} (pausa de ${SLEEP_MS / 1000}s entre consultas)\n`);

  let recovered = 0;
  let totalValue = 0;

  for (const txId of txIds) {
    const existing = await prisma.payment.findFirst({ where: { efi_txid: txId } });

    if (existing && existing.status === 'RECEIVED') {
      console.log(`- ${txId}: já está RECEIVED no banco (payment ${existing.id}) — pulando`);
      continue;
    }

    const res = await fetchSharkTx(txId);
    await sleep(SLEEP_MS);
    if (!res.success || !res.data || !res.data.id) {
      console.log(`- ${txId}: erro ao consultar na Shark (HTTP ${res.status}): ${JSON.stringify(res.data).substring(0, 120)}`);
      continue;
    }

    const tx = res.data;
    const paid = String(tx.status || '').toUpperCase() === 'PAID';
    if (!paid) {
      console.log(`- ${txId}: não pago na Shark (status ${tx.status}) — pulando`);
      continue;
    }

    // ===== Caso 1: existe no banco como PENDING → aprovar =====
    if (existing) {
      const grossValue = Number(existing.value);
      const rates = await getRatesForUser(existing.user_id);
      const feeCalc = calculatePixFeeSellerPays(grossValue, rates);
      console.log(
        `- ${txId}: PAGO na Shark, PENDING no banco → APROVAR | payment ${existing.id} | ` +
          `R$ ${grossValue.toFixed(2)} | líquido R$ ${feeCalc.netValue.toFixed(2)} | pagador: ${tx.payer?.name || '-'}`,
      );
      if (!apply) {
        recovered++;
        totalValue += grossValue;
        continue;
      }

      // Guard atômico: só aprova se ainda não está RECEIVED (evita crédito duplo)
      const updated = await prisma.payment.updateMany({
        where: { id: existing.id, status: { not: 'RECEIVED' } },
        data: { status: 'RECEIVED', payment_date: new Date() },
      });
      if (updated.count === 0) {
        console.log(`  já processado por outro fluxo — pulando crédito`);
        continue;
      }

      let payment = await prisma.payment.findUnique({ where: { id: existing.id } });
      const meta = (payment.metadata || {});
      if (postbackUrl && !meta.postback_url && !meta.callback_url) {
        payment = await prisma.payment.update({
          where: { id: payment.id },
          data: { metadata: { ...meta, postback_url: postbackUrl } },
        });
      }

      await creditPaymentOnReceive({
        payment,
        providerLabel: 'sharkbanking',
        feeCalc,
        rates,
        providerTransactionId: txId,
      });
      await notifyAndPostback(payment, grossValue, feeCalc, tx.externalRef || meta.external_reference);
      console.log(`  ✅ aprovado: payment ${payment.id}, saldo creditado, postbacks enviados`);
      recovered++;
      totalValue += grossValue;
      continue;
    }

    // ===== Caso 2: órfã (não existe no banco) → criar + creditar no seller informado =====
    const grossValue = Number(tx.amount) / 100;
    const rates = await getRatesForUser(seller.id);
    const feeCalc = calculatePixFeeSellerPays(grossValue, rates);
    console.log(
      `- ${txId}: PAGO na Shark, SEM registro no banco → CRIAR | R$ ${grossValue.toFixed(2)} | ` +
        `líquido R$ ${feeCalc.netValue.toFixed(2)} | pagador: ${tx.payer?.name || '-'} | ref: ${tx.externalRef || '-'}`,
    );
    if (!apply) {
      recovered++;
      totalValue += grossValue;
      continue;
    }

    const paidAt = tx.paidAt ? new Date(tx.paidAt) : new Date();
    const payment = await prisma.payment.create({
      data: {
        user_id: seller.id,
        billing_type: 'PIX',
        value: grossValue,
        net_value: feeCalc.netValue,
        status: 'RECEIVED',
        description: tx.description || 'Venda recuperada (Shark)',
        due_date: new Date(),
        payment_date: isNaN(paidAt.getTime()) ? new Date() : paidAt,
        efi_txid: txId,
        metadata: {
          external_reference: tx.externalRef || null,
          ...(postbackUrl ? { postback_url: postbackUrl } : {}),
          payment_provider: 'sharkbanking',
          shark_transaction_id: txId,
          customer_name: tx.payer?.name,
          customer_email: tx.payer?.email,
          customer_document: tx.payer?.taxId,
          created_via: 'script_recovery',
          recovered_at: new Date().toISOString(),
        },
      },
    });

    await creditPaymentOnReceive({
      payment,
      providerLabel: 'sharkbanking',
      feeCalc,
      rates,
      providerTransactionId: txId,
    });
    await notifyAndPostback(payment, grossValue, feeCalc, tx.externalRef);
    console.log(`  ✅ recuperado: payment ${payment.id} criado, saldo creditado, postbacks enviados`);
    recovered++;
    totalValue += grossValue;
  }

  console.log(`\n${apply ? 'Recuperadas' : 'Recuperáveis'}: ${recovered} vendas | total bruto R$ ${totalValue.toFixed(2)}`);

  const after = await prisma.user.findUnique({ where: { id: seller.id } });
  console.log(`Saldo do seller ${apply ? 'agora' : '(inalterado)'}: R$ ${Number(after.balance).toFixed(2)}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

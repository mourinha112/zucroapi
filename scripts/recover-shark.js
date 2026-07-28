// ============================================================
// Recupera vendas Shark órfãs (pagas na adquirente, sem registro local).
// Usa o código JÁ COMPILADO em dist/ — rodar de /var/www/zucroapi:
//
//   Ver o que seria recuperado (não altera nada):
//     node scripts/recover-shark.js <user_id> <postback_url|-> @/root/orphans.txt
//
//   Aprovar de verdade (credita saldo + dispara postbacks):
//     node scripts/recover-shark.js <user_id> <postback_url|-> @/root/orphans.txt --apply
//
// Os txids podem vir de um arquivo (@/caminho, um por linha) ou direto como argumentos.
// Idempotente: pula txid que já existe no banco e cobrança não paga na Shark.
// ============================================================
require('dotenv').config();

const { prisma } = require('../dist/config/database');
const { getSharkTransaction } = require('../dist/providers/sharkbanking/shark.pix');
const { getEffectiveRates, calculatePixFeeSellerPays } = require('../dist/providers/efibank/fee.calculator');
const { creditPaymentOnReceive } = require('../dist/modules/payments/credit.service');
const { sendChargePostback } = require('../dist/utils/postback');
const fs = require('fs');

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
  console.log(`Transações a verificar: ${txIds.length}\n`);

  const customRates = await prisma.userCustomRate.findUnique({ where: { user_id: seller.id } });
  const rates = await getEffectiveRates(
    customRates ? { pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined } : null,
  );

  let recovered = 0;
  let totalValue = 0;

  for (const txId of txIds) {
    const existing = await prisma.payment.findFirst({ where: { efi_txid: txId } });
    if (existing) {
      console.log(`- ${txId}: já existe no banco (payment ${existing.id}, status ${existing.status}) — pulando`);
      continue;
    }

    const shark = await getSharkTransaction(txId);
    if (!shark.success || !shark.data) {
      console.log(`- ${txId}: erro ao consultar na Shark: ${shark.error || 'sem dados'}`);
      continue;
    }

    const tx = shark.data;
    if (shark.status !== 'RECEIVED') {
      console.log(`- ${txId}: não pago na Shark (status ${tx.status}) — pulando`);
      continue;
    }

    const grossValue = Number(tx.amount) / 100;
    const feeCalc = calculatePixFeeSellerPays(grossValue, rates);
    console.log(
      `- ${txId}: PAGO na Shark | R$ ${grossValue.toFixed(2)} | líquido R$ ${feeCalc.netValue.toFixed(2)} | ` +
        `pagador: ${tx.payer?.name || '-'} | ref: ${tx.externalRef || '-'}`,
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

    await sendChargePostback(payment, 'charge.paid');
    await sendUserWebhook(seller.id, 'payment.received', {
      payment_id: payment.id,
      value: grossValue,
      net_value: feeCalc.netValue,
      status: 'RECEIVED',
      billing_type: 'PIX',
      provider: 'sharkbanking',
      external_reference: tx.externalRef || null,
    });

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

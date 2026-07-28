// ============================================================
// Reenvia postbacks de vendas já RECEIVED pro sistema do seller.
// Envia charge.paid pra metadata.postback_url/callback_url do payment
// e payment.received pros webhooks cadastrados do seller na plataforma.
//
//   Simular (só mostra o que seria enviado):
//     node scripts/resend-postbacks.js @/root/paid.txt
//
//   Enviar de verdade:
//     node scripts/resend-postbacks.js @/root/paid.txt --apply
//
// Aceita txids direto como argumentos ou @arquivo (um por linha).
// Só considera payments com status RECEIVED.
// ============================================================
require('dotenv').config();

const { prisma } = require('../dist/config/database');
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
      console.log(`  [WEBHOOK CADASTRADO] ${webhook.url}: HTTP ${response.status}`);
    } catch (error) {
      console.error(`  [WEBHOOK CADASTRADO] erro em ${webhook.url}:`, error.message);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idArgs = args.filter((a) => a !== '--apply');

  if (idArgs.length === 0) {
    console.log('Uso: node scripts/resend-postbacks.js <txids... | @arquivo> [--apply]');
    process.exit(1);
  }

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

  console.log(`Modo: ${apply ? 'ENVIAR (vai disparar os postbacks de verdade)' : 'SIMULAÇÃO (nada será enviado)'}`);
  console.log(`Transações: ${txIds.length}\n`);

  let sent = 0;

  for (const txId of txIds) {
    const payment = await prisma.payment.findFirst({ where: { efi_txid: txId } });
    if (!payment) {
      console.log(`- ${txId}: não existe no banco — pulando`);
      continue;
    }
    if (payment.status !== 'RECEIVED') {
      console.log(`- ${txId}: status ${payment.status} (não é RECEIVED) — pulando`);
      continue;
    }

    const meta = payment.metadata || {};
    const url = meta.postback_url || meta.callback_url || null;
    console.log(
      `- ${txId}: R$ ${Number(payment.value).toFixed(2)} | payment ${payment.id} | ` +
        `postback → ${url || 'SEM URL (só webhooks cadastrados)'} | ref: ${meta.external_reference || '-'}`,
    );

    if (!apply) {
      sent++;
      continue;
    }

    if (url) {
      await sendChargePostback(payment, 'charge.paid');
    }
    await sendUserWebhook(payment.user_id, 'payment.received', {
      payment_id: payment.id,
      value: Number(payment.value),
      net_value: payment.net_value ? Number(payment.net_value) : null,
      status: 'RECEIVED',
      billing_type: payment.billing_type,
      provider: meta.payment_provider || 'sharkbanking',
      external_reference: meta.external_reference || null,
    });
    console.log(`  ✅ reenviado`);
    sent++;
  }

  console.log(`\n${apply ? 'Reenviados' : 'A reenviar'}: ${sent} postbacks`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

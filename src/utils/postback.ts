// ========================================
// Utilitário para enviar postback para URL da cobrança
// Chamada quando o status de um pagamento muda
// ========================================

/**
 * Envia um postback (webhook) para a URL configurada na cobrança.
 * A URL é lida do campo metadata.postback_url ou metadata.callback_url do payment.
 * 
 * @param payment - O objeto de pagamento do banco (com metadata)
 * @param event - Nome do evento (ex: charge.paid, charge.refunded)
 * @param extraData - Dados adicionais para incluir no payload
 */
export async function sendChargePostback(payment: any, event: string, extraData?: any) {
  const metadata = payment.metadata as any;
  const postbackUrl = metadata?.postback_url || metadata?.callback_url;

  if (!postbackUrl) return;

  try {
    const payload = {
      event,
      charge: {
        id: payment.id,
        status: payment.status,
        billing_type: payment.billing_type,
        value: Number(payment.value),
        net_value: payment.net_value ? Number(payment.net_value) : null,
        description: payment.description,
        external_reference: metadata?.external_reference || null,
        payment_date: payment.payment_date || null,
        ...extraData,
      },
      timestamp: new Date().toISOString(),
    };

    console.log(`[POSTBACK] Enviando para ${postbackUrl}: ${event}`);

    const response = await fetch(postbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZucroPay-Event': event,
        'User-Agent': 'ZucroPay-Webhook/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // timeout 10s
    });

    console.log(`[POSTBACK] Resposta de ${postbackUrl}: ${response.status}`);
  } catch (error: any) {
    console.error(`[POSTBACK] Erro ao enviar para ${postbackUrl}:`, error.message);
  }
}

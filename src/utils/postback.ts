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

  // Derivar o status correto a partir do evento para evitar inconsistência
  // (ex: findUnique após $executeRaw pode retornar status stale)
  const eventStatusMap: Record<string, string> = {
    'charge.paid': 'RECEIVED',
    'charge.refunded': 'REFUNDED',
    'charge.cancelled': 'CANCELLED',
    'charge.refused': 'REFUSED',
    'charge.pending': 'PENDING',
    'charge.overdue': 'OVERDUE',
  };
  const resolvedStatus = eventStatusMap[event] || payment.status;

  try {
    const payload = {
      event,
      charge: {
        id: payment.id,
        status: resolvedStatus,
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
    console.log(`[POSTBACK] Payload completo:`, JSON.stringify(payload, null, 2));

    const response = await fetch(postbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZucroPay-Event': event,
        'User-Agent': 'ZucroPay-Webhook/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // timeout 30s
    });

    const responseBody = await response.text().catch(() => '');
    console.log(`[POSTBACK] Resposta de ${postbackUrl}: HTTP ${response.status}`);
    console.log(`[POSTBACK] Response body:`, responseBody.substring(0, 1000));
  } catch (error: any) {
    console.error(`[POSTBACK] Erro ao enviar para ${postbackUrl}:`, error.message);
  }
}

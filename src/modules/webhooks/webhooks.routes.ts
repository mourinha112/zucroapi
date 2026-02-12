import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { webhookQueue } from '../../queues/webhook.queue';
import { authenticate, standardRateLimit, webhookRateLimit, createResourceRateLimit } from '../../middlewares';
import { notifySale } from '../push/push.service';
import { sendChargePostback } from '../../utils/postback';

// Função para enviar postback/webhook para o usuário
async function sendUserWebhook(userId: string, event: string, data: any) {
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
        body: JSON.stringify({
          event,
          data,
          timestamp: new Date().toISOString(),
        }),
      });

      // Logar resultado
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

      console.log(`[POSTBACK] Enviado para ${webhook.url}: ${response.status}`);
    } catch (error: any) {
      await prisma.webhookLog.create({
        data: {
          webhook_id: webhook.id,
          event_type: event,
          payload: data,
          response_code: 0,
          response_body: error.message,
          success: false,
        },
      });
      console.error(`[POSTBACK] Erro ao enviar para ${webhook.url}:`, error.message);
    }
  }
}

export async function webhooksRoutes(app: FastifyInstance) {
  // Webhook da EfiBank (público - não requer auth, com rate limit específico)
  app.post('/efi', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] ========== EfiBank PIX Webhook ==========');
    console.log('[WEBHOOK] Body completo:', JSON.stringify(body, null, 2));
    console.log('[WEBHOOK] Tem body.pix?', !!body.pix);
    console.log('[WEBHOOK] É array?', Array.isArray(body.pix));

    // Processar via fila BullMQ (se disponível)
    if (body.pix && Array.isArray(body.pix)) {
      console.log('[WEBHOOK] Processando', body.pix.length, 'transações PIX');
      
      for (const pix of body.pix) {
        console.log('[WEBHOOK] PIX item:', JSON.stringify(pix));
        
        if (pix.txid) {
          if (webhookQueue) {
            await webhookQueue.add('pix_payment', {
              type: 'pix_payment',
              txid: pix.txid,
              endToEndId: pix.endToEndId || '',
              status: pix.status || 'CONCLUIDA',
              valor: pix.valor || '0',
              horario: pix.horario || new Date().toISOString(),
              pagador: pix.pagador,
            }, {
              jobId: `pix_${pix.txid}_${Date.now()}`,
              removeOnComplete: true,
            });
            
            console.log(`[WEBHOOK] ✅ Job adicionado à fila: ${pix.txid}`);
          } else {
            console.log(`[WEBHOOK] ⚠️ Fila indisponível - processando diretamente`);
            // Processar diretamente se fila não disponível
          }
        } else {
          console.log('[WEBHOOK] ⚠️ PIX sem txid:', pix);
        }
      }
    } else {
      console.log('[WEBHOOK] ⚠️ Webhook não tem array pix - pode ser teste ou outro evento');
    }

    console.log('[WEBHOOK] ========================================');
    return reply.send({ received: true });
  });

  // Webhook de cobranças (cartão/boleto)
  app.post('/efi/cobranca', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] ========== EfiBank Cobrança Webhook ==========');
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));

    // Processar notificação de cobrança
    if (body.id && body.status) {
      const chargeId = body.id.toString();
      
      const payment = await prisma.payment.findFirst({
        where: {
          OR: [
            { efi_charge_id: chargeId },
            { asaas_payment_id: chargeId },
          ],
        },
      });

      if (payment) {
        let newStatus = payment.status;
        
        // Mapeamento completo de status do gateway EfiBank -> ZucroPay
        // paid/approved/settled      -> RECEIVED  (pago)
        // new/waiting/unpaid/pending -> PENDING   (aguardando pagamento)
        // canceled/expired           -> CANCELLED (cancelado/expirado)
        // refunded                   -> REFUNDED  (estornado)
        // refused/declined           -> REFUSED   (recusado pelo gateway/banco)
        // overdue                    -> OVERDUE   (vencido)
        if (body.status === 'paid' || body.status === 'approved' || body.status === 'settled') {
          newStatus = 'RECEIVED';
        } else if (body.status === 'new' || body.status === 'waiting' || body.status === 'unpaid' || body.status === 'pending') {
          newStatus = 'PENDING';
        } else if (body.status === 'canceled' || body.status === 'expired') {
          newStatus = 'CANCELLED';
        } else if (body.status === 'refunded') {
          newStatus = 'REFUNDED';
        } else if (body.status === 'refused' || body.status === 'declined') {
          newStatus = 'REFUSED';
        } else if (body.status === 'overdue') {
          newStatus = 'OVERDUE';
        }

        if (newStatus !== payment.status) {
          const updatedPayment = await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: newStatus,
              payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
            },
          });

          console.log(`[WEBHOOK] Cobrança ${chargeId} atualizada: ${newStatus}`);

          // Enviar postback para a URL da cobrança (postback_url/callback_url)
          const eventMap: Record<string, string> = {
            'RECEIVED': 'charge.paid',
            'REFUNDED': 'charge.refunded',
            'CANCELLED': 'charge.cancelled',
            'REFUSED': 'charge.refused',
            'OVERDUE': 'charge.overdue',
            'PENDING': 'charge.pending',
          };
          sendChargePostback(updatedPayment, eventMap[newStatus] || `charge.${newStatus.toLowerCase()}`);

          // Se foi confirmado, enviar notificações
          if (newStatus === 'RECEIVED') {
            // Enviar notificação push
            try {
              await notifySale(payment.user_id, Number(payment.value), 'Cliente', payment.id);
              console.log(`[WEBHOOK] Notificação push enviada para ${payment.user_id}`);
            } catch (pushError) {
              console.error('[WEBHOOK] Erro ao enviar notificação push:', pushError);
            }

            // Enviar postback/webhook para o usuário (webhooks cadastrados)
            try {
              await sendUserWebhook(payment.user_id, 'payment.received', {
                payment_id: payment.id,
                value: Number(payment.value),
                net_value: Number(payment.net_value),
                status: 'RECEIVED',
                billing_type: payment.billing_type,
              });
              console.log(`[WEBHOOK] Postback enviado para usuário ${payment.user_id}`);
            } catch (webhookError) {
              console.error('[WEBHOOK] Erro ao enviar postback:', webhookError);
            }
          }
        }
      }
    }

    return reply.send({ received: true });
  });

  // Webhook do Asaas (público - recebe notificações de pagamento)
  app.post('/asaas', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] ========== Asaas Webhook ==========');
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));

    // Asaas envia evento no campo "event" e dados no campo "payment"
    const event = body.event;
    const paymentData = body.payment;

    if (!paymentData || !paymentData.id) {
      console.log('[WEBHOOK] ⚠️ Webhook Asaas sem dados de pagamento');
      return reply.send({ received: true });
    }

    const asaasPaymentId = paymentData.id;
    
    // Buscar pagamento pelo asaas_payment_id
    const payment = await prisma.payment.findFirst({
      where: { asaas_payment_id: asaasPaymentId },
      include: { user: true },
    });

    if (!payment) {
      console.log(`[WEBHOOK] Pagamento Asaas não encontrado: ${asaasPaymentId}`);
      return reply.send({ received: true });
    }

    let newStatus = payment.status;
    
    // Mapeamento completo de status do Asaas -> ZucroPay
    // CONFIRMED/RECEIVED                     -> RECEIVED  (pago)
    // PENDING/AWAITING_RISK_ANALYSIS         -> PENDING   (aguardando)
    // REFUNDED/REFUND_REQUESTED              -> REFUNDED  (estornado)
    // CANCELLED                              -> CANCELLED (cancelado)
    // OVERDUE                                -> OVERDUE   (vencido)
    // REFUSED/REPROVED/BANK_ACCOUNT_REJECTED -> REFUSED   (recusado)
    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED' || paymentData.status === 'CONFIRMED' || paymentData.status === 'RECEIVED') {
      newStatus = 'RECEIVED';
    } else if (paymentData.status === 'PENDING' || paymentData.status === 'AWAITING_RISK_ANALYSIS') {
      newStatus = 'PENDING';
    } else if (paymentData.status === 'REFUNDED' || paymentData.status === 'REFUND_REQUESTED') {
      newStatus = 'REFUNDED';
    } else if (paymentData.status === 'CANCELLED') {
      newStatus = 'CANCELLED';
    } else if (paymentData.status === 'OVERDUE') {
      newStatus = 'OVERDUE';
    } else if (paymentData.status === 'REFUSED' || paymentData.status === 'REPROVED' || paymentData.status === 'BANK_ACCOUNT_REJECTED') {
      newStatus = 'REFUSED';
    }

    if (newStatus !== payment.status) {
      const updatedAsaasPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: newStatus,
          payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
        },
      });

      console.log(`[WEBHOOK] Asaas ${asaasPaymentId} atualizado: ${newStatus}`);

      // Enviar postback para a URL da cobrança (postback_url/callback_url)
      const asaasEventMap: Record<string, string> = {
        'RECEIVED': 'charge.paid',
        'REFUNDED': 'charge.refunded',
        'CANCELLED': 'charge.cancelled',
        'PENDING': 'charge.pending',
      };
      sendChargePostback(updatedAsaasPayment, asaasEventMap[newStatus] || `charge.${newStatus.toLowerCase()}`);

      // Se foi confirmado, processar
      if (newStatus === 'RECEIVED') {
        // Atualizar saldo do usuário
        const netValue = Number(payment.net_value) || Number(payment.value);
        
        await prisma.user.update({
          where: { id: payment.user_id },
          data: {
            balance: { increment: netValue },
          },
        });

        // Criar transação
        await prisma.transaction.create({
          data: {
            user_id: payment.user_id,
            type: 'deposit',
            amount: netValue,
            status: 'completed',
            description: `Pagamento recebido - ${payment.description}`,
            metadata: {
              asaas_payment_id: asaasPaymentId,
              payment_id: payment.id,
              billing_type: payment.billing_type,
            },
          },
        });

        // Enviar notificação push
        try {
          const customerName = paymentData.customer?.name || 'Cliente';
          await notifySale(payment.user_id, Number(payment.value), customerName, payment.id);
          console.log(`[WEBHOOK] Notificação push enviada para ${payment.user_id}`);
        } catch (pushError) {
          console.error('[WEBHOOK] Erro ao enviar notificação push:', pushError);
        }

        // Enviar postback/webhook para o usuário
        try {
          await sendUserWebhook(payment.user_id, 'payment.received', {
            payment_id: payment.id,
            value: Number(payment.value),
            net_value: netValue,
            status: 'RECEIVED',
            billing_type: payment.billing_type,
            provider: 'asaas',
          });
          console.log(`[WEBHOOK] Postback Asaas enviado para usuário ${payment.user_id}`);
        } catch (webhookError) {
          console.error('[WEBHOOK] Erro ao enviar postback:', webhookError);
        }
      }
    }

    console.log('[WEBHOOK] ========================================');
    return reply.send({ received: true });
  });

  // Listar webhooks do usuário (autenticado)
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const webhooks = await prisma.webhook.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ success: true, webhooks });
  });

  // Criar webhook (autenticado)
  app.post('/', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = request.body as { url: string; events: string[] };

    const webhook = await prisma.webhook.create({
      data: {
        user_id: decoded.id,
        url: body.url,
        events: body.events,
        secret: `whsec_${Math.random().toString(36).substr(2, 32)}`,
      },
    });

    return reply.status(201).send({ success: true, webhook });
  });

  // Deletar webhook (autenticado)
  app.delete('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const result = await prisma.webhook.deleteMany({
      where: { id, user_id: decoded.id },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'Webhook não encontrado' });
    }

    return reply.send({ success: true, message: 'Webhook deletado' });
  });
}

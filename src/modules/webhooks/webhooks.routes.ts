import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { webhookQueue } from '../../queues/webhook.queue';
import { authenticate, standardRateLimit, webhookRateLimit, createResourceRateLimit } from '../../middlewares';
import { notifySale } from '../push/push.service';

export async function webhooksRoutes(app: FastifyInstance) {
  // Webhook da EfiBank (público - não requer auth, com rate limit específico)
  app.post('/efi', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] EfiBank recebido:', JSON.stringify(body, null, 2));

    // Salvar log do webhook
    try {
      await prisma.$executeRaw`
        INSERT INTO webhooks_log (event_type, payload, processed, created_at)
        VALUES ('efibank_notification', ${JSON.stringify(body)}::jsonb, false, NOW())
      `;
    } catch (e) {
      console.error('[WEBHOOK] Erro ao salvar log:', e);
    }

    // Processar via fila BullMQ (se disponível)
    if (body.pix && Array.isArray(body.pix)) {
      for (const pix of body.pix) {
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
            
            console.log(`[WEBHOOK] Job adicionado à fila: ${pix.txid}`);
          } else {
            console.log(`[WEBHOOK] Fila indisponível - webhook ${pix.txid} não processado via fila`);
          }
        }
      }
    }

    return reply.send({ received: true });
  });

  // Webhook de cobranças (cartão/boleto)
  app.post('/efi/cobranca', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] EfiBank Cobrança:', JSON.stringify(body, null, 2));

    // Salvar log
    try {
      await prisma.$executeRaw`
        INSERT INTO webhooks_log (event_type, payload, processed, created_at)
        VALUES ('efibank_cobranca', ${JSON.stringify(body)}::jsonb, false, NOW())
      `;
    } catch (e) {
      console.error('[WEBHOOK] Erro ao salvar log:', e);
    }

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
        
        if (body.status === 'paid' || body.status === 'approved') {
          newStatus = 'RECEIVED';
        } else if (body.status === 'unpaid') {
          newStatus = 'PENDING';
        } else if (body.status === 'canceled' || body.status === 'refunded') {
          newStatus = 'REFUNDED';
        }

        if (newStatus !== payment.status) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: newStatus,
              payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
            },
          });

          console.log(`[WEBHOOK] Cobrança ${chargeId} atualizada: ${newStatus}`);

          // Enviar notificação push se foi confirmado
          if (newStatus === 'RECEIVED') {
            try {
              await notifySale(payment.user_id, Number(payment.value), 'Cliente', payment.id);
              console.log(`[WEBHOOK] Notificação push enviada para ${payment.user_id}`);
            } catch (pushError) {
              console.error('[WEBHOOK] Erro ao enviar notificação push:', pushError);
            }
          }
        }
      }
    }

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

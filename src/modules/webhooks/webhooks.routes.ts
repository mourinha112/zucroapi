import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { webhookQueue } from '../../queues/webhook.queue';
import { authenticate, standardRateLimit, webhookRateLimit, createResourceRateLimit } from '../../middlewares';
import { notifySale, notifySalePending } from '../push/push.service';
import { sendChargePostback } from '../../utils/postback';
import { sendUtmifyPostback } from '../app-integrations/utmify.postback';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  calculateReleaseDate,
  applyProviderRateOverrides,
} from '../../providers/efibank/fee.calculator';

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

          // Se pendente, enviar notificação de venda pendente
          if (newStatus === 'PENDING') {
            try {
              await notifySalePending(payment.user_id, Number(payment.value), payment.id);
            } catch (pushError) {
              console.error('[WEBHOOK] Erro ao enviar push de venda pendente:', pushError);
            }
          }
        }
      }
    }

    return reply.send({ received: true });
  });

  // Webhook do Asaas - GET para validação/teste do Asaas
  app.get('/asaas', async (request, reply) => {
    console.log('[WEBHOOK] GET /asaas - teste de validação do Asaas');
    return reply.send({ success: true, message: 'Webhook Asaas ativo' });
  });

  // Webhook do Asaas (público - recebe notificações de pagamento)
  app.post('/asaas', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;
    
    console.log('[WEBHOOK] ========== Asaas Webhook ==========');
    console.log('[WEBHOOK] Event:', body.event);
    console.log('[WEBHOOK] Payment ID:', body.payment?.id);
    console.log('[WEBHOOK] Payment Status:', body.payment?.status);
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

      // Se foi confirmado, processar (mesmo fluxo do EfiBank)
      if (newStatus === 'RECEIVED') {
        const grossValue = Number(payment.value);

        // Buscar taxas personalizadas do vendedor
        const customRates = await prisma.userCustomRate.findUnique({
          where: { user_id: payment.user_id },
        });

        const rates = await getEffectiveRates(customRates ? {
          pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        } : null);

        // Calcular taxas
        const feeCalc = calculatePixFeeSellerPays(grossValue, rates);

        // Atualizar net_value no pagamento
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            net_value: feeCalc.netValue,
            metadata: JSON.parse(JSON.stringify({
              ...(payment.metadata as any),
              platform_fee: feeCalc.platformFee,
              reserve_amount: feeCalc.reserveAmount,
              provider: 'asaas',
            })),
          },
        });

        // Atualizar saldo do usuário (líquido + reserva)
        await prisma.user.update({
          where: { id: payment.user_id },
          data: {
            balance: { increment: feeCalc.netValue },
            reserved_balance: { increment: feeCalc.reserveAmount },
          },
        });

        // Criar reserva de segurança (5%)
        await prisma.balanceReserve.create({
          data: {
            user_id: payment.user_id,
            payment_id: payment.id,
            original_amount: grossValue,
            reserve_amount: feeCalc.reserveAmount,
            status: 'held',
            release_date: calculateReleaseDate(rates.reserve_days),
            description: `Reserva 5% - ${payment.description}`,
          },
        });

        // Criar transação
        await prisma.transaction.create({
          data: {
            user_id: payment.user_id,
            type: 'deposit',
            amount: feeCalc.netValue,
            status: 'completed',
            description: `PIX recebido (Asaas) - ${payment.description}`,
            metadata: {
              asaas_payment_id: asaasPaymentId,
              payment_id: payment.id,
              billing_type: payment.billing_type,
              gross_value: grossValue,
              platform_fee: feeCalc.platformFee,
              reserve_amount: feeCalc.reserveAmount,
            },
          },
        });

        // Atualizar link de pagamento se existir
        if (payment.payment_link_id) {
          await prisma.paymentLink.update({
            where: { id: payment.payment_link_id },
            data: {
              total_received: { increment: grossValue },
            },
          });
        }

        console.log(`[WEBHOOK] Asaas pagamento processado: ${payment.id} - R$${feeCalc.netValue.toFixed(2)} líquido, R$${feeCalc.reserveAmount.toFixed(2)} reserva`);

        // Enviar notificação push
        try {
          const customerName = paymentData.customer?.name || 'Cliente';
          await notifySale(payment.user_id, grossValue, customerName, payment.id);
          console.log(`[WEBHOOK] Notificação push enviada para ${payment.user_id}`);
        } catch (pushError) {
          console.error('[WEBHOOK] Erro ao enviar notificação push:', pushError);
        }

        // Enviar postback/webhook para o usuário
        try {
          await sendUserWebhook(payment.user_id, 'payment.received', {
            payment_id: payment.id,
            value: grossValue,
            net_value: feeCalc.netValue,
            status: 'RECEIVED',
            billing_type: payment.billing_type,
            provider: 'asaas',
          });
          console.log(`[WEBHOOK] Postback Asaas enviado para usuário ${payment.user_id}`);
        } catch (webhookError) {
          console.error('[WEBHOOK] Erro ao enviar postback:', webhookError);
        }
      }

      // Se pendente, enviar notificação de venda pendente
      if (newStatus === 'PENDING') {
        try {
          await notifySalePending(payment.user_id, Number(payment.value), payment.id);
        } catch (pushError) {
          console.error('[WEBHOOK] Erro ao enviar push de venda pendente:', pushError);
        }
      }
    }

    console.log('[WEBHOOK] ========================================');
    return reply.send({ received: true });
  });

  // ========== Webhook do SharkBanking ==========
  app.post('/shark', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;

    console.log('[WEBHOOK] ========== SharkBanking Webhook ==========');
    console.log('[WEBHOOK] Type:', body.type);
    console.log('[WEBHOOK] ObjectId:', body.objectId);
    console.log('[WEBHOOK] Status:', body.data?.status);
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));

    // SharkBanking envia postback com type "transaction" e dados em "data"
    if (body.type !== 'transaction' || !body.data) {
      console.log('[WEBHOOK] ⚠️ Evento não é transação, ignorando');
      return reply.send({ received: true });
    }

    const transactionData = body.data;
    const sharkTransactionId = String(transactionData.id);

    // Buscar pagamento pelo shark_transaction_id (armazenado no efi_txid)
    const payment = await prisma.payment.findFirst({
      where: { efi_txid: sharkTransactionId },
      include: { user: true },
    });

    if (!payment) {
      console.log(`[WEBHOOK] Pagamento SharkBanking não encontrado: ${sharkTransactionId}`);
      return reply.send({ received: true });
    }

    let newStatus = payment.status;

    // Mapeamento de status SharkBanking → ZucroPay
    if (transactionData.status === 'paid' || transactionData.status === 'approved') {
      newStatus = 'RECEIVED';
    } else if (transactionData.status === 'waiting_payment' || transactionData.status === 'pending') {
      newStatus = 'PENDING';
    } else if (transactionData.status === 'refused') {
      newStatus = 'REFUSED';
    } else if (transactionData.status === 'refunded' || transactionData.status === 'chargeback') {
      newStatus = 'REFUNDED';
    } else if (transactionData.status === 'cancelled') {
      newStatus = 'CANCELLED';
    }

    // Se já está RECEIVED, ignorar (proteção contra reprocessamento)
    if (payment.status === 'RECEIVED') {
      console.log(`[WEBHOOK] SharkBanking ${sharkTransactionId} já está RECEIVED, ignorando`);
      return reply.send({ received: true });
    }

    if (newStatus !== payment.status) {
      // UPDATE atômico: só atualiza se status ainda não mudou (previne race condition)
      if (newStatus === 'RECEIVED') {
        const updated = await prisma.$executeRaw`
          UPDATE payments SET status = 'RECEIVED', payment_date = NOW(), updated_at = NOW()
          WHERE id = ${payment.id}::uuid AND status != 'RECEIVED'
        `;

        // $executeRaw retorna o número de linhas afetadas
        if (updated === 0) {
          console.log(`[WEBHOOK] ⚠️ Payment ${payment.id} já foi processado por outro webhook, ignorando`);
          return reply.send({ received: true });
        }
      } else {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: newStatus,
            payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
          },
        });
      }

      console.log(`[WEBHOOK] SharkBanking ${sharkTransactionId} atualizado: ${newStatus}`);

      // Enviar postback com status atualizado
      const sharkEventMap: Record<string, string> = {
        'RECEIVED': 'charge.paid',
        'REFUNDED': 'charge.refunded',
        'CANCELLED': 'charge.cancelled',
        'REFUSED': 'charge.refused',
        'PENDING': 'charge.pending',
      };
      const updatedPaymentForPostback = await prisma.payment.findUnique({ where: { id: payment.id } });
      if (updatedPaymentForPostback) {
        sendChargePostback(updatedPaymentForPostback, sharkEventMap[newStatus] || `charge.${newStatus.toLowerCase()}`);
      }

      // Se foi pago, processar saldo
      if (newStatus === 'RECEIVED') {
        const grossValue = Number(payment.value);

        // Buscar taxas do vendedor
        const customRates = await prisma.userCustomRate.findUnique({
          where: { user_id: payment.user_id },
        });

        const rates = await getEffectiveRates(customRates ? {
          pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        } : null);

        const feeCalc = calculatePixFeeSellerPays(grossValue, rates);

        // Atualizar net_value no pagamento
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            net_value: feeCalc.netValue,
            metadata: JSON.parse(JSON.stringify({
              ...(payment.metadata as any),
              platform_fee: feeCalc.platformFee,
              reserve_amount: feeCalc.reserveAmount,
              provider: 'sharkbanking',
            })),
          },
        });

        // Atualizar saldo do seller
        await prisma.user.update({
          where: { id: payment.user_id },
          data: {
            balance: { increment: feeCalc.netValue },
            reserved_balance: { increment: feeCalc.reserveAmount },
          },
        });

        // Criar reserva de segurança (5%)
        await prisma.balanceReserve.create({
          data: {
            user_id: payment.user_id,
            payment_id: payment.id,
            original_amount: grossValue,
            reserve_amount: feeCalc.reserveAmount,
            status: 'held',
            release_date: calculateReleaseDate(rates.reserve_days),
            description: `Reserva 5% - ${payment.description}`,
          },
        });

        // Criar transação
        await prisma.transaction.create({
          data: {
            user_id: payment.user_id,
            type: 'deposit',
            amount: feeCalc.netValue,
            status: 'completed',
            description: `PIX recebido (SharkBanking) - ${payment.description}`,
            metadata: {
              shark_transaction_id: sharkTransactionId,
              payment_id: payment.id,
              billing_type: 'PIX',
              gross_value: grossValue,
              platform_fee: feeCalc.platformFee,
              reserve_amount: feeCalc.reserveAmount,
            },
          },
        });

        // Atualizar link de pagamento
        if (payment.payment_link_id) {
          await prisma.paymentLink.update({
            where: { id: payment.payment_link_id },
            data: { total_received: { increment: grossValue } },
          });
        }

        console.log(`[WEBHOOK] SharkBanking pagamento processado: ${payment.id} - R$${feeCalc.netValue.toFixed(2)} líquido`);

        // Notificação push
        try {
          const customerName = transactionData.customer?.name || 'Cliente';
          await notifySale(payment.user_id, grossValue, customerName, payment.id);
        } catch (pushError) {
          console.error('[WEBHOOK] Erro push:', pushError);
        }

        // Postback para webhooks do seller
        try {
          await sendUserWebhook(payment.user_id, 'payment.received', {
            payment_id: payment.id,
            value: grossValue,
            net_value: feeCalc.netValue,
            status: 'RECEIVED',
            billing_type: 'PIX',
            provider: 'sharkbanking',
          });
        } catch (webhookError) {
          console.error('[WEBHOOK] Erro postback:', webhookError);
        }

        // Postback para UTMify (se configurado)
        try {
          const metadata = payment.metadata as any;
          await sendUtmifyPostback({
            paymentId: payment.id,
            sellerId: payment.user_id,
            value: grossValue,
            netValue: feeCalc.netValue,
            platformFee: feeCalc.platformFee,
            status: 'paid',
            customerName: metadata?.customer_name || transactionData.customer?.name || 'Cliente',
            customerEmail: metadata?.customer_email || transactionData.customer?.email || '',
            customerPhone: metadata?.customer_phone || undefined,
            customerDocument: metadata?.customer_document || undefined,
            productName: payment.description || 'Produto ZucroPay',
            productId: payment.payment_link_id || undefined,
            createdAt: payment.created_at.toISOString().replace('T', ' ').substring(0, 19),
            approvedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
          });
        } catch (utmifyError) {
          console.error('[WEBHOOK] Erro UTMify postback:', utmifyError);
        }
      }

      // Se pendente, enviar notificação de venda pendente
      if (newStatus === 'PENDING') {
        try {
          await notifySalePending(payment.user_id, Number(payment.value), payment.id);
        } catch (pushError) {
          console.error('[WEBHOOK] Erro push venda pendente:', pushError);
        }
      }
    }

    console.log('[WEBHOOK] ========================================');
    return reply.send({ received: true });
  });

  // ========== Webhook do Enki Bank ==========
  app.post('/enki', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;

    console.log('[WEBHOOK] ========== Enki Bank Webhook ==========');
    console.log('[WEBHOOK] Event:', body.event);
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));

    // Enki envia { event: "transaction.paid", transaction: { ... } }
    // ou { event: "withdrawal.completed", withdrawal: { ... } }
    const event = body.event;

    // ===== Webhook de transação =====
    if (event?.startsWith('transaction.') && body.transaction) {
      const transactionData = body.transaction;
      const enkiTransactionId = String(transactionData.id);

      // Buscar pagamento pelo enki_transaction_id (armazenado no efi_txid)
      const payment = await prisma.payment.findFirst({
        where: { efi_txid: enkiTransactionId },
        include: { user: true },
      });

      if (!payment) {
        console.log(`[WEBHOOK] Pagamento Enki não encontrado: ${enkiTransactionId}`);
        return reply.send({ received: true });
      }

      let newStatus = payment.status;

      // Mapeamento de status Enki → ZucroPay
      if (transactionData.status === 'PAID' || transactionData.status === 'APPROVED') {
        newStatus = 'RECEIVED';
      } else if (transactionData.status === 'WAITING_PAYMENT' || transactionData.status === 'PENDING') {
        newStatus = 'PENDING';
      } else if (transactionData.status === 'REFUSED') {
        newStatus = 'REFUSED';
      } else if (transactionData.status === 'REFUNDED') {
        newStatus = 'REFUNDED';
      } else if (transactionData.status === 'CANCELLED') {
        newStatus = 'CANCELLED';
      } else if (transactionData.status === 'CHARGEBACK' || transactionData.status === 'IN_PROTEST') {
        newStatus = 'REFUNDED';
      }

      // Se já está RECEIVED, ignorar (proteção contra reprocessamento)
      if (payment.status === 'RECEIVED') {
        console.log(`[WEBHOOK] Enki ${enkiTransactionId} já está RECEIVED, ignorando`);
        return reply.send({ received: true });
      }

      if (newStatus !== payment.status) {
        // UPDATE atômico: só atualiza se status ainda não mudou (previne race condition)
        if (newStatus === 'RECEIVED') {
          const updated = await prisma.$executeRaw`
            UPDATE payments SET status = 'RECEIVED', payment_date = NOW(), updated_at = NOW()
            WHERE id = ${payment.id}::uuid AND status != 'RECEIVED'
          `;

          if (updated === 0) {
            console.log(`[WEBHOOK] Payment ${payment.id} já foi processado por outro webhook, ignorando`);
            return reply.send({ received: true });
          }
        } else {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: newStatus,
              payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
            },
          });
        }

        console.log(`[WEBHOOK] Enki ${enkiTransactionId} atualizado: ${newStatus}`);

        // Enviar postback com status atualizado
        const enkiEventMap: Record<string, string> = {
          'RECEIVED': 'charge.paid',
          'REFUNDED': 'charge.refunded',
          'CANCELLED': 'charge.cancelled',
          'REFUSED': 'charge.refused',
          'PENDING': 'charge.pending',
        };
        const updatedEnkiPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
        if (updatedEnkiPayment) {
          sendChargePostback(updatedEnkiPayment, enkiEventMap[newStatus] || `charge.${newStatus.toLowerCase()}`);
        }

        // Se foi pago, processar saldo
        if (newStatus === 'RECEIVED') {
          const grossValue = Number(payment.value);

          // Buscar taxas do vendedor
          const customRates = await prisma.userCustomRate.findUnique({
            where: { user_id: payment.user_id },
          });

          const baseRates = await getEffectiveRates(customRates ? {
            pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
          } : null);

          // Aplicar taxas Enki (só se seller não tem taxa customizada)
          const rates = applyProviderRateOverrides(baseRates, 'enki', !!customRates?.pix_rate);
          const feeCalc = calculatePixFeeSellerPays(grossValue, rates);

          // Atualizar net_value no pagamento
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              net_value: feeCalc.netValue,
              metadata: JSON.parse(JSON.stringify({
                ...(payment.metadata as any),
                platform_fee: feeCalc.platformFee,
                reserve_amount: feeCalc.reserveAmount,
                provider: 'enki',
              })),
            },
          });

          // Atualizar saldo do seller
          await prisma.user.update({
            where: { id: payment.user_id },
            data: {
              balance: { increment: feeCalc.netValue },
              reserved_balance: { increment: feeCalc.reserveAmount },
            },
          });

          // Criar reserva de segurança (5%)
          await prisma.balanceReserve.create({
            data: {
              user_id: payment.user_id,
              payment_id: payment.id,
              original_amount: grossValue,
              reserve_amount: feeCalc.reserveAmount,
              status: 'held',
              release_date: calculateReleaseDate(rates.reserve_days),
              description: `Reserva 5% - ${payment.description}`,
            },
          });

          // Criar transação
          await prisma.transaction.create({
            data: {
              user_id: payment.user_id,
              type: 'deposit',
              amount: feeCalc.netValue,
              status: 'completed',
              description: `PIX recebido (Enki Bank) - ${payment.description}`,
              metadata: {
                enki_transaction_id: enkiTransactionId,
                payment_id: payment.id,
                billing_type: 'PIX',
                gross_value: grossValue,
                platform_fee: feeCalc.platformFee,
                reserve_amount: feeCalc.reserveAmount,
              },
            },
          });

          // Atualizar link de pagamento
          if (payment.payment_link_id) {
            await prisma.paymentLink.update({
              where: { id: payment.payment_link_id },
              data: { total_received: { increment: grossValue } },
            });
          }

          console.log(`[WEBHOOK] Enki pagamento processado: ${payment.id} - R$${feeCalc.netValue.toFixed(2)} líquido`);

          // Notificação push
          try {
            const customerName = transactionData.customer?.name || 'Cliente';
            await notifySale(payment.user_id, grossValue, customerName, payment.id);
          } catch (pushError) {
            console.error('[WEBHOOK] Erro push:', pushError);
          }

          // Postback para webhooks do seller
          try {
            await sendUserWebhook(payment.user_id, 'payment.received', {
              payment_id: payment.id,
              value: grossValue,
              net_value: feeCalc.netValue,
              status: 'RECEIVED',
              billing_type: 'PIX',
              provider: 'enki',
            });
          } catch (webhookError) {
            console.error('[WEBHOOK] Erro postback:', webhookError);
          }

          // Postback para UTMify (se configurado)
          try {
            const metadata = payment.metadata as any;
            await sendUtmifyPostback({
              paymentId: payment.id,
              sellerId: payment.user_id,
              value: grossValue,
              netValue: feeCalc.netValue,
              platformFee: feeCalc.platformFee,
              status: 'paid',
              customerName: metadata?.customer_name || transactionData.customer?.name || 'Cliente',
              customerEmail: metadata?.customer_email || transactionData.customer?.email || '',
              customerPhone: metadata?.customer_phone || undefined,
              customerDocument: metadata?.customer_document || undefined,
              productName: payment.description || 'Produto ZucroPay',
              productId: payment.payment_link_id || undefined,
              createdAt: payment.created_at.toISOString().replace('T', ' ').substring(0, 19),
              approvedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
            });
          } catch (utmifyError) {
            console.error('[WEBHOOK] Erro UTMify postback:', utmifyError);
          }
        }

        // Se pendente, enviar notificação de venda pendente
        if (newStatus === 'PENDING') {
          try {
            await notifySalePending(payment.user_id, Number(payment.value), payment.id);
          } catch (pushError) {
            console.error('[WEBHOOK] Erro push venda pendente:', pushError);
          }
        }
      }
    }

    console.log('[WEBHOOK] ========================================');
    return reply.send({ received: true });
  });

  // ========== Webhook do EuSouZucroPay ==========
  app.post('/eusouzucropay', {
    preHandler: [webhookRateLimit],
  }, async (request, reply) => {
    const body = request.body as any;

    console.log('[WEBHOOK] ========== EuSouZucroPay Webhook ==========');
    console.log('[WEBHOOK] Event:', body.event);
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));

    const event = body.event;

    // ===== Webhook de transação =====
    if (event?.startsWith('transaction.') && body.transaction) {
      const transactionData = body.transaction;
      const eusouzucropayTransactionId = String(transactionData.id);

      // Buscar pagamento pelo eusouzucropay_transaction_id (armazenado no efi_txid)
      const payment = await prisma.payment.findFirst({
        where: { efi_txid: eusouzucropayTransactionId },
        include: { user: true },
      });

      if (!payment) {
        console.log(`[WEBHOOK] Pagamento EuSouZucroPay não encontrado: ${eusouzucropayTransactionId}`);
        return reply.send({ received: true });
      }

      let newStatus = payment.status;

      // Mapeamento de status EuSouZucroPay → ZucroPay
      if (transactionData.status === 'PAID' || transactionData.status === 'APPROVED') {
        newStatus = 'RECEIVED';
      } else if (transactionData.status === 'WAITING_PAYMENT' || transactionData.status === 'PENDING') {
        newStatus = 'PENDING';
      } else if (transactionData.status === 'REFUSED') {
        newStatus = 'REFUSED';
      } else if (transactionData.status === 'REFUNDED') {
        newStatus = 'REFUNDED';
      } else if (transactionData.status === 'CANCELLED') {
        newStatus = 'CANCELLED';
      } else if (transactionData.status === 'CHARGEBACK' || transactionData.status === 'IN_PROTEST') {
        newStatus = 'REFUNDED';
      }

      // Se já está RECEIVED, ignorar (proteção contra reprocessamento)
      if (payment.status === 'RECEIVED') {
        console.log(`[WEBHOOK] EuSouZucroPay ${eusouzucropayTransactionId} já está RECEIVED, ignorando`);
        return reply.send({ received: true });
      }

      if (newStatus !== payment.status) {
        // UPDATE atômico: só atualiza se status ainda não mudou (previne race condition)
        if (newStatus === 'RECEIVED') {
          const updated = await prisma.$executeRaw`
            UPDATE payments SET status = 'RECEIVED', payment_date = NOW(), updated_at = NOW()
            WHERE id = ${payment.id}::uuid AND status != 'RECEIVED'
          `;

          if (updated === 0) {
            console.log(`[WEBHOOK] Payment ${payment.id} já foi processado por outro webhook, ignorando`);
            return reply.send({ received: true });
          }
        } else {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: newStatus,
              payment_date: newStatus === 'RECEIVED' ? new Date() : payment.payment_date,
            },
          });
        }

        console.log(`[WEBHOOK] EuSouZucroPay ${eusouzucropayTransactionId} atualizado: ${newStatus}`);

        // Enviar postback com status atualizado
        const eusouzucropayEventMap: Record<string, string> = {
          'RECEIVED': 'charge.paid',
          'REFUNDED': 'charge.refunded',
          'CANCELLED': 'charge.cancelled',
          'REFUSED': 'charge.refused',
          'PENDING': 'charge.pending',
        };
        const updatedEuSouZucroPayPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
        if (updatedEuSouZucroPayPayment) {
          sendChargePostback(updatedEuSouZucroPayPayment, eusouzucropayEventMap[newStatus] || `charge.${newStatus.toLowerCase()}`);
        }

        // Se foi pago, processar saldo
        if (newStatus === 'RECEIVED') {
          const grossValue = Number(payment.value);

          // Buscar taxas do vendedor
          const customRates = await prisma.userCustomRate.findUnique({
            where: { user_id: payment.user_id },
          });

          const baseRates = await getEffectiveRates(customRates ? {
            pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
          } : null);

          // Aplicar taxas EuSouZucroPay (só se seller não tem taxa customizada)
          const rates = applyProviderRateOverrides(baseRates, 'eusouzucropay', !!customRates?.pix_rate);
          const feeCalc = calculatePixFeeSellerPays(grossValue, rates);

          // Atualizar net_value no pagamento
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              net_value: feeCalc.netValue,
              metadata: JSON.parse(JSON.stringify({
                ...(payment.metadata as any),
                platform_fee: feeCalc.platformFee,
                reserve_amount: feeCalc.reserveAmount,
                provider: 'eusouzucropay',
              })),
            },
          });

          // Atualizar saldo do seller
          await prisma.user.update({
            where: { id: payment.user_id },
            data: {
              balance: { increment: feeCalc.netValue },
              reserved_balance: { increment: feeCalc.reserveAmount },
            },
          });

          // Criar reserva de segurança (5%)
          await prisma.balanceReserve.create({
            data: {
              user_id: payment.user_id,
              payment_id: payment.id,
              original_amount: grossValue,
              reserve_amount: feeCalc.reserveAmount,
              status: 'held',
              release_date: calculateReleaseDate(rates.reserve_days),
              description: `Reserva 5% - ${payment.description}`,
            },
          });

          // Criar transação
          await prisma.transaction.create({
            data: {
              user_id: payment.user_id,
              type: 'deposit',
              amount: feeCalc.netValue,
              status: 'completed',
              description: `PIX recebido (EuSouZucroPay) - ${payment.description}`,
              metadata: {
                eusouzucropay_transaction_id: eusouzucropayTransactionId,
                payment_id: payment.id,
                billing_type: 'PIX',
                gross_value: grossValue,
                platform_fee: feeCalc.platformFee,
                reserve_amount: feeCalc.reserveAmount,
              },
            },
          });

          // Atualizar link de pagamento
          if (payment.payment_link_id) {
            await prisma.paymentLink.update({
              where: { id: payment.payment_link_id },
              data: { total_received: { increment: grossValue } },
            });
          }

          console.log(`[WEBHOOK] EuSouZucroPay pagamento processado: ${payment.id} - R$${feeCalc.netValue.toFixed(2)} líquido`);

          // Notificação push
          try {
            const customerName = transactionData.customer?.name || 'Cliente';
            await notifySale(payment.user_id, grossValue, customerName, payment.id);
          } catch (pushError) {
            console.error('[WEBHOOK] Erro push:', pushError);
          }

          // Postback para webhooks do seller
          try {
            await sendUserWebhook(payment.user_id, 'payment.received', {
              payment_id: payment.id,
              value: grossValue,
              net_value: feeCalc.netValue,
              status: 'RECEIVED',
              billing_type: 'PIX',
              provider: 'eusouzucropay',
            });
          } catch (webhookError) {
            console.error('[WEBHOOK] Erro postback:', webhookError);
          }

          // Postback para UTMify (se configurado)
          try {
            const metadata = payment.metadata as any;
            await sendUtmifyPostback({
              paymentId: payment.id,
              sellerId: payment.user_id,
              value: grossValue,
              netValue: feeCalc.netValue,
              platformFee: feeCalc.platformFee,
              status: 'paid',
              customerName: metadata?.customer_name || transactionData.customer?.name || 'Cliente',
              customerEmail: metadata?.customer_email || transactionData.customer?.email || '',
              customerPhone: metadata?.customer_phone || undefined,
              customerDocument: metadata?.customer_document || undefined,
              productName: payment.description || 'Produto ZucroPay',
              productId: payment.payment_link_id || undefined,
              createdAt: payment.created_at.toISOString().replace('T', ' ').substring(0, 19),
              approvedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
            });
          } catch (utmifyError) {
            console.error('[WEBHOOK] Erro UTMify postback:', utmifyError);
          }
        }

        // Se pendente, enviar notificação de venda pendente
        if (newStatus === 'PENDING') {
          try {
            await notifySalePending(payment.user_id, Number(payment.value), payment.id);
          } catch (pushError) {
            console.error('[WEBHOOK] Erro push venda pendente:', pushError);
          }
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

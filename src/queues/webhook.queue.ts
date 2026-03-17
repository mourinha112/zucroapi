import { Queue } from 'bullmq';
import { prisma } from '../config/database';
import { env } from '../config/env';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  calculateReleaseDate,
} from '../providers/efibank/fee.calculator';
import { notifySale } from '../modules/push/push.service';
import { sendChargePostback } from '../utils/postback';
import { sendUtmifyPostback } from '../modules/app-integrations/utmify.postback';

// ============================================
// FILAS COM REDIS (ou mock sem Redis)
// ============================================

// Mock queue para quando Redis não está disponível
const mockQueue = {
  async add(name: string, data: any, _opts?: any): Promise<any> {
    console.log(`[Queue Mock] Job ${name} adicionado`);
    // Processar sincronamente
    try {
      if (name === 'pix_payment') {
        await processPixPayment(data as PixWebhookJob);
      } else if (name === 'release_reserve') {
        await processReleaseReserve(data as ReleaseReserveJob);
      }
    } catch (e) {
      console.error(`[Queue Mock] Erro ao processar job ${name}:`, e);
    }
    return { id: 'mock-' + Date.now() };
  }
};

// Criar fila real se em produção e Redis disponível
let realQueue: Queue | null = null;
if (env.NODE_ENV === 'production' && env.REDIS_URL) {
  try {
    realQueue = new Queue('webhooks', { 
      connection: { 
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: 3,
      }
    });
    console.log('[Queue] ✅ Fila de webhooks inicializada');
  } catch (e) {
    console.log('[Queue] ⚠️ Erro ao criar fila, usando mock');
  }
} else {
  console.log('[Queue] ⚠️ Usando mock (dev mode)');
}

export const webhookQueue = realQueue || mockQueue;

// Tipos de jobs
interface PixWebhookJob {
  type: 'pix_payment';
  txid: string;
  endToEndId: string;
  status: string;
  valor: string;
  horario: string;
  pagador?: {
    cpf?: string;
    cnpj?: string;
    nome?: string;
  };
}

interface ReleaseReserveJob {
  type: 'release_reserve';
  reserveId: string;
}

type WebhookJobData = PixWebhookJob | ReleaseReserveJob;

// Worker desabilitado (sem Redis)
export const webhookWorker = null;

// Processar pagamento PIX confirmado
async function processPixPayment(data: PixWebhookJob) {
  const { txid, endToEndId, valor, pagador } = data;

  // Buscar pagamento pelo txid
  const payment = await prisma.payment.findFirst({
    where: {
      OR: [
        { efi_txid: txid },
        { asaas_payment_id: txid },
      ],
    },
    include: {
      user: true,
      payment_link: {
        include: { product: true },
      },
    },
  });

  if (!payment) {
    console.log(`[PIX] Pagamento não encontrado para txid: ${txid}`);
    return;
  }

  if (payment.status === 'RECEIVED') {
    console.log(`[PIX] Pagamento já processado: ${payment.id}`);
    return;
  }

  // Buscar taxas personalizadas
  const customRates = await prisma.userCustomRate.findUnique({
    where: { user_id: payment.user_id },
  });

  const rates = await getEffectiveRates(customRates ? {
    pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
  } : null);

  // Calcular taxas
  const baseValue = (payment.metadata as any)?.base_value || Number(payment.value);
  const grossValue = Number(payment.value);
  const feePayer = (payment.metadata as any)?.fee_payer || 'seller';

  // PIX não tem parcelamento, então feePayer não afeta o cálculo
  // Taxa da plataforma SEMPRE é do vendedor
  const feeCalc = calculatePixFeeSellerPays(grossValue, rates);

  // Atualizar pagamento
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'RECEIVED',
      payment_date: new Date(),
      net_value: feeCalc.netValue,
      metadata: JSON.parse(JSON.stringify({
        ...(payment.metadata as any),
        platform_fee: feeCalc.platformFee,
        reserve_amount: feeCalc.reserveAmount,
        pix_pagador: pagador,
        efi_end_to_end_id: endToEndId,
      })),
    },
  });

  // Atualizar saldo do usuário
  await prisma.user.update({
    where: { id: payment.user_id },
    data: {
      balance: { increment: feeCalc.netValue },
      reserved_balance: { increment: feeCalc.reserveAmount },
    },
  });

  // Criar reserva
  await prisma.balanceReserve.create({
    data: {
      user_id: payment.user_id,
      payment_id: payment.id,
      original_amount: baseValue,
      reserve_amount: feeCalc.reserveAmount,
      status: 'held',
      release_date: calculateReleaseDate(rates.reserve_days),
      description: `Reserva 5% - ${payment.description}`,
    },
  });

  // Criar transação de recebimento (valor líquido)
  await prisma.transaction.create({
    data: {
      user_id: payment.user_id,
      type: 'deposit',
      amount: feeCalc.netValue,
      status: 'completed',
      description: `PIX recebido - ${payment.description}`,
      efi_txid: txid,
      metadata: {
        gross_value: grossValue,
        platform_fee: feeCalc.platformFee,
        net_amount: feeCalc.netValue,
        reserve_amount: feeCalc.reserveAmount,
        fee_payer: feePayer,
        end_to_end_id: endToEndId,
        payment_id: payment.id,
      },
    },
  });

  // Atualizar link se existir
  if (payment.payment_link_id) {
    await prisma.paymentLink.update({
      where: { id: payment.payment_link_id },
      data: {
        total_received: { increment: grossValue },
      },
    });
  }

  // Enviar webhook para o usuário (se configurado)
  await sendUserWebhook(payment.user_id, 'payment.received', {
    payment_id: payment.id,
    value: grossValue,
    net_value: feeCalc.netValue,
    status: 'RECEIVED',
  });

  // Enviar postback para a URL da cobrança (postback_url/callback_url)
  const updatedPaymentForPostback = await prisma.payment.findUnique({ where: { id: payment.id } });
  if (updatedPaymentForPostback) {
    sendChargePostback(updatedPaymentForPostback, 'charge.paid');
  }

  // Enviar notificação push para o vendedor
  try {
    const customerName = pagador?.nome || 'Cliente';
    await notifySale(payment.user_id, grossValue, customerName, payment.id);
    console.log(`[PIX] Notificação push enviada para ${payment.user_id}`);
  } catch (pushError) {
    console.error('[PIX] Erro ao enviar notificação push:', pushError);
  }

  // Enviar postback para UTMify (se configurado)
  try {
    const metadata = payment.metadata as any;
    await sendUtmifyPostback({
      paymentId: payment.id,
      sellerId: payment.user_id,
      value: grossValue,
      netValue: feeCalc.netValue,
      platformFee: feeCalc.platformFee,
      status: 'paid',
      customerName: metadata?.customer_name || pagador?.nome || 'Cliente',
      customerEmail: metadata?.customer_email || '',
      customerPhone: metadata?.customer_phone || undefined,
      customerDocument: metadata?.customer_document || pagador?.cpf || undefined,
      productName: payment.description || 'Produto ZucroPay',
      productId: payment.payment_link_id || undefined,
      createdAt: payment.created_at.toISOString().replace('T', ' ').substring(0, 19),
      approvedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
    });
  } catch (utmifyError) {
    console.error('[PIX] Erro ao enviar postback UTMify:', utmifyError);
  }

  console.log(`[PIX] Pagamento processado: ${payment.id} - R$${feeCalc.netValue.toFixed(2)} líquido`);
}

// Função exportada para processar PIX diretamente (para testes)
export async function processPixPaymentDirect(data: {
  txid: string;
  endToEndId: string;
  valor: string;
  pagador?: { nome?: string; cpf?: string };
}) {
  return processPixPayment({
    type: 'pix_payment',
    txid: data.txid,
    endToEndId: data.endToEndId,
    status: 'CONCLUIDA',
    valor: data.valor,
    horario: new Date().toISOString(),
    pagador: data.pagador,
  });
}

// Processar liberação de reserva
async function processReleaseReserve(data: ReleaseReserveJob) {
  const reserve = await prisma.balanceReserve.findUnique({
    where: { id: data.reserveId },
  });

  if (!reserve || reserve.status !== 'held') {
    return;
  }

  // Atualizar reserva
  await prisma.balanceReserve.update({
    where: { id: reserve.id },
    data: { status: 'released' },
  });

  // Mover da reserva para saldo disponível
  await prisma.user.update({
    where: { id: reserve.user_id },
    data: {
      balance: { increment: Number(reserve.reserve_amount) },
      reserved_balance: { decrement: Number(reserve.reserve_amount) },
    },
  });

  // Criar transação
  await prisma.transaction.create({
    data: {
      user_id: reserve.user_id,
      type: 'deposit',
      amount: Number(reserve.reserve_amount),
      status: 'completed',
      description: `Liberação de reserva - ${reserve.description}`,
      metadata: { reserve_id: reserve.id, type: 'reserve_released' },
    },
  });

  console.log(`[RESERVE] Reserva liberada: ${reserve.id} - R$${reserve.reserve_amount}`);
}

// Enviar webhook para usuário
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
    }
  }
}

// Agendar verificação de reservas (rodar todo dia)
export const scheduleReserveRelease = async () => {
  if (!webhookQueue) {
    console.log('[SCHEDULER] Filas desabilitadas - pulando agendamento');
    return;
  }

  // Buscar reservas que devem ser liberadas
  const reserves = await prisma.balanceReserve.findMany({
    where: {
      status: 'held',
      release_date: { lte: new Date() },
    },
  });

  for (const reserve of reserves) {
    await webhookQueue.add('release_reserve', {
      type: 'release_reserve',
      reserveId: reserve.id,
    });
  }

  console.log(`[SCHEDULER] ${reserves.length} reservas agendadas para liberação`);
};

// Eventos do worker desabilitados (sem Redis)


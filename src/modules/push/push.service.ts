import webpush from 'web-push';
import { prisma } from '../../config/database';
import { env } from '../../config/env';

// Configurar VAPID keys
if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${env.VAPID_EMAIL || 'contato@zucropay.com'}`,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  console.log('[Push] VAPID configurado com sucesso');
} else {
  console.warn('[Push] VAPID keys não configuradas - notificações push desabilitadas');
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    type?: string;
    url?: string;
    paymentId?: string;
    amount?: number;
    [key: string]: any;
  };
}

/**
 * Envia notificação push para um usuário específico
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('[Push] VAPID não configurado, pulando notificação');
    return 0;
  }

  try {
    // Buscar todas as subscriptions do usuário
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { user_id: userId },
    });

    if (subscriptions.length === 0) {
      console.log(`[Push] Usuário ${userId} não tem subscriptions`);
      return 0;
    }

    console.log(`[Push] Enviando para ${subscriptions.length} dispositivos do usuário ${userId}`);

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon || '/logotipo.png',
      badge: payload.badge || '/logotipo.png',
      tag: payload.tag || `notification-${Date.now()}`,
      data: payload.data || {},
    });

    let successCount = 0;
    const failedSubscriptions: string[] = [];

    // Enviar para todas as subscriptions
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: {
                p256dh: sub.p256dh,
                auth: sub.auth,
              },
            },
            pushPayload
          );
          successCount++;
          console.log(`[Push] Enviado com sucesso para ${sub.endpoint.substring(0, 50)}...`);
        } catch (error: any) {
          console.error(`[Push] Erro ao enviar para ${sub.endpoint.substring(0, 50)}...`, error.message);
          
          // Se subscription expirou ou é inválida, marcar para remoção
          if (error.statusCode === 404 || error.statusCode === 410) {
            failedSubscriptions.push(sub.id);
          }
        }
      })
    );

    // Remover subscriptions inválidas
    if (failedSubscriptions.length > 0) {
      await prisma.pushSubscription.deleteMany({
        where: { id: { in: failedSubscriptions } },
      });
      console.log(`[Push] Removidas ${failedSubscriptions.length} subscriptions inválidas`);
    }

    return successCount;
  } catch (error) {
    console.error('[Push] Erro ao enviar notificações:', error);
    return 0;
  }
}

/**
 * Busca preferências de notificação do usuário
 */
async function getNotificationPreferences(userId: string): Promise<{
  sale_approved: boolean;
  sale_pending: boolean;
  withdrawal_approved: boolean;
}> {
  const defaults = { sale_approved: true, sale_pending: true, withdrawal_approved: true };
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notification_preferences: true },
    });
    if (!user?.notification_preferences) return defaults;
    const prefs = user.notification_preferences as any;
    return {
      sale_approved: prefs.sale_approved ?? true,
      sale_pending: prefs.sale_pending ?? true,
      withdrawal_approved: prefs.withdrawal_approved ?? true,
    };
  } catch {
    return defaults;
  }
}

/**
 * Envia notificação de venda aprovada (paga)
 */
export async function notifySale(
  userId: string,
  amount: number,
  customerName: string,
  paymentId: string
): Promise<void> {
  const prefs = await getNotificationPreferences(userId);
  if (!prefs.sale_approved) return;

  const formattedAmount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);

  await sendPushToUser(userId, {
    title: '💰 Nova Venda Realizada!',
    body: `Valor: ${formattedAmount}`,
    tag: `sale-${paymentId}`,
    data: {
      type: 'sale',
      url: '/vendas',
      paymentId,
      amount,
    },
  });
}

/**
 * Envia notificação de venda pendente
 */
export async function notifySalePending(
  userId: string,
  amount: number,
  paymentId: string
): Promise<void> {
  const prefs = await getNotificationPreferences(userId);
  if (!prefs.sale_pending) return;

  const formattedAmount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);

  await sendPushToUser(userId, {
    title: '⏳ Venda Pendente',
    body: `Nova venda de ${formattedAmount} aguardando pagamento.`,
    tag: `sale-pending-${paymentId}`,
    data: {
      type: 'sale',
      url: '/vendas',
      paymentId,
      amount,
    },
  });
}

/**
 * Envia notificação de saque aprovado
 */
export async function notifyWithdrawalApproved(
  userId: string,
  amount: number,
  withdrawalId: string
): Promise<void> {
  const prefs = await getNotificationPreferences(userId);
  if (!prefs.withdrawal_approved) return;

  const formattedAmount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);

  await sendPushToUser(userId, {
    title: '✅ Saque Aprovado!',
    body: `Seu saque de ${formattedAmount} foi aprovado e será processado em breve.`,
    tag: `withdrawal-${withdrawalId}`,
    data: {
      type: 'withdrawal',
      url: '/financas',
      withdrawalId,
      amount,
    },
  });
}

/**
 * Envia notificação de saque rejeitado
 */
export async function notifyWithdrawalRejected(
  userId: string,
  amount: number,
  reason: string,
  withdrawalId: string
): Promise<void> {
  const formattedAmount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);

  await sendPushToUser(userId, {
    title: '❌ Saque Rejeitado',
    body: `Seu saque de ${formattedAmount} foi rejeitado: ${reason}`,
    tag: `withdrawal-${withdrawalId}`,
    data: {
      type: 'withdrawal',
      url: '/financas',
      withdrawalId,
      amount,
    },
  });
}

/**
 * Envia notificação de conta aprovada
 */
export async function notifyAccountApproved(userId: string): Promise<void> {
  await sendPushToUser(userId, {
    title: '🎉 Conta Aprovada!',
    body: 'Sua conta foi verificada com sucesso. Você já pode usar todas as funcionalidades!',
    tag: `account-approved`,
    data: {
      type: 'account',
      url: '/dashboard',
    },
  });
}

export default {
  sendPushToUser,
  notifySale,
  notifySalePending,
  notifyWithdrawalApproved,
  notifyWithdrawalRejected,
  notifyAccountApproved,
};

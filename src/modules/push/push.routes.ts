import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';
import { env } from '../../config/env';

export async function pushRoutes(app: FastifyInstance) {
  // Obter VAPID public key (para o frontend usar)
  app.get('/vapid-key', async (_request, reply) => {
    if (!env.VAPID_PUBLIC_KEY) {
      return reply.status(503).send({
        success: false,
        error: 'Push notifications não configuradas',
      });
    }

    return reply.send({
      success: true,
      publicKey: env.VAPID_PUBLIC_KEY,
    });
  });

  // Registrar subscription
  app.post('/subscribe', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;
    const body = request.body as {
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
    };

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return reply.status(400).send({
        success: false,
        error: 'Dados de subscription inválidos',
      });
    }

    try {
      // Verificar se já existe subscription com este endpoint
      const existing = await prisma.pushSubscription.findFirst({
        where: {
          user_id: user.id,
          endpoint: body.endpoint,
        },
      });

      if (existing) {
        // Atualizar subscription existente
        await prisma.pushSubscription.update({
          where: { id: existing.id },
          data: {
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            user_agent: request.headers['user-agent'] || null,
            updated_at: new Date(),
          },
        });

        return reply.send({
          success: true,
          message: 'Subscription atualizada',
        });
      }

      // Criar nova subscription
      await prisma.pushSubscription.create({
        data: {
          user_id: user.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          user_agent: request.headers['user-agent'] || null,
        },
      });

      return reply.send({
        success: true,
        message: 'Subscription registrada com sucesso',
      });
    } catch (error: any) {
      console.error('[Push] Erro ao registrar subscription:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao registrar subscription',
      });
    }
  });

  // Remover subscription
  app.delete('/unsubscribe', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;
    const body = request.body as { endpoint: string };

    if (!body.endpoint) {
      return reply.status(400).send({
        success: false,
        error: 'Endpoint não fornecido',
      });
    }

    try {
      await prisma.pushSubscription.deleteMany({
        where: {
          user_id: user.id,
          endpoint: body.endpoint,
        },
      });

      return reply.send({
        success: true,
        message: 'Subscription removida',
      });
    } catch (error: any) {
      console.error('[Push] Erro ao remover subscription:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao remover subscription',
      });
    }
  });

  // Listar subscriptions do usuário (para debug)
  app.get('/subscriptions', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { user_id: user.id },
      select: {
        id: true,
        endpoint: true,
        user_agent: true,
        created_at: true,
      },
    });

    return reply.send({
      success: true,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        endpoint: s.endpoint.substring(0, 50) + '...',
        userAgent: s.user_agent,
        createdAt: s.created_at,
      })),
    });
  });

  // Buscar preferências de notificação
  app.get('/preferences', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;

    const userData = await prisma.user.findUnique({
      where: { id: user.id },
      select: { notification_preferences: true },
    });

    const defaults = { sale_approved: true, sale_pending: true, withdrawal_approved: true };
    const prefs = userData?.notification_preferences as any || defaults;

    return reply.send({
      success: true,
      preferences: {
        sale_approved: prefs.sale_approved ?? true,
        sale_pending: prefs.sale_pending ?? true,
        withdrawal_approved: prefs.withdrawal_approved ?? true,
      },
    });
  });

  // Atualizar preferências de notificação
  app.put('/preferences', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;
    const body = request.body as {
      sale_approved?: boolean;
      sale_pending?: boolean;
      withdrawal_approved?: boolean;
    };

    // Buscar preferências atuais
    const userData = await prisma.user.findUnique({
      where: { id: user.id },
      select: { notification_preferences: true },
    });

    const current = (userData?.notification_preferences as any) || {};
    const updated = {
      sale_approved: body.sale_approved ?? current.sale_approved ?? true,
      sale_pending: body.sale_pending ?? current.sale_pending ?? true,
      withdrawal_approved: body.withdrawal_approved ?? current.withdrawal_approved ?? true,
    };

    await prisma.user.update({
      where: { id: user.id },
      data: { notification_preferences: updated },
    });

    return reply.send({
      success: true,
      preferences: updated,
    });
  });

  // Endpoint para teste de notificação (apenas para o próprio usuário)
  app.post('/test', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const user = request.currentUser!;

    // Import dinâmico para evitar circular dependency
    const { sendPushToUser } = await import('./push.service');

    const sent = await sendPushToUser(user.id, {
      title: '🧪 Teste de Notificação',
      body: 'Se você está vendo isso, as notificações estão funcionando!',
      tag: 'test-' + Date.now(),
      data: {
        type: 'test',
        url: '/dashboard',
      },
    });

    return reply.send({
      success: true,
      message: sent > 0 ? `Notificação enviada para ${sent} dispositivo(s)` : 'Nenhum dispositivo registrado',
      deviceCount: sent,
    });
  });
}

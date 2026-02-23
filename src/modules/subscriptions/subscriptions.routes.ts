import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';

const createSubscriptionPlanSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  interval: z.enum(['week', 'month', 'year']).default('month'),
  intervalCount: z.number().positive().default(1),
  price: z.number().positive(),
  trialDays: z.number().min(0).default(0),
  maxInstallments: z.number().positive().default(1),
  cancelAtEnd: z.boolean().default(true),
  active: z.boolean().default(true),
});

export async function subscriptionRoutes(app: FastifyInstance) {
  // ============================================
  // PLANOS DE ASSINATURA
  // ============================================

  // Listar planos do usuário
  app.get('/plans', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const plans = await prisma.subscriptionPlan.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ success: true, plans });
  });

  // Obter plano por ID
  app.get('/plans/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const plan = await prisma.subscriptionPlan.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!plan) {
      return reply.status(404).send({ error: 'Plano não encontrado' });
    }

    return reply.send({ success: true, plan });
  });

  // Criar plano
  app.post('/plans', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = createSubscriptionPlanSchema.parse(request.body);

    const plan = await prisma.subscriptionPlan.create({
      data: {
        user_id: decoded.id,
        name: body.name,
        description: body.description,
        interval: body.interval,
        interval_count: body.intervalCount,
        price: body.price,
        trial_days: body.trialDays,
        max_installments: body.maxInstallments,
        cancel_at_end: body.cancelAtEnd,
        active: body.active,
      },
    });

    return reply.status(201).send({ success: true, plan });
  });

  // Atualizar plano
  app.put('/plans/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existing = await prisma.subscriptionPlan.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Plano não encontrado' });
    }

    const plan = await prisma.subscriptionPlan.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.interval && { interval: body.interval }),
        ...(body.intervalCount && { interval_count: body.intervalCount }),
        ...(body.price && { price: body.price }),
        ...(body.trialDays !== undefined && { trial_days: body.trialDays }),
        ...(body.maxInstallments && { max_installments: body.maxInstallments }),
        ...(body.cancelAtEnd !== undefined && { cancel_at_end: body.cancelAtEnd }),
        ...(body.active !== undefined && { active: body.active }),
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, plan });
  });

  // Deletar plano
  app.delete('/plans/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const existing = await prisma.subscriptionPlan.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Plano não encontrado' });
    }

    // Verificar se há assinaturas ativas
    const activeSubscriptions = await prisma.subscription.count({
      where: {
        subscription_plan_id: id,
        status: 'active',
      },
    });

    if (activeSubscriptions > 0) {
      return reply.status(400).send({ 
        error: 'Não é possível excluir um plano com assinaturas ativas' 
      });
    }

    await prisma.subscriptionPlan.delete({
      where: { id },
    });

    return reply.send({ success: true, message: 'Plano deletado' });
  });

  // ============================================
  // ASSINATURAS ATIVAS
  // ============================================

  // Listar assinaturas (como vendedor)
  app.get('/subscriptions', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const query = request.query as { status?: string; limit?: string; offset?: string };

    const subscriptions = await prisma.subscription.findMany({
      where: {
        user_id: decoded.id,
        ...(query.status && { status: query.status }),
      },
      include: {
        plan: true,
        customer: {
          select: { id: true, name: true, email: true }
        },
      },
      orderBy: { created_at: 'desc' },
      take: parseInt(query.limit || '50'),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({ success: true, subscriptions });
  });

  // Obter assinatura por ID
  app.get('/subscriptions/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const subscription = await prisma.subscription.findFirst({
      where: { id, user_id: decoded.id },
      include: {
        plan: true,
        customer: true,
        subscription_subscriptions: {
          orderBy: { billing_date: 'desc' },
          take: 10,
        },
      },
    });

    if (!subscription) {
      return reply.status(404).send({ error: 'Assinatura não encontrada' });
    }

    return reply.send({ success: true, subscription });
  });

  // Cancelar assinatura
  app.post('/subscriptions/:id/cancel', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const subscription = await prisma.subscription.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!subscription) {
      return reply.status(404).send({ error: 'Assinatura não encontrada' });
    }

    if (subscription.status === 'cancelled') {
      return reply.status(400).send({ error: 'Assinatura já está cancelada' });
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: {
        cancel_at_period_end: true,
        status: 'cancelled',
        cancelled_at: new Date(),
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, subscription: updated });
  });

  // ============================================
  // COBRANÇAS DA ASSINATURA
  // ============================================

  // Listar cobranças de uma assinatura
  app.get('/subscriptions/:id/payments', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const subscription = await prisma.subscription.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!subscription) {
      return reply.status(404).send({ error: 'Assinatura não encontrada' });
    }

    const payments = await prisma.subscriptionPayment.findMany({
      where: { subscription_id: id },
      orderBy: { billing_date: 'desc' },
    });

    return reply.send({ success: true, payments });
  });
}

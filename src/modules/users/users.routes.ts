import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

export async function usersRoutes(app: FastifyInstance) {
  // Obter perfil do usuário
  app.get('/profile', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string; type: string };
    
    if (decoded.type !== 'user') {
      return reply.status(403).send({ error: 'Acesso negado' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { custom_rates: true },
    });

    if (!user) {
      return reply.status(404).send({ error: 'Usuário não encontrado' });
    }

    const { password_hash, ...userData } = user;
    return reply.send({ success: true, user: userData });
  });

  // Atualizar perfil
  app.put('/profile', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string; type: string };
    const body = request.body as { name?: string; phone?: string; avatar?: string };

    const user = await prisma.user.update({
      where: { id: decoded.id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.phone && { phone: body.phone }),
        ...(body.avatar && { avatar: body.avatar }),
        updated_at: new Date(),
      },
    });

    const { password_hash, ...userData } = user;
    return reply.send({ success: true, user: userData });
  });

  // Obter saldo
  app.get('/balance', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { balance: true, reserved_balance: true },
    });

    if (!user) {
      return reply.status(404).send({ error: 'Usuário não encontrado' });
    }

    return reply.send({
      success: true,
      balance: {
        available: Number(user.balance),
        reserved: Number(user.reserved_balance),
        total: Number(user.balance) + Number(user.reserved_balance),
      },
    });
  });

  // Obter dashboard data
  app.get('/dashboard', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const [user, recentPayments, recentTransactions] = await Promise.all([
      prisma.user.findUnique({
        where: { id: decoded.id },
        include: { custom_rates: true },
      }),
      prisma.payment.findMany({
        where: { user_id: decoded.id },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
      prisma.transaction.findMany({
        where: { user_id: decoded.id },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
    ]);

    if (!user) {
      return reply.status(404).send({ error: 'Usuário não encontrado' });
    }

    const { password_hash, ...userData } = user;

    return reply.send({
      success: true,
      user: userData,
      recentPayments,
      recentTransactions,
    });
  });
}

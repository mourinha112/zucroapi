import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { authenticateAdmin, standardRateLimit, sensitiveActionRateLimit } from '../../middlewares';

export async function adminRoutes(app: FastifyInstance) {
  // Dashboard stats
  app.get('/stats', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      // Queries básicas que devem sempre funcionar
      const [totalUsers, pendingUsers, totalBalance] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { account_status: 'pending' } }),
        prisma.user.aggregate({ _sum: { balance: true } }),
      ]);

      // Queries que podem falhar se tabelas não existirem
      let totalPayments = 0;
      let pendingWithdrawals = 0;
      let pendingWithdrawalAmount = 0;
      let completedWithdrawals = 0;
      let pendingVerifications = 0;
      let totalSales = 0;

      try {
        totalPayments = await prisma.payment.count({ where: { status: 'RECEIVED' } });
        const salesAgg = await prisma.payment.aggregate({
          where: { status: 'RECEIVED' },
          _sum: { amount: true }
        });
        totalSales = Number(salesAgg._sum.amount || 0);
      } catch (e) {
        console.log('Erro ao buscar payments:', e);
      }

      try {
        pendingWithdrawals = await prisma.withdrawal.count({ where: { status: 'pending' } });
        const withdrawalAgg = await prisma.withdrawal.aggregate({ 
          where: { status: 'pending' },
          _sum: { amount: true } 
        });
        pendingWithdrawalAmount = Number(withdrawalAgg._sum.amount || 0);
        completedWithdrawals = await prisma.withdrawal.count({ where: { status: 'completed' } });
      } catch (e) {
        console.log('Erro ao buscar withdrawals:', e);
      }

      try {
        pendingVerifications = await prisma.userVerification.count({ where: { status: 'pending' } });
      } catch (e) {
        console.log('Erro ao buscar verifications:', e);
      }

      return reply.send({
        success: true,
        stats: {
          totalUsers,
          pendingUsers,
          totalPayments,
          pendingWithdrawals,
          pendingWithdrawalAmount,
          completedWithdrawals,
          totalBalance: Number(totalBalance._sum.balance || 0),
          pendingVerifications,
          totalSales,
        },
      });
    } catch (error: any) {
      console.error('Erro ao buscar stats:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar estatísticas',
        details: error.message,
      });
    }
  });

  // Listar usuários
  app.get('/users', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as { status?: string; search?: string; limit?: string; offset?: string };

    const users = await prisma.user.findMany({
      where: {
        ...(query.status && { account_status: query.status }),
        ...(query.search && {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { created_at: 'desc' },
      take: parseInt(query.limit || '50'),
      skip: parseInt(query.offset || '0'),
      select: {
        id: true,
        name: true,
        email: true,
        cpf_cnpj: true,
        phone: true,
        balance: true,
        reserved_balance: true,
        account_status: true,
        verification_status: true,
        created_at: true,
      },
    });

    return reply.send({ success: true, users });
  });

  // Aprovar/Rejeitar usuário (ação sensível)
  app.post('/users/:id/status', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { status: string; reason?: string };

    const user = await prisma.user.update({
      where: { id },
      data: {
        account_status: body.status,
        account_status_reason: body.reason,
        account_reviewed_by: currentUser.id,
        account_reviewed_at: new Date(),
      },
    });

    // Log da ação
    await prisma.adminLog.create({
      data: {
        admin_id: currentUser.id,
        action: `${body.status}_user`,
        target_type: 'user',
        target_id: id,
        details: { status: body.status, reason: body.reason },
      },
    });

    return reply.send({ success: true, user });
  });

  // Listar saques pendentes
  app.get('/withdrawals', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as { status?: string };

    const withdrawals = await prisma.withdrawal.findMany({
      where: {
        ...(query.status && { status: query.status }),
      },
      orderBy: { created_at: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return reply.send({ success: true, withdrawals });
  });

  // Aprovar/Rejeitar saque (ação sensível)
  app.post('/withdrawals/:id/status', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { status: 'approved' | 'rejected' | 'completed'; reason?: string };

    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id },
    });

    if (!withdrawal) {
      return reply.status(404).send({ error: 'Saque não encontrado' });
    }

    // Se rejeitado, devolver o saldo
    if (body.status === 'rejected' && withdrawal.status === 'pending') {
      await prisma.user.update({
        where: { id: withdrawal.user_id },
        data: {
          balance: { increment: withdrawal.amount },
        },
      });
    }

    const updated = await prisma.withdrawal.update({
      where: { id },
      data: {
        status: body.status,
        rejection_reason: body.reason,
        reviewed_by: currentUser.id,
        reviewed_at: new Date(),
        ...(body.status === 'completed' && { completed_at: new Date() }),
      },
    });

    // Log da ação
    await prisma.adminLog.create({
      data: {
        admin_id: currentUser.id,
        action: `${body.status}_withdrawal`,
        target_type: 'withdrawal',
        target_id: id,
        details: { status: body.status, reason: body.reason },
      },
    });

    return reply.send({ success: true, withdrawal: updated });
  });

  // Definir taxas customizadas para usuário
  app.post('/users/:id/rates', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as {
      pix_rate?: number;
      card_rate?: number;
      boleto_rate?: number;
      withdrawal_fee?: number;
      notes?: string;
    };

    const rates = await prisma.userCustomRate.upsert({
      where: { user_id: id },
      create: {
        user_id: id,
        pix_rate: body.pix_rate,
        card_rate: body.card_rate,
        boleto_rate: body.boleto_rate,
        withdrawal_fee: body.withdrawal_fee,
        notes: body.notes,
        created_by: currentUser.id,
      },
      update: {
        pix_rate: body.pix_rate,
        card_rate: body.card_rate,
        boleto_rate: body.boleto_rate,
        withdrawal_fee: body.withdrawal_fee,
        notes: body.notes,
        updated_at: new Date(),
      },
    });

    // Log da ação
    await prisma.adminLog.create({
      data: {
        admin_id: currentUser.id,
        action: 'set_custom_rates',
        target_type: 'user',
        target_id: id,
        details: body,
      },
    });

    return reply.send({ success: true, rates });
  });

  // Verificações de identidade pendentes
  app.get('/verifications', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as { status?: string };

    const verifications = await prisma.userVerification.findMany({
      where: {
        ...(query.status && { status: query.status }),
      },
      orderBy: { created_at: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return reply.send({ success: true, verifications });
  });

  // Aprovar/Rejeitar verificação (ação sensível)
  app.post('/verifications/:id/status', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { status: 'approved' | 'rejected'; reason?: string };

    const verification = await prisma.userVerification.update({
      where: { id },
      data: {
        status: body.status,
        rejection_reason: body.reason,
        reviewed_by: currentUser.id,
        reviewed_at: new Date(),
      },
    });

    // Atualizar status do usuário
    await prisma.user.update({
      where: { id: verification.user_id },
      data: {
        verification_status: body.status,
        verification_reviewed_at: new Date(),
        verification_reviewed_by: currentUser.id,
        verification_rejection_reason: body.reason,
      },
    });

    // Log da ação
    await prisma.adminLog.create({
      data: {
        admin_id: currentUser.id,
        action: `${body.status}_verification`,
        target_type: 'verification',
        target_id: id,
        details: { status: body.status, reason: body.reason },
      },
    });

    return reply.send({ success: true, verification });
  });
}

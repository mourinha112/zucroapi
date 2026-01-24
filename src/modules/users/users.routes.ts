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

  // ============================================
  // VERIFICAÇÃO DE IDENTIDADE
  // ============================================

  // Obter status de verificação
  app.get('/verification', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const verification = await prisma.userVerification.findUnique({
      where: { user_id: decoded.id },
    });

    return reply.send({
      success: true,
      verification: verification || null,
    });
  });

  // Submeter documentos para verificação
  app.post('/verification', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = request.body as {
      document_type: string;
      document_front_url?: string;
      document_back_url?: string;
      selfie_url?: string;
      full_name: string;
      birth_date: string;
      document_number: string;
    };

    try {
      // Verificar se já existe uma verificação pendente ou aprovada
      const existing = await prisma.userVerification.findUnique({
        where: { user_id: decoded.id },
      });

      if (existing?.status === 'approved') {
        return reply.status(400).send({
          success: false,
          error: 'Sua conta já está verificada',
        });
      }

      // Criar ou atualizar verificação
      const verification = await prisma.userVerification.upsert({
        where: { user_id: decoded.id },
        create: {
          user_id: decoded.id,
          document_type: body.document_type,
          document_front_url: body.document_front_url,
          document_back_url: body.document_back_url,
          selfie_url: body.selfie_url,
          full_name: body.full_name,
          birth_date: body.birth_date ? new Date(body.birth_date) : null,
          document_number: body.document_number,
          status: 'pending',
        },
        update: {
          document_type: body.document_type,
          document_front_url: body.document_front_url,
          document_back_url: body.document_back_url,
          selfie_url: body.selfie_url,
          full_name: body.full_name,
          birth_date: body.birth_date ? new Date(body.birth_date) : null,
          document_number: body.document_number,
          status: 'pending',
          rejection_reason: null,
          updated_at: new Date(),
        },
      });

      // Atualizar status do usuário
      await prisma.user.update({
        where: { id: decoded.id },
        data: { verification_status: 'pending' },
      });

      return reply.send({
        success: true,
        message: 'Documentos enviados para verificação',
        verification,
      });
    } catch (error: any) {
      console.error('Erro ao enviar verificação:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao processar verificação',
      });
    }
  });
}

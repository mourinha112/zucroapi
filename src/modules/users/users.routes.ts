import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';
import { getEffectiveRates } from '../../providers/efibank/fee.calculator';
import { listDevices, recordDevice } from './devices.service';

export async function usersRoutes(app: FastifyInstance) {
  // Dispositivos/sessões do usuário (aba Dispositivos das Configurações)
  app.get('/devices', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    // Mantém o dispositivo atual no topo mesmo que o login tenha sido antigo
    await recordDevice(request, decoded.id);
    const devices = await listDevices(decoded.id);
    return reply.send({ success: true, devices });
  });

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

  // Obter taxas efetivas do seller (platform_settings + custom se houver)
  // Usado pela página "Minhas Taxas" — sempre reflete o que o admin configurou
  app.get('/my-rates', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const customRates = await prisma.userCustomRate.findUnique({
      where: { user_id: decoded.id },
    });

    // Merge: platform rates (do banco) + custom rates do seller (se houver)
    const effectiveRates = await getEffectiveRates(
      customRates
        ? {
            pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
            card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
            boleto_rate: customRates.boleto_rate ? Number(customRates.boleto_rate) : undefined,
            withdrawal_fee: customRates.withdrawal_fee
              ? Number(customRates.withdrawal_fee)
              : undefined,
          }
        : null,
    );

    return reply.send({
      success: true,
      rates: {
        pix_rate: effectiveRates.pix_rate,
        card_rate: effectiveRates.card_rate,
        boleto_rate: effectiveRates.boleto_rate,
        fixed_fee: effectiveRates.fixed_fee,
        reserve_percent: effectiveRates.reserve_percent,
        reserve_days: effectiveRates.reserve_days,
        withdrawal_fee: effectiveRates.withdrawal_fee,
      },
      isCustom: !!customRates,
    });
  });

  // Obter dashboard data
  app.get('/dashboard', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    // Buscar pagamentos dos últimos 90 dias para cálculos corretos de faturamento
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const [user, recentPayments, recentTransactions] = await Promise.all([
      prisma.user.findUnique({
        where: { id: decoded.id },
        include: { custom_rates: true },
      }),
      prisma.payment.findMany({
        where: {
          user_id: decoded.id,
          created_at: { gte: ninetyDaysAgo },
        },
        orderBy: { created_at: 'desc' },
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

    // Extrair dados do cliente do metadata
    const paymentsWithCustomer = recentPayments.map(payment => {
      const metadata = payment.metadata as any;
      return {
        ...payment,
        customer_name: metadata?.customer_name || null,
        customer_email: metadata?.customer_email || null,
        customer_cpf: metadata?.customer_document || null,
      };
    });

    return reply.send({
      success: true,
      user: userData,
      recentPayments: paymentsWithCustomer,
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

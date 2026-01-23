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
          _sum: { value: true }
        });
        totalSales = Number(salesAgg._sum?.value || 0);
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

  // Configurações do Gateway (EfiBank)
  app.get('/gateway-config', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (_request, reply) => {
    try {
      const clientId = process.env.EFI_CLIENT_ID || '';
      const clientSecret = process.env.EFI_CLIENT_SECRET || '';
      const pixKey = process.env.EFI_PIX_KEY || '';
      const certificate = process.env.EFI_CERTIFICATE_BASE64 || '';
      const sandbox = process.env.EFI_SANDBOX === 'true';

      // Mascarar dados sensíveis
      const maskString = (str: string) => {
        if (!str || str.length < 8) return '';
        return str.substring(0, 4) + '****' + str.substring(str.length - 4);
      };

      const configured = !!(clientId && clientSecret && pixKey && certificate);

      return reply.send({
        success: true,
        config: {
          configured,
          provider: 'EfiBank',
          sandbox,
          clientIdMasked: clientId ? maskString(clientId) : null,
          clientSecretConfigured: !!clientSecret,
          pixKeyMasked: pixKey ? maskString(pixKey) : null,
          certificateConfigured: !!certificate,
          features: {
            pix: configured,
            creditCard: configured, // EfiBank suporta cartão quando configurado
            boleto: configured,
          },
        },
      });
    } catch (error: any) {
      console.error('Erro ao buscar config do gateway:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar configurações do gateway',
      });
    }
  });

  // ============================================
  // CONFIGURAÇÃO DE WEBHOOK PIX
  // ============================================

  // Configurar webhook PIX na EfiBank
  app.post('/webhook/pix/configure', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const { configurePixWebhook } = await import('../../providers/efibank/efi.pix');
      
      // URL do webhook - deve ser HTTPS e acessível pela EfiBank
      const webhookUrl = 'https://api.appzucropay.com/api/webhooks/efi';
      
      const result = await configurePixWebhook(webhookUrl);
      
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error,
          debug: result.debug,
        });
      }

      return reply.send({
        success: true,
        message: 'Webhook PIX configurado com sucesso',
        webhookUrl,
        data: result.data,
      });
    } catch (error: any) {
      console.error('Erro ao configurar webhook PIX:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao configurar webhook PIX',
      });
    }
  });

  // Consultar webhook PIX configurado
  app.get('/webhook/pix', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const { getPixWebhook } = await import('../../providers/efibank/efi.pix');
      
      const result = await getPixWebhook();
      
      return reply.send({
        success: result.success,
        webhookUrl: result.webhookUrl || null,
        error: result.error,
        data: result.data,
      });
    } catch (error: any) {
      console.error('Erro ao consultar webhook PIX:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao consultar webhook PIX',
      });
    }
  });

  // Remover webhook PIX
  app.delete('/webhook/pix', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const { deletePixWebhook } = await import('../../providers/efibank/efi.pix');
      
      const result = await deletePixWebhook();
      
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error,
        });
      }

      return reply.send({
        success: true,
        message: 'Webhook PIX removido com sucesso',
      });
    } catch (error: any) {
      console.error('Erro ao remover webhook PIX:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao remover webhook PIX',
      });
    }
  });

  // ============================================
  // TAXAS GLOBAIS DA PLATAFORMA
  // ============================================

  // Obter taxas globais
  app.get('/platform-rates', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      let settings = await prisma.platformSettings.findUnique({
        where: { id: 'default' },
      });

      // Criar configuração padrão se não existir
      if (!settings) {
        settings = await prisma.platformSettings.create({
          data: {
            id: 'default',
            pix_rate: 5.99,
            card_rate: 5.99,
            boleto_rate: 5.99,
            fixed_fee: 2.50,
            installment_fee: 2.49,
            reserve_percent: 0.05,
            reserve_days: 30,
            withdrawal_fee: 2.00,
            max_installments: 12,
            min_pix_value: 1.00,
            min_card_value: 5.00,
          },
        });
      }

      return reply.send({
        success: true,
        rates: {
          pix_rate: Number(settings.pix_rate),
          card_rate: Number(settings.card_rate),
          boleto_rate: Number(settings.boleto_rate),
          fixed_fee: Number(settings.fixed_fee),
          installment_fee: Number(settings.installment_fee),
          reserve_percent: Number(settings.reserve_percent),
          reserve_days: settings.reserve_days,
          withdrawal_fee: Number(settings.withdrawal_fee),
          max_installments: settings.max_installments,
          min_pix_value: Number(settings.min_pix_value),
          min_card_value: Number(settings.min_card_value),
        },
        updated_at: settings.updated_at,
      });
    } catch (error: any) {
      console.error('Erro ao buscar taxas:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao buscar taxas',
      });
    }
  });

  // Atualizar taxas globais
  app.put('/platform-rates', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const body = request.body as {
      pix_rate?: number;
      card_rate?: number;
      boleto_rate?: number;
      fixed_fee?: number;
      installment_fee?: number;
      reserve_percent?: number;
      reserve_days?: number;
      withdrawal_fee?: number;
      max_installments?: number;
      min_pix_value?: number;
      min_card_value?: number;
    };

    try {
      // Validações
      if (body.pix_rate !== undefined && (body.pix_rate < 0 || body.pix_rate > 50)) {
        return reply.status(400).send({ success: false, error: 'Taxa PIX deve ser entre 0% e 50%' });
      }
      if (body.card_rate !== undefined && (body.card_rate < 0 || body.card_rate > 50)) {
        return reply.status(400).send({ success: false, error: 'Taxa Cartão deve ser entre 0% e 50%' });
      }
      if (body.boleto_rate !== undefined && (body.boleto_rate < 0 || body.boleto_rate > 50)) {
        return reply.status(400).send({ success: false, error: 'Taxa Boleto deve ser entre 0% e 50%' });
      }
      if (body.installment_fee !== undefined && (body.installment_fee < 0 || body.installment_fee > 10)) {
        return reply.status(400).send({ success: false, error: 'Juros de parcelamento deve ser entre 0% e 10%' });
      }
      if (body.reserve_percent !== undefined && (body.reserve_percent < 0 || body.reserve_percent > 0.5)) {
        return reply.status(400).send({ success: false, error: 'Reserva deve ser entre 0% e 50%' });
      }
      if (body.reserve_days !== undefined && (body.reserve_days < 1 || body.reserve_days > 180)) {
        return reply.status(400).send({ success: false, error: 'Dias de reserva deve ser entre 1 e 180' });
      }

      // Atualizar ou criar
      const settings = await prisma.platformSettings.upsert({
        where: { id: 'default' },
        update: {
          ...(body.pix_rate !== undefined && { pix_rate: body.pix_rate }),
          ...(body.card_rate !== undefined && { card_rate: body.card_rate }),
          ...(body.boleto_rate !== undefined && { boleto_rate: body.boleto_rate }),
          ...(body.fixed_fee !== undefined && { fixed_fee: body.fixed_fee }),
          ...(body.installment_fee !== undefined && { installment_fee: body.installment_fee }),
          ...(body.reserve_percent !== undefined && { reserve_percent: body.reserve_percent }),
          ...(body.reserve_days !== undefined && { reserve_days: body.reserve_days }),
          ...(body.withdrawal_fee !== undefined && { withdrawal_fee: body.withdrawal_fee }),
          ...(body.max_installments !== undefined && { max_installments: body.max_installments }),
          ...(body.min_pix_value !== undefined && { min_pix_value: body.min_pix_value }),
          ...(body.min_card_value !== undefined && { min_card_value: body.min_card_value }),
          updated_at: new Date(),
        },
        create: {
          id: 'default',
          pix_rate: body.pix_rate ?? 5.99,
          card_rate: body.card_rate ?? 5.99,
          boleto_rate: body.boleto_rate ?? 5.99,
          fixed_fee: body.fixed_fee ?? 2.50,
          installment_fee: body.installment_fee ?? 2.49,
          reserve_percent: body.reserve_percent ?? 0.05,
          reserve_days: body.reserve_days ?? 30,
          withdrawal_fee: body.withdrawal_fee ?? 2.00,
          max_installments: body.max_installments ?? 12,
          min_pix_value: body.min_pix_value ?? 1.00,
          min_card_value: body.min_card_value ?? 5.00,
        },
      });

      // Invalidar cache
      const { invalidatePlatformRatesCache } = await import('../../providers/efibank/fee.calculator');
      invalidatePlatformRatesCache();

      // Logar alteração
      await prisma.adminLog.create({
        data: {
          action: 'platform_rates_updated',
          details: body as any,
        },
      });

      return reply.send({
        success: true,
        message: 'Taxas atualizadas com sucesso',
        rates: {
          pix_rate: Number(settings.pix_rate),
          card_rate: Number(settings.card_rate),
          boleto_rate: Number(settings.boleto_rate),
          fixed_fee: Number(settings.fixed_fee),
          installment_fee: Number(settings.installment_fee),
          reserve_percent: Number(settings.reserve_percent),
          reserve_days: settings.reserve_days,
          withdrawal_fee: Number(settings.withdrawal_fee),
          max_installments: settings.max_installments,
          min_pix_value: Number(settings.min_pix_value),
          min_card_value: Number(settings.min_card_value),
        },
      });
    } catch (error: any) {
      console.error('Erro ao atualizar taxas:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao atualizar taxas',
      });
    }
  });
}

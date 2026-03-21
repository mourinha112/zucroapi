import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { authenticateAdmin, standardRateLimit, sensitiveActionRateLimit } from '../../middlewares';

export async function adminRoutes(app: FastifyInstance) {
  // Dashboard stats com GMV, Lucro e dados para gráficos
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
      let gmv = 0; // Gross Merchandise Volume (movimentação total)
      let totalFees = 0; // Lucro da plataforma (taxas cobradas)
      let totalWithdrawn = 0; // Total sacado
      let chargebackCount = 0;

      try {
        // Faturamento total baseado nos depósitos (transactions)
        const depositStats = await prisma.$queryRaw`
          SELECT
            COUNT(*) as count,
            COALESCE(SUM(amount), 0) as total_value
          FROM transactions
          WHERE type = 'deposit'
        ` as any[];

        const row = depositStats[0];
        totalPayments = Number(row?.count || 0);
        gmv = Number(row?.total_value || 0);

        // Lucro = faturamento total - soma dos saldos dos sellers
        const sellerBalances = await prisma.user.aggregate({ _sum: { balance: true } });
        const totalSellerBalance = Number(sellerBalances._sum.balance || 0);
        const totalWithdrawnForFees = await prisma.$queryRaw`
          SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE status = 'completed'
        ` as any[];
        const withdrawn = Number(totalWithdrawnForFees[0]?.total || 0);
        totalFees = gmv - totalSellerBalance - withdrawn;
        totalSales = gmv;
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
        
        // Total já sacado
        const withdrawnAgg = await prisma.withdrawal.aggregate({
          where: { status: 'completed' },
          _sum: { amount: true }
        });
        totalWithdrawn = Number(withdrawnAgg._sum?.amount || 0);
      } catch (e) {
        console.log('Erro ao buscar withdrawals:', e);
      }

      try {
        pendingVerifications = await prisma.userVerification.count({ where: { status: 'pending' } });
      } catch (e) {
        console.log('Erro ao buscar verifications:', e);
      }

      // Gráfico de vendas dos últimos 7 dias
      let salesChartData: any[] = [];
      try {
        const last7Days = await prisma.$queryRaw`
          SELECT
            DATE(created_at) as date,
            COUNT(*) as count,
            COALESCE(SUM(amount), 0) as total
          FROM transactions
          WHERE type = 'deposit'
            AND created_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(created_at)
          ORDER BY date ASC
        ` as any[];

        salesChartData = last7Days.map((d: any) => ({
          date: new Date(d.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          vendas: Number(d.count),
          valor: Number(d.total),
        }));
      } catch (e) {
        console.log('Erro ao buscar dados do gráfico:', e);
      }

      // Métodos de pagamento
      let paymentMethodData: any[] = [];
      try {
        const methodStats = await prisma.$queryRaw`
          SELECT
            billing_type,
            COUNT(*) as count,
            COALESCE(SUM(value), 0) as total
          FROM payments
          WHERE status = 'RECEIVED'
          GROUP BY billing_type
        ` as any[];

        paymentMethodData = methodStats.map((m: any) => ({
          name: m.billing_type || 'Outro',
          value: Number(m.count),
          total: Number(m.total),
        }));
      } catch (e) {
        console.log('Erro ao buscar métodos de pagamento:', e);
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
          // Novos campos
          gmv, // Movimentação total
          totalFees, // Lucro da plataforma
          totalWithdrawn, // Total sacado
          chargebackCount, // Chargebacks
        },
        charts: {
          salesChart: salesChartData,
          paymentMethods: paymentMethodData,
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
        identity_verified: true,
        payment_provider: true,
        created_at: true,
        custom_rates: true,
      },
    });

    return reply.send({ success: true, users });
  });

  // Detalhes de um usuário específico
  app.get('/users/:id', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          cpf_cnpj: true,
          phone: true,
          balance: true,
          reserved_balance: true,
          account_status: true,
          account_status_reason: true,
          verification_status: true,
          payment_provider: true,
          created_at: true,
          updated_at: true,
        },
      });

      if (!user) {
        return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
      }

      // Buscar estatísticas do usuário
      let userStats = {
        totalSales: 0,
        totalValue: 0,
        totalWithdrawals: 0,
        withdrawnAmount: 0,
      };

      try {
        const salesAgg = await prisma.payment.aggregate({
          where: { user_id: id, status: 'RECEIVED' },
          _count: true,
          _sum: { value: true },
        });
        userStats.totalSales = salesAgg._count || 0;
        userStats.totalValue = Number(salesAgg._sum?.value || 0);

        const withdrawalsAgg = await prisma.withdrawal.aggregate({
          where: { user_id: id, status: 'completed' },
          _count: true,
          _sum: { amount: true },
        });
        userStats.totalWithdrawals = withdrawalsAgg._count || 0;
        userStats.withdrawnAmount = Number(withdrawalsAgg._sum?.amount || 0);
      } catch (e) {
        console.log('Erro ao buscar stats do usuário:', e);
      }

      // Buscar taxas customizadas
      let customRates = null;
      try {
        customRates = await prisma.userCustomRate.findUnique({
          where: { user_id: id },
        });
      } catch (e) {
        // Tabela pode não existir
      }

      return reply.send({
        success: true,
        user: {
          ...user,
          stats: userStats,
          customRates,
        },
      });
    } catch (error: any) {
      console.error('Erro ao buscar usuário:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
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
      include: {
        user: {
          select: { name: true, email: true },
        },
      },
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

    // Se aprovado, enviar PIX automaticamente via SharkBanking
    if (body.status === 'approved' && withdrawal.status === 'pending') {
      try {
        const seller = await prisma.user.findUnique({
          where: { id: withdrawal.user_id },
          select: { name: true },
        });

        console.log(`[SAQUE] Processando saque automático via SharkBanking ID: ${id}`);
        console.log(`[SAQUE] Valor: R$ ${withdrawal.amount}, Chave: ${withdrawal.pix_key}`);

        const { createSharkPixTransfer } = await import('../../providers/sharkbanking/shark.pix');
        const pixResult = await createSharkPixTransfer({
          value: Number(withdrawal.amount),
          pixKey: withdrawal.pix_key!,
          pixKeyType: withdrawal.pix_key_type || 'cpf',
          description: `Saque ZucroPay - ${seller?.name || 'Usuario'}`,
        });

        if (!pixResult.success) {
          console.error(`[SAQUE] Erro ao enviar PIX:`, pixResult.error);
          
          // Log do erro
          await prisma.adminLog.create({
            data: {
              admin_id: currentUser.id,
              action: 'withdrawal_pix_error',
              target_type: 'withdrawal',
              target_id: id,
              details: { error: pixResult.error, debug: pixResult.debug },
            },
          });

          return reply.status(400).send({ 
            success: false, 
            error: `Erro ao enviar PIX: ${pixResult.error}`,
            debug: pixResult.debug,
          });
        }

        console.log(`[SAQUE] PIX enviado com sucesso! E2E: ${pixResult.endToEndId}`);

        // Atualizar saque como completed (já foi pago)
        const updated = await prisma.withdrawal.update({
          where: { id },
          data: {
            status: 'completed',
            reviewed_by: currentUser.id,
            reviewed_at: new Date(),
            completed_at: new Date(),
            // Salvar dados da transação PIX no campo admin_notes
            admin_notes: `PIX enviado automaticamente via SharkBanking. E2E: ${pixResult.endToEndId || pixResult.transferId}`,
          },
        });

        // Log da ação
        await prisma.adminLog.create({
          data: {
            admin_id: currentUser.id,
            action: 'approved_withdrawal_auto_pix',
            target_type: 'withdrawal',
            target_id: id,
            details: {
              endToEndId: pixResult.endToEndId,
              transferId: pixResult.transferId,
              status: pixResult.status,
            },
          },
        });

        return reply.send({ 
          success: true, 
          message: 'Saque aprovado e PIX enviado automaticamente!',
          withdrawal: updated,
          pix: {
            endToEndId: pixResult.endToEndId,
            status: pixResult.status,
          },
        });

      } catch (error: any) {
        console.error(`[SAQUE] Erro crítico ao processar saque:`, error);
        
        return reply.status(500).send({ 
          success: false, 
          error: `Erro ao processar saque: ${error.message}`,
        });
      }
    }

    // Para outros status (rejected, completed manual)
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

  // Obter taxas customizadas do usuário
  app.get('/users/:id/rates', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const rates = await prisma.userCustomRate.findUnique({
      where: { user_id: id },
    });

    return reply.send({ 
      success: true, 
      rates: rates || null,
    });
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

  // ============================================
  // ADQUIRENTE/PROVEDOR DE PAGAMENTO POR USUÁRIO
  // ============================================

  // Alterar provedor de pagamento do usuário (efibank ou asaas)
  app.post('/users/:id/payment-provider', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { provider: 'efibank' | 'asaas' };

    if (!['efibank', 'asaas'].includes(body.provider)) {
      return reply.status(400).send({
        success: false,
        error: 'Provedor inválido. Use "efibank" ou "asaas".',
      });
    }

    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          payment_provider: body.provider,
          updated_at: new Date(),
        },
      });

      // Log da ação
      await prisma.adminLog.create({
        data: {
          admin_id: currentUser.id,
          action: 'change_payment_provider',
          target_type: 'user',
          target_id: id,
          details: { provider: body.provider },
        },
      });

      return reply.send({
        success: true,
        message: `Provedor alterado para ${body.provider.toUpperCase()}`,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          payment_provider: user.payment_provider,
        },
      });
    } catch (error: any) {
      console.error('Erro ao alterar provedor:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao alterar provedor de pagamento',
      });
    }
  });

  // Obter provedor de pagamento do usuário
  app.get('/users/:id/payment-provider', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          payment_provider: true,
          asaas_customer_id: true,
          efi_customer_id: true,
        },
      });

      if (!user) {
        return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
      }

      return reply.send({
        success: true,
        provider: user.payment_provider || 'efibank',
        user,
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
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
      select: {
        id: true,
        user_id: true,
        document_type: true,
        document_front_url: true,
        document_back_url: true,
        selfie_url: true,
        full_name: true,
        birth_date: true,
        document_number: true,
        status: true,
        reviewed_at: true,
        reviewed_by: true,
        rejection_reason: true,
        admin_notes: true,
        created_at: true,
        user: {
          select: { 
            id: true, 
            name: true, 
            email: true,
            cpf_cnpj: true,
            phone: true,
          },
        },
      },
    });

    // Formatar as datas e URLs para o frontend
    const formattedVerifications = verifications.map((v) => ({
      ...v,
      birth_date: v.birth_date ? new Date(v.birth_date).toLocaleDateString('pt-BR') : null,
      // Se document_number não foi preenchido, usar cpf_cnpj do usuário
      document_number: v.document_number || v.user?.cpf_cnpj || null,
      // Se full_name não foi preenchido, usar name do usuário
      full_name: v.full_name || v.user?.name || null,
    }));

    return reply.send({ success: true, verifications: formattedVerifications });
  });

  // Buscar verificação de um usuário específico pelo user_id
  app.get('/verifications/user/:userId', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const { userId } = request.params as { userId: string };

    const verification = await prisma.userVerification.findFirst({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        user_id: true,
        document_type: true,
        document_front_url: true,
        document_back_url: true,
        selfie_url: true,
        full_name: true,
        birth_date: true,
        document_number: true,
        status: true,
        reviewed_at: true,
        reviewed_by: true,
        rejection_reason: true,
        admin_notes: true,
        created_at: true,
        user: {
          select: { 
            id: true, 
            name: true, 
            email: true,
            cpf_cnpj: true,
            phone: true,
          },
        },
      },
    });

    if (!verification) {
      return reply.status(404).send({ success: false, error: 'Nenhum documento de verificação encontrado para este usuário' });
    }

    const formattedVerification = {
      ...verification,
      birth_date: verification.birth_date ? new Date(verification.birth_date).toLocaleDateString('pt-BR') : null,
      document_number: verification.document_number || verification.user?.cpf_cnpj || null,
      full_name: verification.full_name || verification.user?.name || null,
    };

    return reply.send({ success: true, verification: formattedVerification });
  });

  // Função auxiliar para processar aprovação/rejeição
  const processVerificationStatus = async (
    currentUser: any,
    verificationId: string,
    status: 'approved' | 'rejected',
    reason?: string
  ) => {
    const verification = await prisma.userVerification.update({
      where: { id: verificationId },
      data: {
        status: status,
        rejection_reason: reason,
        reviewed_by: currentUser.id,
        reviewed_at: new Date(),
      },
    });

    // Atualizar status do usuário
    // Se aprovado, também atualizar account_status para 'active'
    await prisma.user.update({
      where: { id: verification.user_id },
      data: {
        verification_status: status,
        verification_reviewed_at: new Date(),
        verification_reviewed_by: currentUser.id,
        verification_rejection_reason: reason,
        ...(status === 'approved' && { account_status: 'active', identity_verified: true }),
      },
    });

    // Log da ação
    await prisma.adminLog.create({
      data: {
        admin_id: currentUser.id,
        action: `${status}_verification`,
        target_type: 'verification',
        target_id: verificationId,
        details: { status, reason },
      },
    });

    return verification;
  };

  // Aprovar/Rejeitar verificação via status (ação sensível)
  app.post('/verifications/:id/status', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { status: 'approved' | 'rejected'; reason?: string };

    try {
      const verification = await processVerificationStatus(currentUser, id, body.status, body.reason);
      return reply.send({ success: true, verification });
    } catch (error: any) {
      console.error('Erro ao atualizar verificação:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Aprovar verificação (endpoint direto)
  app.post('/verifications/:id/approve', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };

    try {
      const verification = await processVerificationStatus(currentUser, id, 'approved');
      return reply.send({ success: true, message: 'Verificação aprovada com sucesso', verification });
    } catch (error: any) {
      console.error('Erro ao aprovar verificação:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Rejeitar verificação (endpoint direto)
  app.post('/verifications/:id/reject', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: string };

    try {
      const verification = await processVerificationStatus(currentUser, id, 'rejected', body.reason || 'Documentos inválidos');
      return reply.send({ success: true, message: 'Verificação rejeitada', verification });
    } catch (error: any) {
      console.error('Erro ao rejeitar verificação:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
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
            installment_fee: 2.95,
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
          installment_fee: body.installment_fee ?? 3.69,
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

  // ============================================
  // PRODUTOS (ADMIN)
  // ============================================

  // Listar todos os produtos
  app.get('/products', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const products = await prisma.product.findMany({
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return reply.send({ success: true, products });
    } catch (error: any) {
      console.error('Erro ao listar produtos:', error);
      return reply.send({ success: true, products: [] });
    }
  });

  // Deletar produto (admin pode deletar qualquer produto)
  app.delete('/products/:id', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };

    try {
      const product = await prisma.product.findUnique({
        where: { id },
        include: { user: { select: { name: true, email: true } } },
      });

      if (!product) {
        return reply.status(404).send({ success: false, error: 'Produto não encontrado' });
      }

      await prisma.product.delete({
        where: { id },
      });

      // Log da ação
      await prisma.adminLog.create({
        data: {
          admin_id: currentUser.id,
          action: 'delete_product',
          target_type: 'product',
          target_id: id,
          details: {
            product_name: product.name,
            user_name: product.user?.name,
            user_email: product.user?.email,
          },
        },
      });

      return reply.send({
        success: true,
        message: `Produto "${product.name}" deletado com sucesso`,
      });
    } catch (error: any) {
      console.error('Erro ao deletar produto:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao deletar produto',
      });
    }
  });

  // ============================================
  // GERENTES (SUB-ADMINS)
  // ============================================

  // Listar gerentes
  app.get('/managers', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      // Buscar na tabela admin_credentials
      const managers = await prisma.adminCredential.findMany({
        where: {
          is_active: true,
        },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          permissions: true,
          created_at: true,
          last_login: true,
        },
      });

      return reply.send({
        success: true,
        managers,
      });
    } catch (error: any) {
      console.error('Erro ao listar gerentes:', error);
      return reply.send({ success: true, managers: [] });
    }
  });

  // Criar gerente
  app.post('/managers', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const body = request.body as {
      email: string;
      name: string;
      password: string;
      permissions?: string[];
    };

    try {
      // Verificar se email já existe na tabela admin_credentials
      const existingAdmin = await prisma.adminCredential.findUnique({
        where: { email: body.email.toLowerCase() },
      });

      if (existingAdmin) {
        // Atualizar para gerente se não for admin principal
        if (existingAdmin.role === 'admin') {
          return reply.status(400).send({
            success: false,
            error: 'Este usuário já é um administrador',
          });
        }

        const updated = await prisma.adminCredential.update({
          where: { id: existingAdmin.id },
          data: {
            is_active: true,
            permissions: body.permissions || [],
          },
        });

        return reply.send({
          success: true,
          message: 'Gerente reativado com sucesso',
          manager: { id: updated.id, email: updated.email, name: updated.name },
        });
      }

      // Criar novo gerente na tabela admin_credentials
      const bcrypt = await import('bcryptjs');
      const hashedPassword = await bcrypt.hash(body.password, 10);

      const newManager = await prisma.adminCredential.create({
        data: {
          name: body.name,
          email: body.email.toLowerCase(),
          password_hash: hashedPassword,
          role: 'gerente',
          is_active: true,
          permissions: body.permissions || [],
        },
      });

      return reply.status(201).send({
        success: true,
        message: 'Gerente criado com sucesso',
        manager: { id: newManager.id, email: newManager.email, name: newManager.name },
      });
    } catch (error: any) {
      console.error('Erro ao criar gerente:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao criar gerente',
      });
    }
  });

  // Remover gerente (desativar)
  app.delete('/managers/:id', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Verificar se o gerente existe
      const manager = await prisma.adminCredential.findUnique({
        where: { id },
      });

      if (!manager) {
        return reply.status(404).send({ success: false, error: 'Gerente não encontrado' });
      }

      // Não permitir remover o admin principal
      if (manager.role === 'admin') {
        return reply.status(400).send({ success: false, error: 'Não é possível remover o administrador principal' });
      }

      // Desativar o gerente
      await prisma.adminCredential.update({
        where: { id },
        data: { is_active: false },
      });

      return reply.send({
        success: true,
        message: 'Gerente removido com sucesso',
      });
    } catch (error: any) {
      console.error('Erro ao remover gerente:', error);
      return reply.status(500).send({
        success: false,
        error: error.message || 'Erro ao remover gerente',
      });
    }
  });

  // ============================================
  // CHARGEBACKS
  // ============================================

  // Listar chargebacks
  app.get('/chargebacks', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const query = request.query as { status?: string; userId?: string };
      
      const chargebacks = await prisma.chargeback.findMany({
        where: {
          ...(query.status && { status: query.status }),
          ...(query.userId && { user_id: query.userId }),
        },
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, is_risky: true, chargeback_count: true },
          },
          payment: {
            select: { id: true, value: true, billing_type: true, status: true, description: true },
          },
        },
      });

      return reply.send({ success: true, chargebacks });
    } catch (error: any) {
      console.error('Erro ao listar chargebacks:', error);
      return reply.send({ success: true, chargebacks: [] });
    }
  });

  // Criar chargeback
  app.post('/chargebacks', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const body = request.body as {
      payment_id: string;
      reason?: string;
      amount?: number;
    };

    try {
      // Buscar o pagamento
      const payment = await prisma.payment.findUnique({
        where: { id: body.payment_id },
        include: { user: true },
      });

      if (!payment) {
        return reply.status(404).send({ success: false, error: 'Pagamento não encontrado' });
      }

      // Criar chargeback
      const chargeback = await prisma.chargeback.create({
        data: {
          payment_id: body.payment_id,
          user_id: payment.user_id,
          amount: body.amount || payment.value,
          reason: body.reason,
          status: 'open',
        },
      });

      // Incrementar contador de chargebacks do usuário
      await prisma.user.update({
        where: { id: payment.user_id },
        data: {
          chargeback_count: { increment: 1 },
          // Se tiver 3+ chargebacks, marcar como risky
          is_risky: payment.user.chargeback_count >= 2,
          risk_level: payment.user.chargeback_count >= 2 ? 'high' : payment.user.chargeback_count >= 1 ? 'medium' : 'low',
        },
      });

      // Log
      await prisma.adminLog.create({
        data: {
          admin_id: currentUser.id,
          action: 'create_chargeback',
          target_type: 'chargeback',
          target_id: chargeback.id,
          details: { payment_id: body.payment_id, reason: body.reason },
        },
      });

      return reply.send({
        success: true,
        message: 'Chargeback registrado',
        chargeback,
      });
    } catch (error: any) {
      console.error('Erro ao criar chargeback:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // Atualizar status do chargeback
  app.put('/chargebacks/:id', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { status: 'won' | 'lost' | 'cancelled'; admin_notes?: string };

    try {
      const chargeback = await prisma.chargeback.update({
        where: { id },
        data: {
          status: body.status,
          admin_notes: body.admin_notes,
          resolved_at: new Date(),
          resolved_by: currentUser.id,
        },
      });

      // Se perdeu o chargeback, debitar do saldo do vendedor
      if (body.status === 'lost') {
        await prisma.user.update({
          where: { id: chargeback.user_id },
          data: {
            balance: { decrement: chargeback.amount },
          },
        });
      }

      return reply.send({ success: true, chargeback });
    } catch (error: any) {
      console.error('Erro ao atualizar chargeback:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // ============================================
  // SELLERS DE RISCO
  // ============================================

  // Listar sellers de risco
  app.get('/risky-sellers', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    try {
      const riskySellers = await prisma.user.findMany({
        where: {
          OR: [
            { is_risky: true },
            { chargeback_count: { gte: 1 } },
            { refund_count: { gte: 3 } },
          ],
        },
        orderBy: { chargeback_count: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          cpf_cnpj: true,
          account_status: true,
          is_risky: true,
          risk_level: true,
          risk_notes: true,
          chargeback_count: true,
          refund_count: true,
          balance: true,
          blocked_at: true,
          blocked_reason: true,
          created_at: true,
        },
      });

      // Buscar estatísticas de chargebacks por seller
      const sellersWithStats = await Promise.all(
        riskySellers.map(async (seller) => {
          const chargebacksTotal = await prisma.chargeback.aggregate({
            where: { user_id: seller.id },
            _sum: { amount: true },
            _count: true,
          });

          return {
            ...seller,
            chargebacksValue: Number(chargebacksTotal._sum?.amount || 0),
            chargebacksCount: chargebacksTotal._count,
          };
        })
      );

      return reply.send({ success: true, sellers: sellersWithStats });
    } catch (error: any) {
      console.error('Erro ao listar sellers de risco:', error);
      return reply.send({ success: true, sellers: [] });
    }
  });

  // Marcar/Desmarcar seller como de risco
  app.post('/users/:id/risk-status', {
    preHandler: [sensitiveActionRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const currentUser = request.currentUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { 
      is_risky: boolean; 
      risk_level?: string; 
      risk_notes?: string;
      block?: boolean;
      blocked_reason?: string;
    };

    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          is_risky: body.is_risky,
          risk_level: body.risk_level || (body.is_risky ? 'high' : 'low'),
          risk_notes: body.risk_notes,
          ...(body.block && {
            account_status: 'blocked',
            blocked_at: new Date(),
            blocked_by: currentUser.id,
            blocked_reason: body.blocked_reason || 'Marcado como seller de risco',
          }),
          ...(!body.block && body.is_risky === false && {
            account_status: 'approved',
            blocked_at: null,
            blocked_by: null,
            blocked_reason: null,
          }),
        },
      });

      // Log da ação
      await prisma.riskySellerLog.create({
        data: {
          user_id: id,
          action: body.is_risky ? 'marked_risky' : 'unmarked_risky',
          reason: body.risk_notes || body.blocked_reason,
          chargebacks: user.chargeback_count,
          refunds: user.refund_count,
          marked_by: currentUser.id,
        },
      });

      await prisma.adminLog.create({
        data: {
          admin_id: currentUser.id,
          action: body.is_risky ? 'mark_risky_seller' : 'unmark_risky_seller',
          target_type: 'user',
          target_id: id,
          details: body,
        },
      });

      return reply.send({
        success: true,
        message: body.is_risky ? 'Seller marcado como de risco' : 'Seller removido da lista de risco',
        user,
      });
    } catch (error: any) {
      console.error('Erro ao atualizar status de risco:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // ========================================
  // SALES / VENDAS
  // ========================================
  app.get('/sales', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      startDate?: string;
      endDate?: string;
      limit?: string;
      userId?: string;
    };

    try {
      const where: any = {};
      
      if (query.status) {
        where.status = query.status;
      }
      if (query.userId) {
        where.user_id = query.userId;
      }
      if (query.startDate) {
        where.created_at = { ...where.created_at, gte: new Date(query.startDate) };
      }
      if (query.endDate) {
        where.created_at = { ...where.created_at, lte: new Date(query.endDate) };
      }

      const sales = await prisma.payment.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: parseInt(query.limit || '100'),
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      return reply.send({
        success: true,
        sales: sales.map((s: any) => ({
          id: s.id,
          amount: Number(s.value),
          net_value: Number(s.net_value),
          fee: Number(s.fee),
          billing_type: s.billing_type,
          status: s.status,
          created_at: s.created_at,
          user: s.user,
          // Dados do cliente do metadata
          customer_name: s.metadata?.customer_name,
          customer_email: s.metadata?.customer_email,
          customer_document: s.metadata?.customer_document,
          customer_phone: s.metadata?.customer_phone,
          ip_address: s.metadata?.customer_ip,
          user_agent: s.metadata?.user_agent,
          // IDs do gateway
          asaas_payment_id: s.asaas_payment_id,
          efi_charge_id: s.efi_charge_id,
          efi_txid: s.efi_txid,
          // Descrição
          description: s.description,
        })),
      });
    } catch (error: any) {
      console.error('Erro ao buscar vendas:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // ========================================
  // WEBHOOK LOGS
  // ========================================
  app.get('/webhook-logs', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as {
      eventType?: string;
      processed?: string;
      limit?: string;
    };

    try {
      const where: any = {};
      
      if (query.eventType) {
        where.event_type = query.eventType;
      }
      if (query.processed !== undefined) {
        where.processed = query.processed === 'true';
      }

      // Try to get webhook logs from the database
      let logs: any[] = [];
      try {
        logs = await prisma.webhookLog.findMany({
          where,
          orderBy: { created_at: 'desc' },
          take: parseInt(query.limit || '50'),
        });
      } catch (e) {
        // Table might not exist
        console.log('webhookLog table might not exist:', e);
      }

      return reply.send({
        success: true,
        logs,
      });
    } catch (error: any) {
      console.error('Erro ao buscar webhook logs:', error);
      return reply.send({ success: true, logs: [] });
    }
  });

  // ========================================
  // ADMIN LOGS
  // ========================================
  app.get('/logs', {
    preHandler: [standardRateLimit, authenticateAdmin],
  }, async (request, reply) => {
    const query = request.query as {
      action?: string;
      targetType?: string;
      limit?: string;
    };

    try {
      const where: any = {};
      
      if (query.action) {
        where.action = query.action;
      }
      if (query.targetType) {
        where.target_type = query.targetType;
      }

      const logs = await prisma.adminLog.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: parseInt(query.limit || '50'),
      });

      // Get admin names for logs
      const adminIds = [...new Set(logs.map((l: any) => l.admin_id).filter(Boolean))];
      const admins = adminIds.length > 0 ? await prisma.user.findMany({
        where: { id: { in: adminIds } },
        select: { id: true, name: true, email: true },
      }) : [];
      const adminMap = Object.fromEntries(admins.map(a => [a.id, a]));

      return reply.send({
        success: true,
        logs: logs.map((l: any) => ({
          ...l,
          admin: l.admin_id ? adminMap[l.admin_id] || null : null,
        })),
      });
    } catch (error: any) {
      console.error('Erro ao buscar admin logs:', error);
      return reply.send({ success: true, logs: [] });
    }
  });
}

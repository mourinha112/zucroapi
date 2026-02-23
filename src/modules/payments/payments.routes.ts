import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { createPixCharge } from '../../providers/efibank/efi.pix';
import { createCardCharge, payWithCardToken } from '../../providers/efibank/efi.card';
import { createAsaasPixCharge, createAsaasCustomer } from '../../providers/asaas/asaas.pix';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  calculateCardFeeSellerPays,
  calculateCardFeeBuyerPays,
  calculateReleaseDate,
  calculateTotalForBuyer,
} from '../../providers/efibank/fee.calculator';
import { 
  authenticate, 
  standardRateLimit, 
  checkoutRateLimit, 
  createResourceRateLimit 
} from '../../middlewares';

export async function paymentsRoutes(app: FastifyInstance) {
  // Listar pagamentos do usuário
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const query = request.query as { status?: string; limit?: string; offset?: string };

    const payments = await prisma.payment.findMany({
      where: {
        user_id: decoded.id,
        ...(query.status && { status: query.status }),
      },
      orderBy: { created_at: 'desc' },
      take: parseInt(query.limit || '50'),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({ success: true, payments });
  });

  // Obter pagamento por ID
  app.get('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const payment = await prisma.payment.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!payment) {
      return reply.status(404).send({ error: 'Pagamento não encontrado' });
    }

    return reply.send({ success: true, payment });
  });

  // Listar links de pagamento
  app.get('/links', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const links = await prisma.paymentLink.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
      include: { product: true },
    });

    return reply.send({ success: true, links });
  });

  // Criar link de pagamento
  app.post('/links', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = request.body as {
      name: string;
      description?: string;
      amount: number;
      product_id?: string;
      billing_type?: string;
    };

    const link = await prisma.paymentLink.create({
      data: {
        user_id: decoded.id,
        product_id: body.product_id,
        name: body.name,
        description: body.description,
        amount: body.amount,
        billing_type: body.billing_type || 'UNDEFINED',
        asaas_payment_link_id: `efi_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
        asaas_link_url: '', // Será preenchido depois
      },
    });

    // Gerar URL do checkout
    const checkoutUrl = `https://dashboard.appzucropay.com/checkout/${link.id}`;
    
    await prisma.paymentLink.update({
      where: { id: link.id },
      data: { asaas_link_url: checkoutUrl },
    });

    return reply.status(201).send({
      success: true,
      link: { ...link, asaas_link_url: checkoutUrl },
    });
  });

  // Obter transações
  app.get('/transactions', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const query = request.query as { limit?: string; offset?: string };

    const transactions = await prisma.transaction.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
      take: parseInt(query.limit || '50'),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({ success: true, transactions });
  });

  // ========== CHECKOUT PÚBLICO (não requer auth, com rate limit) ==========
  app.post('/checkout', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    try {
      const body = request.body as {
        linkId: string;
        billingType: 'PIX' | 'CREDIT_CARD';
        customerName: string;
        customerEmail: string;
        customerCpfCnpj?: string;
        customerPhone?: string;
        cardPaymentToken?: string;
        cardInstallments?: number;
        billingAddress?: any;
        totalValue?: number;
      };

      // Buscar link de pagamento
      const link = await prisma.paymentLink.findFirst({
        where: { id: body.linkId, active: true },
        include: { product: true, user: true },
      });

      if (!link) {
        return reply.status(404).send({ success: false, message: 'Link de pagamento não encontrado', error: 'Link de pagamento não encontrado' });
      }

      // Buscar taxas personalizadas do vendedor
      const customRates = await prisma.userCustomRate.findUnique({
        where: { user_id: link.user_id },
      });

      const rates = await getEffectiveRates(customRates ? {
        pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
        boleto_rate: customRates.boleto_rate ? Number(customRates.boleto_rate) : undefined,
      } : null);

      // Determinar quem paga os juros (somente juros de parcelamento, não taxa da plataforma)
      const feePayer = (link.product as any)?.fee_payer || 'seller';
      const baseValue = Number(link.amount);
      const description = link.product?.name || link.name || 'Pagamento ZucroPay';
      const installments = body.cardInstallments || 1;

      // Calcular valor que o cliente paga
      // PIX: sempre valor base (não tem juros)
      // Cartão: valor base + juros de parcelamento (se comprador paga)
      const grossValue = calculateTotalForBuyer(
        baseValue,
        body.billingType as 'PIX' | 'CREDIT_CARD' | 'BOLETO',
        installments,
        feePayer,
        rates
      );

      let payment: any;

      // ========== PIX ==========
      if (body.billingType === 'PIX') {
        // Verificar qual provedor usar baseado no payment_provider do vendedor
        const paymentProvider = (link.user as any).payment_provider || 'efibank';
        console.log(`[CHECKOUT PIX] Provedor configurado: ${paymentProvider}, vendedor: ${link.user.name} (${link.user_id})`);

        let pixCode = '';
        let pixQrCode = '';
        let paymentId = '';

        if (paymentProvider === 'asaas') {
          // ========== ASAAS PIX ==========
          console.log(`[CHECKOUT PIX] Usando ASAAS para vendedor ${link.user.name}`);

          // Asaas exige CPF/CNPJ do comprador
          if (!body.customerCpfCnpj) {
            return reply.send({ 
              success: false, 
              message: 'CPF/CNPJ é obrigatório para este vendedor. Por favor, preencha o campo.',
              error: 'CPF/CNPJ obrigatório',
            });
          }

          // Criar/buscar cliente no Asaas
          const customerResult = await createAsaasCustomer({
            name: body.customerName,
            cpfCnpj: body.customerCpfCnpj,
            email: body.customerEmail,
            phone: body.customerPhone,
          });

          if (!customerResult.success || !customerResult.customerId) {
            const errorMsg = customerResult.error || 'Erro ao registrar cliente no gateway';
            console.error(`[CHECKOUT PIX] Asaas - erro no cliente: ${errorMsg}`, customerResult.debug);
            return reply.send({ success: false, message: errorMsg, error: errorMsg });
          }

          console.log(`[CHECKOUT PIX] Asaas - cliente: ${customerResult.customerId}`);

          // Criar cobrança PIX no Asaas
          const asaasResult = await createAsaasPixCharge({
            value: baseValue,
            description,
            customerAsaasId: customerResult.customerId,
          });

          if (!asaasResult.success) {
            const errorMsg = asaasResult.error || 'Erro ao gerar cobrança PIX';
            console.error(`[CHECKOUT PIX] Asaas - erro na cobrança: ${errorMsg}`, asaasResult.debug);
            return reply.send({ success: false, message: errorMsg, error: errorMsg });
          }

          pixCode = asaasResult.pixCode || '';
          pixQrCode = asaasResult.pixQrCode || '';
          paymentId = asaasResult.paymentId || asaasResult.externalReference || '';
          console.log(`[CHECKOUT PIX] Asaas OK - paymentId: ${paymentId}, temQR: ${!!pixQrCode}, temCopia: ${!!pixCode}`);

        } else {
          // ========== EFIBANK PIX ==========
          console.log(`[CHECKOUT PIX] Usando EFIBANK para vendedor ${link.user.name}`);

          const pixResult = await createPixCharge({
            value: baseValue,
            description,
            customerCpf: body.customerCpfCnpj,
            customerName: body.customerName,
          });

          if (!pixResult.success) {
            const errorMsg = pixResult.error || 'Erro ao gerar cobrança PIX';
            console.error(`[CHECKOUT PIX] EfiBank falhou: ${errorMsg}`, pixResult.debug);
            return reply.send({ success: false, message: errorMsg, error: errorMsg });
          }

          pixCode = pixResult.pixCode || '';
          pixQrCode = pixResult.pixQrCode || '';
          paymentId = pixResult.txid || '';
          console.log(`[CHECKOUT PIX] EfiBank OK - txid: ${paymentId}`);
        }

        // Verificação final
        if (!pixCode) {
          return reply.send({ success: false, message: 'Não foi possível gerar o código PIX. Tente novamente.', error: 'PIX vazio' });
        }

        // Calcular taxas (PIX não tem parcelamento, taxa sempre do vendedor)
        const feeCalc = calculatePixFeeSellerPays(baseValue, rates);

        // Salvar pagamento
        const savedPayment = await prisma.payment.create({
          data: {
            user_id: link.user_id,
            billing_type: 'PIX',
            value: baseValue,
            net_value: feeCalc.netValue,
            status: 'PENDING',
            description,
            due_date: new Date(),
            efi_txid: paymentProvider === 'efibank' ? paymentId : null,
            asaas_payment_id: paymentProvider === 'asaas' ? paymentId : paymentId, // Compatibilidade
            pix_qrcode: pixQrCode,
            pix_copy_paste: pixCode,
            payment_link_id: link.id,
            metadata: JSON.parse(JSON.stringify({
              base_value: baseValue,
              platform_fee: feeCalc.platformFee,
              reserve_amount: feeCalc.reserveAmount,
              fee_payer: feePayer,
              seller_rates: rates,
              payment_provider: paymentProvider,
            })),
          },
        });

        // Atualizar contador do link
        await prisma.paymentLink.update({
          where: { id: link.id },
          data: { payments_count: { increment: 1 } },
        });

        payment = {
          id: savedPayment.id,
          txid: paymentId,
          status: 'PENDING',
          pixCode,
          pixQrCode,
        };
      }

      // ========== CARTÃO ==========
      else if (body.billingType === 'CREDIT_CARD') {
        // Criar cobrança com valor que inclui juros se comprador paga
        const chargeResult = await createCardCharge({ value: grossValue, description });

        if (!chargeResult.success) {
          const errorMsg = chargeResult.error || 'Erro ao criar cobrança de cartão';
          return reply.send({ success: false, message: errorMsg, error: errorMsg });
        }

        // Pagar com token
        if (body.cardPaymentToken) {
          const payResult = await payWithCardToken(chargeResult.chargeId!, {
            value: grossValue,
            description,
            installments,
            paymentToken: body.cardPaymentToken,
            customer: {
              name: body.customerName,
              email: body.customerEmail,
              cpf: body.customerCpfCnpj || '',
              phone: body.customerPhone,
            },
            billingAddress: body.billingAddress,
          });

          if (!payResult.success) {
            return reply.send({
              success: false,
              message: payResult.error || 'Erro ao processar pagamento com cartão',
              error: payResult.error,
              cardRefused: payResult.cardRefused,
              canRetry: payResult.canRetry,
            });
          }

          // Calcular taxas
          // Se comprador paga, ele paga apenas juros de parcelamento, taxa da plataforma é do vendedor
          const feeCalc = feePayer === 'buyer'
            ? calculateCardFeeBuyerPays(baseValue, installments, rates)
            : calculateCardFeeSellerPays(baseValue, installments, rates);

          const status = payResult.status === 'RECEIVED' ? 'RECEIVED' : 'PENDING';

          // Salvar pagamento
          const savedPayment = await prisma.payment.create({
            data: {
              user_id: link.user_id,
              billing_type: 'CREDIT_CARD',
              value: grossValue, // Valor que o cliente pagou (inclui juros se buyer paga)
              net_value: feeCalc.netValue,
              status,
              description,
              due_date: new Date(),
              payment_date: status === 'RECEIVED' ? new Date() : null,
              efi_charge_id: chargeResult.chargeId!.toString(),
              payment_link_id: link.id,
              asaas_payment_id: chargeResult.chargeId!.toString(),
              metadata: JSON.parse(JSON.stringify({
                base_value: baseValue,
                gross_value: grossValue,
                platform_fee: feeCalc.platformFee,
                installment_fee: feeCalc.installmentFee,
                reserve_amount: feeCalc.reserveAmount,
                installments,
                fee_payer: feePayer,
                seller_rates: rates,
              })),
            },
          });

          // Se aprovado, atualizar saldo
          if (status === 'RECEIVED') {
            // Atualizar saldo do usuário
            await prisma.user.update({
              where: { id: link.user_id },
              data: {
                balance: { increment: feeCalc.netValue },
                reserved_balance: { increment: feeCalc.reserveAmount },
              },
            });

            // Criar reserva
            await prisma.balanceReserve.create({
              data: {
                user_id: link.user_id,
                payment_id: savedPayment.id,
                original_amount: baseValue,
                reserve_amount: feeCalc.reserveAmount,
                status: 'held',
                release_date: calculateReleaseDate(rates.reserve_days),
                description: `Reserva 5% - ${description}`,
              },
            });

            // Criar transação
            await prisma.transaction.create({
              data: {
                user_id: link.user_id,
                type: 'payment_received',
                amount: grossValue, // Valor bruto recebido
                status: 'completed',
                description: `Venda com cartão ${installments}x - ${description}`,
                efi_charge_id: chargeResult.chargeId!.toString(),
                metadata: feeCalc as any,
              },
            });
          }

          // Atualizar link
          await prisma.paymentLink.update({
            where: { id: link.id },
            data: {
              payments_count: { increment: 1 },
              total_received: status === 'RECEIVED' ? { increment: grossValue } : undefined,
            },
          });

          payment = {
            id: savedPayment.id,
            chargeId: chargeResult.chargeId,
            status,
            installments,
          };
        } else {
          return reply.send({ success: false, message: 'Token do cartão é obrigatório', error: 'Token do cartão é obrigatório' });
        }
      }

      return reply.send({ success: true, payment });
    } catch (error: any) {
      console.error('[CHECKOUT] Erro:', error);
      return reply.status(500).send({ success: false, message: error.message || 'Erro interno ao processar pagamento', error: error.message });
    }
  });

  // Obter dados do link para checkout (público, com rate limit)
  app.get('/checkout/:linkId', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const { linkId } = request.params as { linkId: string };

    const link = await prisma.paymentLink.findFirst({
      where: { id: linkId, active: true },
      include: { product: true },
    });

    if (!link) {
      return reply.status(404).send({ success: false, error: 'Link não encontrado' });
    }

    // Incrementar cliques
    await prisma.paymentLink.update({
      where: { id: linkId },
      data: { clicks: { increment: 1 } },
    });

    // Buscar taxas do vendedor para calcular valor pro comprador
    const customRates = await prisma.userCustomRate.findUnique({
      where: { user_id: link.user_id },
    });

    const rates = await getEffectiveRates(customRates ? {
      pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
      card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
    } : null);

    // Buscar orderbumps do produto (se existir produto vinculado)
    let orderBumps: any[] = [];
    let subscriptionPlan = null;
    if (link.product_id) {
      orderBumps = await prisma.orderBump.findMany({
        where: {
          product_id: link.product_id,
          show_in_checkout: true,
          active: true,
        },
        include: {
          bump_product: {
            select: {
              id: true,
              name: true,
              description: true,
              price: true,
              image_url: true,
            },
          },
        },
        orderBy: { position: 'asc' },
      });

      // Buscar plano de assinatura se o produto for uma assinatura
      const product = link.product as any;
      if (product?.is_subscription) {
        subscriptionPlan = await prisma.subscriptionPlan.findFirst({
          where: { 
            user_id: link.user_id,
            active: true,
          },
          orderBy: { created_at: 'asc' },
        });
      }
    }

    const baseValue = Number(link.amount);
    const feePayer = (link.product as any)?.fee_payer || 'seller';

    // Calcular valores para cada opção de pagamento
    const installmentOptions = [];
    for (let i = 1; i <= 12; i++) {
      const total = calculateTotalForBuyer(baseValue, 'CREDIT_CARD', i, feePayer, rates);
      const installmentValue = total / i;
      const fee = total - baseValue;
      installmentOptions.push({
        installments: i,
        total: Math.round(total * 100) / 100,
        installmentValue: Math.round(installmentValue * 100) / 100,
        fee: Math.round(fee * 100) / 100,
        label: i === 1 
          ? `À vista - R$ ${baseValue.toFixed(2)}` 
          : `${i}x de R$ ${installmentValue.toFixed(2)} (Total: R$ ${total.toFixed(2)})`,
      });
    }

    return reply.send({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        description: link.description,
        amount: baseValue,
        product: link.product,
        feePayer,
      },
      rates: {
        pix: rates.pix_rate,
        card: rates.card_rate,
        fixed: rates.fixed_fee,
        installment: rates.installment_fee,
      },
      // OrderBumps disponíveis para este checkout
      orderBumps: orderBumps.map(ob => ({
        id: ob.id,
        name: ob.name,
        description: ob.description,
        price: Number(ob.price),
        originalPrice: ob.original_price ? Number(ob.original_price) : null,
        discountType: ob.discount_type,
        discountValue: Number(ob.discount_value),
        showImage: ob.show_image,
        position: ob.position,
        product: ob.bump_product,
      })),
      // Info de assinatura (se aplicável)
      subscription: subscriptionPlan ? {
        id: subscriptionPlan.id,
        name: subscriptionPlan.name,
        description: subscriptionPlan.description,
        interval: subscriptionPlan.interval,
        intervalCount: subscriptionPlan.interval_count,
        price: Number(subscriptionPlan.price),
        trialDays: subscriptionPlan.trial_days,
        maxInstallments: subscriptionPlan.max_installments,
      } : null,
      // Valores calculados baseados em quem paga os juros
      paymentOptions: {
        pix: {
          total: baseValue, // PIX não tem juros
          feePayer,
        },
        card: {
          installments: installmentOptions,
          feePayer,
          note: feePayer === 'buyer' 
            ? 'Juros de parcelamento inclusos no valor das parcelas' 
            : 'Valor à vista em todas as parcelas (vendedor absorve juros)',
        },
      },
    });
  });
}

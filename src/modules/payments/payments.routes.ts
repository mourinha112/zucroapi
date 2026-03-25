import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { createSharkPixCharge } from '../../providers/sharkbanking/shark.pix';
import { createEnkiPixCharge } from '../../providers/enki/enki.pix';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  calculateReleaseDate,
  applyProviderRateOverrides,
} from '../../providers/efibank/fee.calculator';
import {
  authenticate,
  standardRateLimit,
  checkoutRateLimit,
  createResourceRateLimit
} from '../../middlewares';
import { notifySalePending } from '../push/push.service';

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
      take: Math.min(parseInt(query.limit || '500'), 1000),
      skip: parseInt(query.offset || '0'),
    });

    // Extrair dados do cliente do metadata
    const paymentsWithCustomer = payments.map(payment => {
      const metadata = payment.metadata as any;
      return {
        ...payment,
        customer_name: metadata?.customer_name || null,
        customer_email: metadata?.customer_email || null,
        customer_cpf: metadata?.customer_document || null,
      };
    });

    return reply.send({ success: true, payments: paymentsWithCustomer });
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

    // Extrair dados do cliente do metadata
    const metadata = payment.metadata as any;
    const paymentWithCustomer = {
      ...payment,
      customer_name: metadata?.customer_name || null,
      customer_email: metadata?.customer_email || null,
      customer_cpf: metadata?.customer_document || null,
    };

    return reply.send({ success: true, payment: paymentWithCustomer });
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

  // ========== Tokenizar cartão com Asaas ==========
  app.post('/tokenize-card', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const body = request.body as {
      provider: 'asaas' | 'efibank';
      cardNumber: string;
      holderName: string;
      expiryMonth: string;
      expiryYear: string;
      ccv: string;
    };

    try {
      if (body.provider === 'asaas') {
        const { createAsaasCardToken } = await import('../../providers/asaas/asaas.card');
        const result = await createAsaasCardToken({
          number: body.cardNumber,
          holderName: body.holderName,
          expiryMonth: body.expiryMonth,
          expiryYear: body.expiryYear,
          ccv: body.ccv,
        });
        
        return reply.send(result);
      } else {
        // EfiBank tokenization needs SDK on frontend
        return reply.send({ success: false, error: 'Use SDK EfiBank para tokenizar' });
      }
    } catch (error: any) {
      console.error('[Tokenize] Erro:', error);
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  // ========== CHECKOUT PÚBLICO (sem autenticação, com rate limit) ==========
  app.post('/checkout', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    try {
      const body = request.body as {
        linkId: string;
        billingType: 'PIX';
        customerName: string;
        customerEmail: string;
        customerCpfCnpj?: string;
        customerPhone?: string;
        couponCode?: string;
      };

      // Capturar IP do cliente
      const clientIp = request.headers['x-forwarded-for'] as string || request.ip || 'unknown';

      // Buscar link de pagamento
      const link = await prisma.paymentLink.findFirst({
        where: { id: body.linkId, active: true },
        include: { product: true, user: true },
      });

      console.log('[CHECKOUT] Link encontrado:', link?.id);
      console.log('[CHECKOUT] User do link:', link?.user?.name, '- payment_provider:', (link?.user as any)?.payment_provider);

      if (!link) {
        return reply.status(404).send({ 
          success: false, 
          message: 'Link de pagamento não encontrado', 
          error: 'Link de pagamento não encontrado' 
        });
      }

      // Taxas personalizadas do vendedor
      const customRates = await prisma.userCustomRate.findUnique({
        where: { user_id: link.user_id },
      });

      const rates = await getEffectiveRates(customRates ? {
        pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
        boleto_rate: customRates.boleto_rate ? Number(customRates.boleto_rate) : undefined,
      } : null);

      let baseValue = Number(link.amount);
      const originalValue = baseValue;
      const description = link.product?.name || link.name || 'Pagamento ZucroPay';
      let appliedCoupon: any = null;

      // Validar valor máximo
      if (baseValue > 1000) {
        return reply.status(400).send({
          success: false,
          message: 'O valor máximo por transação é R$ 1.000,00',
          error: 'Valor acima do limite permitido',
        });
      }

      // Aplicar cupom de desconto se informado
      if (body.couponCode) {
        const coupon = await prisma.coupon.findUnique({
          where: { user_id_code: { user_id: link.user_id, code: body.couponCode.toUpperCase().trim() } },
        });

        if (coupon && coupon.active) {
          const now = new Date();
          const isValid =
            (!coupon.starts_at || now >= coupon.starts_at) &&
            (!coupon.expires_at || now <= coupon.expires_at) &&
            (coupon.max_uses === null || coupon.used_count < coupon.max_uses) &&
            (!coupon.product_id || !link.product_id || coupon.product_id === link.product_id) &&
            (!coupon.min_value || baseValue >= Number(coupon.min_value));

          if (isValid) {
            let discountAmount: number;
            if (coupon.discount_type === 'percentage') {
              discountAmount = baseValue * (Number(coupon.discount_value) / 100);
              if (coupon.max_discount && discountAmount > Number(coupon.max_discount)) {
                discountAmount = Number(coupon.max_discount);
              }
            } else {
              discountAmount = Number(coupon.discount_value);
            }
            discountAmount = Math.min(discountAmount, baseValue);
            discountAmount = Math.round(discountAmount * 100) / 100;
            baseValue = Math.round((baseValue - discountAmount) * 100) / 100;

            // Incrementar uso do cupom
            await prisma.coupon.update({
              where: { id: coupon.id },
              data: { used_count: { increment: 1 }, updated_at: new Date() },
            });

            appliedCoupon = {
              id: coupon.id,
              code: coupon.code,
              discountType: coupon.discount_type,
              discountValue: Number(coupon.discount_value),
              discountAmount,
            };

            console.log(`[CHECKOUT] Cupom ${coupon.code} aplicado: -R$${discountAmount.toFixed(2)} (${originalValue} -> ${baseValue})`);
          }
        }
      }

      // Somente PIX
      if (body.billingType !== 'PIX') {
        return reply.status(400).send({
          success: false,
          message: 'Apenas pagamento via PIX está disponível.',
          error: 'Somente PIX disponível',
        });
      }

      // Determinar provider do seller (default: sharkbanking)
      const sellerProvider = (link.user as any)?.payment_provider || 'sharkbanking';
      console.log(`[CHECKOUT PIX] ${sellerProvider} - vendedor: ${link.user.name} (${link.user_id})`);

      let chargeResult: { success: boolean; transactionId?: string; pixCode?: string; pixQrCode?: string; error?: string; debug?: any };

      if (sellerProvider === 'enki') {
        chargeResult = await createEnkiPixCharge({
          value: baseValue,
          description,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          customerCpf: body.customerCpfCnpj,
          customerPhone: body.customerPhone,
          externalRef: `zp_${link.id}_${Date.now()}`,
        });
      } else {
        chargeResult = await createSharkPixCharge({
          value: baseValue,
          description,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          customerCpf: body.customerCpfCnpj,
          customerPhone: body.customerPhone,
          externalRef: `zp_${link.id}_${Date.now()}`,
        });
      }

      if (!chargeResult.success) {
        const errorMsg = chargeResult.error || 'Erro ao gerar cobrança PIX';
        console.error(`[CHECKOUT PIX] ${sellerProvider} falhou: ${errorMsg}`, chargeResult.debug);
        return reply.send({ success: false, message: errorMsg, error: errorMsg });
      }

      if (!chargeResult.pixCode) {
        return reply.send({
          success: false,
          message: 'Não foi possível gerar o código PIX. Tente novamente.',
          error: 'PIX vazio',
        });
      }

      // Aplicar taxas específicas do adquirente (Enki: 4.99% + R$2.50)
      const effectiveRates = applyProviderRateOverrides(rates, sellerProvider);
      const feeCalc = calculatePixFeeSellerPays(baseValue, effectiveRates);

      const savedPayment = await prisma.payment.create({
        data: {
          user_id: link.user_id,
          billing_type: 'PIX',
          value: baseValue,
          net_value: feeCalc.netValue,
          status: 'PENDING',
          description,
          due_date: new Date(),
          efi_txid: chargeResult.transactionId,
          pix_qrcode: chargeResult.pixQrCode,
          pix_copy_paste: chargeResult.pixCode,
          payment_link_id: link.id,
          metadata: JSON.parse(JSON.stringify({
            base_value: baseValue,
            platform_fee: feeCalc.platformFee,
            reserve_amount: feeCalc.reserveAmount,
            fee_payer: 'seller',
            seller_rates: rates,
            payment_provider: sellerProvider,
            ...(sellerProvider === 'enki'
              ? { enki_transaction_id: chargeResult.transactionId }
              : { shark_transaction_id: chargeResult.transactionId }),
            customer_ip: clientIp,
            customer_name: body.customerName,
            customer_email: body.customerEmail,
            customer_document: body.customerCpfCnpj,
            customer_phone: body.customerPhone,
            ...(appliedCoupon && {
              coupon_code: appliedCoupon.code,
              coupon_discount: appliedCoupon.discountAmount,
              original_value: originalValue,
            }),
          })),
        },
      });

      await prisma.paymentLink.update({
        where: { id: link.id },
        data: { payments_count: { increment: 1 } },
      });

      // Notificação push de venda pendente
      try {
        await notifySalePending(link.user_id, baseValue, savedPayment.id);
      } catch (pushError) {
        console.error('[CHECKOUT] Erro ao enviar push de venda pendente:', pushError);
      }

      const payment = {
        id: savedPayment.id,
        txid: chargeResult.transactionId,
        status: 'PENDING',
        pixCode: chargeResult.pixCode,
        pixQrCode: chargeResult.pixQrCode,
      };

      // Sucesso
      return reply.send({ success: true, payment });
    } catch (error: any) {
      console.error('[CHECKOUT] Erro:', error);
      return reply.status(500).send({
        success: false,
        message: error.message || 'Erro interno ao processar pagamento',
        error: error.message,
      });
    }
  });

  // Obter dados do link para checkout (público)
  app.get('/checkout/:linkId', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const { linkId } = request.params as { linkId: string };

    const link = await prisma.paymentLink.findFirst({
      where: { id: linkId, active: true },
      include: { product: true, user: true },
    });

    console.log('[CHECKOUT GET] Link:', link?.id, '- User:', (link?.user as any)?.name, '- Provider:', (link?.user as any)?.payment_provider);

    if (!link) {
      return reply.status(404).send({ success: false, error: 'Link não encontrado' });
    }

    // Incrementar cliques em background (não bloqueia a resposta)
    prisma.paymentLink.update({
      where: { id: linkId },
      data: { clicks: { increment: 1 } },
    }).catch(() => {});

    const customRates = await prisma.userCustomRate.findUnique({
      where: { user_id: link.user_id },
    });

    const rates = await getEffectiveRates(customRates ? {
      pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
      card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
    } : null);

    let orderBumps: any[] = [];
    let subscriptionPlan = null;
    let checkoutCustomization = null;

    if (link.product_id) {
      const [orderBumpsResult, subscriptionResult, customizationResult] = await Promise.all([
        prisma.orderBump.findMany({
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
        }),
        (link.product as any)?.is_subscription
          ? prisma.subscriptionPlan.findFirst({
              where: {
                user_id: link.user_id,
                active: true,
              },
              orderBy: { created_at: 'asc' },
            })
          : Promise.resolve(null),
        prisma.checkoutCustomization.findUnique({
          where: { product_id: link.product_id },
        }),
      ]);

      orderBumps = orderBumpsResult;
      subscriptionPlan = subscriptionResult;
      checkoutCustomization = customizationResult;
    }

    const baseValue = Number(link.amount);
    const feePayer = (link.product as any)?.fee_payer || 'seller';

    // Somente PIX - sem opções de parcelamento
    const installmentOptions = [{
      installments: 1,
      total: baseValue,
      installmentValue: baseValue,
      fee: 0,
      label: `À vista - R$ ${baseValue.toFixed(2)}`,
    }];

    return reply.send({
      success: true,
      link: {
        id: link.id,
        name: link.name,
        description: link.description,
        amount: baseValue,
        product: link.product,
        feePayer,
        paymentProvider: (link.user as any)?.payment_provider || 'efibank',
      },
      rates: {
        pix: rates.pix_rate,
        card: rates.card_rate,
        fixed: rates.fixed_fee,
        installment: rates.installment_fee,
      },
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
      paymentOptions: {
        pix: {
          total: baseValue,
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
      customization: checkoutCustomization ? {
        logoUrl: checkoutCustomization.logo_url,
        bannerUrl: checkoutCustomization.banner_url,
        backgroundUrl: checkoutCustomization.background_url,
        primaryColor: checkoutCustomization.primary_color,
        secondaryColor: checkoutCustomization.secondary_color,
        backgroundColor: checkoutCustomization.background_color,
        textColor: checkoutCustomization.text_color,
        buttonColor: checkoutCustomization.button_color,
        timerEnabled: checkoutCustomization.timer_enabled,
        timerMinutes: checkoutCustomization.timer_minutes,
        timerMessage: checkoutCustomization.timer_message,
        timerColor: checkoutCustomization.timer_color,
        customTitle: checkoutCustomization.custom_title,
        customDescription: checkoutCustomization.custom_description,
        customButtonText: checkoutCustomization.custom_button_text,
        successMessage: checkoutCustomization.success_message,
        showLogo: checkoutCustomization.show_logo,
        showBanner: checkoutCustomization.show_banner,
        showTimer: checkoutCustomization.show_timer,
        showStock: checkoutCustomization.show_stock,
        allowQuantity: checkoutCustomization.allow_quantity,
      } : null,
    });
  });
}
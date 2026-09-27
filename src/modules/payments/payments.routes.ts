import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { createSharkPixCharge } from '../../providers/sharkbanking/shark.pix';
import { createEnkiPixCharge } from '../../providers/enki/enki.pix';
import { createEuSouZucroPayPixCharge } from '../../providers/eusouzucropay/eusouzucropay.pix';
import { createXflowPixCharge } from '../../providers/xflow/xflow.pix';
import { createUvviPayPixCharge } from '../../providers/uvvipay/uvvipay.pix';
import { createUvviPayCardCharge } from '../../providers/uvvipay/uvvipay.card';
import { createPaySharkPixCharge } from '../../providers/payshark/payshark.pix';
import { readSettings as readAcquirerSettings } from '../acquirers/acquirers.routes';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { env } from '../../config/env';
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
import {
  SplitInput,
  loadProductSplitRules,
  persistPaymentSplits,
  validateSplits,
} from './split.service';

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

  // Comprovante enviado pelo comprador (público; exige o txid da cobrança como prova de posse)
  app.post('/:id/receipt', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { txid?: string };
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment || !q.txid || payment.efi_txid !== q.txid) {
      return reply.status(404).send({ success: false, error: 'Pagamento não encontrado' });
    }
    const data = await request.file();
    if (!data) return reply.status(400).send({ success: false, error: 'Envie o arquivo no campo "file"' });
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(data.mimetype)) return reply.status(400).send({ success: false, error: 'Use imagem (JPG, PNG, WEBP) ou PDF' });
    const dir = path.join(__dirname, '..', '..', '..', 'uploads', 'receipts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(data.filename || '') || (data.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    const name = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    try {
      await pipeline(data.file, fs.createWriteStream(path.join(dir, name)));
    } catch (err: any) {
      request.log.error(err);
      return reply.status(500).send({ success: false, error: 'Erro ao salvar o comprovante' });
    }
    if ((data.file as any).truncated) return reply.status(413).send({ success: false, error: 'Arquivo muito grande (máx. 4 MB)' });
    const url = `/uploads/receipts/${name}`;
    await prisma.payment.update({ where: { id }, data: { receipt_url: url, receipt_name: (data.filename || name).slice(0, 200), receipt_uploaded_at: new Date() } });
    return reply.send({ success: true, receipt: { url, name: data.filename || name, kind: data.mimetype === 'application/pdf' ? 'pdf' : 'image' } });
  });

  // Upsell 1-clique: nova cobrança Pix para a oferta pós-compra usando os dados do comprador da venda original
  app.post('/checkout/upsell', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const body = request.body as { paymentId?: string; txid?: string; upsellId?: string };
    if (!body.paymentId || !body.txid || !body.upsellId) return reply.status(400).send({ success: false, error: 'Dados incompletos' });
    const original = await prisma.payment.findUnique({ where: { id: body.paymentId }, include: { payment_link: { include: { product: true, user: true } } } });
    if (!original || original.efi_txid !== body.txid || !original.payment_link || !original.payment_link.product) {
      return reply.status(404).send({ success: false, error: 'Venda não encontrada' });
    }
    if (!['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PAID'].includes(String(original.status).toUpperCase())) {
      return reply.status(400).send({ success: false, error: 'A compra original ainda não foi confirmada' });
    }
    const extras = ((original.payment_link.product as any).extras || {}) as { upsells?: any[] };
    const up = Array.isArray(extras.upsells) ? extras.upsells.find((u) => u && u.id === body.upsellId && u.active !== false) : null;
    if (!up) return reply.status(404).send({ success: false, error: 'Oferta indisponível' });
    const base = Number(up.productPrice) || 0;
    let price = base;
    if (up.mode === 'percent') price = base - base * ((Number(up.percent) || 0) / 100);
    else if (up.mode === 'amount') price = base - (Number(up.amount) || 0);
    price = Math.max(0.01, Math.round(price * 100) / 100);
    const upsellProduct = up.productId ? await prisma.product.findFirst({ where: { id: up.productId, user_id: original.user_id } }) : null;
    const description = upsellProduct?.name || up.productName || up.name || 'Oferta especial';
    const meta = (original.metadata && typeof original.metadata === 'object') ? (original.metadata as any) : {};
    const customerName = String(meta.customer_name || 'Cliente');
    const customerEmail = String(meta.customer_email || '');
    const customerCpf = meta.customer_document ? String(meta.customer_document) : undefined;
    const customerPhone = meta.customer_phone ? String(meta.customer_phone) : undefined;
    const clientIp = (request.headers['x-forwarded-for'] as string) || request.ip || 'unknown';
    const seller = original.payment_link.user as any;
    const settings = readAcquirerSettings(seller);
    const candidates = settings.order.length ? settings.order : [seller.payment_provider || 'payshark'];
    const pixArgs = { value: price, description, customerName, customerEmail, customerCpf, customerPhone, externalRef: `zp_up_${original.id}_${Date.now()}` };
    let result: any = { success: false, error: 'Nenhuma adquirente disponível' };
    let used = candidates[0];
    for (const provider of candidates) {
      try {
        result = provider === 'payshark' ? await createPaySharkPixCharge({ ...pixArgs, ip: clientIp })
          : provider === 'payshark_white' ? await createPaySharkPixCharge({ ...pixArgs, ip: clientIp, account: 'payshark_white' })
          : provider === 'xflow' ? await createXflowPixCharge(pixArgs)
          : provider === 'enki' ? await createEnkiPixCharge(pixArgs)
          : provider === 'eusouzucropay' ? await createEuSouZucroPayPixCharge(pixArgs)
          : provider === 'uvvipay' ? await createUvviPayPixCharge(pixArgs)
          : await createSharkPixCharge(pixArgs);
      } catch (e: any) { result = { success: false, error: e?.message }; }
      used = provider;
      if (result.success && result.pixCode) break;
      if (settings.rules && settings.rules.autoSwitch === false) break;
    }
    if (!result.success || !result.pixCode) return reply.send({ success: false, message: result.error || 'Erro ao gerar Pix', error: result.error || 'Erro ao gerar Pix' });
    const customRates = await prisma.userCustomRate.findUnique({ where: { user_id: original.user_id } });
    const rates = await getEffectiveRates(customRates ? { pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined } : null);
    const feeCalc = calculatePixFeeSellerPays(price, applyProviderRateOverrides(rates, used, !!customRates?.pix_rate));
    const saved = await prisma.payment.create({
      data: {
        user_id: original.user_id,
        billing_type: 'PIX',
        value: price,
        net_value: feeCalc.netValue,
        status: 'PENDING',
        description,
        due_date: new Date(),
        efi_txid: result.transactionId,
        pix_qrcode: result.pixQrCode,
        pix_copy_paste: result.pixCode,
        payment_link_id: original.payment_link_id,
        metadata: JSON.parse(JSON.stringify({
          base_value: price,
          platform_fee: feeCalc.platformFee,
          reserve_amount: feeCalc.reserveAmount,
          fee_payer: 'seller',
          seller_rates: rates,
          payment_provider: used,
          [`${used}_transaction_id`]: result.transactionId,
          upsell_of: original.id,
          upsell_id: up.id,
          product_name: description,
          customer_ip: clientIp,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_document: customerCpf,
          customer_phone: customerPhone,
        })),
      },
    });
    return reply.status(201).send({ success: true, payment: { id: saved.id, txid: result.transactionId, status: 'PENDING', pixCode: result.pixCode, pixQrCode: result.pixQrCode, value: price } });
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

  // Atualizar link de pagamento (nome, valor, ativo/arquivado)
  app.put('/links/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; amount?: number; active?: boolean; checkout_config?: Record<string, unknown> | null; domain_id?: string | null };

    const existing = await prisma.paymentLink.findFirst({ where: { id, user_id: decoded.id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Link não encontrado' });
    }

    const data: { name?: string; description?: string; amount?: number; active?: boolean; checkout_config?: any; domain_id?: string | null; updated_at: Date } = { updated_at: new Date() };
    if (body.domain_id !== undefined) {
      if (body.domain_id === null || body.domain_id === '') data.domain_id = null;
      else {
        const dom = await prisma.domain.findFirst({ where: { id: body.domain_id, user_id: decoded.id } });
        if (!dom) return reply.status(404).send({ success: false, error: 'Domínio não encontrado' });
        if (dom.status !== 'approved') return reply.status(400).send({ success: false, error: 'Só é possível vincular domínios aprovados' });
        data.domain_id = dom.id;
      }
    }
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 200);
    if (typeof body.description === 'string') data.description = body.description;
    if (typeof body.amount === 'number' && body.amount > 0) data.amount = body.amount;
    if (typeof body.active === 'boolean') data.active = body.active;
    if (body.checkout_config !== undefined) {
      if (body.checkout_config !== null && typeof body.checkout_config !== 'object') {
        return reply.status(400).send({ success: false, error: 'checkout_config inválido' });
      }
      data.checkout_config = body.checkout_config;
    }

    const link = await prisma.paymentLink.update({ where: { id }, data });
    return reply.send({ success: true, link });
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
        billingType: 'PIX' | 'CREDIT_CARD';
        customerName: string;
        customerEmail: string;
        customerCpfCnpj?: string;
        customerPhone?: string;
        couponCode?: string;
        /** Order bumps marcados no checkout (ids de OrderBump do produto do link). */
        orderBumpIds?: string[];
        /** Regra de frete escolhida (id em products.extras.shipping). */
        shippingId?: string;
        /** Só usado quando billingType = CREDIT_CARD (hoje: apenas UvviPay). */
        card?: {
          number: string;
          holderName: string;
          cvv: string;
          expirationMonth: number;
          expirationYear: number;
          installments?: number;
        };
        split?: Array<{
          recipient_id: string;
          type?: 'amount' | 'percent';
          amount?: number;
          percent?: number;
          description?: string;
        }>;
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

      // Order bumps: só os do produto deste link, ativos e visíveis no checkout; preço vem do banco.
      const selectedBumps: Array<{ id: string; name: string; price: number }> = [];
      const bumpIds = Array.isArray(body.orderBumpIds) ? body.orderBumpIds.filter((v) => typeof v === 'string').slice(0, 20) : [];
      if (bumpIds.length && link.product_id) {
        const bumps = await prisma.orderBump.findMany({
          where: { id: { in: bumpIds }, product_id: link.product_id, active: true, show_in_checkout: true },
          select: { id: true, name: true, price: true },
        });
        for (const b of bumps) {
          const price = Math.round(Number(b.price) * 100) / 100;
          selectedBumps.push({ id: b.id, name: b.name, price });
          baseValue = Math.round((baseValue + price) * 100) / 100;
        }
      }

      // Frete: regra cadastrada na aba Frete do produto (products.extras.shipping); preço vem do banco
      let selectedShipping: { id: string; name: string; price: number } | null = null;
      if (body.shippingId && link.product) {
        const extras = ((link.product as any).extras || {}) as { shipping?: any[] };
        const rule = Array.isArray(extras.shipping) ? extras.shipping.find((s) => s && s.id === body.shippingId && s.active !== false) : null;
        if (!rule) return reply.status(400).send({ success: false, message: 'Opção de frete inválida', error: 'Frete inválido' });
        const parseMoney = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
        const price = rule.free ? 0 : Math.round(parseMoney(rule.price) * 100) / 100;
        selectedShipping = { id: rule.id, name: rule.name || 'Frete', price };
        baseValue = Math.round((baseValue + price) * 100) / 100;
      }

      const originalValue = baseValue;
      const description = link.product?.name || link.name || 'Pagamento ZucroPay';
      let appliedCoupon: any = null;

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

      // PIX para todos; cartão só para vendedores na UvviPay com a flag ligada.
      // Com UVVIPAY_CARD_ENABLED=false o comportamento é o de antes: só PIX.
      const providerForMethod = (link.user as any)?.payment_provider || 'payshark';
      const isCardCheckout = body.billingType === 'CREDIT_CARD';

      if (isCardCheckout) {
        if (providerForMethod !== 'uvvipay' || !env.UVVIPAY_CARD_ENABLED) {
          return reply.status(400).send({
            success: false,
            message: 'Apenas pagamento via PIX está disponível.',
            error: 'Somente PIX disponível',
          });
        }
        if (!body.card?.number || !body.card?.cvv || !body.card?.holderName) {
          return reply.status(400).send({
            success: false,
            message: 'Dados do cartão incompletos.',
            error: 'Cartão inválido',
          });
        }
      } else if (body.billingType !== 'PIX') {
        return reply.status(400).send({
          success: false,
          message: 'Apenas pagamento via PIX está disponível.',
          error: 'Somente PIX disponível',
        });
      }

      // ===== SPLIT: resolver regras fixas do produto + splits dinâmicos =====
      // Valida antes de chamar o provider para não criar cobrança no gateway e depois abortar.
      const productRules = await loadProductSplitRules(link.id);
      const dynamicSplits: SplitInput[] = (body.split || []).map((s) => ({
        recipient_id: s.recipient_id,
        type: s.type || (s.percent != null ? 'percent' : 'amount'),
        amount: s.amount,
        percent: s.percent,
        description: s.description ?? null,
      }));

      // Merge: regra fixa do produto + dinâmica da request (dinâmica sobrescreve por recipient).
      const mergedMap = new Map<string, SplitInput>();
      for (const r of productRules) mergedMap.set(r.recipient_id, r);
      for (const r of dynamicSplits) mergedMap.set(r.recipient_id, r);
      const mergedSplits = Array.from(mergedMap.values());

      let splitsToPersist: SplitInput[] = [];
      if (mergedSplits.length > 0) {
        const validation = await validateSplits(mergedSplits, baseValue, link.user_id);
        if ('error' in validation) {
          return reply.status(400).send({
            success: false,
            message: validation.error,
            error: validation.error,
          });
        }
        splitsToPersist = validation.normalized;
      }

      // Determinar provider do seller: A/B ativo (alterna) ou ordem de contingência (tenta a próxima se falhar)
      let sellerProvider = (link.user as any)?.payment_provider || 'payshark';
      const acqSettings = readAcquirerSettings(link.user as any);
      let providerCandidates: string[] = acqSettings.order.length ? acqSettings.order.slice() : [sellerProvider];
      let abTestId: string | undefined;
      if (acqSettings.ab && acqSettings.ab.active && acqSettings.ab.acquirers.length >= 2) {
        const sinceAb = new Date(acqSettings.ab.startedAt);
        const countAb = await prisma.payment.count({ where: { user_id: link.user_id, billing_type: 'PIX', created_at: { gte: sinceAb } } });
        const pick = acqSettings.ab.acquirers[countAb % acqSettings.ab.acquirers.length];
        providerCandidates = [pick, ...providerCandidates.filter((p) => p !== pick)];
        abTestId = acqSettings.ab.id;
      }
      sellerProvider = providerCandidates[0];
      console.log(`[CHECKOUT PIX] ${sellerProvider} - vendedor: ${link.user.name} (${link.user_id})`);

      let chargeResult: {
        success: boolean;
        transactionId?: string;
        pixCode?: string;
        pixQrCode?: string;
        error?: string;
        debug?: any;
        /** Só no fluxo de cartão: status já autorizado/recusado pelo emissor. */
        status?: string;
        cardRefused?: boolean;
      };

      if (isCardCheckout) {
        // Cartão de crédito (UvviPay). A autorização é síncrona, mas quem
        // libera o saldo continua sendo o webhook — igual ao PIX.
        const cardCharge = await createUvviPayCardCharge({
          value: baseValue,
          description,
          installments: body.card?.installments || 1,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          customerCpf: body.customerCpfCnpj,
          customerPhone: body.customerPhone,
          externalRef: `zp_${link.id}_${Date.now()}`,
          ip: clientIp,
          card: {
            number: body.card!.number,
            holderName: body.card!.holderName,
            cvv: body.card!.cvv,
            expirationMonth: body.card!.expirationMonth,
            expirationYear: body.card!.expirationYear,
          },
        });
        chargeResult = {
          success: cardCharge.success,
          transactionId: cardCharge.transactionId,
          status: cardCharge.status,
          cardRefused: cardCharge.cardRefused,
          error: cardCharge.error,
          debug: cardCharge.debug,
        };
      } else {
        const pixArgs = {
          value: baseValue,
          description,
          customerName: body.customerName,
          customerEmail: body.customerEmail,
          customerCpf: body.customerCpfCnpj,
          customerPhone: body.customerPhone,
          externalRef: `zp_${link.id}_${Date.now()}`,
        };
        const chargeWith = async (provider: string) => {
          if (provider === 'payshark') return createPaySharkPixCharge({ ...pixArgs, ip: clientIp });
          if (provider === 'payshark_white') return createPaySharkPixCharge({ ...pixArgs, ip: clientIp, account: 'payshark_white' });
          if (provider === 'xflow') return createXflowPixCharge(pixArgs);
          if (provider === 'enki') return createEnkiPixCharge(pixArgs);
          if (provider === 'eusouzucropay') return createEuSouZucroPayPixCharge(pixArgs);
          if (provider === 'uvvipay') return createUvviPayPixCharge(pixArgs);
          return createSharkPixCharge(pixArgs);
        };
        chargeResult = { success: false, error: 'Nenhuma adquirente disponível' };
        const useFallback = acqSettings.rules && acqSettings.rules.autoSwitch !== false;
        for (let i = 0; i < providerCandidates.length; i++) {
          const provider = providerCandidates[i];
          try {
            chargeResult = await chargeWith(provider);
          } catch (e: any) {
            chargeResult = { success: false, error: e?.message || 'Falha na adquirente' };
          }
          sellerProvider = provider;
          if (chargeResult.success && chargeResult.pixCode) break;
          console.error(`[CHECKOUT PIX] ${provider} falhou: ${chargeResult.error}`);
          if (!useFallback) break;
        }
      }


      if (!chargeResult.success) {
        const errorMsg = chargeResult.error || 'Erro ao gerar cobrança PIX';
        console.error(`[CHECKOUT PIX] ${sellerProvider} falhou: ${errorMsg}`, chargeResult.debug);
        return reply.send({ success: false, message: errorMsg, error: errorMsg });
      }

      if (!isCardCheckout && !chargeResult.pixCode) {
        return reply.send({
          success: false,
          message: 'Não foi possível gerar o código PIX. Tente novamente.',
          error: 'PIX vazio',
        });
      }

      // Aplicar taxas específicas do adquirente (só se seller não tem taxa customizada)
      const effectiveRates = applyProviderRateOverrides(rates, sellerProvider, !!customRates?.pix_rate);
      const feeCalc = calculatePixFeeSellerPays(baseValue, effectiveRates);

      const savedPayment = await prisma.payment.create({
        data: {
          user_id: link.user_id,
          billing_type: isCardCheckout ? 'CREDIT_CARD' : 'PIX',
          value: baseValue,
          net_value: feeCalc.netValue,
          // Cartão nasce com o status devolvido pela autorização; PIX nasce PENDING.
          // Em ambos, o crédito no saldo só acontece pelo webhook.
          status: isCardCheckout ? (chargeResult.status || 'PENDING') : 'PENDING',
          description,
          due_date: new Date(),
          efi_txid: chargeResult.transactionId,
          pix_qrcode: isCardCheckout ? null : chargeResult.pixQrCode,
          pix_copy_paste: isCardCheckout ? null : chargeResult.pixCode,
          payment_link_id: link.id,
          metadata: JSON.parse(JSON.stringify({
            base_value: baseValue,
            order_bumps: selectedBumps.length ? selectedBumps : undefined,
            order_bumps_total: selectedBumps.length ? selectedBumps.reduce((a, b) => a + b.price, 0) : undefined,
            shipping: selectedShipping || undefined,
            ab_test: abTestId,
            platform_fee: feeCalc.platformFee,
            reserve_amount: feeCalc.reserveAmount,
            fee_payer: 'seller',
            seller_rates: rates,
            payment_provider: sellerProvider,
            ...(sellerProvider === 'payshark'
              ? { payshark_transaction_id: chargeResult.transactionId }
              : sellerProvider === 'payshark_white'
              ? { payshark_white_transaction_id: chargeResult.transactionId }
              : sellerProvider === 'xflow'
              ? { xflow_transaction_id: chargeResult.transactionId }
              : sellerProvider === 'enki'
              ? { enki_transaction_id: chargeResult.transactionId }
              : sellerProvider === 'eusouzucropay'
              ? { eusouzucropay_transaction_id: chargeResult.transactionId }
              : sellerProvider === 'uvvipay'
              ? { uvvipay_transaction_id: chargeResult.transactionId }
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

      // Persistir splits (se houver) e marcar payment.has_split = true
      if (splitsToPersist.length > 0) {
        await persistPaymentSplits(savedPayment.id, splitsToPersist);
      }

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
      include: { product: true, user: true, domain: true },
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

    // Cupons ativos válidos para este link (o checkout mostra o desconto antes de gerar o Pix;
    // o valor cobrado é sempre recalculado no POST /checkout).
    const nowForCoupons = new Date();
    const activeCoupons = await prisma.coupon.findMany({
      where: {
        user_id: link.user_id,
        active: true,
        OR: [{ product_id: null }, ...(link.product_id ? [{ product_id: link.product_id }] : [])],
      },
      select: { code: true, discount_type: true, discount_value: true, max_uses: true, used_count: true, starts_at: true, expires_at: true, min_value: true, max_discount: true },
    });
    const publicCoupons = activeCoupons
      .filter((c) => (!c.starts_at || nowForCoupons >= c.starts_at) && (!c.expires_at || nowForCoupons <= c.expires_at) && (c.max_uses === null || c.used_count < c.max_uses))
      .map((c) => ({
        code: c.code,
        discountType: c.discount_type,
        discountValue: Number(c.discount_value),
        minValue: c.min_value ? Number(c.min_value) : null,
        maxDiscount: c.max_discount ? Number(c.max_discount) : null,
      }));

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
        paymentProvider: (link.user as any)?.payment_provider || 'eusouzucropay',
      },
      rates: {
        pix: rates.pix_rate,
        card: rates.card_rate,
        fixed: rates.fixed_fee,
        installment: rates.installment_fee,
      },
      checkoutConfig: (link as any).checkout_config || null,
      productExtras: ((link.product as any)?.extras) || null,
      domain: (link as any).domain && (link as any).domain.status === 'approved' ? { name: (link as any).domain.name } : null,
      coupons: publicCoupons,
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
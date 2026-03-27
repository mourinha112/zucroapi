import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { createSharkPixCharge } from '../../providers/sharkbanking/shark.pix';
import { createEnkiPixCharge } from '../../providers/enki/enki.pix';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  applyProviderRateOverrides,
} from '../../providers/efibank/fee.calculator';
import crypto from 'crypto';
import {
  authenticateApiKey,
  authenticate,
  integratorRateLimit,
  standardRateLimit,
  createResourceRateLimit,
} from '../../middlewares';
import { notifySalePending } from '../push/push.service';

// Schemas de validação
const createChargeSchema = z.object({
  billing_type: z.enum(['PIX', 'CREDIT_CARD', 'BOLETO', 'UNDEFINED']),
  value: z.number().positive(),
  description: z.string().optional(),
  due_date: z.string().optional(),
  customer: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    cpf_cnpj: z.string().optional(),
    phone: z.string().optional(),
  }).optional(),
  external_reference: z.string().optional(),
  callback_url: z.string().url().optional(),
  postback_url: z.string().url().optional(),
});

import { sendChargePostback } from '../../utils/postback';

export async function integrationsRoutes(app: FastifyInstance) {
  // ========================================
  // Documentação / Health
  // ========================================
  app.get('/', async (request, reply) => {
    return reply.send({
      name: 'ZucroPay API',
      version: '1.0.0',
      documentation: 'https://docs.appzucropay.com',
      endpoints: {
        account: {
          get: 'GET /api/v1/account',
        },
        charges: {
          create: 'POST /api/v1/charges',
          get: 'GET /api/v1/charges/:id',
          list: 'GET /api/v1/charges',
          refund: 'POST /api/v1/charges/:id/refund',
        },
        customers: {
          create: 'POST /api/v1/customers',
          get: 'GET /api/v1/customers/:id',
          list: 'GET /api/v1/customers',
        },
        payment_links: {
          create: 'POST /api/v1/payment-links',
          get: 'GET /api/v1/payment-links/:id',
          list: 'GET /api/v1/payment-links',
          deactivate: 'DELETE /api/v1/payment-links/:id',
        },
        products: {
          create: 'POST /api/v1/products',
          get: 'GET /api/v1/products/:id',
          list: 'GET /api/v1/products',
          update: 'PUT /api/v1/products/:id',
          delete: 'DELETE /api/v1/products/:id',
        },
        transactions: {
          list: 'GET /api/v1/transactions',
        },
        withdrawals: {
          create: 'POST /api/v1/withdrawals',
          list: 'GET /api/v1/withdrawals',
        },
        balance: {
          get: 'GET /api/v1/balance',
        },
        webhooks: {
          create: 'POST /api/v1/webhooks',
          list: 'GET /api/v1/webhooks',
          delete: 'DELETE /api/v1/webhooks/:id',
        },
      },
    });
  });

  // ========================================
  // Dados da Conta / Seller (para integradores)
  // ========================================
  app.get('/account', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apiUser = request.apiUser!;

      // Buscar dados completos do seller
      const seller = await prisma.user.findUnique({
        where: { id: apiUser.id },
        select: {
          id: true,
          name: true,
          email: true,
          cpf_cnpj: true,
          person_type: true,
          phone: true,
          account_status: true,
          identity_verified: true,
          payment_provider: true,
          created_at: true,
        },
      });

      if (!seller) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }

      return reply.send({
        object: 'account',
        id: seller.id,
        name: seller.name,
        email: seller.email,
        document: seller.cpf_cnpj || null,
        person_type: seller.person_type, // PF ou PJ
        phone: seller.phone || null,
        account_status: seller.account_status,
        identity_verified: seller.identity_verified,
        payment_provider: seller.payment_provider,
        created_at: seller.created_at,
      });
    } catch (error: any) {
      console.error('[API] Erro ao buscar dados da conta:', error);
      return reply.status(500).send({ error: 'Erro interno' });
    }
  });

  // ========================================
  // Criar Cobrança (para integradores)
  // ========================================
  app.post('/charges', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = request.apiUser!;
      const body = createChargeSchema.parse(request.body);

      // Buscar taxas do usuário
      const customRates = await prisma.userCustomRate.findUnique({
        where: { user_id: user.id },
      });

      const rates = await getEffectiveRates(customRates ? {
        pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
      } : null);

      const description = body.description || 'Cobrança via API';
      let payment: any;
      let chargeData: any = {};

      // ========== PIX ==========
      if (body.billing_type === 'PIX') {
        const sellerProvider = (user as any).payment_provider || 'sharkbanking';
        let chargeRes: { success: boolean; transactionId?: string; pixCode?: string; pixQrCode?: string; error?: string; debug?: any };

        if (sellerProvider === 'enki') {
          chargeRes = await createEnkiPixCharge({
            value: body.value,
            description,
            customerName: body.customer?.name || 'Cliente',
            customerEmail: body.customer?.email || '',
            customerCpf: body.customer?.cpf_cnpj,
            customerPhone: body.customer?.phone,
            externalRef: body.external_reference || `api_${user.id}_${Date.now()}`,
          });
        } else {
          chargeRes = await createSharkPixCharge({
            value: body.value,
            description,
            customerName: body.customer?.name || 'Cliente',
            customerEmail: body.customer?.email || '',
            customerCpf: body.customer?.cpf_cnpj,
            customerPhone: body.customer?.phone,
            externalRef: body.external_reference || `api_${user.id}_${Date.now()}`,
          });
        }

        if (!chargeRes.success || !chargeRes.pixCode) {
          return reply.status(400).send({
            error: chargeRes.error || 'Erro ao gerar cobrança PIX',
            code: 'PIX_CREATION_FAILED',
          });
        }

        // Aplicar taxas específicas do adquirente (Enki: 4.99% + R$2.50)
        const effectiveRates = applyProviderRateOverrides(rates, sellerProvider);
        const feeCalc = calculatePixFeeSellerPays(body.value, effectiveRates);

        payment = await prisma.payment.create({
          data: {
            user_id: user.id,
            billing_type: 'PIX',
            value: body.value,
            net_value: feeCalc.netValue,
            status: 'PENDING',
            description,
            due_date: body.due_date ? new Date(body.due_date) : new Date(),
            efi_txid: chargeRes.transactionId,
            pix_qrcode: chargeRes.pixQrCode,
            pix_copy_paste: chargeRes.pixCode,
            metadata: {
              external_reference: body.external_reference,
              callback_url: body.callback_url,
              postback_url: body.postback_url || body.callback_url,
              platform_fee: feeCalc.platformFee,
              payment_provider: sellerProvider,
              ...(sellerProvider === 'enki'
                ? { enki_transaction_id: chargeRes.transactionId }
                : { shark_transaction_id: chargeRes.transactionId }),
              customer_name: body.customer?.name,
              customer_email: body.customer?.email,
              customer_document: body.customer?.cpf_cnpj,
              customer_phone: body.customer?.phone,
              created_via: 'api',
            },
          },
        });

        // Notificação push de venda pendente
        try {
          await notifySalePending(user.id, body.value, payment.id);
        } catch (pushError) {
          console.error('[API] Erro ao enviar push de venda pendente:', pushError);
        }

        chargeData = {
          id: payment.id,
          object: 'charge',
          billing_type: 'PIX',
          status: 'PENDING',
          value: body.value,
          net_value: feeCalc.netValue,
          platform_fee: feeCalc.platformFee,
          pix: {
            txid: chargeRes.transactionId,
            qr_code: chargeRes.pixQrCode,
            copy_paste: chargeRes.pixCode,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          created_at: payment.created_at,
        };
      }

      // ========== Cartão/Boleto não disponível ==========
      else if (body.billing_type === 'CREDIT_CARD' || body.billing_type === 'BOLETO') {
        return reply.status(400).send({
          error: 'Apenas PIX está disponível no momento. Use billing_type: "PIX".',
          code: 'METHOD_NOT_AVAILABLE',
        });
      }

      // ========== UNDEFINED (gera link flexível) ==========
      else {
        // Criar link de pagamento interno
        const link = await prisma.paymentLink.create({
          data: {
            user_id: user.id,
            name: description,
            description,
            amount: body.value,
            billing_type: 'UNDEFINED',
            asaas_payment_link_id: `api_${Date.now()}`,
            asaas_link_url: '',
          },
        });

        const checkoutUrl = `https://dashboard.appzucropay.com/checkout/${link.id}`;

        await prisma.paymentLink.update({
          where: { id: link.id },
          data: { asaas_link_url: checkoutUrl },
        });

        chargeData = {
          id: link.id,
          object: 'payment_link',
          billing_type: 'UNDEFINED',
          status: 'ACTIVE',
          value: body.value,
          checkout_url: checkoutUrl,
          created_at: link.created_at,
        };
      }

      return reply.status(201).send(chargeData);
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return reply.status(400).send({
          error: 'Dados inválidos',
          details: error.errors,
        });
      }
      console.error('[API] Erro ao criar cobrança:', error);
      return reply.status(500).send({ error: 'Erro interno' });
    }
  });

  // ========================================
  // Consultar Cobrança (para integradores)
  // ========================================
  app.get('/charges/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const payment = await prisma.payment.findFirst({
      where: { id, user_id: user.id },
    });

    if (!payment) {
      return reply.status(404).send({ error: 'Cobrança não encontrada' });
    }

    return reply.send({
      id: payment.id,
      object: 'charge',
      billing_type: payment.billing_type,
      status: payment.status,
      value: Number(payment.value),
      net_value: payment.net_value ? Number(payment.net_value) : null,
      description: payment.description,
      pix: payment.billing_type === 'PIX' ? {
        txid: payment.efi_txid,
        qr_code: payment.pix_qrcode,
        copy_paste: payment.pix_copy_paste,
      } : null,
      payment_date: payment.payment_date,
      created_at: payment.created_at,
      metadata: payment.metadata,
    });
  });

  // ========================================
  // Listar Cobranças (para integradores)
  // ========================================
  app.get('/charges', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const query = request.query as {
      status?: string;
      billing_type?: string;
      limit?: string;
      offset?: string;
    };

    const payments = await prisma.payment.findMany({
      where: {
        user_id: user.id,
        ...(query.status && { status: query.status }),
        ...(query.billing_type && { billing_type: query.billing_type }),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(parseInt(query.limit || '50'), 100),
      skip: parseInt(query.offset || '0'),
    });

    const total = await prisma.payment.count({
      where: {
        user_id: user.id,
        ...(query.status && { status: query.status }),
        ...(query.billing_type && { billing_type: query.billing_type }),
      },
    });

    return reply.send({
      object: 'list',
      data: payments.map((p) => ({
        id: p.id,
        billing_type: p.billing_type,
        status: p.status,
        value: Number(p.value),
        description: p.description,
        created_at: p.created_at,
      })),
      total,
      has_more: total > (parseInt(query.offset || '0') + payments.length),
    });
  });

  // ========================================
  // Consultar Saldo (para integradores)
  // ========================================
  app.get('/balance', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;

    const userData = await prisma.user.findUnique({
      where: { id: user.id },
      select: { balance: true, reserved_balance: true },
    });

    return reply.send({
      object: 'balance',
      available: Number(userData?.balance || 0),
      reserved: Number(userData?.reserved_balance || 0),
      total: Number(userData?.balance || 0) + Number(userData?.reserved_balance || 0),
    });
  });

  // ========================================
  // Gerar API Key (autenticado via JWT)
  // ========================================
  app.post('/keys', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const decoded = request.user as { id: string };
      const body = request.body as { name?: string };

      console.log('[API Keys] Creating key for user:', decoded.id);

      // Gerar API Key aleatória (43 caracteres: zp_ + 40 hex)
      const rawKey = `zp_${crypto.randomBytes(20).toString('hex')}`;

      const apiKey = await prisma.apiKey.create({
        data: {
          user_id: decoded.id,
          name: body.name || 'API Key',
          api_key: rawKey,
          status: 'active',
        },
      });

      console.log('[API Keys] Key created:', apiKey.id);

      // Retornar a key completa apenas uma vez
      return reply.status(201).send({
        success: true,
        id: apiKey.id,
        name: apiKey.name,
        api_key: rawKey, // Só aparece uma vez!
        created_at: apiKey.created_at,
        warning: 'Guarde esta chave em local seguro. Ela não será exibida novamente.',
      });
    } catch (error: any) {
      console.error('[API Keys] Error creating key:', error);
      return reply.status(500).send({
        error: error.message || 'Erro ao criar API Key',
        details: error.code,
      });
    }
  });

  // ========================================
  // Listar API Keys (autenticado via JWT)
  // ========================================
  app.get('/keys', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const decoded = request.user as { id: string };

    const keys = await prisma.apiKey.findMany({
      where: { user_id: decoded.id },
      select: {
        id: true,
        name: true,
        api_key: true,
        status: true,
        last_used_at: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ keys });
  });

  // ========================================
  // Revogar API Key (autenticado via JWT)
  // ========================================
  app.delete('/keys/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const result = await prisma.apiKey.updateMany({
      where: { id, user_id: decoded.id },
      data: { status: 'revoked' },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'API Key não encontrada' });
    }

    return reply.send({ success: true, message: 'API Key revogada' });
  });

  // ========================================
  // CUSTOMERS - Gerenciar clientes
  // ========================================
  app.post('/customers', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const body = request.body as {
      name: string;
      email?: string;
      cpf_cnpj?: string;
      phone?: string;
    };

    if (!body.name) {
      return reply.status(400).send({ error: 'Nome é obrigatório' });
    }

    // Criar ou buscar cliente na tabela de pagamentos (usamos metadata para clientes)
    const customer = {
      id: `cus_${crypto.randomBytes(12).toString('hex')}`,
      name: body.name,
      email: body.email || null,
      cpf_cnpj: body.cpf_cnpj || null,
      phone: body.phone || null,
      user_id: user.id,
      created_at: new Date().toISOString(),
    };

    return reply.status(201).send({
      object: 'customer',
      ...customer,
    });
  });

  app.get('/customers', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Por enquanto, retorna lista vazia (clientes são armazenados inline nos pagamentos)
    return reply.send({
      object: 'list',
      data: [],
      total: 0,
      has_more: false,
    });
  });

  // ========================================
  // PAYMENT LINKS - Gerenciar links
  // ========================================
  app.post('/payment-links', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const body = request.body as {
      name: string;
      description?: string;
      value: number;
      billing_type?: 'PIX' | 'CREDIT_CARD' | 'UNDEFINED';
    };

    if (!body.name || !body.value) {
      return reply.status(400).send({ error: 'Nome e valor são obrigatórios' });
    }

    const link = await prisma.paymentLink.create({
      data: {
        user_id: user.id,
        name: body.name,
        description: body.description || '',
        amount: body.value,
        billing_type: body.billing_type || 'UNDEFINED',
        asaas_payment_link_id: `api_${Date.now()}`,
        asaas_link_url: '',
      },
    });

    const checkoutUrl = `https://dashboard.appzucropay.com/checkout/${link.id}`;

    await prisma.paymentLink.update({
      where: { id: link.id },
      data: { asaas_link_url: checkoutUrl },
    });

    return reply.status(201).send({
      object: 'payment_link',
      id: link.id,
      name: link.name,
      description: link.description,
      value: Number(link.amount),
      billing_type: link.billing_type,
      checkout_url: checkoutUrl,
      active: link.active,
      created_at: link.created_at,
    });
  });

  app.get('/payment-links', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const query = request.query as { limit?: string; offset?: string };

    const links = await prisma.paymentLink.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      take: Math.min(parseInt(query.limit || '50'), 100),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({
      object: 'list',
      data: links.map((l) => ({
        id: l.id,
        name: l.name,
        value: Number(l.amount),
        billing_type: l.billing_type,
        checkout_url: l.asaas_link_url,
        active: l.active,
        total_received: Number(l.total_received),
        created_at: l.created_at,
      })),
      total: links.length,
    });
  });

  app.get('/payment-links/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const link = await prisma.paymentLink.findFirst({
      where: { id, user_id: user.id },
    });

    if (!link) {
      return reply.status(404).send({ error: 'Link não encontrado' });
    }

    return reply.send({
      object: 'payment_link',
      id: link.id,
      name: link.name,
      description: link.description,
      value: Number(link.amount),
      billing_type: link.billing_type,
      checkout_url: link.asaas_link_url,
      active: link.active,
      total_received: Number(link.total_received),
      created_at: link.created_at,
    });
  });

  app.delete('/payment-links/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const result = await prisma.paymentLink.updateMany({
      where: { id, user_id: user.id },
      data: { active: false },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'Link não encontrado' });
    }

    return reply.send({ success: true, message: 'Link desativado' });
  });

  // ========================================
  // PRODUCTS - Gerenciar produtos
  // ========================================
  app.post('/products', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const body = request.body as {
      name: string;
      description?: string;
      price: number;
      image_url?: string;
      stock?: number;
    };

    if (!body.name || !body.price) {
      return reply.status(400).send({ error: 'Nome e preço são obrigatórios' });
    }

    const product = await prisma.product.create({
      data: {
        user_id: user.id,
        name: body.name,
        description: body.description || '',
        price: body.price,
        image_url: body.image_url || null,
        stock: body.stock,
        active: true,
      },
    });

    return reply.status(201).send({
      object: 'product',
      id: product.id,
      name: product.name,
      description: product.description,
      price: Number(product.price),
      image_url: product.image_url,
      stock: product.stock,
      active: product.active,
      created_at: product.created_at,
    });
  });

  app.get('/products', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const query = request.query as { limit?: string; offset?: string };

    const products = await prisma.product.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      take: Math.min(parseInt(query.limit || '50'), 100),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({
      object: 'list',
      data: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        image_url: p.image_url,
        stock: p.stock,
        active: p.active,
        created_at: p.created_at,
      })),
      total: products.length,
    });
  });

  app.get('/products/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({
      where: { id, user_id: user.id },
    });

    if (!product) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    return reply.send({
      object: 'product',
      id: product.id,
      name: product.name,
      description: product.description,
      price: Number(product.price),
      image_url: product.image_url,
      stock: product.stock,
      active: product.active,
      created_at: product.created_at,
    });
  });

  app.put('/products/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      description?: string;
      price?: number;
      image_url?: string;
      stock?: number;
      active?: boolean;
    };

    const product = await prisma.product.updateMany({
      where: { id, user_id: user.id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.price && { price: body.price }),
        ...(body.image_url !== undefined && { image_url: body.image_url }),
        ...(body.stock !== undefined && { stock: body.stock }),
        ...(body.active !== undefined && { active: body.active }),
      },
    });

    if (product.count === 0) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    const updated = await prisma.product.findFirst({
      where: { id, user_id: user.id },
    });

    return reply.send({
      object: 'product',
      ...updated,
      price: Number(updated?.price),
    });
  });

  app.delete('/products/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const result = await prisma.product.deleteMany({
      where: { id, user_id: user.id },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    return reply.send({ success: true, message: 'Produto excluído' });
  });

  // ========================================
  // TRANSACTIONS - Histórico de transações
  // ========================================
  app.get('/transactions', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const query = request.query as { 
      type?: string; 
      limit?: string; 
      offset?: string;
    };

    const transactions = await prisma.transaction.findMany({
      where: {
        user_id: user.id,
        ...(query.type && { type: query.type }),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(parseInt(query.limit || '50'), 100),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({
      object: 'list',
      data: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        status: t.status,
        description: t.description,
        created_at: t.created_at,
      })),
      total: transactions.length,
    });
  });

  // ========================================
  // WITHDRAWALS - Solicitar saques
  // ========================================
  app.post('/withdrawals', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const body = request.body as {
      amount: number;
      withdraw_type?: 'pix' | 'bank';
      pix_key?: string;
      pix_key_type?: string;
      bank_code?: string;
      bank_name?: string;
      agency?: string;
      account_number?: string;
      account_digit?: string;
      account_type?: string;
      holder_name?: string;
      holder_document?: string;
    };

    if (!body.amount || body.amount <= 0) {
      return reply.status(400).send({ error: 'Valor inválido' });
    }

    // Validar dados conforme tipo de saque
    if (body.withdraw_type === 'bank') {
      if (!body.bank_code || !body.agency || !body.account_number || !body.holder_name || !body.holder_document) {
        return reply.status(400).send({ error: 'Dados bancários incompletos' });
      }
    } else if (!body.pix_key) {
      return reply.status(400).send({ error: 'Chave PIX obrigatória para saque via PIX' });
    }

    // Verificar saldo
    const userData = await prisma.user.findUnique({
      where: { id: user.id },
      select: { balance: true },
    });

    if (!userData || Number(userData.balance) < body.amount) {
      return reply.status(400).send({ error: 'Saldo insuficiente' });
    }

    // Criar saque
    const withdrawal = await prisma.withdrawal.create({
      data: {
        user_id: user.id,
        amount: body.amount,
        withdrawal_type: body.withdraw_type || 'pix',
        pix_key: body.pix_key || '',
        pix_key_type: body.pix_key_type || 'cpf',
        bank_code: body.bank_code || null,
        bank_name: body.bank_name || null,
        agency: body.agency || null,
        account_number: body.account_number || null,
        account_digit: body.account_digit || null,
        account_type: body.account_type || null,
        holder_name: body.holder_name || null,
        holder_document: body.holder_document?.replace(/\D/g, '') || null,
        status: 'pending',
      },
    });

    // Deduzir do saldo
    await prisma.user.update({
      where: { id: user.id },
      data: {
        balance: { decrement: body.amount },
      },
    });

    return reply.status(201).send({
      object: 'withdrawal',
      id: withdrawal.id,
      amount: Number(withdrawal.amount),
      status: withdrawal.status,
      withdrawal_type: withdrawal.withdrawal_type,
      created_at: withdrawal.created_at,
    });
  });

  app.get('/withdrawals', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const query = request.query as { status?: string; limit?: string; offset?: string };

    const withdrawals = await prisma.withdrawal.findMany({
      where: {
        user_id: user.id,
        ...(query.status && { status: query.status }),
      },
      orderBy: { created_at: 'desc' },
      take: Math.min(parseInt(query.limit || '50'), 100),
      skip: parseInt(query.offset || '0'),
    });

    return reply.send({
      object: 'list',
      data: withdrawals.map((w) => ({
        id: w.id,
        amount: Number(w.amount),
        status: w.status,
        pix_key: w.pix_key,
        created_at: w.created_at,
      })),
      total: withdrawals.length,
    });
  });

  // ========================================
  // REFUNDS - Estornar cobranças
  // ========================================
  app.post('/charges/:id/refund', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };
    const body = request.body as { amount?: number; reason?: string };

    const payment = await prisma.payment.findFirst({
      where: { id, user_id: user.id },
    });

    if (!payment) {
      return reply.status(404).send({ error: 'Cobrança não encontrada' });
    }

    if (payment.status !== 'RECEIVED') {
      return reply.status(400).send({ error: 'Apenas cobranças pagas podem ser estornadas' });
    }

    const refundAmount = body.amount || Number(payment.value);

    // Atualizar pagamento
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        metadata: {
          ...(payment.metadata as any),
          refund_amount: refundAmount,
          refund_reason: body.reason || 'Solicitado via API',
          refunded_at: new Date().toISOString(),
        },
      },
    });

    // Deduzir do saldo do vendedor
    await prisma.user.update({
      where: { id: user.id },
      data: {
        balance: { decrement: refundAmount },
      },
    });

    // Enviar postback de estorno para a URL da cobrança (se configurada)
    const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    if (updatedPayment) {
      sendChargePostback(updatedPayment, 'charge.refunded', {
        refund_amount: refundAmount,
        refund_reason: body.reason || 'Solicitado via API',
      });
    }

    return reply.send({
      object: 'refund',
      id: `ref_${crypto.randomBytes(8).toString('hex')}`,
      charge_id: payment.id,
      amount: refundAmount,
      reason: body.reason || 'Solicitado via API',
      status: 'succeeded',
      created_at: new Date().toISOString(),
    });
  });

  // ========================================
  // WEBHOOKS - Gerenciar webhooks via API
  // ========================================
  app.post('/webhooks', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const body = request.body as {
      url: string;
      events?: string[];
    };

    if (!body.url) {
      return reply.status(400).send({ error: 'URL é obrigatória' });
    }

    const webhook = await prisma.webhook.create({
      data: {
        user_id: user.id,
        url: body.url,
        events: body.events || ['payment.received', 'payment.refunded'],
        secret: `whsec_${crypto.randomBytes(16).toString('hex')}`,
      },
    });

    return reply.status(201).send({
      object: 'webhook',
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      status: webhook.status,
      created_at: webhook.created_at,
    });
  });

  app.get('/webhooks', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;

    const webhooks = await prisma.webhook.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({
      object: 'list',
      data: webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        events: w.events,
        status: w.status,
        created_at: w.created_at,
      })),
      total: webhooks.length,
    });
  });

  app.delete('/webhooks/:id', {
    preHandler: [integratorRateLimit, authenticateApiKey],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.apiUser!;
    const { id } = request.params as { id: string };

    const result = await prisma.webhook.deleteMany({
      where: { id, user_id: user.id },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'Webhook não encontrado' });
    }

    return reply.send({ success: true, message: 'Webhook removido' });
  });
}

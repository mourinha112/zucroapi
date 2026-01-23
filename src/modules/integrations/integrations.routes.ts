import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { createPixCharge } from '../../providers/efibank/efi.pix';
import { createCardCharge, createPaymentLink as createEfiPaymentLink } from '../../providers/efibank/efi.card';
import {
  getEffectiveRates,
  calculatePixFeeSellerPays,
  calculateCardFeeSellerPays,
} from '../../providers/efibank/fee.calculator';
import crypto from 'crypto';
import {
  authenticateApiKey,
  authenticate,
  integratorRateLimit,
  standardRateLimit,
  createResourceRateLimit,
} from '../../middlewares';

// Schemas de validação
const createChargeSchema = z.object({
  billing_type: z.enum(['PIX', 'CREDIT_CARD', 'UNDEFINED']),
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
});

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
        charges: {
          create: 'POST /api/v1/charges',
          get: 'GET /api/v1/charges/:id',
          list: 'GET /api/v1/charges',
        },
        balance: {
          get: 'GET /api/v1/balance',
        },
      },
    });
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

      const rates = getEffectiveRates(customRates ? {
        pix_rate: customRates.pix_rate ? Number(customRates.pix_rate) : undefined,
        card_rate: customRates.card_rate ? Number(customRates.card_rate) : undefined,
      } : null);

      const description = body.description || 'Cobrança via API';
      let payment: any;
      let chargeData: any = {};

      // ========== PIX ==========
      if (body.billing_type === 'PIX') {
        const pixResult = await createPixCharge({
          value: body.value,
          description,
          customerCpf: body.customer?.cpf_cnpj,
          customerName: body.customer?.name,
        });

        if (!pixResult.success) {
          return reply.status(400).send({
            error: pixResult.error,
            code: 'PIX_CREATION_FAILED',
          });
        }

        const feeCalc = calculatePixFeeSellerPays(body.value, rates);

        payment = await prisma.payment.create({
          data: {
            user_id: user.id,
            billing_type: 'PIX',
            value: body.value,
            net_value: feeCalc.netValue,
            status: 'PENDING',
            description,
            due_date: body.due_date ? new Date(body.due_date) : new Date(),
            efi_txid: pixResult.txid,
            pix_qrcode: pixResult.pixQrCode,
            pix_copy_paste: pixResult.pixCode,
            asaas_payment_id: pixResult.txid,
            metadata: {
              external_reference: body.external_reference,
              callback_url: body.callback_url,
              platform_fee: feeCalc.platformFee,
              created_via: 'api',
            },
          },
        });

        chargeData = {
          id: payment.id,
          object: 'charge',
          billing_type: 'PIX',
          status: 'PENDING',
          value: body.value,
          net_value: feeCalc.netValue,
          platform_fee: feeCalc.platformFee,
          pix: {
            txid: pixResult.txid,
            qr_code: pixResult.pixQrCode,
            copy_paste: pixResult.pixCode,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
          created_at: payment.created_at,
        };
      }

      // ========== CARTÃO (gera link) ==========
      else if (body.billing_type === 'CREDIT_CARD') {
        const chargeResult = await createCardCharge({
          value: body.value,
          description,
        });

        if (!chargeResult.success) {
          return reply.status(400).send({
            error: chargeResult.error,
            code: 'CARD_CHARGE_CREATION_FAILED',
          });
        }

        // Gerar link de pagamento
        const linkResult = await createEfiPaymentLink(chargeResult.chargeId!);

        const feeCalc = calculateCardFeeSellerPays(body.value, 1, rates);

        payment = await prisma.payment.create({
          data: {
            user_id: user.id,
            billing_type: 'CREDIT_CARD',
            value: body.value,
            net_value: feeCalc.netValue,
            status: 'PENDING',
            description,
            due_date: body.due_date ? new Date(body.due_date) : new Date(),
            efi_charge_id: chargeResult.chargeId!.toString(),
            asaas_payment_id: chargeResult.chargeId!.toString(),
            metadata: {
              external_reference: body.external_reference,
              callback_url: body.callback_url,
              platform_fee: feeCalc.platformFee,
              payment_url: linkResult.success ? linkResult.paymentUrl : null,
              created_via: 'api',
            },
          },
        });

        chargeData = {
          id: payment.id,
          object: 'charge',
          billing_type: 'CREDIT_CARD',
          status: 'PENDING',
          value: body.value,
          net_value: feeCalc.netValue,
          platform_fee: feeCalc.platformFee,
          payment_url: linkResult.success ? linkResult.paymentUrl : null,
          charge_id: chargeResult.chargeId,
          created_at: payment.created_at,
        };
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
}

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import {
  authenticate,
  standardRateLimit,
  createResourceRateLimit,
  checkoutRateLimit,
} from '../../middlewares';

export async function couponsRoutes(app: FastifyInstance) {
  // ========== ROTAS DO SELLER (autenticado) ==========

  // Listar cupons do seller
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const coupons = await prisma.coupon.findMany({
      where: { user_id: decoded.id },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ success: true, coupons });
  });

  // Criar cupom
  app.post('/', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const schema = z.object({
      code: z.string().min(2).max(50).transform(v => v.toUpperCase().trim()),
      discountType: z.enum(['percentage', 'fixed']),
      discountValue: z.number().positive(),
      maxUses: z.number().int().positive().optional(),
      minValue: z.number().positive().optional(),
      maxDiscount: z.number().positive().optional(),
      productId: z.string().uuid().optional(),
      startsAt: z.string().optional(),
      expiresAt: z.string().optional(),
      active: z.boolean().optional(),
    });

    const body = schema.parse(request.body);

    // Validar desconto percentual max 100%
    if (body.discountType === 'percentage' && body.discountValue > 100) {
      return reply.status(400).send({ error: 'Desconto percentual não pode ser maior que 100%' });
    }

    // Verificar se código já existe para este seller
    const existing = await prisma.coupon.findUnique({
      where: { user_id_code: { user_id: decoded.id, code: body.code } },
    });

    if (existing) {
      return reply.status(400).send({ error: 'Já existe um cupom com este código' });
    }

    // Verificar se produto pertence ao seller (se informado)
    if (body.productId) {
      const product = await prisma.product.findFirst({
        where: { id: body.productId, user_id: decoded.id },
      });
      if (!product) {
        return reply.status(400).send({ error: 'Produto não encontrado' });
      }
    }

    const coupon = await prisma.coupon.create({
      data: {
        user_id: decoded.id,
        code: body.code,
        discount_type: body.discountType,
        discount_value: body.discountValue,
        max_uses: body.maxUses || null,
        min_value: body.minValue || null,
        max_discount: body.maxDiscount || null,
        product_id: body.productId || null,
        starts_at: body.startsAt ? new Date(body.startsAt) : null,
        expires_at: body.expiresAt ? new Date(body.expiresAt) : null,
        active: body.active ?? true,
      },
      include: { product: { select: { id: true, name: true } } },
    });

    return reply.status(201).send({ success: true, coupon });
  });

  // Atualizar cupom
  app.put('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const coupon = await prisma.coupon.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!coupon) {
      return reply.status(404).send({ error: 'Cupom não encontrado' });
    }

    const schema = z.object({
      code: z.string().min(2).max(50).transform(v => v.toUpperCase().trim()).optional(),
      discountType: z.enum(['percentage', 'fixed']).optional(),
      discountValue: z.number().positive().optional(),
      maxUses: z.number().int().positive().nullable().optional(),
      minValue: z.number().positive().nullable().optional(),
      maxDiscount: z.number().positive().nullable().optional(),
      productId: z.string().uuid().nullable().optional(),
      startsAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
      active: z.boolean().optional(),
    });

    const body = schema.parse(request.body);

    // Verificar se novo código já existe (se mudou)
    if (body.code && body.code !== coupon.code) {
      const existing = await prisma.coupon.findUnique({
        where: { user_id_code: { user_id: decoded.id, code: body.code } },
      });
      if (existing) {
        return reply.status(400).send({ error: 'Já existe um cupom com este código' });
      }
    }

    const updated = await prisma.coupon.update({
      where: { id },
      data: {
        ...(body.code !== undefined && { code: body.code }),
        ...(body.discountType !== undefined && { discount_type: body.discountType }),
        ...(body.discountValue !== undefined && { discount_value: body.discountValue }),
        ...(body.maxUses !== undefined && { max_uses: body.maxUses }),
        ...(body.minValue !== undefined && { min_value: body.minValue }),
        ...(body.maxDiscount !== undefined && { max_discount: body.maxDiscount }),
        ...(body.productId !== undefined && { product_id: body.productId }),
        ...(body.startsAt !== undefined && { starts_at: body.startsAt ? new Date(body.startsAt) : null }),
        ...(body.expiresAt !== undefined && { expires_at: body.expiresAt ? new Date(body.expiresAt) : null }),
        ...(body.active !== undefined && { active: body.active }),
        updated_at: new Date(),
      },
      include: { product: { select: { id: true, name: true } } },
    });

    return reply.send({ success: true, coupon: updated });
  });

  // Deletar cupom
  app.delete('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const coupon = await prisma.coupon.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!coupon) {
      return reply.status(404).send({ error: 'Cupom não encontrado' });
    }

    await prisma.coupon.delete({ where: { id } });

    return reply.send({ success: true });
  });

  // ========== ROTA PÚBLICA - Validar cupom no checkout ==========

  app.post('/validate', {
    preHandler: [checkoutRateLimit],
  }, async (request, reply) => {
    const schema = z.object({
      code: z.string().min(1).transform(v => v.toUpperCase().trim()),
      linkId: z.string().uuid(),
    });

    const body = schema.parse(request.body);

    // Buscar o link para saber o seller e produto
    const link = await prisma.paymentLink.findFirst({
      where: { id: body.linkId, active: true },
    });

    if (!link) {
      return reply.status(404).send({ success: false, error: 'Link não encontrado' });
    }

    // Buscar cupom do seller com o código
    const coupon = await prisma.coupon.findUnique({
      where: { user_id_code: { user_id: link.user_id, code: body.code } },
    });

    if (!coupon || !coupon.active) {
      return reply.status(404).send({ success: false, error: 'Cupom inválido ou expirado' });
    }

    // Verificar data de início
    if (coupon.starts_at && new Date() < coupon.starts_at) {
      return reply.status(400).send({ success: false, error: 'Cupom ainda não está ativo' });
    }

    // Verificar expiração
    if (coupon.expires_at && new Date() > coupon.expires_at) {
      return reply.status(400).send({ success: false, error: 'Cupom expirado' });
    }

    // Verificar limite de uso
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
      return reply.status(400).send({ success: false, error: 'Cupom esgotado' });
    }

    // Verificar produto específico
    if (coupon.product_id && link.product_id && coupon.product_id !== link.product_id) {
      return reply.status(400).send({ success: false, error: 'Cupom não válido para este produto' });
    }

    // Verificar valor mínimo
    const orderValue = Number(link.amount);
    if (coupon.min_value && orderValue < Number(coupon.min_value)) {
      return reply.status(400).send({
        success: false,
        error: `Valor mínimo para este cupom: R$ ${Number(coupon.min_value).toFixed(2)}`,
      });
    }

    // Calcular desconto
    let discountAmount: number;
    if (coupon.discount_type === 'percentage') {
      discountAmount = orderValue * (Number(coupon.discount_value) / 100);
      // Aplicar teto se existir
      if (coupon.max_discount && discountAmount > Number(coupon.max_discount)) {
        discountAmount = Number(coupon.max_discount);
      }
    } else {
      discountAmount = Number(coupon.discount_value);
    }

    // Desconto não pode ser maior que o valor
    discountAmount = Math.min(discountAmount, orderValue);
    discountAmount = Math.round(discountAmount * 100) / 100;

    const finalValue = Math.round((orderValue - discountAmount) * 100) / 100;

    return reply.send({
      success: true,
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: Number(coupon.discount_value),
        discountAmount,
        finalValue,
        originalValue: orderValue,
      },
    });
  });
}

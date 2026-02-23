import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';

const createOrderBumpSchema = z.object({
  productId: z.string().transform(String),
  bumpProductId: z.string().transform(String),
  name: z.string().min(1),
  description: z.string().optional(),
  price: z.number().positive(),
  originalPrice: z.number().positive().optional(),
  discountType: z.enum(['percentage', 'fixed']).default('percentage'),
  discountValue: z.number().default(0),
  showInCheckout: z.boolean().default(true),
  showImage: z.boolean().default(true),
  position: z.number().default(0),
  minQuantity: z.number().default(1),
  active: z.boolean().default(true),
});

export async function orderBumpRoutes(app: FastifyInstance) {
  // Listar orderbumps do usuário
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const orderBumps = await prisma.orderBump.findMany({
      where: { user_id: decoded.id },
      include: {
        product: {
          select: { id: true, name: true, price: true, image_url: true }
        },
        bump_product: {
          select: { id: true, name: true, price: true, image_url: true }
        },
      },
      orderBy: { position: 'asc' },
    });

    return reply.send({ success: true, orderBumps });
  });

  // Listar orderbumps de um produto (público)
  app.get('/product/:productId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { productId } = request.params as { productId: string };

    const orderBumps = await prisma.orderBump.findMany({
      where: {
        product_id: productId,
        show_in_checkout: true,
        active: true,
      },
      include: {
        bump_product: {
          select: { 
            id: true, 
            name: true, 
            price: true, 
            image_url: true,
            description: true,
          }
        },
      },
      orderBy: { position: 'asc' },
    });

    return reply.send({ success: true, orderBumps });
  });

  // Obter orderbump por ID
  app.get('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const orderBump = await prisma.orderBump.findFirst({
      where: { id, user_id: decoded.id },
      include: {
        product: true,
        bump_product: true,
      },
    });

    if (!orderBump) {
      return reply.status(404).send({ error: 'OrderBump não encontrado' });
    }

    return reply.send({ success: true, orderBump });
  });

  // Criar orderbump
  app.post('/', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = createOrderBumpSchema.parse(request.body);

    // Verificar se os produtos pertencem ao usuário
    const [mainProduct, bumpProduct] = await Promise.all([
      prisma.product.findFirst({ where: { id: body.productId, user_id: decoded.id } }),
      prisma.product.findFirst({ where: { id: body.bumpProductId, user_id: decoded.id } }),
    ]);

    if (!mainProduct) {
      return reply.status(400).send({ error: 'Produto principal não encontrado' });
    }
    if (!bumpProduct) {
      return reply.status(400).send({ error: 'Produto do orderbump não encontrado' });
    }

    const orderBump = await prisma.orderBump.create({
      data: {
        user_id: decoded.id,
        product_id: body.productId,
        bump_product_id: body.bumpProductId,
        name: body.name,
        description: body.description,
        price: body.price,
        original_price: body.originalPrice,
        discount_type: body.discountType,
        discount_value: body.discountValue,
        show_in_checkout: body.showInCheckout,
        show_image: body.showImage,
        position: body.position,
        min_quantity: body.minQuantity,
        active: body.active,
      },
    });

    return reply.status(201).send({ success: true, orderBump });
  });

  // Atualizar orderbump
  app.put('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const body = request.body as any;

    // Verificar se o orderbump pertence ao usuário
    const existing = await prisma.orderBump.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'OrderBump não encontrado' });
    }

    const orderBump = await prisma.orderBump.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.price && { price: body.price }),
        ...(body.originalPrice && { original_price: body.originalPrice }),
        ...(body.discountType && { discount_type: body.discountType }),
        ...(body.discountValue !== undefined && { discount_value: body.discountValue }),
        ...(body.showInCheckout !== undefined && { show_in_checkout: body.showInCheckout }),
        ...(body.showImage !== undefined && { show_image: body.showImage }),
        ...(body.position !== undefined && { position: body.position }),
        ...(body.minQuantity !== undefined && { min_quantity: body.minQuantity }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.bumpProductId && { bump_product_id: body.bumpProductId }),
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, orderBump });
  });

  // Deletar orderbump
  app.delete('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const existing = await prisma.orderBump.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'OrderBump não encontrado' });
    }

    await prisma.orderBump.delete({
      where: { id },
    });

    return reply.send({ success: true, message: 'OrderBump deletado' });
  });
}

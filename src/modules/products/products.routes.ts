import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  subtitle: z.string().optional(),
  price: z.number().positive(),
  image_url: z.string().optional(),
  cover_url: z.string().optional(),
  stock: z.number().optional(),
  fee_payer: z.enum(['seller', 'buyer']).optional(),
  is_subscription: z.boolean().optional(),
  product_type: z.enum(['link', 'infoproduct']).optional(),
  member_area_enabled: z.boolean().optional(),
  support_email: z.string().email().optional().or(z.literal('')),
  welcome_message: z.string().optional(),
});

export async function productsRoutes(app: FastifyInstance) {
  // Listar produtos do usuário
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const products = await prisma.product.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ success: true, products });
  });

  // Criar produto
  app.post('/', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const parsed = createProductSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message || 'Dados inválidos';
      return reply.status(400).send({ success: false, error: firstError, message: firstError });
    }
    const body = parsed.data;

    const product = await prisma.product.create({
      data: {
        user_id: decoded.id,
        name: body.name,
        description: body.description,
        subtitle: body.subtitle,
        price: body.price,
        image_url: body.image_url,
        cover_url: body.cover_url,
        stock: body.stock,
        fee_payer: body.fee_payer || 'seller',
        is_subscription: body.is_subscription || false,
        product_type: body.product_type || 'link',
        member_area_enabled:
          body.member_area_enabled ?? body.product_type === 'infoproduct',
        support_email: body.support_email || null,
        welcome_message: body.welcome_message || null,
      },
    });

    return reply.status(201).send({ success: true, product });
  });

  // Obter produto por ID
  app.get('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const product = await prisma.product.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!product) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    return reply.send({ success: true, product });
  });

  // Atualizar produto
  app.put('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const product = await prisma.product.updateMany({
      where: { id, user_id: decoded.id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.subtitle !== undefined && { subtitle: body.subtitle }),
        ...(body.price && { price: body.price }),
        ...(body.image_url !== undefined && { image_url: body.image_url }),
        ...(body.cover_url !== undefined && { cover_url: body.cover_url }),
        ...(body.stock !== undefined && { stock: body.stock }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.fee_payer && { fee_payer: body.fee_payer }),
        ...(body.is_subscription !== undefined && { is_subscription: body.is_subscription }),
        ...(body.product_type && { product_type: body.product_type }),
        ...(body.member_area_enabled !== undefined && { member_area_enabled: body.member_area_enabled }),
        ...(body.support_email !== undefined && { support_email: body.support_email || null }),
        ...(body.welcome_message !== undefined && { welcome_message: body.welcome_message || null }),
        updated_at: new Date(),
      },
    });

    if (product.count === 0) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    const updated = await prisma.product.findUnique({ where: { id } });
    return reply.send({ success: true, product: updated });
  });

  // Deletar produto
  app.delete('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const result = await prisma.product.deleteMany({
      where: { id, user_id: decoded.id },
    });

    if (result.count === 0) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    return reply.send({ success: true, message: 'Produto deletado' });
  });
}

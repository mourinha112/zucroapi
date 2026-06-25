import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

// ============================================
// Helpers
// ============================================

async function ensureProductOwner(productId: string, userId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, user_id: userId },
  });
  return product;
}

async function ensureModuleOwner(moduleId: string, userId: string) {
  const mod = await prisma.productModule.findUnique({
    where: { id: moduleId },
    include: { product: true },
  });
  if (!mod || mod.product.user_id !== userId) return null;
  return mod;
}

async function ensureLessonOwner(lessonId: string, userId: string) {
  const lesson = await prisma.productLesson.findUnique({
    where: { id: lessonId },
    include: { module: { include: { product: true } } },
  });
  if (!lesson || lesson.module.product.user_id !== userId) return null;
  return lesson;
}

// ============================================
// Validation schemas
// ============================================

const moduleSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  cover_url: z.string().optional().nullable(),
  position: z.number().int().optional(),
  active: z.boolean().optional(),
});

const lessonSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  video_provider: z.enum(['youtube', 'vimeo', 'panda', 'url', 'upload']).optional().nullable(),
  video_url: z.string().optional().nullable(),
  duration_seconds: z.number().int().optional().nullable(),
  position: z.number().int().optional(),
  is_free: z.boolean().optional(),
  active: z.boolean().optional(),
});

const materialSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().max(20).optional(),
  file_url: z.string().min(1),
  size_bytes: z.number().int().optional().nullable(),
  position: z.number().int().optional(),
});

const classSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional().nullable(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  max_seats: z.number().int().optional().nullable(),
  active: z.boolean().optional(),
});

const pixelSchema = z.object({
  platform: z.string().min(1).max(30),
  pixel_id: z.string().optional().nullable(),
  access_token: z.string().optional().nullable(),
  events: z.any().optional(),
  active: z.boolean().optional(),
});

const waitlistSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional().nullable(),
  metadata: z.any().optional(),
});

// ============================================
// Routes
// Mounted at /api/products/:productId/...
// ============================================

export async function memberAreaRoutes(app: FastifyInstance) {
  // ----------------------------------------
  // MODULES
  // ----------------------------------------

  app.get('/:productId/modules', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const modules = await prisma.productModule.findMany({
      where: { product_id: productId },
      orderBy: { position: 'asc' },
      include: {
        lessons: {
          orderBy: { position: 'asc' },
          include: { materials: { orderBy: { position: 'asc' } } },
        },
      },
    });

    return reply.send({ success: true, modules });
  });

  app.post('/:productId/modules', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const parsed = moduleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const last = await prisma.productModule.findFirst({
      where: { product_id: productId },
      orderBy: { position: 'desc' },
    });

    const mod = await prisma.productModule.create({
      data: {
        product_id: productId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        cover_url: parsed.data.cover_url ?? null,
        position: parsed.data.position ?? (last ? last.position + 1 : 0),
        active: parsed.data.active ?? true,
      },
    });

    // Auto-enable member area on first module
    if (!product.member_area_enabled) {
      await prisma.product.update({
        where: { id: productId },
        data: { member_area_enabled: true, product_type: 'infoproduct' },
      });
    }

    return reply.status(201).send({ success: true, module: mod });
  });

  app.put('/:productId/modules/:moduleId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { moduleId } = request.params as { productId: string; moduleId: string };

    const mod = await ensureModuleOwner(moduleId, decoded.id);
    if (!mod) return reply.status(404).send({ error: 'Módulo não encontrado' });

    const parsed = moduleSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const updated = await prisma.productModule.update({
      where: { id: moduleId },
      data: { ...parsed.data, updated_at: new Date() },
    });

    return reply.send({ success: true, module: updated });
  });

  app.delete('/:productId/modules/:moduleId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { moduleId } = request.params as { productId: string; moduleId: string };

    const mod = await ensureModuleOwner(moduleId, decoded.id);
    if (!mod) return reply.status(404).send({ error: 'Módulo não encontrado' });

    await prisma.productModule.delete({ where: { id: moduleId } });
    return reply.send({ success: true });
  });

  // Reorder all modules at once
  app.post('/:productId/modules/reorder', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };
    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const body = request.body as { ids?: string[] };
    if (!Array.isArray(body.ids)) {
      return reply.status(400).send({ error: 'ids[] obrigatório' });
    }

    await prisma.$transaction(
      body.ids.map((id, idx) =>
        prisma.productModule.updateMany({
          where: { id, product_id: productId },
          data: { position: idx },
        })
      )
    );
    return reply.send({ success: true });
  });

  // ----------------------------------------
  // LESSONS
  // ----------------------------------------

  app.post('/:productId/modules/:moduleId/lessons', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { moduleId } = request.params as { productId: string; moduleId: string };

    const mod = await ensureModuleOwner(moduleId, decoded.id);
    if (!mod) return reply.status(404).send({ error: 'Módulo não encontrado' });

    const parsed = lessonSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const last = await prisma.productLesson.findFirst({
      where: { module_id: moduleId },
      orderBy: { position: 'desc' },
    });

    const lesson = await prisma.productLesson.create({
      data: {
        module_id: moduleId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        video_provider: parsed.data.video_provider ?? null,
        video_url: parsed.data.video_url ?? null,
        duration_seconds: parsed.data.duration_seconds ?? null,
        position: parsed.data.position ?? (last ? last.position + 1 : 0),
        is_free: parsed.data.is_free ?? false,
        active: parsed.data.active ?? true,
      },
    });

    return reply.status(201).send({ success: true, lesson });
  });

  app.put('/:productId/lessons/:lessonId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { lessonId } = request.params as { productId: string; lessonId: string };

    const lesson = await ensureLessonOwner(lessonId, decoded.id);
    if (!lesson) return reply.status(404).send({ error: 'Aula não encontrada' });

    const parsed = lessonSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const updated = await prisma.productLesson.update({
      where: { id: lessonId },
      data: { ...parsed.data, updated_at: new Date() },
    });

    return reply.send({ success: true, lesson: updated });
  });

  app.delete('/:productId/lessons/:lessonId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { lessonId } = request.params as { productId: string; lessonId: string };

    const lesson = await ensureLessonOwner(lessonId, decoded.id);
    if (!lesson) return reply.status(404).send({ error: 'Aula não encontrada' });

    await prisma.productLesson.delete({ where: { id: lessonId } });
    return reply.send({ success: true });
  });

  // ----------------------------------------
  // MATERIALS
  // ----------------------------------------

  app.post('/:productId/lessons/:lessonId/materials', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { lessonId } = request.params as { productId: string; lessonId: string };

    const lesson = await ensureLessonOwner(lessonId, decoded.id);
    if (!lesson) return reply.status(404).send({ error: 'Aula não encontrada' });

    const parsed = materialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const last = await prisma.productLessonMaterial.findFirst({
      where: { lesson_id: lessonId },
      orderBy: { position: 'desc' },
    });

    const material = await prisma.productLessonMaterial.create({
      data: {
        lesson_id: lessonId,
        name: parsed.data.name,
        type: parsed.data.type || 'file',
        file_url: parsed.data.file_url,
        size_bytes: parsed.data.size_bytes ?? null,
        position: parsed.data.position ?? (last ? last.position + 1 : 0),
      },
    });

    return reply.status(201).send({ success: true, material });
  });

  app.delete('/:productId/materials/:materialId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { materialId } = request.params as { productId: string; materialId: string };

    const material = await prisma.productLessonMaterial.findUnique({
      where: { id: materialId },
      include: { lesson: { include: { module: { include: { product: true } } } } },
    });
    if (!material || material.lesson.module.product.user_id !== decoded.id) {
      return reply.status(404).send({ error: 'Material não encontrado' });
    }

    await prisma.productLessonMaterial.delete({ where: { id: materialId } });
    return reply.send({ success: true });
  });

  // ----------------------------------------
  // CLASSES (Turmas)
  // ----------------------------------------

  app.get('/:productId/classes', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const classes = await prisma.productClass.findMany({
      where: { product_id: productId },
      orderBy: { created_at: 'desc' },
    });
    return reply.send({ success: true, classes });
  });

  app.post('/:productId/classes', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const parsed = classSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const created = await prisma.productClass.create({
      data: {
        product_id: productId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        start_date: parsed.data.start_date ? new Date(parsed.data.start_date) : null,
        end_date: parsed.data.end_date ? new Date(parsed.data.end_date) : null,
        max_seats: parsed.data.max_seats ?? null,
        active: parsed.data.active ?? true,
      },
    });
    return reply.status(201).send({ success: true, class: created });
  });

  app.put('/:productId/classes/:classId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, classId } = request.params as { productId: string; classId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const parsed = classSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const updated = await prisma.productClass.updateMany({
      where: { id: classId, product_id: productId },
      data: {
        ...(parsed.data.name && { name: parsed.data.name }),
        ...(parsed.data.description !== undefined && { description: parsed.data.description ?? null }),
        ...(parsed.data.start_date !== undefined && { start_date: parsed.data.start_date ? new Date(parsed.data.start_date) : null }),
        ...(parsed.data.end_date !== undefined && { end_date: parsed.data.end_date ? new Date(parsed.data.end_date) : null }),
        ...(parsed.data.max_seats !== undefined && { max_seats: parsed.data.max_seats ?? null }),
        ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      },
    });
    if (updated.count === 0) return reply.status(404).send({ error: 'Turma não encontrada' });
    const cls = await prisma.productClass.findUnique({ where: { id: classId } });
    return reply.send({ success: true, class: cls });
  });

  app.delete('/:productId/classes/:classId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, classId } = request.params as { productId: string; classId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    await prisma.productClass.deleteMany({
      where: { id: classId, product_id: productId },
    });
    return reply.send({ success: true });
  });

  // ----------------------------------------
  // TRACKING PIXELS
  // ----------------------------------------

  app.get('/:productId/pixels', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const pixels = await prisma.productTrackingPixel.findMany({
      where: { product_id: productId },
      orderBy: { created_at: 'desc' },
    });
    return reply.send({ success: true, pixels });
  });

  app.post('/:productId/pixels', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const parsed = pixelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    const created = await prisma.productTrackingPixel.create({
      data: {
        product_id: productId,
        platform: parsed.data.platform,
        pixel_id: parsed.data.pixel_id ?? null,
        access_token: parsed.data.access_token ?? null,
        events: parsed.data.events ?? null,
        active: parsed.data.active ?? true,
      },
    });
    return reply.status(201).send({ success: true, pixel: created });
  });

  app.delete('/:productId/pixels/:pixelId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, pixelId } = request.params as { productId: string; pixelId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    await prisma.productTrackingPixel.deleteMany({
      where: { id: pixelId, product_id: productId },
    });
    return reply.send({ success: true });
  });

  // ----------------------------------------
  // WAITLIST
  // ----------------------------------------

  app.get('/:productId/waitlist', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const waitlist = await prisma.productWaitlist.findMany({
      where: { product_id: productId },
      orderBy: { created_at: 'desc' },
    });
    return reply.send({ success: true, waitlist });
  });

  app.delete('/:productId/waitlist/:entryId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, entryId } = request.params as { productId: string; entryId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    await prisma.productWaitlist.deleteMany({
      where: { id: entryId, product_id: productId },
    });
    return reply.send({ success: true });
  });

  // Public endpoint (no auth) — basic product info for public landing/waitlist page
  app.get('/:productId/public', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        subtitle: true,
        description: true,
        image_url: true,
        cover_url: true,
        price: true,
        member_area_enabled: true,
        product_type: true,
        active: true,
      },
    });
    if (!product || !product.active) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    // Buscar link de pagamento ativo mais recente para este produto
    const link = await prisma.paymentLink.findFirst({
      where: { product_id: productId, active: true },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });

    return reply.send({
      success: true,
      product,
      checkout_link_id: link?.id ?? null,
    });
  });

  // Public endpoint (no auth) — anyone with the link can subscribe
  app.post('/:productId/waitlist/public', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const parsed = waitlistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0]?.message });
    }

    try {
      const entry = await prisma.productWaitlist.create({
        data: {
          product_id: productId,
          name: parsed.data.name,
          email: parsed.data.email,
          phone: parsed.data.phone ?? null,
          metadata: parsed.data.metadata ?? null,
        },
      });
      return reply.status(201).send({ success: true, entry });
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.status(200).send({ success: true, message: 'Já cadastrado' });
      }
      throw err;
    }
  });

  // ----------------------------------------
  // MEMBERS (buyers with access)
  // ----------------------------------------

  app.get('/:productId/members', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const accesses = await prisma.productMemberAccess.findMany({
      where: { product_id: productId },
      include: {
        class: true,
        progress: { select: { lesson_id: true, completed: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const members = accesses.map((a) => ({
      id: a.id,
      buyer_email: a.buyer_email,
      buyer_name: a.buyer_name,
      buyer_phone: a.buyer_phone,
      access_token: a.access_token,
      class_name: a.class?.name || null,
      class_id: a.class_id,
      active: a.active,
      created_at: a.created_at,
      last_access_at: a.last_access_at,
      lessons_completed: a.progress.filter((p) => p.completed).length,
    }));

    return reply.send({ success: true, members });
  });

  // Manually create a member access (e.g., gift access without payment)
  app.post('/:productId/members', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    const body = request.body as {
      email: string;
      name?: string;
      phone?: string;
      class_id?: string;
    };
    if (!body.email) return reply.status(400).send({ error: 'email obrigatório' });

    const access = await prisma.productMemberAccess.create({
      data: {
        product_id: productId,
        buyer_email: body.email.toLowerCase(),
        buyer_name: body.name ?? null,
        buyer_phone: body.phone ?? null,
        class_id: body.class_id ?? null,
        access_token: crypto.randomBytes(24).toString('hex'),
      },
    });

    return reply.status(201).send({ success: true, access });
  });

  app.delete('/:productId/members/:accessId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, accessId } = request.params as { productId: string; accessId: string };

    const product = await ensureProductOwner(productId, decoded.id);
    if (!product) return reply.status(404).send({ error: 'Produto não encontrado' });

    await prisma.productMemberAccess.deleteMany({
      where: { id: accessId, product_id: productId },
    });
    return reply.send({ success: true });
  });
}

// ============================================
// PUBLIC member-area routes (for buyers)
// Mounted at /api/member-area/...
// Auth via access_token (UUID-like) sent in header X-Member-Token
// ============================================

export async function memberAreaPublicRoutes(app: FastifyInstance) {
  // Login via email — sends/returns access tokens for products this email purchased
  app.post('/login', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const body = request.body as { email?: string };
    if (!body.email) return reply.status(400).send({ error: 'email obrigatório' });
    const email = body.email.toLowerCase();

    // Fallback: para qualquer compra confirmada com este e-mail (em produto com área de
    // membros habilitada) que ainda não tenha acesso criado, criar agora.
    const confirmedPayments = await prisma.payment.findMany({
      where: {
        status: 'RECEIVED',
        OR: [
          { metadata: { path: ['customer_email'], equals: email } },
          { metadata: { path: ['buyer_email'], equals: email } },
        ],
      },
      include: { payment_link: { include: { product: true } } },
    });

    for (const p of confirmedPayments) {
      const product = p.payment_link?.product;
      if (!product || !product.member_area_enabled) continue;
      const existing = await prisma.productMemberAccess.findFirst({
        where: { product_id: product.id, buyer_email: email },
      });
      if (existing) continue;
      const meta = (p.metadata as any) || {};
      await prisma.productMemberAccess.create({
        data: {
          product_id: product.id,
          payment_id: p.id,
          buyer_email: email,
          buyer_name: meta.customer_name || null,
          buyer_phone: meta.customer_phone || null,
          access_token: crypto.randomBytes(24).toString('hex'),
        },
      });
    }

    const accesses = await prisma.productMemberAccess.findMany({
      where: { buyer_email: email, active: true },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            cover_url: true,
            image_url: true,
            description: true,
            subtitle: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({
      success: true,
      accesses: accesses.map((a) => ({
        access_token: a.access_token,
        product: a.product,
        created_at: a.created_at,
      })),
    });
  });

  // Get content for a single product (modules + lessons + materials + progress)
  app.get('/content/:accessToken', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken } = request.params as { accessToken: string };
    const access = await prisma.productMemberAccess.findUnique({
      where: { access_token: accessToken },
      include: {
        product: true,
        class: true,
        progress: true,
      },
    });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });

    const modules = await prisma.productModule.findMany({
      where: { product_id: access.product_id, active: true },
      orderBy: { position: 'asc' },
      include: {
        lessons: {
          where: { active: true },
          orderBy: { position: 'asc' },
          include: { materials: { orderBy: { position: 'asc' } } },
        },
      },
    });

    // touch last_access_at
    await prisma.productMemberAccess.update({
      where: { id: access.id },
      data: { last_access_at: new Date() },
    });

    const progressByLesson: Record<string, { completed: boolean; watched_seconds: number }> = {};
    for (const p of access.progress) {
      progressByLesson[p.lesson_id] = {
        completed: p.completed,
        watched_seconds: p.watched_seconds,
      };
    }

    return reply.send({
      success: true,
      product: {
        id: access.product.id,
        name: access.product.name,
        subtitle: access.product.subtitle,
        description: access.product.description,
        cover_url: access.product.cover_url,
        cover_video_url: access.product.cover_video_url,
        image_url: access.product.image_url,
        welcome_message: access.product.welcome_message,
        support_email: access.product.support_email,
      },
      class: access.class
        ? { id: access.class.id, name: access.class.name }
        : null,
      buyer: {
        email: access.buyer_email,
        name: access.buyer_name,
      },
      modules,
      progress: progressByLesson,
    });
  });

  // Mark lesson progress
  app.post('/progress/:accessToken/:lessonId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken, lessonId } = request.params as {
      accessToken: string;
      lessonId: string;
    };
    const body = request.body as { completed?: boolean; watched_seconds?: number };

    const access = await prisma.productMemberAccess.findUnique({
      where: { access_token: accessToken },
    });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });

    // make sure lesson belongs to this product
    const lesson = await prisma.productLesson.findUnique({
      where: { id: lessonId },
      include: { module: true },
    });
    if (!lesson || lesson.module.product_id !== access.product_id) {
      return reply.status(404).send({ error: 'Aula inválida' });
    }

    const updated = await prisma.productLessonProgress.upsert({
      where: {
        access_id_lesson_id: { access_id: access.id, lesson_id: lessonId },
      },
      create: {
        access_id: access.id,
        lesson_id: lessonId,
        completed: !!body.completed,
        watched_seconds: body.watched_seconds ?? 0,
        completed_at: body.completed ? new Date() : null,
      },
      update: {
        ...(body.completed !== undefined && {
          completed: body.completed,
          completed_at: body.completed ? new Date() : null,
        }),
        ...(body.watched_seconds !== undefined && { watched_seconds: body.watched_seconds }),
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, progress: updated });
  });

  // ============================================
  // COMENTÁRIOS E AVALIAÇÃO DAS AULAS
  // ============================================

  // Lista comentários de uma aula + avaliação do próprio membro e média
  app.get('/comments/:accessToken/:lessonId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken, lessonId } = request.params as { accessToken: string; lessonId: string };
    const access = await prisma.productMemberAccess.findUnique({ where: { access_token: accessToken } });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });
    const lesson = await prisma.productLesson.findUnique({ where: { id: lessonId }, include: { module: true } });
    if (!lesson || lesson.module.product_id !== access.product_id) {
      return reply.status(404).send({ error: 'Aula inválida' });
    }

    const comments = await prisma.lessonComment.findMany({
      where: { lesson_id: lessonId },
      orderBy: { created_at: 'asc' },
    });
    const myRating = await prisma.lessonRating.findUnique({
      where: { lesson_id_access_id: { lesson_id: lessonId, access_id: access.id } },
    });
    const agg = await prisma.lessonRating.aggregate({
      where: { lesson_id: lessonId },
      _avg: { rating: true },
      _count: true,
    });

    return reply.send({
      success: true,
      comments: comments.map((c) => ({
        id: c.id,
        author_name: c.author_name,
        is_admin: c.is_admin,
        message: c.message,
        parent_id: c.parent_id,
        created_at: c.created_at,
        mine: c.access_id === access.id,
      })),
      rating: {
        mine: myRating?.rating || 0,
        average: agg._avg.rating ? Number(agg._avg.rating) : 0,
        count: agg._count || 0,
      },
    });
  });

  // Cria um comentário (ou resposta, via parent_id)
  app.post('/comments/:accessToken/:lessonId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken, lessonId } = request.params as { accessToken: string; lessonId: string };
    const body = request.body as { message?: string; parent_id?: string };
    if (!body.message || !body.message.trim()) return reply.status(400).send({ error: 'Mensagem vazia' });
    if (body.message.length > 1050) return reply.status(400).send({ error: 'Mensagem muito longa (máx 1050)' });

    const access = await prisma.productMemberAccess.findUnique({ where: { access_token: accessToken } });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });
    const lesson = await prisma.productLesson.findUnique({ where: { id: lessonId }, include: { module: true } });
    if (!lesson || lesson.module.product_id !== access.product_id) {
      return reply.status(404).send({ error: 'Aula inválida' });
    }

    const comment = await prisma.lessonComment.create({
      data: {
        lesson_id: lessonId,
        product_id: access.product_id,
        access_id: access.id,
        author_name: access.buyer_name || access.buyer_email.split('@')[0],
        author_email: access.buyer_email,
        message: body.message.trim(),
        parent_id: body.parent_id || null,
      },
    });

    return reply.send({
      success: true,
      comment: {
        id: comment.id,
        author_name: comment.author_name,
        is_admin: comment.is_admin,
        message: comment.message,
        parent_id: comment.parent_id,
        created_at: comment.created_at,
        mine: true,
      },
    });
  });

  // Remove um comentário próprio
  app.delete('/comments/:accessToken/:commentId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken, commentId } = request.params as { accessToken: string; commentId: string };
    const access = await prisma.productMemberAccess.findUnique({ where: { access_token: accessToken } });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });
    const comment = await prisma.lessonComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.access_id !== access.id) {
      return reply.status(404).send({ error: 'Comentário não encontrado' });
    }
    await prisma.lessonComment.delete({ where: { id: commentId } });
    return reply.send({ success: true });
  });

  // Avalia a aula (1 a 5 estrelas) — uma avaliação por membro
  app.post('/rating/:accessToken/:lessonId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { accessToken, lessonId } = request.params as { accessToken: string; lessonId: string };
    const body = request.body as { rating?: number };
    const rating = Math.round(Number(body.rating));
    if (!rating || rating < 1 || rating > 5) return reply.status(400).send({ error: 'Nota inválida' });

    const access = await prisma.productMemberAccess.findUnique({ where: { access_token: accessToken } });
    if (!access || !access.active) return reply.status(404).send({ error: 'Acesso inválido' });
    const lesson = await prisma.productLesson.findUnique({ where: { id: lessonId }, include: { module: true } });
    if (!lesson || lesson.module.product_id !== access.product_id) {
      return reply.status(404).send({ error: 'Aula inválida' });
    }

    await prisma.lessonRating.upsert({
      where: { lesson_id_access_id: { lesson_id: lessonId, access_id: access.id } },
      create: { lesson_id: lessonId, access_id: access.id, rating },
      update: { rating, updated_at: new Date() },
    });
    const agg = await prisma.lessonRating.aggregate({
      where: { lesson_id: lessonId },
      _avg: { rating: true },
      _count: true,
    });

    return reply.send({
      success: true,
      rating: { mine: rating, average: agg._avg.rating ? Number(agg._avg.rating) : 0, count: agg._count || 0 },
    });
  });
}

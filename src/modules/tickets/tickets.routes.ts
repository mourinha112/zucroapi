import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, authenticateAdmin, standardRateLimit, createResourceRateLimit } from '../../middlewares';

export async function ticketsRoutes(app: FastifyInstance) {

  // ============================================
  // ROTAS DO USUÁRIO (SELLER)
  // ============================================

  // Listar tickets do usuário
  app.get('/', {
    preHandler: [authenticate, standardRateLimit],
  }, async (request, reply) => {
    const userId = request.currentUser!.id;

    const tickets = await prisma.ticket.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { messages: true } },
      },
    });

    return reply.send({ success: true, tickets });
  });

  // Criar ticket
  app.post('/', {
    preHandler: [authenticate, createResourceRateLimit],
  }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const { subject, category, priority, description } = request.body as {
      subject: string;
      category?: string;
      priority?: string;
      description: string;
    };

    if (!subject || !description) {
      return reply.status(400).send({ success: false, error: 'Assunto e descrição são obrigatórios' });
    }

    const ticket = await prisma.ticket.create({
      data: {
        user_id: userId,
        subject,
        category: category || 'support',
        priority: priority || 'normal',
        description,
      },
    });

    return reply.status(201).send({ success: true, ticket });
  });

  // Ver ticket com mensagens
  app.get('/:ticketId', {
    preHandler: [authenticate, standardRateLimit],
  }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const { ticketId } = request.params as { ticketId: string };

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, user_id: userId },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!ticket) {
      return reply.status(404).send({ success: false, error: 'Ticket não encontrado' });
    }

    return reply.send({ success: true, ticket });
  });

  // Enviar mensagem no ticket
  app.post('/:ticketId/messages', {
    preHandler: [authenticate, standardRateLimit],
  }, async (request, reply) => {
    const userId = request.currentUser!.id;
    const { ticketId } = request.params as { ticketId: string };
    const { message } = request.body as { message: string };

    if (!message) {
      return reply.status(400).send({ success: false, error: 'Mensagem é obrigatória' });
    }

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, user_id: userId },
    });

    if (!ticket) {
      return reply.status(404).send({ success: false, error: 'Ticket não encontrado' });
    }

    const ticketMessage = await prisma.ticketMessage.create({
      data: {
        ticket_id: ticketId,
        user_id: userId,
        message,
        is_admin: false,
      },
    });

    // Reabrir ticket se estava resolved
    if (ticket.status === 'resolved') {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: 'open', updated_at: new Date() },
      });
    }

    return reply.status(201).send({ success: true, message: ticketMessage });
  });

  // ============================================
  // ROTAS DO ADMIN
  // ============================================

  // Listar todos os tickets
  app.get('/admin/all', {
    preHandler: [authenticateAdmin, standardRateLimit],
  }, async (request, reply) => {
    const { status, priority, category } = request.query as {
      status?: string;
      priority?: string;
      category?: string;
    };

    const where: any = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (category) where.category = category;

    const tickets = await prisma.ticket.findMany({
      where,
      orderBy: [
        { status: 'asc' },
        { created_at: 'desc' },
      ],
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        _count: { select: { messages: true } },
      },
    });

    return reply.send({ success: true, tickets });
  });

  // Admin ver ticket com mensagens
  app.get('/admin/:ticketId', {
    preHandler: [authenticateAdmin, standardRateLimit],
  }, async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        messages: {
          orderBy: { created_at: 'asc' },
        },
      },
    });

    if (!ticket) {
      return reply.status(404).send({ success: false, error: 'Ticket não encontrado' });
    }

    return reply.send({ success: true, ticket });
  });

  // Admin responder ticket
  app.post('/admin/:ticketId/messages', {
    preHandler: [authenticateAdmin, standardRateLimit],
  }, async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };
    const { message } = request.body as { message: string };
    const adminId = request.currentUser!.id;

    if (!message) {
      return reply.status(400).send({ success: false, error: 'Mensagem é obrigatória' });
    }

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return reply.status(404).send({ success: false, error: 'Ticket não encontrado' });
    }

    const ticketMessage = await prisma.ticketMessage.create({
      data: {
        ticket_id: ticketId,
        admin_id: adminId,
        message,
        is_admin: true,
      },
    });

    // Atualizar status para em andamento se estava open
    if (ticket.status === 'open') {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: 'in_progress', admin_id: adminId, updated_at: new Date() },
      });
    }

    return reply.status(201).send({ success: true, message: ticketMessage });
  });

  // Admin atualizar status do ticket
  app.patch('/admin/:ticketId/status', {
    preHandler: [authenticateAdmin, standardRateLimit],
  }, async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };
    const { status } = request.body as { status: string };

    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ success: false, error: 'Status inválido' });
    }

    const data: any = { status, updated_at: new Date() };
    if (status === 'resolved') data.resolved_at = new Date();
    if (status === 'closed') data.closed_at = new Date();

    const ticket = await prisma.ticket.update({
      where: { id: ticketId },
      data,
    });

    return reply.send({ success: true, ticket });
  });
}

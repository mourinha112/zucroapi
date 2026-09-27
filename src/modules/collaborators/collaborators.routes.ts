import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';
import { sendCollaboratorInvite } from '../auth/email.service';

/** Colaboradores da conta (Configurações → Colaboradores). Permissões = lista de chaves do front (PERM_GROUPS). */
const permissionsSchema = z.array(z.string().min(1).max(60)).max(200);

function serialize(c: any) {
  return {
    id: c.id,
    email: c.email,
    name: c.name || '',
    permissions: Array.isArray(c.permissions) ? c.permissions : [],
    status: c.status,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    acceptedAt: c.accepted_at,
  };
}

export async function collaboratorsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const list = await prisma.collaborator.findMany({ where: { owner_id: decoded.id }, orderBy: { created_at: 'desc' } });
    return reply.send({ success: true, collaborators: list.map(serialize) });
  });

  app.post('/', { preHandler: [createResourceRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const parsed = z.object({
      email: z.string().email().max(200).transform((v) => v.trim().toLowerCase()),
      name: z.string().max(200).optional(),
      permissions: permissionsSchema.optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Dados inválidos (e-mail obrigatório)' });
    const owner = await prisma.user.findUnique({ where: { id: decoded.id }, select: { email: true, name: true } });
    if (owner && owner.email.toLowerCase() === parsed.data.email) {
      return reply.status(400).send({ success: false, error: 'Você já é o dono da conta' });
    }
    const exists = await prisma.collaborator.findFirst({ where: { owner_id: decoded.id, email: parsed.data.email } });
    if (exists) return reply.status(400).send({ success: false, error: 'Este e-mail já foi convidado' });
    const token = crypto.randomBytes(24).toString('hex');
    const c = await prisma.collaborator.create({
      data: {
        owner_id: decoded.id,
        email: parsed.data.email,
        name: parsed.data.name || null,
        permissions: parsed.data.permissions || [],
        status: 'invited',
        invite_token: token,
      },
    });
    sendCollaboratorInvite(c.email, owner?.name || 'ZucroPay', token).catch(() => {});
    return reply.status(201).send({ success: true, collaborator: serialize(c) });
  });

  app.put('/:id', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const parsed = z.object({
      name: z.string().max(200).optional(),
      permissions: permissionsSchema.optional(),
      status: z.enum(['invited', 'active', 'suspended']).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Dados inválidos' });
    const c = await prisma.collaborator.findFirst({ where: { id, owner_id: decoded.id } });
    if (!c) return reply.status(404).send({ success: false, error: 'Colaborador não encontrado' });
    const updated = await prisma.collaborator.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined && { name: parsed.data.name || null }),
        ...(parsed.data.permissions !== undefined && { permissions: parsed.data.permissions }),
        ...(parsed.data.status !== undefined && { status: parsed.data.status }),
        updated_at: new Date(),
      },
    });
    return reply.send({ success: true, collaborator: serialize(updated) });
  });

  app.post('/:id/resend', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const c = await prisma.collaborator.findFirst({ where: { id, owner_id: decoded.id } });
    if (!c) return reply.status(404).send({ success: false, error: 'Colaborador não encontrado' });
    const owner = await prisma.user.findUnique({ where: { id: decoded.id }, select: { name: true } });
    const token = c.invite_token || crypto.randomBytes(24).toString('hex');
    if (!c.invite_token) await prisma.collaborator.update({ where: { id }, data: { invite_token: token } });
    const sent = await sendCollaboratorInvite(c.email, owner?.name || 'ZucroPay', token);
    return reply.send({ success: sent, collaborator: serialize(c) });
  });

  app.delete('/:id', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const c = await prisma.collaborator.findFirst({ where: { id, owner_id: decoded.id } });
    if (!c) return reply.status(404).send({ success: false, error: 'Colaborador não encontrado' });
    await prisma.collaborator.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // Público: aceitar convite (o colaborador entra com a própria conta ZucroPay depois de aceitar)
  app.post('/accept', { preHandler: [standardRateLimit] }, async (request, reply) => {
    const parsed = z.object({ token: z.string().min(20).max(80) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Token inválido' });
    const c = await prisma.collaborator.findFirst({ where: { invite_token: parsed.data.token } });
    if (!c) return reply.status(404).send({ success: false, error: 'Convite não encontrado ou já utilizado' });
    const updated = await prisma.collaborator.update({ where: { id: c.id }, data: { status: 'active', accepted_at: new Date(), invite_token: null, updated_at: new Date() } });
    return reply.send({ success: true, collaborator: serialize(updated) });
  });
}

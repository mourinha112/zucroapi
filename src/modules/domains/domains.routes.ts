import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import dns from 'dns';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';

/**
 * Domínios próprios do vendedor (checkout em domínio personalizado).
 * Contrato do front: Domain { id, name, status: 'pending'|'approved', method: 'cname', cnameTarget,
 * records[], createdAt, verifiedAt?, lastCheckedAt?, verificationError? }
 * A aprovação só acontece após consulta DNS real feita aqui (nunca pelo navegador).
 */
export const DOMAINS_CNAME_TARGET = (process.env.DOMAINS_CNAME_TARGET || 'dashboard.appzucropay.com').toLowerCase();

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(raw: string): string | null {
  let v = String(raw || '').trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0].split(':')[0].replace(/\.+$/, '');
  if (!HOST_RE.test(v)) return null;
  return v;
}

function serialize(d: any) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    method: d.method,
    cnameTarget: d.cname_target,
    records: [{ type: 'CNAME', name: d.name, content: d.cname_target, proxy: false }],
    createdAt: d.created_at,
    verifiedAt: d.verified_at,
    lastCheckedAt: d.last_checked_at,
    verificationError: d.verification_error,
  };
}

async function resolveA(host: string): Promise<string[]> {
  try { return (await dns.promises.resolve4(host)).map((ip) => ip.trim()).sort(); } catch { return []; }
}

/** Verificação DNS real: CNAME apontando exatamente para o alvo, ou A/AAAA iguais aos do alvo. */
export async function checkDomainDns(name: string, target: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const cnames = await dns.promises.resolveCname(name).catch(() => [] as string[]);
    const norm = cnames.map((c) => c.toLowerCase().replace(/\.+$/, ''));
    if (norm.includes(target)) return { ok: true };
    if (norm.length) return { ok: false, error: `CNAME aponta para ${norm[0]}; esperado ${target}` };
    const [a, b] = await Promise.all([resolveA(name), resolveA(target)]);
    if (a.length && b.length && a.some((ip) => b.includes(ip))) return { ok: true };
    if (!a.length) return { ok: false, error: 'Nenhum registro DNS encontrado ainda (propagação pode levar até 24h)' };
    return { ok: false, error: `O domínio resolve para ${a[0]}, que não é o destino da ZucroPay` };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Falha na consulta DNS' };
  }
}

export async function domainsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const list = await prisma.domain.findMany({ where: { user_id: decoded.id }, orderBy: { created_at: 'desc' } });
    return reply.send({ success: true, domains: list.map(serialize), cnameTarget: DOMAINS_CNAME_TARGET });
  });

  app.post('/', { preHandler: [createResourceRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const parsed = z.object({ name: z.string().min(4).max(300) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Informe o domínio' });
    const name = normalizeHostname(parsed.data.name);
    if (!name) return reply.status(400).send({ success: false, error: 'Domínio inválido. Use algo como pay.suamarca.com.br' });
    if (name === DOMAINS_CNAME_TARGET || name.endsWith('.appzucropay.com')) {
      return reply.status(400).send({ success: false, error: 'Este domínio pertence à ZucroPay' });
    }
    const exists = await prisma.domain.findUnique({ where: { name } });
    if (exists) {
      return reply.status(400).send({ success: false, error: exists.user_id === decoded.id ? 'Domínio já cadastrado' : 'Domínio já está em uso por outra conta' });
    }
    const d = await prisma.domain.create({ data: { user_id: decoded.id, name, status: 'pending', method: 'cname', cname_target: DOMAINS_CNAME_TARGET } });
    return reply.status(201).send({ success: true, domain: serialize(d) });
  });

  app.patch('/:id', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const d = await prisma.domain.findFirst({ where: { id, user_id: decoded.id } });
    if (!d) return reply.status(404).send({ success: false, error: 'Domínio não encontrado' });
    // Único campo editável pelo vendedor: o método (o restante é calculado no servidor)
    const body = (request.body || {}) as { method?: string };
    const method = body.method === 'nameserver' ? 'nameserver' : 'cname';
    const updated = await prisma.domain.update({ where: { id }, data: { method, updated_at: new Date() } });
    return reply.send({ success: true, domain: serialize(updated) });
  });

  app.post('/:id/verify', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const d = await prisma.domain.findFirst({ where: { id, user_id: decoded.id } });
    if (!d) return reply.status(404).send({ success: false, error: 'Domínio não encontrado' });
    if (d.last_checked_at && Date.now() - new Date(d.last_checked_at).getTime() < 20_000) {
      return reply.status(429).send({ success: false, error: 'Aguarde alguns segundos antes de verificar de novo', domain: serialize(d) });
    }
    const result = await checkDomainDns(d.name, d.cname_target);
    const now = new Date();
    const updated = await prisma.domain.update({
      where: { id },
      data: {
        last_checked_at: now,
        status: result.ok ? 'approved' : 'pending',
        verified_at: result.ok ? (d.verified_at || now) : null,
        verification_error: result.ok ? null : (result.error || 'Não verificado'),
        updated_at: now,
      },
    });
    return reply.send({ success: true, domain: serialize(updated) });
  });

  app.delete('/:id', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };
    const d = await prisma.domain.findFirst({ where: { id, user_id: decoded.id } });
    if (!d) return reply.status(404).send({ success: false, error: 'Domínio não encontrado' });
    const linked = await prisma.paymentLink.count({ where: { domain_id: id } });
    if (linked > 0) {
      return reply.status(400).send({ success: false, error: `Desvincule o domínio de ${linked} checkout(s) antes de excluir` });
    }
    await prisma.domain.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // Público: resolve um hostname para o checkout vinculado (roteamento por domínio próprio)
  app.get('/resolve', { preHandler: [standardRateLimit] }, async (request, reply) => {
    const q = request.query as { host?: string; path?: string };
    const host = normalizeHostname(q.host || '');
    if (!host) return reply.status(400).send({ success: false, error: 'host inválido' });
    const d = await prisma.domain.findFirst({ where: { name: host, status: 'approved' } });
    if (!d) return reply.status(404).send({ success: false, error: 'Domínio não aprovado' });
    const seg = String(q.path || '').replace(/^\/+|\/+$/g, '').split('/')[0];
    const link = seg
      ? await prisma.paymentLink.findFirst({ where: { id: seg, domain_id: d.id, active: true }, select: { id: true } })
      : await prisma.paymentLink.findFirst({ where: { domain_id: d.id, active: true }, orderBy: { created_at: 'asc' }, select: { id: true } });
    if (!link) return reply.status(404).send({ success: false, error: 'Nenhum checkout vinculado a este domínio' });
    return reply.send({ success: true, linkId: link.id, domain: serialize(d) });
  });
}

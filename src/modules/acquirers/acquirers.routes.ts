import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

/**
 * Adquirentes por vendedor: ordem/contingência, teste A/B e ranking de conversão.
 * Persistência em users.acquirer_settings (JSON): { order: string[], rules: {...}, ab: {...} | null }.
 * A escolha da adquirente em cada cobrança acontece em payments.routes.ts (pickProviders()).
 */
export const ACQUIRERS: { id: string; name: string }[] = [
  { id: 'payshark', name: 'Pay Shark' },
  { id: 'payshark_white', name: 'Pay Shark White' },
  { id: 'xflow', name: 'XFlow' },
  { id: 'enki', name: 'Enki' },
  { id: 'eusouzucropay', name: 'EuSouZucroPay' },
  { id: 'uvvipay', name: 'UvviPay' },
  { id: 'sharkbanking', name: 'Shark Banking' },
];
const IDS = ACQUIRERS.map((a) => a.id);
const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PAID']);
const REFUSED = new Set(['REFUSED', 'FAILED', 'CANCELLED']);

export type AcquirerSettings = {
  order?: string[];
  rules?: { autoSwitch?: boolean; hourlyCheck?: boolean; globalRanking?: boolean; autoPrimary?: boolean };
  ab?: { id: string; active: boolean; acquirers: string[]; pixPerAcquirer: number; autoWinner: boolean; startedAt: string; endedAt?: string; winner?: string } | null;
};

export function readSettings(user: { payment_provider: string; acquirer_settings: any }): Required<Pick<AcquirerSettings, 'order' | 'rules'>> & { ab: AcquirerSettings['ab'] } {
  const s: AcquirerSettings = (user.acquirer_settings && typeof user.acquirer_settings === 'object') ? user.acquirer_settings : {};
  const primary = IDS.includes(user.payment_provider) ? user.payment_provider : 'payshark';
  let order = Array.isArray(s.order) ? s.order.filter((v) => IDS.includes(v)) : [];
  if (!order.includes(primary)) order = [primary, ...order];
  return { order, rules: s.rules || {}, ab: s.ab && s.ab.active ? s.ab : (s.ab || null) };
}

function providerOf(p: any): string {
  const m = (p.metadata && typeof p.metadata === 'object') ? p.metadata : {};
  return String(m.payment_provider || '').toLowerCase();
}

function rangeSince(range: string): Date {
  const now = Date.now();
  const H = 3600_000;
  if (range === '6h') return new Date(now - 6 * H);
  if (range === '24h') return new Date(now - 24 * H);
  if (range === '7d') return new Date(now - 7 * 24 * H);
  if (range === '30d') return new Date(now - 30 * 24 * H);
  const d = new Date(); d.setHours(0, 0, 0, 0); return d; // today
}

export async function acquirersRoutes(app: FastifyInstance) {
  app.get('/mine', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { payment_provider: true, acquirer_settings: true } });
    if (!user) return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    const s = readSettings(user);
    return reply.send({ success: true, active: s.order[0], contracted: ACQUIRERS, order: s.order, rules: s.rules, ab: s.ab });
  });

  app.put('/mine', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const parsed = z.object({
      order: z.array(z.string()).min(1).max(10).optional(),
      rules: z.object({ autoSwitch: z.boolean().optional(), hourlyCheck: z.boolean().optional(), globalRanking: z.boolean().optional(), autoPrimary: z.boolean().optional() }).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Dados inválidos' });
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { payment_provider: true, acquirer_settings: true } });
    if (!user) return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    const cur = readSettings(user);
    let order = cur.order;
    if (parsed.data.order) {
      order = parsed.data.order.filter((v, i, arr) => IDS.includes(v) && arr.indexOf(v) === i);
      if (!order.length) return reply.status(400).send({ success: false, error: 'Nenhuma adquirente válida na ordem' });
    }
    const settings: AcquirerSettings = { order, rules: { ...cur.rules, ...(parsed.data.rules || {}) }, ab: cur.ab };
    await prisma.user.update({ where: { id: decoded.id }, data: { acquirer_settings: settings as any, payment_provider: order[0], updated_at: new Date() } });
    return reply.send({ success: true, active: order[0], contracted: ACQUIRERS, order, rules: settings.rules, ab: settings.ab });
  });

  // ---- Teste A/B: cobranças PIX alternadas entre as adquirentes escolhidas
  app.post('/ab-tests', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const parsed = z.object({
      acquirers: z.array(z.string()).min(2).max(6),
      pixPerAcquirer: z.number().int().min(1).max(10000).default(50),
      autoWinner: z.boolean().default(true),
    }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Escolha ao menos duas adquirentes' });
    const acqs = parsed.data.acquirers.filter((v, i, a) => IDS.includes(v) && a.indexOf(v) === i);
    if (acqs.length < 2) return reply.status(400).send({ success: false, error: 'Escolha ao menos duas adquirentes válidas' });
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { payment_provider: true, acquirer_settings: true } });
    if (!user) return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    const cur = readSettings(user);
    const ab = { id: crypto.randomBytes(8).toString('hex'), active: true, acquirers: acqs, pixPerAcquirer: parsed.data.pixPerAcquirer, autoWinner: parsed.data.autoWinner, startedAt: new Date().toISOString() };
    await prisma.user.update({ where: { id: decoded.id }, data: { acquirer_settings: { order: cur.order, rules: cur.rules, ab } as any, updated_at: new Date() } });
    return reply.status(201).send({ success: true, ab });
  });

  app.get('/ab-tests/current', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { payment_provider: true, acquirer_settings: true } });
    if (!user) return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    const s = readSettings(user);
    if (!s.ab) return reply.send({ success: true, ab: null, metrics: [] });
    const since = new Date(s.ab.startedAt);
    const payments = await prisma.payment.findMany({
      where: { user_id: decoded.id, billing_type: 'PIX', created_at: { gte: since } },
      select: { status: true, metadata: true, value: true },
    });
    const metrics = s.ab.acquirers.map((id) => {
      const rows = payments.filter((p) => providerOf(p) === id);
      const approved = rows.filter((p) => PAID.has(String(p.status).toUpperCase())).length;
      const refused = rows.filter((p) => REFUSED.has(String(p.status).toUpperCase())).length;
      const pending = rows.length - approved - refused;
      const revenue = rows.filter((p) => PAID.has(String(p.status).toUpperCase())).reduce((a, p) => a + Number(p.value), 0);
      return { id, name: ACQUIRERS.find((a) => a.id === id)?.name || id, processed: rows.length, approved, pending, refused, revenue, conversion: rows.length ? approved / rows.length : 0 };
    });
    const done = metrics.every((m) => m.processed >= s.ab!.pixPerAcquirer);
    let winner: string | undefined = s.ab.winner;
    if (done && s.ab.autoWinner && s.ab.active) {
      winner = metrics.slice().sort((a, b) => b.conversion - a.conversion)[0]?.id;
      const order = [winner!, ...s.order.filter((o) => o !== winner)];
      await prisma.user.update({ where: { id: decoded.id }, data: { payment_provider: winner!, acquirer_settings: { order, rules: s.rules, ab: { ...s.ab, active: false, endedAt: new Date().toISOString(), winner } } as any, updated_at: new Date() } });
      return reply.send({ success: true, ab: { ...s.ab, active: false, winner }, metrics, finished: true });
    }
    return reply.send({ success: true, ab: s.ab, metrics, finished: done });
  });

  app.delete('/ab-tests/current', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { payment_provider: true, acquirer_settings: true } });
    if (!user) return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    const s = readSettings(user);
    if (!s.ab) return reply.send({ success: true, ab: null });
    const ab = { ...s.ab, active: false, endedAt: new Date().toISOString() };
    await prisma.user.update({ where: { id: decoded.id }, data: { acquirer_settings: { order: s.order, rules: s.rules, ab } as any, updated_at: new Date() } });
    return reply.send({ success: true, ab });
  });

  // ---- Ranking de conversão PIX da plataforma por adquirente (dados agregados, sem expor vendedores)
  app.get('/ranking', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const q = request.query as { range?: string };
    const since = rangeSince(q.range || 'today');
    const payments = await prisma.payment.findMany({
      where: { billing_type: 'PIX', created_at: { gte: since } },
      select: { status: true, metadata: true },
      take: 20000,
      orderBy: { created_at: 'desc' },
    });
    const ranking = ACQUIRERS.map((a) => {
      const rows = payments.filter((p) => providerOf(p) === a.id);
      const approved = rows.filter((p) => PAID.has(String(p.status).toUpperCase())).length;
      return { id: a.id, name: a.name, processed: rows.length, approved, conversion: rows.length ? approved / rows.length : 0 };
    }).filter((r) => r.processed > 0).sort((x, y) => y.conversion - x.conversion);
    return reply.send({ success: true, range: q.range || 'today', since, ranking });
  });
}

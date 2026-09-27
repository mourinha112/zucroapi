import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

/**
 * Análises reais para os dashboards de "Consumo de conteúdos" e "Marketing".
 * (Vendas / Recuperação de vendas já vêm dos pagamentos no front.)
 */
function parseRange(q: { start?: string; end?: string }) {
  const end = q.end ? new Date(q.end) : new Date();
  const start = q.start ? new Date(q.start) : new Date(end.getTime() - 29 * 86400000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export async function analyticsRoutes(app: FastifyInstance) {
  // Consumo de conteúdos: alunos, aulas concluídas, conclusão por aula, atividade por dia
  app.get('/consumption', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const q = request.query as { start?: string; end?: string; productId?: string };
    const range = parseRange(q);
    if (!range) return reply.status(400).send({ success: false, error: 'Período inválido' });

    const products = await prisma.product.findMany({
      where: { user_id: decoded.id, ...(q.productId ? { id: q.productId } : {}) },
      select: { id: true, name: true },
    });
    const productIds = products.map((p) => p.id);
    if (!productIds.length) return reply.send({ success: true, totals: { students: 0, activeStudents: 0, lessons: 0, completions: 0, completionRate: 0, watchedHours: 0 }, lessons: [], byDay: [], products: [] });

    const [accesses, lessons, progress] = await Promise.all([
      prisma.productMemberAccess.findMany({ where: { product_id: { in: productIds } }, select: { id: true, product_id: true, buyer_email: true, created_at: true, last_access_at: true } }),
      prisma.productLesson.findMany({ where: { module: { product_id: { in: productIds } } }, select: { id: true, title: true, module: { select: { title: true, product_id: true } } } }),
      prisma.productLessonProgress.findMany({
        where: { access: { product_id: { in: productIds } } },
        select: { access_id: true, lesson_id: true, completed: true, watched_seconds: true, completed_at: true, updated_at: true },
      }),
    ]);

    const inRange = (d: Date | null | undefined) => !!d && d >= range.start && d <= range.end;
    const accessById = new Map(accesses.map((a) => [a.id, a]));
    const students = new Set(accesses.map((a) => a.buyer_email.toLowerCase())).size;
    const activeStudents = new Set(accesses.filter((a) => inRange(a.last_access_at) || progress.some((p) => p.access_id === a.id && inRange(p.updated_at))).map((a) => a.buyer_email.toLowerCase())).size;
    const completionsInRange = progress.filter((p) => p.completed && inRange(p.completed_at));
    const watchedSeconds = progress.reduce((a, p) => a + (p.watched_seconds || 0), 0);

    const byLesson = lessons.map((l) => {
      const rows = progress.filter((p) => p.lesson_id === l.id);
      const completed = rows.filter((p) => p.completed).length;
      const enrolled = accesses.filter((a) => a.product_id === l.module.product_id).length;
      return { id: l.id, title: l.title, module: l.module.title, productId: l.module.product_id, started: rows.length, completed, enrolled, completionRate: enrolled ? completed / enrolled : 0 };
    }).sort((a, b) => b.completed - a.completed);

    const days = new Map<string, { completions: number; active: number }>();
    for (let t = new Date(range.start); t <= range.end; t = new Date(t.getTime() + 86400000)) days.set(t.toISOString().slice(0, 10), { completions: 0, active: 0 });
    const activeDay = new Map<string, Set<string>>();
    for (const p of progress) {
      const key = p.updated_at.toISOString().slice(0, 10);
      if (!days.has(key)) continue;
      if (p.completed && p.completed_at && inRange(p.completed_at)) days.get(p.completed_at.toISOString().slice(0, 10))!.completions++;
      const acc = accessById.get(p.access_id);
      if (acc) { if (!activeDay.has(key)) activeDay.set(key, new Set()); activeDay.get(key)!.add(acc.buyer_email); }
    }
    activeDay.forEach((set, key) => { if (days.has(key)) days.get(key)!.active = set.size; });

    return reply.send({
      success: true,
      totals: {
        students,
        activeStudents,
        lessons: lessons.length,
        completions: completionsInRange.length,
        completionRate: lessons.length && accesses.length ? progress.filter((p) => p.completed).length / (lessons.length * accesses.length) : 0,
        watchedHours: Math.round((watchedSeconds / 3600) * 10) / 10,
      },
      lessons: byLesson,
      byDay: Array.from(days.entries()).map(([date, v]) => ({ date, ...v })),
      products,
    });
  });

  // Marketing: vendas por origem (utm_source/medium/campaign) a partir dos metadados dos pagamentos
  app.get('/marketing', { preHandler: [standardRateLimit, authenticate] }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const q = request.query as { start?: string; end?: string };
    const range = parseRange(q);
    if (!range) return reply.status(400).send({ success: false, error: 'Período inválido' });
    const payments = await prisma.payment.findMany({
      where: { user_id: decoded.id, created_at: { gte: range.start, lte: range.end } },
      select: { status: true, value: true, metadata: true, created_at: true },
      take: 5000,
    });
    const PAID = new Set(['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'PAID']);
    const group = (key: string) => {
      const map = new Map<string, { label: string; attempts: number; paid: number; revenue: number }>();
      for (const p of payments) {
        const m = (p.metadata && typeof p.metadata === 'object') ? (p.metadata as any) : {};
        const label = String(m[key] || '').trim() || 'Direto / sem UTM';
        const g = map.get(label) || { label, attempts: 0, paid: 0, revenue: 0 };
        g.attempts++;
        if (PAID.has(String(p.status).toUpperCase())) { g.paid++; g.revenue += Number(p.value); }
        map.set(label, g);
      }
      return Array.from(map.values()).map((g) => ({ ...g, conversion: g.attempts ? g.paid / g.attempts : 0 })).sort((a, b) => b.revenue - a.revenue);
    };
    const paid = payments.filter((p) => PAID.has(String(p.status).toUpperCase()));
    return reply.send({
      success: true,
      totals: { attempts: payments.length, paid: paid.length, revenue: paid.reduce((a, p) => a + Number(p.value), 0), withUtm: payments.filter((p) => (p.metadata as any)?.utm_source).length },
      bySource: group('utm_source'),
      byMedium: group('utm_medium'),
      byCampaign: group('utm_campaign'),
    });
  });
}

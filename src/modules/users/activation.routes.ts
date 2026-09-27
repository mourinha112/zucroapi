import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

/**
 * Fluxo "Ativar conta" (wizard do dashboard: CPF/CNPJ, dados cadastrais, documentos,
 * KYC facial e chave Pix). O estado inteiro do wizard fica em users.activation (JSONB):
 *   { type: 'cpf'|'cnpj', step: number, data: {...}, finished: boolean,
 *     submitted_at?: ISO, updated_at: ISO, review?: { status, reason, at, by } }
 *
 * Arquivos (documentos e capturas do KYC) NUNCA vão em base64 aqui: o front envia via
 * POST /api/upload e guarda só a URL dentro de `data`.
 *
 * Registrado em app.ts com prefix '/api/users/activation'.
 */

const APPROVED_STATUSES = ['active', 'approved'];
const MAX_DATA_BYTES = 200 * 1024;
const MAX_DATA_URL_CHARS = 256;

const activationBodySchema = z.object({
  type: z.enum(['cpf', 'cnpj']),
  step: z.number().int().min(1).max(50),
  data: z.record(z.string(), z.unknown()).default({}),
  finished: z.boolean().optional().default(false),
});

export type ActivationRecord = {
  type: 'cpf' | 'cnpj';
  step: number;
  data: Record<string, unknown>;
  finished: boolean;
  submitted_at?: string | null;
  updated_at?: string;
  review?: { status: string; reason?: string | null; at: string; by?: string | null } | null;
};

/** Remove data URLs (base64) de qualquer profundidade — arquivos devem ir por /api/upload. */
export function stripDataUrls(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_DATA_URL_CHARS && /^data:/i.test(value) ? '' : value;
  }
  if (Array.isArray(value)) return value.map(stripDataUrls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'function' || v === undefined) continue;
      out[k] = stripDataUrls(v);
    }
    return out;
  }
  return value;
}

export function readActivation(raw: unknown): ActivationRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as ActivationRecord;
}

export async function activationRoutes(app: FastifyInstance) {
  // Estado atual do wizard + status da conta
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { activation: true, account_status: true },
    });

    if (!user) {
      return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    }

    return reply.send({
      success: true,
      activation: readActivation(user.activation),
      status: user.account_status,
    });
  });

  // Salva o estado do wizard (chamado a cada etapa, debounced no front).
  // finished=true envia o cadastro para análise: account_status vira 'pending_review'
  // (a não ser que a conta já esteja ativa/aprovada).
  app.put('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const parsed = activationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: 'Dados inválidos',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

    const data = stripDataUrls(body.data) as Record<string, unknown>;
    if (JSON.stringify(data).length > MAX_DATA_BYTES) {
      return reply.status(413).send({
        success: false,
        error: 'Dados do cadastro muito grandes (máx. 200 KB). Envie os arquivos por /api/upload e guarde só a URL.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, activation: true, account_status: true },
    });
    if (!user) {
      return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
    }

    const previous = readActivation(user.activation);
    const now = new Date().toISOString();
    const alreadyApproved = APPROVED_STATUSES.includes(user.account_status);
    const firstSubmit = body.finished && !(previous && previous.finished);

    const activation: ActivationRecord = {
      type: body.type,
      step: body.step,
      data,
      finished: body.finished,
      submitted_at: body.finished
        ? (previous && previous.finished && previous.submitted_at) || now
        : (previous && previous.submitted_at) || null,
      updated_at: now,
      // uma nova submissão limpa a reprovação anterior
      review: firstSubmit ? null : (previous && previous.review) || null,
    };

    const nextStatus = body.finished && !alreadyApproved ? 'pending_review' : user.account_status;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        activation: activation as any,
        account_status: nextStatus,
        // espelha no cadastro principal quando o usuário terminar o wizard
        ...(body.finished && !alreadyApproved && {
          person_type: body.type === 'cnpj' ? 'PJ' : 'PF',
          ...(typeof data.cpf === 'string' && body.type === 'cpf' && data.cpf && { cpf_cnpj: String(data.cpf).slice(0, 20) }),
          ...(typeof data.cnpj === 'string' && body.type === 'cnpj' && data.cnpj && { cpf_cnpj: String(data.cnpj).slice(0, 20) }),
          ...(typeof data.phone === 'string' && data.phone && { phone: String(data.phone).slice(0, 20) }),
        }),
        updated_at: new Date(),
      },
      select: { activation: true, account_status: true },
    });

    if (firstSubmit) {
      request.log.info({ userId: user.id, type: body.type }, '[activation] cadastro enviado para análise');
    }

    return reply.send({
      success: true,
      activation: readActivation(updated.activation),
      status: updated.account_status,
    });
  });
}

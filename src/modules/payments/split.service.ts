import { prisma } from '../../config/database';

const MAX_SPLITS_PER_PAYMENT = 10;

export type SplitInput = {
  recipient_id: string;
  type: 'amount' | 'percent';
  amount?: number;
  percent?: number;
  description?: string | null;
};

export type SplitValidationError = { error: string };
export type SplitValidationOk = { ok: true; normalized: SplitInput[] };

/**
 * Valida uma lista de splits contra o valor bruto da cobrança.
 * Regras: cada recipient aprovado, soma estritamente menor que o total,
 * limite de MAX_SPLITS_PER_PAYMENT, dono não pode estar na lista.
 */
export async function validateSplits(
  splits: SplitInput[],
  grossValue: number,
  ownerUserId: string,
): Promise<SplitValidationOk | SplitValidationError> {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { ok: true, normalized: [] };
  }

  if (splits.length > MAX_SPLITS_PER_PAYMENT) {
    return { error: `Máximo de ${MAX_SPLITS_PER_PAYMENT} splits por cobrança` };
  }

  const normalized: SplitInput[] = [];
  const seen = new Set<string>();

  for (const raw of splits) {
    if (!raw.recipient_id) {
      return { error: 'recipient_id é obrigatório em cada split' };
    }
    if (raw.recipient_id === ownerUserId) {
      return { error: 'O dono da cobrança não pode estar na lista de splits' };
    }
    if (seen.has(raw.recipient_id)) {
      return { error: `Recipient ${raw.recipient_id} duplicado` };
    }
    seen.add(raw.recipient_id);

    const hasAmount = raw.amount != null && Number(raw.amount) > 0;
    const hasPercent = raw.percent != null && Number(raw.percent) > 0;

    if (hasAmount === hasPercent) {
      return { error: 'Cada split deve ter amount OU percent (nunca os dois)' };
    }

    normalized.push({
      recipient_id: raw.recipient_id,
      type: hasAmount ? 'amount' : 'percent',
      amount: hasAmount ? Number(raw.amount) : undefined,
      percent: hasPercent ? Number(raw.percent) : undefined,
      description: raw.description ?? null,
    });
  }

  // Verifica se todos os recipients existem e estão ativos (aprovados pela plataforma)
  const recipients = await prisma.user.findMany({
    where: {
      id: { in: normalized.map((s) => s.recipient_id) },
      account_status: { in: ['active', 'approved'] },
    },
    select: { id: true },
  });

  if (recipients.length !== normalized.length) {
    return { error: 'Um ou mais recipients não existem ou não estão ativos' };
  }

  // Soma em centavos para evitar float
  const grossCents = Math.round(grossValue * 100);
  const totalSplitCents = normalized.reduce((acc, s) => {
    if (s.type === 'amount') {
      return acc + Math.round((s.amount ?? 0) * 100);
    }
    return acc + Math.round((grossCents * (s.percent ?? 0)) / 100);
  }, 0);

  if (totalSplitCents <= 0) {
    return { error: 'Soma dos splits precisa ser maior que zero' };
  }
  if (totalSplitCents >= grossCents) {
    return { error: 'Soma dos splits não pode igualar ou exceder o valor da cobrança' };
  }

  return { ok: true, normalized };
}

/**
 * Carrega as regras fixas de split configuradas no produto (via payment_link).
 */
export async function loadProductSplitRules(
  paymentLinkId: string | null | undefined,
): Promise<SplitInput[]> {
  if (!paymentLinkId) return [];

  const link = await prisma.paymentLink.findUnique({
    where: { id: paymentLinkId },
    select: { product_id: true },
  });

  if (!link?.product_id) return [];

  const rules = await prisma.productSplitRule.findMany({
    where: { product_id: link.product_id, active: true },
  });

  return rules.map((r) => ({
    recipient_id: r.recipient_id,
    type: r.type as 'amount' | 'percent',
    amount: r.amount != null ? Number(r.amount) : undefined,
    percent: r.percent != null ? Number(r.percent) : undefined,
    description: r.description ?? null,
  }));
}

/**
 * Persiste as linhas de PaymentSplit e marca o Payment como has_split=true.
 * Deve ser chamado imediatamente após prisma.payment.create().
 */
export async function persistPaymentSplits(
  paymentId: string,
  splits: SplitInput[],
): Promise<void> {
  if (splits.length === 0) return;

  await prisma.$transaction([
    prisma.paymentSplit.createMany({
      data: splits.map((s) => ({
        payment_id: paymentId,
        recipient_id: s.recipient_id,
        type: s.type,
        amount: s.amount ?? null,
        percent: s.percent ?? null,
        description: s.description ?? null,
        status: 'pending',
      })),
    }),
    prisma.payment.update({
      where: { id: paymentId },
      data: { has_split: true },
    }),
  ]);
}

/**
 * Calcula o valor em R$ (2 casas) devido a cada split, dado o net_value disponível.
 * O dono absorve a taxa do gateway, igual ao modelo Jumpfy.
 * Trabalha em centavos para evitar drift de float.
 */
export function computeSplitDistribution(params: {
  grossValue: number;
  netValue: number;
  splits: Array<{ id: string; type: string; amount: any; percent: any }>;
}): { recipientCredits: Map<string, number>; totalSplitCents: number } {
  const grossCents = Math.round(params.grossValue * 100);
  const netCents = Math.round(params.netValue * 100);

  const recipientCredits = new Map<string, number>();
  let totalSplitCents = 0;

  for (const s of params.splits) {
    let credit: number;
    if (s.type === 'amount') {
      credit = Math.round(Number(s.amount ?? 0) * 100);
    } else {
      credit = Math.round((grossCents * Number(s.percent ?? 0)) / 100);
    }

    // Clamp de segurança: não pode passar do net disponível (evita dono ficar negativo).
    if (totalSplitCents + credit > netCents) {
      credit = Math.max(0, netCents - totalSplitCents);
    }

    recipientCredits.set(s.id, credit);
    totalSplitCents += credit;
  }

  return { recipientCredits, totalSplitCents };
}

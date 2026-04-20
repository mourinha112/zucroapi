import { FastifyInstance } from 'fastify';
import { prisma } from '../../config/database';
import {
  authenticate,
  standardRateLimit,
  createResourceRateLimit,
} from '../../middlewares';

/**
 * Rotas de gerenciamento de splits:
 * - GET    /splits/recipients/lookup?query=...  → buscar usuário por email/cpf/cnpj
 * - GET    /splits/products/:productId          → listar regras fixas do produto
 * - POST   /splits/products/:productId          → adicionar regra fixa
 * - PUT    /splits/products/:productId/:ruleId  → atualizar regra
 * - DELETE /splits/products/:productId/:ruleId  → remover regra
 * - GET    /splits/payments/:paymentId          → histórico de splits de um pagamento
 */
export async function splitsRoutes(app: FastifyInstance) {
  // ========== Buscar recipient por email/documento ==========
  app.get('/recipients/lookup', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { query } = request.query as { query?: string };

    if (!query || query.trim().length < 3) {
      return reply.status(400).send({
        success: false,
        error: 'Informe email ou CPF/CNPJ (mínimo 3 caracteres)',
      });
    }

    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');

    // Busca sem filtro de status para retornar erro específico
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: q },
          ...(digits.length >= 11 ? [{ cpf_cnpj: digits }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        cpf_cnpj: true,
        avatar: true,
        account_status: true,
      },
    });

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: 'Nenhuma conta ZucroPay encontrada com esse email/documento. Peça para o parceiro criar uma conta em dashboard.appzucropay.com.',
      });
    }

    if (user.id === decoded.id) {
      return reply.status(400).send({
        success: false,
        error: 'Você não pode adicionar a si mesmo como parceiro no split.',
      });
    }

    const allowedStatuses = ['active', 'approved'];
    if (!allowedStatuses.includes(user.account_status)) {
      const label =
        user.account_status === 'pending' ? 'ainda não concluiu a verificação de identidade (KYC)' :
        user.account_status === 'blocked' ? 'está bloqueada' :
        `está com status "${user.account_status}"`;
      return reply.status(400).send({
        success: false,
        error: `A conta do parceiro ${label}. Peça para ele completar o cadastro antes de adicioná-lo ao split.`,
      });
    }

    const { account_status, ...publicUser } = user;
    return reply.send({ success: true, recipient: publicUser });
  });

  // ========== Listar regras de split de um produto ==========
  app.get('/products/:productId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };

    const product = await prisma.product.findFirst({
      where: { id: productId, user_id: decoded.id },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Produto não encontrado' });
    }

    const rules = await prisma.productSplitRule.findMany({
      where: { product_id: productId },
      orderBy: { created_at: 'asc' },
    });

    // Hidrata com nome/email do recipient
    const recipientIds = rules.map((r) => r.recipient_id);
    const recipients = await prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, name: true, email: true, avatar: true },
    });
    const recipMap = new Map(recipients.map((r) => [r.id, r]));

    return reply.send({
      success: true,
      rules: rules.map((r) => ({
        id: r.id,
        recipient_id: r.recipient_id,
        recipient: recipMap.get(r.recipient_id) || null,
        type: r.type,
        amount: r.amount != null ? Number(r.amount) : null,
        percent: r.percent != null ? Number(r.percent) : null,
        description: r.description,
        active: r.active,
        created_at: r.created_at,
      })),
    });
  });

  // ========== Adicionar regra de split ==========
  app.post('/products/:productId', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.params as { productId: string };
    const body = request.body as {
      recipient_id: string;
      type: 'amount' | 'percent';
      amount?: number;
      percent?: number;
      description?: string;
    };

    const product = await prisma.product.findFirst({
      where: { id: productId, user_id: decoded.id },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Produto não encontrado' });
    }

    if (!body.recipient_id) {
      return reply.status(400).send({ success: false, error: 'recipient_id é obrigatório' });
    }
    if (body.recipient_id === decoded.id) {
      return reply.status(400).send({
        success: false,
        error: 'Você não pode adicionar a si mesmo como recipient',
      });
    }

    const hasAmount = body.amount != null && Number(body.amount) > 0;
    const hasPercent = body.percent != null && Number(body.percent) > 0;
    if (hasAmount === hasPercent) {
      return reply.status(400).send({
        success: false,
        error: 'Informe amount OU percent (nunca os dois)',
      });
    }

    if (hasPercent && Number(body.percent) >= 100) {
      return reply.status(400).send({
        success: false,
        error: 'Percentual do split deve ser menor que 100',
      });
    }

    const recipient = await prisma.user.findFirst({
      where: {
        id: body.recipient_id,
        account_status: { in: ['active', 'approved'] },
      },
      select: { id: true },
    });
    if (!recipient) {
      return reply.status(400).send({
        success: false,
        error: 'Recipient não existe ou não está com a conta ativa/aprovada',
      });
    }

    // Validação agregada: soma das regras existentes + nova não pode alcançar 100% nem o preço
    const existing = await prisma.productSplitRule.findMany({
      where: { product_id: productId, active: true },
    });

    const productPrice = Number(product.price);
    const priceCents = Math.round(productPrice * 100);
    const newCents = hasAmount
      ? Math.round(Number(body.amount) * 100)
      : Math.round((priceCents * Number(body.percent)) / 100);

    const existingCents = existing.reduce((acc, r) => {
      if (r.type === 'amount') return acc + Math.round(Number(r.amount) * 100);
      return acc + Math.round((priceCents * Number(r.percent)) / 100);
    }, 0);

    if (existingCents + newCents >= priceCents) {
      return reply.status(400).send({
        success: false,
        error: 'Soma dos splits não pode igualar ou exceder o preço do produto',
      });
    }

    const rule = await prisma.productSplitRule.create({
      data: {
        product_id: productId,
        recipient_id: body.recipient_id,
        type: hasAmount ? 'amount' : 'percent',
        amount: hasAmount ? body.amount : null,
        percent: hasPercent ? body.percent : null,
        description: body.description || null,
      },
    });

    return reply.status(201).send({ success: true, rule });
  });

  // ========== Atualizar regra ==========
  app.put('/products/:productId/:ruleId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, ruleId } = request.params as {
      productId: string;
      ruleId: string;
    };
    const body = request.body as {
      amount?: number;
      percent?: number;
      description?: string;
      active?: boolean;
    };

    const product = await prisma.product.findFirst({
      where: { id: productId, user_id: decoded.id },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Produto não encontrado' });
    }

    const rule = await prisma.productSplitRule.findFirst({
      where: { id: ruleId, product_id: productId },
    });
    if (!rule) {
      return reply.status(404).send({ success: false, error: 'Regra não encontrada' });
    }

    const updateData: any = { updated_at: new Date() };
    if (body.active !== undefined) updateData.active = body.active;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.amount != null) {
      updateData.amount = body.amount;
      updateData.percent = null;
      updateData.type = 'amount';
    } else if (body.percent != null) {
      updateData.percent = body.percent;
      updateData.amount = null;
      updateData.type = 'percent';
    }

    const updated = await prisma.productSplitRule.update({
      where: { id: ruleId },
      data: updateData,
    });

    return reply.send({ success: true, rule: updated });
  });

  // ========== Deletar regra ==========
  app.delete('/products/:productId/:ruleId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId, ruleId } = request.params as {
      productId: string;
      ruleId: string;
    };

    const product = await prisma.product.findFirst({
      where: { id: productId, user_id: decoded.id },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Produto não encontrado' });
    }

    const result = await prisma.productSplitRule.deleteMany({
      where: { id: ruleId, product_id: productId },
    });

    if (result.count === 0) {
      return reply.status(404).send({ success: false, error: 'Regra não encontrada' });
    }

    return reply.send({ success: true });
  });

  // ========== Histórico de splits de um pagamento ==========
  app.get('/payments/:paymentId', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { paymentId } = request.params as { paymentId: string };

    const payment = await prisma.payment.findFirst({
      where: {
        id: paymentId,
        OR: [
          { user_id: decoded.id },
          { splits: { some: { recipient_id: decoded.id } } },
        ],
      },
    });
    if (!payment) {
      return reply.status(404).send({ success: false, error: 'Pagamento não encontrado' });
    }

    const splits = await prisma.paymentSplit.findMany({
      where: { payment_id: paymentId },
      orderBy: { created_at: 'asc' },
    });

    const recipientIds = splits.map((s) => s.recipient_id);
    const recipients = await prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, name: true, email: true },
    });
    const recipMap = new Map(recipients.map((r) => [r.id, r]));

    return reply.send({
      success: true,
      payment: {
        id: payment.id,
        value: Number(payment.value),
        net_value: Number(payment.net_value),
        status: payment.status,
        has_split: payment.has_split,
      },
      splits: splits.map((s) => ({
        id: s.id,
        recipient_id: s.recipient_id,
        recipient: recipMap.get(s.recipient_id) || null,
        type: s.type,
        amount: s.amount != null ? Number(s.amount) : null,
        percent: s.percent != null ? Number(s.percent) : null,
        computed_value: s.computed_value != null ? Number(s.computed_value) : null,
        status: s.status,
        description: s.description,
        credited_at: s.credited_at,
        created_at: s.created_at,
      })),
    });
  });
}

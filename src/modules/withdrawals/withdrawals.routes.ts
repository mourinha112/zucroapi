import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, sensitiveActionRateLimit } from '../../middlewares';

const createWithdrawalSchema = z.object({
  amount: z.number().positive(),
  pix_key: z.string(),
  pix_key_type: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
});

export async function withdrawalsRoutes(app: FastifyInstance) {
  // Listar saques do usuário
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const withdrawals = await prisma.withdrawal.findMany({
      where: { user_id: decoded.id },
      orderBy: { created_at: 'desc' },
    });

    return reply.send({ success: true, withdrawals });
  });

  // Solicitar saque (rate limit mais rigoroso)
  app.post('/', {
    preHandler: [sensitiveActionRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    
    try {
      const body = createWithdrawalSchema.parse(request.body);

      // Verificar saldo
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        include: { custom_rates: true },
      });

      if (!user) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }

      // Taxa de saque (padrão R$ 10,00 ou taxa customizada)
      const customRates = user.custom_rates as any;
      const withdrawalFee = customRates?.withdrawal_fee
        ? Number(customRates.withdrawal_fee)
        : 10.00;

      // Taxa descontada do valor sacado (seller pede 50, recebe 40, taxa 10)
      const netAmount = body.amount - withdrawalFee;

      if (netAmount <= 0) {
        return reply.status(400).send({
          error: `Valor mínimo de saque é R$ ${(withdrawalFee + 1).toFixed(2)} (taxa de R$ ${withdrawalFee.toFixed(2)} é descontada do valor)`,
        });
      }

      if (Number(user.balance) < body.amount) {
        return reply.status(400).send({
          error: `Saldo insuficiente. Seu saldo é R$ ${Number(user.balance).toFixed(2)}`
        });
      }

      // Criar saque (amount = valor solicitado, net_amount via metadata)
      const withdrawal = await prisma.withdrawal.create({
        data: {
          user_id: decoded.id,
          amount: netAmount,
          pix_key: body.pix_key,
          pix_key_type: body.pix_key_type,
          status: 'pending',
        },
      });

      // Descontar valor total do saldo
      await prisma.user.update({
        where: { id: decoded.id },
        data: {
          balance: { decrement: body.amount },
        },
      });

      // Criar transação
      await prisma.transaction.create({
        data: {
          user_id: decoded.id,
          type: 'withdraw',
          amount: body.amount,
          status: 'pending',
          description: `Saque PIX - ${body.pix_key}`,
          metadata: {
            withdrawal_id: withdrawal.id,
            fee: withdrawalFee,
            requested_amount: body.amount,
            net_amount: netAmount,
          },
        },
      });

      return reply.status(201).send({
        success: true,
        withdrawal: {
          ...withdrawal,
          requested_amount: body.amount,
          fee: withdrawalFee,
          net_amount: netAmount,
        },
        message: `Saque de R$ ${body.amount.toFixed(2)} solicitado. Você receberá R$ ${netAmount.toFixed(2)} (taxa R$ ${withdrawalFee.toFixed(2)})`,
      });
    } catch (error: any) {
      if (error.issues) {
        return reply.status(400).send({ error: 'Dados inválidos', details: error.issues });
      }
      throw error;
    }
  });

  // Obter saque por ID
  app.get('/:id', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { id } = request.params as { id: string };

    const withdrawal = await prisma.withdrawal.findFirst({
      where: { id, user_id: decoded.id },
    });

    if (!withdrawal) {
      return reply.status(404).send({ error: 'Saque não encontrado' });
    }

    return reply.send({ success: true, withdrawal });
  });
}

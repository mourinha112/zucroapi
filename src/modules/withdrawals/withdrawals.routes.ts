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

      // Taxa de saque (padrão R$ 2,00 ou taxa customizada)
      const withdrawalFee = user.custom_rates?.withdrawal_fee 
        ? Number(user.custom_rates.withdrawal_fee) 
        : 2.00;

      const totalNeeded = body.amount + withdrawalFee;

      if (Number(user.balance) < totalNeeded) {
        return reply.status(400).send({ 
          error: `Saldo insuficiente. Você precisa de R$ ${totalNeeded.toFixed(2)} (incluindo taxa de R$ ${withdrawalFee.toFixed(2)})` 
        });
      }

      // Criar saque
      const withdrawal = await prisma.withdrawal.create({
        data: {
          user_id: decoded.id,
          amount: body.amount,
          pix_key: body.pix_key,
          pix_key_type: body.pix_key_type,
          status: 'pending',
        },
      });

      // Descontar do saldo
      await prisma.user.update({
        where: { id: decoded.id },
        data: {
          balance: { decrement: totalNeeded },
        },
      });

      // Nota: Não criamos transaction aqui pois o withdrawal já registra a operação
      // A transaction será criada quando o saque for aprovado/processado

      return reply.status(201).send({ 
        success: true, 
        withdrawal,
        message: 'Saque solicitado com sucesso',
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

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit, createResourceRateLimit } from '../../middlewares';

export async function appIntegrationsRoutes(app: FastifyInstance) {
  // Listar integrações do seller
  app.get('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const integrations = await prisma.appIntegration.findMany({
      where: { user_id: decoded.id },
    });

    // Mascarar tokens na resposta
    const masked = integrations.map(i => ({
      ...i,
      api_token: i.api_token ? i.api_token.substring(0, 6) + '...' + i.api_token.substring(i.api_token.length - 4) : '',
    }));

    return reply.send({ success: true, integrations: masked });
  });

  // Salvar/atualizar integração
  app.post('/', {
    preHandler: [createResourceRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };

    const schema = z.object({
      appId: z.string().min(1).max(50),
      apiToken: z.string().max(500),
      active: z.boolean(),
    });

    const body = schema.parse(request.body);

    const integration = await prisma.appIntegration.upsert({
      where: {
        user_id_app_id: { user_id: decoded.id, app_id: body.appId },
      },
      create: {
        user_id: decoded.id,
        app_id: body.appId,
        api_token: body.apiToken,
        active: body.active,
      },
      update: {
        ...(body.apiToken && { api_token: body.apiToken }),
        active: body.active,
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, integration });
  });
}

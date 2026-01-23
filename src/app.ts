import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';

import { env } from './config/env';
import { prisma } from './config/database';
import './config/redis'; // Inicializa Redis (opcional)
import { scheduleReserveRelease } from './queues/webhook.queue';

// Import routes
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';
import { productsRoutes } from './modules/products/products.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { withdrawalsRoutes } from './modules/withdrawals/withdrawals.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { integrationsRoutes } from './modules/integrations/integrations.routes';
import { verificationRoutes } from './modules/verification/verification.routes';
import { pushRoutes } from './modules/push/push.routes';

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'development' ? 'info' : 'warn',
  },
});

async function bootstrap() {
  // CORS
  await app.register(cors, {
    origin: true, // Permite qualquer origem em desenvolvimento
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Requested-With'],
  });

  // JWT
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });

  // Rate Limiting
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // File uploads
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max
      files: 5, // Max 5 arquivos por vez
    },
  });

  // Servir arquivos estáticos (uploads)
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Rota especial para configurar webhook PIX (rodar uma vez)
  app.get('/setup-webhook', async (request, reply) => {
    try {
      const { configurePixWebhook, getPixWebhook } = await import('./providers/efibank/efi.pix');
      
      // Primeiro verifica se já está configurado
      const current = await getPixWebhook();
      if (current.success && current.webhookUrl) {
        return reply.send({
          success: true,
          message: 'Webhook já configurado',
          webhookUrl: current.webhookUrl,
        });
      }
      
      // Configura o webhook
      const webhookUrl = 'https://api.appzucropay.com/api/webhooks/efi';
      const result = await configurePixWebhook(webhookUrl);
      
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error,
          debug: result.debug,
        });
      }

      return reply.send({
        success: true,
        message: 'Webhook PIX configurado com sucesso!',
        webhookUrl,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // API Routes
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(usersRoutes, { prefix: '/api/users' });
  app.register(productsRoutes, { prefix: '/api/products' });
  app.register(paymentsRoutes, { prefix: '/api/payments' });
  app.register(webhooksRoutes, { prefix: '/api/webhooks' });
  app.register(withdrawalsRoutes, { prefix: '/api/withdrawals' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(integrationsRoutes, { prefix: '/api/v1' });
  app.register(verificationRoutes, { prefix: '/api/verification' });
  app.register(pushRoutes, { prefix: '/api/push' });

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
      });
    }

    const statusCode = error.statusCode || 500;
    const message = statusCode === 500 ? 'Internal Server Error' : error.message;

    return reply.status(statusCode).send({
      error: message,
      statusCode,
    });
  });

  // Test database connection
  try {
    await prisma.$connect();
    app.log.info('✅ Database connected');
  } catch (error) {
    app.log.error(`❌ Database connection failed: ${String(error)}`);
    process.exit(1);
  }

  // Start server
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`🚀 Server running at http://localhost:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

bootstrap();

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
});

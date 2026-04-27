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
import { memberAreaRoutes, memberAreaPublicRoutes } from './modules/products/member-area.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { splitsRoutes } from './modules/payments/splits.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { withdrawalsRoutes } from './modules/withdrawals/withdrawals.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { integrationsRoutes } from './modules/integrations/integrations.routes';
import { verificationRoutes } from './modules/verification/verification.routes';
import { pushRoutes } from './modules/push/push.routes';
import { uploadRoutes } from './modules/upload/upload.routes';
import { checkoutRoutes } from './modules/checkout/checkout.routes';
import { orderBumpRoutes } from './modules/orderbump/orderbump.routes';
import { subscriptionRoutes } from './modules/subscriptions/subscriptions.routes';
import { ticketsRoutes } from './modules/tickets/tickets.routes';
import { couponsRoutes } from './modules/coupons/coupons.routes';
import { appIntegrationsRoutes } from './modules/app-integrations/app-integrations.routes';

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

  // Rota para simular pagamento PIX (APENAS PARA TESTE)
  app.get('/test-pix/:txid', async (request, reply) => {
    const { txid } = request.params as { txid: string };
    
    console.log('[TEST] Simulando pagamento PIX para txid:', txid);
    
    // Buscar pagamento pelo txid
    const payment = await prisma.payment.findFirst({
      where: {
        OR: [
          { efi_txid: txid },
          { asaas_payment_id: txid },
        ],
      },
      include: {
        user: true,
        payment_link: {
          include: { product: true },
        },
      },
    });

    if (!payment) {
      return reply.status(404).send({
        success: false,
        error: 'Pagamento não encontrado',
        txid,
      });
    }

    if (payment.status === 'RECEIVED') {
      return reply.send({
        success: true,
        message: 'Pagamento já foi processado anteriormente',
        payment: {
          id: payment.id,
          status: payment.status,
          value: payment.value,
        },
      });
    }

    // Importar e processar
    const { processPixPaymentDirect } = await import('./queues/webhook.queue');
    
    await processPixPaymentDirect({
      txid,
      endToEndId: 'TEST_' + Date.now(),
      valor: String(payment.value),
      pagador: {
        nome: 'Teste Manual',
        cpf: '00000000000',
      },
    });

    // Buscar pagamento atualizado
    const updatedPayment = await prisma.payment.findUnique({
      where: { id: payment.id },
    });

    return reply.send({
      success: true,
      message: 'Pagamento simulado com sucesso!',
      payment: {
        id: updatedPayment?.id,
        status: updatedPayment?.status,
        value: updatedPayment?.value,
        net_value: updatedPayment?.net_value,
      },
    });
  });

  // Rota especial para configurar webhook PIX (rodar uma vez)
  app.get('/setup-webhook', async (request, reply) => {
    try {
      const { configurePixWebhook, getPixWebhook } = await import('./providers/efibank/efi.pix');
      
      const correctWebhookUrl = 'https://api.appzucropay.com/api/webhooks/efi';
      
      // Verifica se já está configurado com a URL correta
      const current = await getPixWebhook();
      if (current.success && current.webhookUrl === correctWebhookUrl) {
        return reply.send({
          success: true,
          message: 'Webhook já configurado corretamente',
          webhookUrl: current.webhookUrl,
        });
      }
      
      // Configura/Reconfigura o webhook com a URL correta
      console.log('[Setup] URL atual:', current.webhookUrl);
      console.log('[Setup] Reconfigurando para:', correctWebhookUrl);
      
      const result = await configurePixWebhook(correctWebhookUrl);
      
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error,
          debug: result.debug,
          previousUrl: current.webhookUrl,
        });
      }

      return reply.send({
        success: true,
        message: 'Webhook PIX reconfigurado com sucesso!',
        webhookUrl: correctWebhookUrl,
        previousUrl: current.webhookUrl || null,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ========================================
  // Rota de polling para verificar status de pagamento (checkout público)
  // ========================================
  app.get('/api/check-payment-status', async (request, reply) => {
    const query = request.query as { type?: string; txid?: string; chargeId?: string; paymentId?: string };
    
    try {
      let payment = null;

      // Buscar por paymentId (mais confiável)
      if (query.paymentId) {
        payment = await prisma.payment.findUnique({
          where: { id: query.paymentId },
        });
      }
      
      // Buscar por txid (PIX EfiBank ou Asaas)
      if (!payment && query.txid) {
        payment = await prisma.payment.findFirst({
          where: {
            OR: [
              { efi_txid: query.txid },
              { asaas_payment_id: query.txid },
            ],
          },
        });
      }

      // Buscar por chargeId (Cartão/Boleto)
      if (!payment && query.chargeId) {
        payment = await prisma.payment.findFirst({
          where: {
            OR: [
              { efi_charge_id: query.chargeId },
              { asaas_payment_id: query.chargeId },
            ],
          },
        });
      }

      if (!payment) {
        return reply.send({ success: false, status: 'NOT_FOUND' });
      }

      const isConfirmed = payment.status === 'RECEIVED';

      return reply.send({
        success: true,
        status: isConfirmed ? 'CONFIRMED' : payment.status,
        payment_id: payment.id,
        value: Number(payment.value),
        billing_type: payment.billing_type,
      });
    } catch (error: any) {
      console.error('[CHECK STATUS] Erro:', error);
      return reply.send({ success: false, status: 'ERROR', error: error.message });
    }
  });

  // API Routes
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(usersRoutes, { prefix: '/api/users' });
  app.register(productsRoutes, { prefix: '/api/products' });
  app.register(memberAreaRoutes, { prefix: '/api/products' });
  app.register(memberAreaPublicRoutes, { prefix: '/api/member-area' });
  app.register(paymentsRoutes, { prefix: '/api/payments' });
  app.register(splitsRoutes, { prefix: '/api/splits' });
  app.register(webhooksRoutes, { prefix: '/api/webhooks' });
  app.register(withdrawalsRoutes, { prefix: '/api/withdrawals' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(integrationsRoutes, { prefix: '/api/v1' });
  app.register(verificationRoutes, { prefix: '/api/verification' });
  app.register(pushRoutes, { prefix: '/api/push' });
  app.register(uploadRoutes, { prefix: '/api/upload' });
  app.register(checkoutRoutes, { prefix: '/api/checkout' });
  app.register(orderBumpRoutes, { prefix: '/api/orderbumps' });
  app.register(subscriptionRoutes, { prefix: '/api/subscriptions' });
  app.register(ticketsRoutes, { prefix: '/api/tickets' });
  app.register(couponsRoutes, { prefix: '/api/coupons' });
  app.register(appIntegrationsRoutes, { prefix: '/api/app-integrations' });

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

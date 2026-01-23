// ============================================
// Middleware de Rate Limiting
// ============================================

import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../config/redis';

interface RateLimitOptions {
  max: number;           // Máximo de requests
  windowMs: number;      // Janela de tempo em ms
  keyPrefix?: string;    // Prefixo para a key no Redis
  message?: string;      // Mensagem de erro customizada
  skipFailedRequests?: boolean;  // Não contar requests que falharam
  keyGenerator?: (request: FastifyRequest) => string;  // Função para gerar a key
}

const defaultOptions: RateLimitOptions = {
  max: 100,
  windowMs: 60 * 1000, // 1 minuto
  keyPrefix: 'rl:',
  message: 'Muitas requisições. Tente novamente em alguns minutos.',
};

/**
 * Cria um middleware de rate limiting customizado
 */
export function createRateLimiter(options: Partial<RateLimitOptions> = {}) {
  const config = { ...defaultOptions, ...options };
  const windowSeconds = Math.ceil(config.windowMs / 1000);

  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Se Redis não está disponível, permite a request (fail-open)
    if (!redis) {
      return;
    }

    // Gera a key baseada no IP ou função customizada
    const key = config.keyGenerator
      ? config.keyGenerator(request)
      : `${config.keyPrefix}${request.ip}`;

    try {
      // Incrementa o contador
      const current = await redis.incr(key);

      // Se é a primeira request, define o TTL
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      // Adiciona headers informativos
      const ttl = await redis.ttl(key);
      reply.header('X-RateLimit-Limit', config.max);
      reply.header('X-RateLimit-Remaining', Math.max(0, config.max - current));
      reply.header('X-RateLimit-Reset', Math.ceil(Date.now() / 1000) + ttl);

      // Verifica se excedeu o limite
      if (current > config.max) {
        reply.header('Retry-After', ttl);
        return reply.status(429).send({
          error: config.message,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: ttl,
        });
      }
    } catch (error) {
      // Se o Redis falhar, permite a request (fail-open)
      console.error('[RateLimit] Redis error:', error);
    }
  };
}

// ============================================
// Rate Limiters Pré-configurados
// ============================================

/**
 * Rate limit padrão para API
 * 100 requests por minuto
 */
export const standardRateLimit = createRateLimiter({
  max: 100,
  windowMs: 60 * 1000,
  keyPrefix: 'rl:api:',
});

/**
 * Rate limit para login/registro
 * 10 tentativas por 15 minutos
 */
export const authRateLimit = createRateLimiter({
  max: 10,
  windowMs: 15 * 60 * 1000, // 15 minutos
  keyPrefix: 'rl:auth:',
  message: 'Muitas tentativas de login. Aguarde 15 minutos.',
});

/**
 * Rate limit para checkout público
 * 30 requests por minuto por IP
 */
export const checkoutRateLimit = createRateLimiter({
  max: 30,
  windowMs: 60 * 1000,
  keyPrefix: 'rl:checkout:',
  message: 'Muitas tentativas. Aguarde um momento.',
});

/**
 * Rate limit para webhooks (mais permissivo)
 * 500 requests por minuto
 */
export const webhookRateLimit = createRateLimiter({
  max: 500,
  windowMs: 60 * 1000,
  keyPrefix: 'rl:webhook:',
});

/**
 * Rate limit para criação de recursos
 * 20 criações por minuto
 */
export const createResourceRateLimit = createRateLimiter({
  max: 20,
  windowMs: 60 * 1000,
  keyPrefix: 'rl:create:',
  message: 'Limite de criação atingido. Aguarde um momento.',
});

/**
 * Rate limit para API de integradores
 * Baseado na API Key (se disponível) ou IP
 */
export const integratorRateLimit = createRateLimiter({
  max: 60,
  windowMs: 60 * 1000,
  keyPrefix: 'rl:integrator:',
  keyGenerator: (request) => {
    const apiKey = request.headers['x-api-key'] as string;
    if (apiKey) {
      // Usa os primeiros 10 caracteres da API key
      return `rl:integrator:${apiKey.substring(0, 10)}`;
    }
    return `rl:integrator:${request.ip}`;
  },
});

/**
 * Rate limit rigoroso para ações sensíveis
 * 5 requests por hora
 */
export const sensitiveActionRateLimit = createRateLimiter({
  max: 5,
  windowMs: 60 * 60 * 1000, // 1 hora
  keyPrefix: 'rl:sensitive:',
  message: 'Ação limitada. Tente novamente mais tarde.',
});

/**
 * Rate limit por usuário (requer autenticação prévia)
 */
export function userRateLimit(max: number, windowMs: number) {
  return createRateLimiter({
    max,
    windowMs,
    keyPrefix: 'rl:user:',
    keyGenerator: (request) => {
      const userId = (request as any).currentUser?.id;
      if (userId) {
        return `rl:user:${userId}`;
      }
      return `rl:user:${request.ip}`;
    },
  });
}

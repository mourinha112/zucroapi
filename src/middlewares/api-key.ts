// ============================================
// Middleware de Autenticação por API Key
// Para integradores externos
// ============================================

import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database';

export interface ApiKeyUser {
  id: string;
  userId: string;
  name: string;
  user: {
    id: string;
    email: string;
    name: string;
    account_status: string;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyUser;
    apiUser?: ApiKeyUser['user'];
  }
}

/**
 * Middleware para autenticar requests via API Key
 * Aceita header X-API-Key ou Authorization: Bearer
 * 
 * Uso: { preHandler: [authenticateApiKey] }
 */
export async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Busca a API Key no header
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    return reply.status(401).send({
      error: 'API Key não fornecida',
      code: 'API_KEY_MISSING',
      hint: 'Envie a API Key no header X-API-Key ou Authorization: Bearer <api_key>',
    });
  }

  // Valida formato da API Key (começa com zp_)
  if (!apiKey.startsWith('zp_')) {
    return reply.status(401).send({
      error: 'Formato de API Key inválido',
      code: 'API_KEY_INVALID_FORMAT',
    });
  }

  try {
    // Busca a API Key no banco (comparação direta, pois armazenamos a key em texto)
    const apiKeyRecord = await prisma.apiKey.findFirst({
      where: {
        api_key: apiKey,
        status: 'active',
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            account_status: true,
          },
        },
      },
    });

    if (!apiKeyRecord) {
      return reply.status(401).send({
        error: 'API Key inválida ou inativa',
        code: 'API_KEY_INVALID',
      });
    }

    // Verifica se o usuário está ativo
    if (apiKeyRecord.user.account_status === 'blocked' || apiKeyRecord.user.account_status === 'suspended') {
      return reply.status(403).send({
        error: 'Conta suspensa ou bloqueada',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    // Atualiza último uso (async, não bloqueia)
    prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { last_used_at: new Date() },
    }).catch(console.error);

    // Anexa dados ao request
    request.apiKey = {
      id: apiKeyRecord.id,
      userId: apiKeyRecord.user_id,
      name: apiKeyRecord.name || 'API Key',
      user: apiKeyRecord.user,
    };
    request.apiUser = apiKeyRecord.user;

  } catch (error) {
    console.error('[API Key Auth] Error:', error);
    return reply.status(500).send({
      error: 'Erro ao validar API Key',
      code: 'API_KEY_ERROR',
    });
  }
}

/**
 * Middleware que aceita API Key OU JWT
 * Útil para endpoints que podem ser usados tanto por integradores quanto pelo dashboard
 */
export async function authenticateApiKeyOrJwt(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = extractApiKey(request);

  // Se tem API Key, usa autenticação por API Key
  if (apiKey && apiKey.startsWith('zp_')) {
    return authenticateApiKey(request, reply);
  }

  // Senão, tenta JWT
  try {
    const decoded = await request.jwtVerify<{ id: string; email: string }>();
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, name: true, account_status: true },
    });

    if (!user) {
      return reply.status(401).send({
        error: 'Usuário não encontrado',
        code: 'USER_NOT_FOUND',
      });
    }

    request.apiUser = user;
  } catch {
    return reply.status(401).send({
      error: 'Autenticação necessária (API Key ou JWT)',
      code: 'AUTH_REQUIRED',
    });
  }
}

/**
 * Extrai API Key dos headers
 */
function extractApiKey(request: FastifyRequest): string | null {
  // Primeiro tenta X-API-Key
  const xApiKey = request.headers['x-api-key'];
  if (xApiKey) {
    return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }

  // Depois tenta Authorization: Bearer (se não for JWT)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // API Keys começam com zp_, JWTs são mais longos e têm formato diferente
    if (token.startsWith('zp_')) {
      return token;
    }
  }

  return null;
}

/**
 * Registra uso da API Key para analytics
 */
export async function logApiKeyUsage(
  apiKeyId: string,
  endpoint: string,
  method: string,
  statusCode: number
): Promise<void> {
  try {
    // Incrementa contador no Redis ou registra em tabela de analytics
    // Implementar conforme necessidade de métricas
    console.log(`[API Key Usage] ${apiKeyId} - ${method} ${endpoint} - ${statusCode}`);
  } catch (error) {
    console.error('[API Key Usage] Log error:', error);
  }
}

/**
 * Valida se a API Key tem permissão para determinada ação
 * Para uso futuro com scopes/permissions
 */
export async function checkApiKeyPermission(
  request: FastifyRequest,
  permission: string
): Promise<boolean> {
  if (!request.apiKey) {
    return false;
  }

  // Por enquanto, todas as API Keys têm acesso total
  // No futuro, implementar sistema de scopes
  return true;
}

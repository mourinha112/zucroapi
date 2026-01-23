// ============================================
// Middleware de Autenticação JWT
// ============================================

import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
  }
}

/**
 * Middleware para validar JWT e autenticar usuário
 * Uso: { preHandler: [authenticate] }
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // Verifica o token JWT
    const decoded = await request.jwtVerify<{ id: string; email: string }>();

    // Busca o usuário no banco
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        name: true,
        account_status: true,
      },
    });

    if (!user) {
      return reply.status(401).send({
        error: 'Usuário não encontrado',
        code: 'USER_NOT_FOUND',
      });
    }

    if (user.account_status === 'blocked' || user.account_status === 'suspended') {
      return reply.status(403).send({
        error: 'Conta suspensa ou bloqueada',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    // Anexa o usuário ao request
    request.currentUser = {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  } catch (err) {
    return reply.status(401).send({
      error: 'Token inválido ou expirado',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Middleware para validar JWT de admin
 * Uso: { preHandler: [authenticateAdmin] }
 */
export async function authenticateAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const decoded = await request.jwtVerify<{ id: string; email: string; isAdmin?: boolean }>();

    // Verifica se é admin
    const admin = await prisma.adminCredential.findFirst({
      where: {
        OR: [
          { id: decoded.id },
          { email: decoded.email },
        ],
        is_active: true,
      },
    });

    if (!admin) {
      return reply.status(403).send({
        error: 'Acesso negado. Apenas administradores.',
        code: 'ADMIN_REQUIRED',
      });
    }

    request.currentUser = {
      id: admin.id,
      email: admin.email,
      name: admin.name || 'Admin',
      role: 'admin',
    };
  } catch (err) {
    return reply.status(401).send({
      error: 'Token inválido ou expirado',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Middleware opcional - não falha se não tiver token
 * Útil para rotas que funcionam com ou sem auth
 */
export async function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return; // Continua sem autenticação
    }

    const decoded = await request.jwtVerify<{ id: string; email: string }>();
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, name: true },
    });

    if (user) {
      request.currentUser = {
        id: user.id,
        email: user.email,
        name: user.name,
      };
    }
  } catch {
    // Ignora erros - continua sem autenticação
  }
}

/**
 * Verifica se o usuário tem status ativo/aprovado
 * Usar APÓS authenticate
 */
export async function requireActiveUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.currentUser) {
    return reply.status(401).send({
      error: 'Autenticação necessária',
      code: 'AUTH_REQUIRED',
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: request.currentUser.id },
    select: { account_status: true },
  });

  if (!user || user.account_status !== 'active') {
    return reply.status(403).send({
      error: 'Conta não verificada. Complete a verificação para continuar.',
      code: 'ACCOUNT_NOT_VERIFIED',
    });
  }
}

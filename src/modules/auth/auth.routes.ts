import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { authService } from './auth.service';
import { authenticate, authRateLimit } from '../../middlewares';
import { prisma } from '../../config/database';

// Schemas de validação
const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Nome deve ter no mínimo 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
  cpf_cnpj: z.string().optional(),
  phone: z.string().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(6, 'Nova senha deve ter no mínimo 6 caracteres'),
});

export async function authRoutes(app: FastifyInstance) {
  // Login de usuário (com rate limit)
  app.post('/login', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body);
      const user = await authService.loginUser(body.email, body.password);
      
      // Gerar JWT
      const token = app.jwt.sign({
        id: user.id,
        email: user.email,
        type: 'user',
      });

      return reply.send({
        success: true,
        token,
        user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        error: error.message || 'Erro ao fazer login',
      });
    }
  });

  // Login de admin (com rate limit)
  app.post('/admin/login', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body);
      const admin = await authService.loginAdmin(body.email, body.password);
      
      // Gerar JWT
      const token = app.jwt.sign({
        id: admin.id,
        email: admin.email,
        type: 'admin',
        role: admin.role,
      });

      return reply.send({
        success: true,
        token,
        admin,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        error: error.message || 'Erro ao fazer login',
      });
    }
  });

  // Registrar usuário (com rate limit)
  app.post('/register', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = registerSchema.parse(request.body);
      const user = await authService.registerUser(body);
      
      // Gerar JWT
      const token = app.jwt.sign({
        id: user.id,
        email: user.email,
        type: 'user',
      });

      return reply.status(201).send({
        success: true,
        token,
        user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        error: error.message || 'Erro ao registrar',
      });
    }
  });

  // Obter usuário atual (requer autenticação)
  app.get('/me', {
    preHandler: [authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const decoded = request.user as { id: string; type: string };
      
      if (decoded.type === 'admin') {
        const admin = await authService.getAdminById(decoded.id);
        return reply.send({ success: true, admin });
      } else {
        const user = await authService.getUserById(decoded.id);
        return reply.send({ success: true, user });
      }
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Alterar senha
  app.post('/change-password', {
    preHandler: [authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const decoded = request.user as { id: string; type: string };
      const body = changePasswordSchema.parse(request.body);
      
      if (decoded.type !== 'user') {
        return reply.status(403).send({ error: 'Apenas usuários podem alterar senha por aqui' });
      }

      await authService.updatePassword(decoded.id, body.currentPassword, body.newPassword);
      
      return reply.send({ success: true, message: 'Senha alterada com sucesso' });
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Refresh token
  app.post('/refresh', {
    preHandler: [authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const decoded = request.user as { id: string; email: string; type: string; role?: string };
    
    // Gerar novo token
    const token = app.jwt.sign({
      id: decoded.id,
      email: decoded.email,
      type: decoded.type,
      ...(decoded.role && { role: decoded.role }),
    });

    return reply.send({ success: true, token });
  });

  // ============================================
  // ENDPOINT TEMPORÁRIO - RESET DE SENHA
  // ⚠️ REMOVER APÓS USO EM PRODUÇÃO!
  // ============================================
  app.post('/reset-password-temp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { email, newPassword, secretKey } = request.body as {
        email: string;
        newPassword: string;
        secretKey: string;
      };

      // Chave secreta para proteção básica
      if (secretKey !== 'zucro2025-reset-temp') {
        return reply.status(403).send({ error: 'Acesso negado' });
      }

      if (!email || !newPassword) {
        return reply.status(400).send({ error: 'Email e nova senha são obrigatórios' });
      }

      if (newPassword.length < 6) {
        return reply.status(400).send({ error: 'Senha deve ter no mínimo 6 caracteres' });
      }

      // Hash da senha
      const password_hash = await bcrypt.hash(newPassword, 10);

      // Verificar se usuário existe
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }

      await prisma.user.update({
        where: { email: email.toLowerCase() },
        data: { password_hash },
      });

      return reply.send({
        success: true,
        message: `Senha do usuário ${email} atualizada com sucesso!`,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // ============================================
  // ENDPOINT TEMPORÁRIO - ATIVAR CONTA
  // ⚠️ REMOVER APÓS USO EM PRODUÇÃO!
  // ============================================
  app.post('/activate-account-temp', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { email, secretKey } = request.body as {
        email: string;
        secretKey: string;
      };

      if (secretKey !== 'zucro2025-reset-temp') {
        return reply.status(403).send({ error: 'Acesso negado' });
      }

      if (!email) {
        return reply.status(400).send({ error: 'Email é obrigatório' });
      }

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }

      await prisma.user.update({
        where: { email: email.toLowerCase() },
        data: { 
          account_status: 'active',
          identity_verified: true,
          verification_status: 'approved',
        },
      });

      return reply.send({
        success: true,
        message: `Conta ${email} ativada com sucesso!`,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });
}

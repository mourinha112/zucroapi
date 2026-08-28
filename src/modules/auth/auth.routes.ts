import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { authService } from './auth.service';
import { authenticate, authRateLimit } from '../../middlewares';
import { prisma } from '../../config/database';
import { sendLoginCode } from './email.service';
import { recordDevice } from '../users/devices.service';

// Schemas de validação
const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Nome deve ter no mínimo 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
  person_type: z.enum(['PF', 'PJ']).default('PF'),
  cpf_cnpj: z.string().optional(),
  phone: z.string().optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(6, 'Nova senha deve ter no mínimo 6 caracteres'),
});

export async function authRoutes(app: FastifyInstance) {
  // Login de usuário - Etapa 1: valida credenciais e envia código por email
  app.post('/login', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body);
      const user = await authService.loginUser(body.email, body.password);

      // Gerar código de 6 dígitos
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos

      // Invalidar códigos anteriores do usuário
      await prisma.loginCode.updateMany({
        where: { user_id: user.id, used: false },
        data: { used: true },
      });

      // Salvar novo código
      await prisma.loginCode.create({
        data: {
          user_id: user.id,
          code,
          expires_at: expiresAt,
        },
      });

      // Enviar email
      const sent = await sendLoginCode(user.email, code, user.name);
      if (!sent) {
        console.error(`[Auth] Falha ao enviar email para ${user.email}`);
      }

      return reply.send({
        success: true,
        requireCode: true,
        message: 'Código de verificação enviado para seu email',
        userId: user.id,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        error: error.message || 'Erro ao fazer login',
      });
    }
  });

  // Login de usuário - Etapa 2: verificar código e retornar token
  app.post('/verify-code', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const schema = z.object({
        userId: z.string().uuid(),
        code: z.string().length(6),
      });
      const body = schema.parse(request.body);

      // Buscar código válido
      const loginCode = await prisma.loginCode.findFirst({
        where: {
          user_id: body.userId,
          code: body.code,
          used: false,
          expires_at: { gte: new Date() },
        },
      });

      if (!loginCode) {
        return reply.status(400).send({
          success: false,
          error: 'Código inválido ou expirado',
        });
      }

      // Marcar como usado
      await prisma.loginCode.update({
        where: { id: loginCode.id },
        data: { used: true },
      });

      // Buscar usuário
      const user = await authService.getUserById(body.userId);

      // Gerar JWT
      const token = app.jwt.sign({
        id: user.id,
        email: user.email,
        type: 'user',
      });

      // Registra o dispositivo desta sessão (aba Dispositivos das Configurações)
      await recordDevice(request, user.id);

      return reply.send({
        success: true,
        token,
        user,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message || 'Código inválido',
      });
    }
  });

  // Reenviar código
  app.post('/resend-code', {
    preHandler: [authRateLimit],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const schema = z.object({ userId: z.string().uuid() });
      const body = schema.parse(request.body);

      const user = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { id: true, email: true, name: true },
      });

      if (!user) {
        return reply.status(404).send({ success: false, error: 'Usuário não encontrado' });
      }

      // Invalidar anteriores
      await prisma.loginCode.updateMany({
        where: { user_id: user.id, used: false },
        data: { used: true },
      });

      // Novo código
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      await prisma.loginCode.create({
        data: {
          user_id: user.id,
          code,
          expires_at: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      await sendLoginCode(user.email, code, user.name);

      return reply.send({ success: true, message: 'Novo código enviado' });
    } catch (error: any) {
      return reply.status(400).send({ success: false, error: error.message });
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

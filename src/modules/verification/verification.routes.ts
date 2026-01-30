import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';

// Tipos de documento aceitos
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function verificationRoutes(app: FastifyInstance) {
  // Obter status da verificação do usuário
  app.get('/status', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.currentUser!;

    const verification = await prisma.userVerification.findFirst({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });

    const userInfo = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        verification_status: true,
        verification_rejection_reason: true,
        verification_reviewed_at: true,
        verification_attempts: true,
      },
    });

    const MAX_ATTEMPTS = 3;
    const attemptsUsed = userInfo?.verification_attempts || 0;
    const remainingAttempts = MAX_ATTEMPTS - attemptsUsed;
    const canResubmit = remainingAttempts > 0 && userInfo?.verification_status !== 'approved';

    return reply.send({
      success: true,
      verification: verification ? {
        id: verification.id,
        status: verification.status,
        document_type: verification.document_type,
        created_at: verification.created_at,
        reviewed_at: verification.reviewed_at,
        rejection_reason: verification.rejection_reason,
      } : null,
      user_status: userInfo?.verification_status || 'pending',
      rejection_reason: userInfo?.verification_rejection_reason,
      attempts_used: attemptsUsed,
      max_attempts: MAX_ATTEMPTS,
      remaining_attempts: remainingAttempts,
      can_resubmit: canResubmit,
    });
  });

  // Enviar documentos para verificação
  app.post('/submit', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.currentUser!;

    // Verificar limite de tentativas (máximo 3)
    const userData = await prisma.user.findUnique({
      where: { id: user.id },
      select: { verification_attempts: true, verification_status: true },
    });

    const MAX_ATTEMPTS = 3;
    const currentAttempts = userData?.verification_attempts || 0;

    if (currentAttempts >= MAX_ATTEMPTS) {
      return reply.status(403).send({
        success: false,
        error: 'Você atingiu o limite máximo de 3 tentativas de verificação. Entre em contato com o suporte.',
        attempts_used: currentAttempts,
        max_attempts: MAX_ATTEMPTS,
      });
    }

    // Se já está aprovado, não permitir reenvio
    if (userData?.verification_status === 'approved') {
      return reply.status(400).send({
        success: false,
        error: 'Sua conta já está verificada.',
      });
    }

    // Processar upload de arquivos
    const parts = request.parts();
    const uploadedFiles: { type: string; path: string; originalName: string }[] = [];
    let documentType = 'rg'; // Padrão
    let selfieFile: string | null = null;
    let documentFrontFile: string | null = null;
    let documentBackFile: string | null = null;

    const uploadsDir = path.join(__dirname, '..', '..', '..', 'uploads', 'verifications', user.id);
    
    // Criar diretório do usuário se não existir
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Campos adicionais opcionais
    let fullName: string | null = null;
    let birthDate: string | null = null;
    let documentNumber: string | null = null;

    try {
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'document_type') {
            documentType = part.value as string;
          } else if (part.fieldname === 'full_name') {
            fullName = part.value as string;
          } else if (part.fieldname === 'birth_date') {
            birthDate = part.value as string;
          } else if (part.fieldname === 'document_number') {
            documentNumber = part.value as string;
          }
        } else if (part.type === 'file') {
          // Validar tipo de arquivo
          if (!ALLOWED_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              success: false,
              error: `Tipo de arquivo não permitido: ${part.mimetype}. Use JPEG, PNG ou PDF.`,
            });
          }

          // Gerar nome único
          const ext = path.extname(part.filename) || '.jpg';
          const uniqueName = `${part.fieldname}_${crypto.randomBytes(8).toString('hex')}${ext}`;
          const filePath = path.join(uploadsDir, uniqueName);

          // Salvar arquivo
          await pipeline(part.file, fs.createWriteStream(filePath));

          uploadedFiles.push({
            type: part.fieldname,
            path: `/uploads/verifications/${user.id}/${uniqueName}`,
            originalName: part.filename,
          });

          // Mapear arquivos
          if (part.fieldname === 'selfie') {
            selfieFile = `/uploads/verifications/${user.id}/${uniqueName}`;
          } else if (part.fieldname === 'document_front') {
            documentFrontFile = `/uploads/verifications/${user.id}/${uniqueName}`;
          } else if (part.fieldname === 'document_back') {
            documentBackFile = `/uploads/verifications/${user.id}/${uniqueName}`;
          }
        }
      }

      // Validar arquivos obrigatórios
      if (!selfieFile || !documentFrontFile) {
        return reply.status(400).send({
          success: false,
          error: 'Selfie e frente do documento são obrigatórios.',
        });
      }

      // Buscar dados do usuário para preencher campos faltantes
      const userInfo = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true, cpf_cnpj: true },
      });

      // Criar ou atualizar verificação no banco (user_id é unique)
      const verification = await prisma.userVerification.upsert({
        where: { user_id: user.id },
        create: {
          user_id: user.id,
          document_type: documentType,
          selfie_url: selfieFile,
          document_front_url: documentFrontFile,
          document_back_url: documentBackFile,
          full_name: fullName || userInfo?.name || null,
          birth_date: birthDate ? new Date(birthDate) : null,
          document_number: documentNumber || userInfo?.cpf_cnpj || null,
          status: 'pending',
        },
        update: {
          document_type: documentType,
          selfie_url: selfieFile,
          document_front_url: documentFrontFile,
          document_back_url: documentBackFile,
          full_name: fullName || userInfo?.name || null,
          birth_date: birthDate ? new Date(birthDate) : null,
          document_number: documentNumber || userInfo?.cpf_cnpj || null,
          status: 'pending',
          rejection_reason: null,
          reviewed_at: null,
          reviewed_by: null,
          updated_at: new Date(),
        },
      });

      // Atualizar status do usuário e incrementar tentativas
      const newAttempts = currentAttempts + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          verification_status: 'submitted', // 'submitted' = documentos enviados, aguardando análise
          verification_attempts: newAttempts,
          verification_submitted_at: new Date(),
        },
      });

      const remainingAttempts = MAX_ATTEMPTS - newAttempts;

      return reply.status(201).send({
        success: true,
        message: remainingAttempts > 0 
          ? `Documentos enviados com sucesso! Aguarde a análise. Você ainda tem ${remainingAttempts} tentativa(s) restante(s).`
          : 'Documentos enviados com sucesso! Esta foi sua última tentativa. Aguarde a análise.',
        verification: {
          id: verification.id,
          status: verification.status,
          document_type: verification.document_type,
          created_at: verification.created_at,
        },
        attempts_used: newAttempts,
        max_attempts: MAX_ATTEMPTS,
        remaining_attempts: remainingAttempts,
      });

    } catch (error: any) {
      console.error('Erro no upload de verificação:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao processar os documentos. Tente novamente.',
      });
    }
  });

  // Histórico de verificações do usuário
  app.get('/history', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.currentUser!;

    const verifications = await prisma.userVerification.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        status: true,
        document_type: true,
        created_at: true,
        reviewed_at: true,
        rejection_reason: true,
      },
    });

    return reply.send({
      success: true,
      verifications,
    });
  });
}

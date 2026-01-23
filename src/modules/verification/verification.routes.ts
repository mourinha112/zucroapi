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
      },
    });

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
    });
  });

  // Enviar documentos para verificação
  app.post('/submit', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.currentUser!;

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

    try {
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'document_type') {
            documentType = part.value as string;
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

      // Criar ou atualizar verificação no banco (user_id é unique)
      const verification = await prisma.userVerification.upsert({
        where: { user_id: user.id },
        create: {
          user_id: user.id,
          document_type: documentType,
          selfie_url: selfieFile,
          document_front_url: documentFrontFile,
          document_back_url: documentBackFile,
          status: 'pending',
        },
        update: {
          document_type: documentType,
          selfie_url: selfieFile,
          document_front_url: documentFrontFile,
          document_back_url: documentBackFile,
          status: 'pending',
          rejection_reason: null,
          reviewed_at: null,
          reviewed_by: null,
          updated_at: new Date(),
        },
      });

      // Atualizar status do usuário
      await prisma.user.update({
        where: { id: user.id },
        data: {
          verification_status: 'pending',
        },
      });

      return reply.status(201).send({
        success: true,
        message: 'Documentos enviados com sucesso! Aguarde a análise.',
        verification: {
          id: verification.id,
          status: verification.status,
          document_type: verification.document_type,
          created_at: verification.created_at,
        },
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

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { authenticate, standardRateLimit } from '../../middlewares';

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

const ALLOWED_MATERIAL_TYPES = [
  // images
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  // documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  // archives
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  // audio / video
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        success: false,
        error: 'Nenhum arquivo enviado. Use o campo "file".',
      });
    }

    if (!ALLOWED_TYPES.includes(data.mimetype)) {
      return reply.status(400).send({
        success: false,
        error: `Tipo não permitido: ${data.mimetype}. Use JPEG, PNG, WEBP ou GIF.`,
      });
    }

    const uploadsDir = path.join(__dirname, '..', '..', '..', 'uploads', 'products');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const ext = path.extname(data.filename) || '.jpg';
    const uniqueName = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    const filePath = path.join(uploadsDir, uniqueName);

    try {
      await pipeline(data.file, fs.createWriteStream(filePath));
    } catch (err: any) {
      request.log.error(err);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao salvar o arquivo.',
      });
    }

    const url = `/uploads/products/${uniqueName}`;
    return reply.send({ success: true, url });
  });

  // Upload de materiais da área de membros (PDFs, docs, áudio, vídeo curto, etc.)
  app.post('/material', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ success: false, error: 'Nenhum arquivo enviado.' });
    }

    if (!ALLOWED_MATERIAL_TYPES.includes(data.mimetype)) {
      return reply.status(400).send({
        success: false,
        error: `Tipo não permitido: ${data.mimetype}.`,
      });
    }

    const uploadsDir = path.join(__dirname, '..', '..', '..', 'uploads', 'materials');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const ext = path.extname(data.filename) || '';
    const uniqueName = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    const filePath = path.join(uploadsDir, uniqueName);

    try {
      await pipeline(data.file, fs.createWriteStream(filePath));
    } catch (err: any) {
      request.log.error(err);
      return reply.status(500).send({ success: false, error: 'Erro ao salvar o arquivo.' });
    }

    const stat = fs.statSync(filePath);
    const url = `/uploads/materials/${uniqueName}`;
    return reply.send({
      success: true,
      url,
      name: data.filename,
      mime: data.mimetype,
      size: stat.size,
    });
  });
}

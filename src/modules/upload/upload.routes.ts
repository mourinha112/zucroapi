import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { authenticate, standardRateLimit } from '../../middlewares';

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

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
}

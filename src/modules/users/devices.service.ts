import crypto from 'crypto';
import { FastifyRequest } from 'fastify';
import { prisma } from '../../config/database';

/** Nome do navegador a partir do User-Agent (ordem importa: Edge/Opera antes de Chrome). */
function parseBrowser(ua: string): string {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Navegador';
}

/** Sistema operacional a partir do User-Agent (iOS antes de Mac: iPad manda "like Mac"). */
function parseOs(ua: string): string {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Desconhecido';
}

/** IP real do cliente: a API fica atrás do Cloudflare + nginx. */
export function clientIp(request: FastifyRequest): string {
  const h = request.headers;
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return request.ip || '';
}

/**
 * Registra (ou atualiza) o dispositivo de onde veio a requisição.
 * Nunca lança: falha aqui não pode derrubar um login.
 */
export async function recordDevice(request: FastifyRequest, userId: string): Promise<void> {
  try {
    const ua = (request.headers['user-agent'] as string) || '';
    const ip = clientIp(request);
    const browser = parseBrowser(ua);
    const os = parseOs(ua);
    // Mesmo navegador/SO/IP = mesmo dispositivo (evita uma linha por login).
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${browser}|${os}|${ip}`)
      .digest('hex')
      .slice(0, 64);

    await prisma.userDevice.upsert({
      where: { user_id_fingerprint: { user_id: userId, fingerprint } },
      update: { last_seen: new Date(), user_agent: ua || undefined, ip_address: ip || undefined },
      create: {
        user_id: userId,
        fingerprint,
        user_agent: ua || null,
        ip_address: ip || null,
        browser,
        os,
      },
    });
  } catch (err) {
    request.log?.warn({ err }, '[devices] falha ao registrar dispositivo');
  }
}

export async function listDevices(userId: string) {
  const rows = await prisma.userDevice.findMany({
    where: { user_id: userId },
    orderBy: { last_seen: 'desc' },
    take: 50,
  });
  return rows.map((d) => ({
    id: d.id,
    name: `${d.browser || 'Navegador'} (${d.os || 'Desconhecido'})`,
    os: d.os,
    browser: d.browser,
    ip: d.ip_address,
    last_seen: d.last_seen,
    created_at: d.created_at,
  }));
}

import crypto from 'crypto';
import { env } from '../../config/env';

const BASE_URL = 'https://api.uvvipay.com.br';

interface UvviPayResponse {
  success: boolean;
  status: number;
  data: any;
}

/**
 * Cliente HTTP da UvviPay.
 *
 * Diferente dos outros adquirentes (Basic/Bearer), a UvviPay autentica os
 * endpoints de pagamento com os headers `client-id` e `client-secret` direto —
 * não há troca prévia por token. O fluxo OAuth2 (`POST /oauth/token`) existe
 * na doc, mas é para os endpoints de subconta, que não usamos aqui.
 *
 * Docs: https://developers.uvvipay.com.br/authentication
 */
const getAuthHeaders = (): Record<string, string> => ({
  'client-id': env.UVVIPAY_CLIENT_ID,
  'client-secret': env.UVVIPAY_CLIENT_SECRET,
});

/** Credenciais presentes? Usado para expor `configured` no painel admin. */
export const isUvviPayConfigured = (): boolean =>
  !!(env.UVVIPAY_CLIENT_ID && env.UVVIPAY_CLIENT_SECRET);

/**
 * Chave de idempotência (UUID v4). A UvviPay usa `x-idempotency-key` para que
 * um retry da mesma cobrança não gere uma segunda transação.
 */
export const uvvipayIdempotencyKey = (): string => crypto.randomUUID();

/**
 * Faz requisições para a API da UvviPay.
 * Segue o padrão dos demais providers: nunca lança em erro HTTP —
 * devolve { success, status, data } e o chamador decide.
 */
export const uvvipayRequest = async (
  method: string,
  endpoint: string,
  data: any = null,
  extraHeaders: Record<string, string> = {},
): Promise<UvviPayResponse> => {
  const url = `${BASE_URL}${endpoint}`;

  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extraHeaders,
  };

  const options: RequestInit = { method, headers };
  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  console.log(`[UVVIPAY] ${method} ${endpoint}`);

  try {
    const response = await fetch(url, options);
    const responseData = await response.json().catch(() => ({}));
    console.log(
      `[UVVIPAY] Response ${response.status}:`,
      JSON.stringify(responseData).substring(0, 500),
    );
    return { success: response.ok, status: response.status, data: responseData };
  } catch (error: any) {
    console.error('[UVVIPAY] Request Error:', error.message);
    throw error;
  }
};

/**
 * Valida a assinatura HMAC do webhook da UvviPay.
 *
 * A UvviPay envia `X-UvviPay-Timestamp` (unix em segundos) e
 * `X-UvviPay-Signature` = HMAC-SHA256 hex de `"{timestamp}.{corpo cru}"`.
 * O corpo precisa ser exatamente o recebido — reserializar quebra a conferência.
 *
 * Retorna:
 *  - 'skip'    → sem segredo configurado ou sem corpo cru (não bloqueia)
 *  - 'ok'      → assinatura confere
 *  - 'invalid' → assinatura ausente, fora da janela de 5 min ou divergente
 */
export const verifyUvviPaySignature = (
  rawBody: string | undefined,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
): 'ok' | 'skip' | 'invalid' => {
  if (!secret) return 'skip';
  if (!rawBody) return 'skip';
  if (!signature || !timestamp) return 'invalid';

  // Janela de 300s contra replay (recomendação da doc)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return 'invalid';
  if (Math.abs(Date.now() / 1000 - ts) > 300) return 'invalid';

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return 'invalid';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'invalid';
};

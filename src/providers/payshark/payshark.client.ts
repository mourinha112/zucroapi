import crypto from 'crypto';
import { env } from '../../config/env';

const BASE_URL = 'https://api.gatewaypayshark.com.br/v1';

interface PaySharkResponse {
  success: boolean;
  status: number;
  data: any;
}

/**
 * A Pay Shark tem DUAS credenciais Bearer (painel → Financeiro → Integrações):
 *  - `api`      → token padrão: /payment, /payment/:id, /payment/refund
 *  - `withdraw` → "API Withdrawal Credentials": /transfer, /transfer/:id e /balance
 * Usar o token errado devolve 403.
 *
 * Docs: https://app.gatewaypayshark.com.br/docs/introduction/start
 */
type PaySharkAuthMode = 'api' | 'withdraw';

/**
 * Contas na plataforma Pay Shark. Mesma API, credenciais diferentes:
 *  - 'payshark'       → conta original (PAYSHARK_*)
 *  - 'payshark_white' → Pay Shark White (PAYSHARK_WHITE_*)
 */
export type PaySharkAccount = 'payshark' | 'payshark_white';

export const PAYSHARK_ACCOUNTS: { account: PaySharkAccount; label: string; path: string }[] = [
  { account: 'payshark', label: 'Pay Shark', path: '/payshark' },
  { account: 'payshark_white', label: 'Pay Shark White', path: '/payshark-white' },
];

export const isPaySharkAccount = (v: unknown): v is PaySharkAccount => v === 'payshark' || v === 'payshark_white';

export const paysharkEnv = (account: PaySharkAccount = 'payshark') =>
  account === 'payshark_white'
    ? {
        label: 'Pay Shark White',
        apiKey: env.PAYSHARK_WHITE_API_KEY || '',
        withdrawKey: env.PAYSHARK_WHITE_WITHDRAW_KEY || '',
        webhookUrl: env.PAYSHARK_WHITE_WEBHOOK_URL || (env.PAYSHARK_WEBHOOK_URL ? env.PAYSHARK_WEBHOOK_URL.replace(/\/payshark\/?$/, '/payshark-white') : ''),
        webhookSecret: env.PAYSHARK_WHITE_WEBHOOK_SECRET || '',
        webhookSecretTransfer: env.PAYSHARK_WHITE_WEBHOOK_SECRET_TRANSFER || '',
      }
    : {
        label: 'Pay Shark',
        apiKey: env.PAYSHARK_API_KEY || '',
        withdrawKey: env.PAYSHARK_WITHDRAW_KEY || '',
        webhookUrl: env.PAYSHARK_WEBHOOK_URL || '',
        webhookSecret: env.PAYSHARK_WEBHOOK_SECRET || '',
        webhookSecretTransfer: env.PAYSHARK_WEBHOOK_SECRET_TRANSFER || '',
      };

const resolveToken = (mode: PaySharkAuthMode, account: PaySharkAccount): string => {
  const e = paysharkEnv(account);
  return mode === 'withdraw' ? e.withdrawKey : e.apiKey;
};

/** Credenciais presentes? Usado para expor `configured` no painel admin. */
export const isPaySharkConfigured = (account: PaySharkAccount = 'payshark'): boolean => !!paysharkEnv(account).apiKey;

/**
 * Faz requisições para a API da Pay Shark.
 * Segue o padrão dos demais providers: nunca lança em erro HTTP —
 * devolve { success, status, data } e o chamador decide.
 */
export const paysharkRequest = async (
  method: string,
  endpoint: string,
  data: any = null,
  options: { auth?: PaySharkAuthMode; extraHeaders?: Record<string, string>; account?: PaySharkAccount } = {},
): Promise<PaySharkResponse> => {
  const url = `${BASE_URL}${endpoint}`;
  const authMode: PaySharkAuthMode = options.auth || 'api';
  const account: PaySharkAccount = options.account || 'payshark';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveToken(authMode, account)}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.extraHeaders || {}),
  };

  const init: RequestInit = { method, headers };
  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    init.body = JSON.stringify(data);
  }

  console.log(`[PAYSHARK${account === 'payshark_white' ? ' WHITE' : ''}] ${method} ${endpoint} (auth=${authMode})`);

  try {
    const response = await fetch(url, init);
    const responseData = await response.json().catch(() => ({}));
    console.log(
      `[PAYSHARK] Response ${response.status}:`,
      JSON.stringify(responseData).substring(0, 500),
    );
    return { success: response.ok, status: response.status, data: responseData };
  } catch (error: any) {
    console.error('[PAYSHARK] Request Error:', error.message);
    throw error;
  }
};

/**
 * Valida a assinatura do webhook da Pay Shark.
 *
 * Header `X-Signature` = HMAC-SHA256 do corpo cru (JSON), em Base64, com o
 * WEBHOOK_SECRET cadastrado no painel. Só webhooks registrados no PAINEL
 * trazem o header — os enviados para a `notificationUrl` informada na
 * cobrança chegam SEM assinatura (documentado). Por isso a ausência do header
 * é 'skip' e não 'invalid': rejeitar aqui derrubaria os webhooks de venda.
 *
 * Retorna:
 *  - 'skip'    → sem segredo, sem corpo cru ou sem header (não bloqueia)
 *  - 'ok'      → assinatura confere
 *  - 'invalid' → header presente e divergente
 */
export const verifyPaySharkSignature = (
  rawBody: string | undefined,
  headerSignature: string | undefined,
  secret: string,
): 'ok' | 'skip' | 'invalid' => {
  if (!secret || !rawBody || !headerSignature) return 'skip';
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(headerSignature);
    if (a.length !== b.length) return 'invalid';
    return crypto.timingSafeEqual(a, b) ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
};

import { env } from '../../config/env';

const BASE_URL = 'https://api.xflow-hub.com/v1';

interface XflowResponse {
  success: boolean;
  status: number;
  data: any;
}

/**
 * Gera o header Basic Auth (public_key:secret_key em base64).
 * Docs: https://app.xflow-hub.com/docs/introducao
 */
const getAuthHeader = (): string => {
  const credentials = Buffer.from(
    `${env.XFLOW_PUBLIC_KEY}:${env.XFLOW_SECRET_KEY}`,
  ).toString('base64');
  return `Basic ${credentials}`;
};

/**
 * Faz requisições para a API do XFlow Hub.
 * Retorna sempre um objeto com success/status/data — chamadores
 * checam `success` em vez de try/catch.
 */
export const xflowRequest = async (
  method: string,
  endpoint: string,
  data: any = null,
  extraHeaders: Record<string, string> = {},
): Promise<XflowResponse> => {
  const url = `${BASE_URL}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: getAuthHeader(),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extraHeaders,
  };

  const options: RequestInit = { method, headers };
  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  console.log(`[XFLOW] ${method} ${endpoint}`);

  try {
    const response = await fetch(url, options);
    const responseData = await response.json().catch(() => ({}));
    console.log(
      `[XFLOW] Response ${response.status}:`,
      JSON.stringify(responseData).substring(0, 500),
    );
    return { success: response.ok, status: response.status, data: responseData };
  } catch (error: any) {
    console.error('[XFLOW] Request Error:', error.message);
    throw error;
  }
};

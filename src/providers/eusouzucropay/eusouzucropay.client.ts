import { env } from '../../config/env';

const BASE_URL = 'https://api.eusouzucropay.com/v1';

interface EuSouZucroPayResponse {
  success: boolean;
  status: number;
  data: any;
}

/**
 * Gera o header de autenticação Basic Auth
 */
const getAuthHeader = (): string => {
  const credentials = Buffer.from(`${env.EUSOUZUCROPAY_PUBLIC_KEY}:${env.EUSOUZUCROPAY_SECRET_KEY}`).toString('base64');
  return `Basic ${credentials}`;
};

/**
 * Faz requisições para a API do EuSouZucroPay
 */
export const eusouzucropayRequest = async (
  method: string,
  endpoint: string,
  data: any = null,
  extraHeaders: Record<string, string> = {}
): Promise<EuSouZucroPayResponse> => {
  const url = `${BASE_URL}${endpoint}`;

  const headers: Record<string, string> = {
    'Authorization': getAuthHeader(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...extraHeaders,
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  console.log(`[EUSOUZUCROPAY] ${method} ${endpoint}`);

  try {
    const response = await fetch(url, options);
    const responseData = await response.json().catch(() => ({}));

    console.log(`[EUSOUZUCROPAY] Response ${response.status}:`, JSON.stringify(responseData).substring(0, 500));

    return {
      success: response.ok,
      status: response.status,
      data: responseData,
    };
  } catch (error: any) {
    console.error(`[EUSOUZUCROPAY] Request Error:`, error.message);
    throw error;
  }
};

import { env } from '../../config/env';

const BASE_URL = 'https://api.sharkhubsubadquirente.com/v1';

interface SharkResponse {
  success: boolean;
  status: number;
  data: any;
}

type SharkAuthMode = 'api' | 'withdraw';

const resolveToken = (mode: SharkAuthMode): string => {
  if (mode === 'withdraw') {
    return env.SHARK_WITHDRAW_KEY || '';
  }
  return env.SHARK_API_KEY || '';
};

export const sharkRequest = async (
  method: string,
  endpoint: string,
  data: any = null,
  options: { auth?: SharkAuthMode; extraHeaders?: Record<string, string> } = {}
): Promise<SharkResponse> => {
  const url = `${BASE_URL}${endpoint}`;
  const authMode: SharkAuthMode = options.auth || 'api';
  const token = resolveToken(authMode);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.extraHeaders || {}),
  };

  const init: RequestInit = { method, headers };

  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    init.body = JSON.stringify(data);
  }

  console.log(`[SHARK] ${method} ${endpoint} (auth=${authMode})`);

  try {
    const response = await fetch(url, init);
    const responseData = await response.json().catch(() => ({}));

    console.log(`[SHARK] Response ${response.status}:`, JSON.stringify(responseData).substring(0, 500));

    return {
      success: response.ok,
      status: response.status,
      data: responseData,
    };
  } catch (error: any) {
    console.error(`[SHARK] Request Error:`, error.message);
    throw error;
  }
};

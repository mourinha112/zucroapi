import https from 'https';
import { env } from '../../config/env';

// URLs da API Asaas
const getAsaasApiUrl = (sandbox: boolean) => sandbox ? 'sandbox.asaas.com' : 'api.asaas.com';

interface HttpResponse {
  status: number;
  data: any;
}

// Requisição HTTPS para Asaas
const httpsRequest = (options: https.RequestOptions, postData: string | null = null): Promise<HttpResponse> => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[ASAAS] Response ${res.statusCode}:`, data.substring(0, 500));
        try {
          resolve({ status: res.statusCode || 500, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode || 500, data: { raw: data } });
        }
      });
    });

    req.on('error', (error) => {
      console.error('[ASAAS] Request Error:', error);
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

// Fazer requisição à API Asaas
export const makeAsaasRequest = async (
  method: string, 
  endpoint: string, 
  data: any = null,
  apiKey?: string // Opcional - usa a key global se não fornecida
) => {
  const postData = data ? JSON.stringify(data) : null;
  const accessToken = apiKey || env.ASAAS_API_KEY;

  if (!accessToken) {
    console.error('[ASAAS] API Key não configurada');
    return {
      success: false,
      status: 500,
      data: { error: 'Asaas API Key não configurada' }
    };
  }

  const options: https.RequestOptions = {
    hostname: getAsaasApiUrl(env.ASAAS_SANDBOX || false),
    port: 443,
    path: `/v3${endpoint}`,
    method,
    headers: {
      'access_token': accessToken,
      'Content-Type': 'application/json',
      'User-Agent': 'ZucroPay/1.0',
      ...(postData && { 'Content-Length': Buffer.byteLength(postData) }),
    },
  };

  console.log(`[ASAAS] ${method} /v3${endpoint}`);
  
  try {
    const response = await httpsRequest(options, postData);
    return { 
      success: response.status >= 200 && response.status < 300, 
      status: response.status, 
      data: response.data 
    };
  } catch (error: any) {
    return {
      success: false,
      status: 500,
      data: { error: error.message }
    };
  }
};

// Gerar ID único para cobranças
export const generateExternalReference = (): string => {
  return `zp_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
};

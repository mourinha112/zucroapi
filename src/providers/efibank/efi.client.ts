import https from 'https';
import { env } from '../../config/env';

// URLs da API
const getPixApiUrl = (sandbox: boolean) => sandbox ? 'pix-h.api.efipay.com.br' : 'pix.api.efipay.com.br';
const getCobrancaApiUrl = (sandbox: boolean) => sandbox ? 'sandbox.gerencianet.com.br' : 'api.gerencianet.com.br';

// Cache de tokens
let pixTokenCache: { token: string | null; expiry: number | null } = { token: null, expiry: null };
let cobrancaTokenCache: { token: string | null; expiry: number | null } = { token: null, expiry: null };

interface HttpResponse {
  status: number;
  data: any;
}

// Requisição HTTPS com certificado (mTLS) - Para PIX
const httpsRequestWithCert = (options: https.RequestOptions & { pfx?: Buffer }, postData: string | null = null): Promise<HttpResponse> => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[EFI mTLS] Response ${res.statusCode}:`, data.substring(0, 500));
        try {
          resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, data: { raw: data } });
        }
      });
    });

    req.on('error', (error) => {
      console.error('[EFI mTLS] Request Error:', error);
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

// Requisição HTTPS sem certificado - Para Cobranças (Cartão/Boleto)
const httpsRequestNoCert = (options: https.RequestOptions, postData: string | null = null): Promise<HttpResponse> => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[EFI Cobranca] Response ${res.statusCode}:`, data.substring(0, 500));
        try {
          resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, data: { raw: data } });
        }
      });
    });

    req.on('error', (error) => {
      console.error('[EFI Cobranca] Request Error:', error);
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

// Obter token PIX (com certificado mTLS)
export const getPixAccessToken = async (): Promise<string> => {
  if (pixTokenCache.token && pixTokenCache.expiry && Date.now() < pixTokenCache.expiry) {
    return pixTokenCache.token;
  }

  console.log('[EFI PIX] Obtendo novo token...');
  const auth = Buffer.from(`${env.EFI_CLIENT_ID}:${env.EFI_CLIENT_SECRET}`).toString('base64');
  const certBuffer = Buffer.from(env.EFI_CERTIFICATE_BASE64, 'base64');
  const postData = JSON.stringify({ grant_type: 'client_credentials' });

  const options: https.RequestOptions & { pfx: Buffer; passphrase: string } = {
    hostname: getPixApiUrl(env.EFI_SANDBOX),
    port: 443,
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
    pfx: certBuffer,
    passphrase: '',
  };

  const response = await httpsRequestWithCert(options, postData);

  if (response.data?.access_token) {
    pixTokenCache.token = response.data.access_token;
    pixTokenCache.expiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    console.log('[EFI PIX] Token obtido com sucesso');
    return pixTokenCache.token!;
  }

  console.error('[EFI PIX] Auth failed:', response);
  throw new Error(response.data?.error_description || 'Falha na autenticação EfiBank PIX');
};

// Obter token Cobranças (sem certificado)
export const getCobrancaAccessToken = async (): Promise<string> => {
  if (cobrancaTokenCache.token && cobrancaTokenCache.expiry && Date.now() < cobrancaTokenCache.expiry) {
    return cobrancaTokenCache.token;
  }

  console.log('[EFI Cobranca] Obtendo novo token...');
  const auth = Buffer.from(`${env.EFI_CLIENT_ID}:${env.EFI_CLIENT_SECRET}`).toString('base64');
  const postData = JSON.stringify({ grant_type: 'client_credentials' });

  const options: https.RequestOptions = {
    hostname: getCobrancaApiUrl(env.EFI_SANDBOX),
    port: 443,
    path: '/v1/authorize',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const response = await httpsRequestNoCert(options, postData);

  if (response.data?.access_token) {
    cobrancaTokenCache.token = response.data.access_token;
    cobrancaTokenCache.expiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    console.log('[EFI Cobranca] Token obtido com sucesso');
    return cobrancaTokenCache.token!;
  }

  console.error('[EFI Cobranca] Auth failed:', response);
  throw new Error(response.data?.error_description || 'Falha na autenticação EfiBank Cobranças');
};

// Requisição PIX (com certificado mTLS)
export const makePixRequest = async (method: string, endpoint: string, data: any = null) => {
  const token = await getPixAccessToken();
  const certBuffer = Buffer.from(env.EFI_CERTIFICATE_BASE64, 'base64');
  const postData = data ? JSON.stringify(data) : null;

  const options: https.RequestOptions & { pfx: Buffer; passphrase: string } = {
    hostname: getPixApiUrl(env.EFI_SANDBOX),
    port: 443,
    path: endpoint,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(postData && { 'Content-Length': Buffer.byteLength(postData) }),
    },
    pfx: certBuffer,
    passphrase: '',
  };

  console.log(`[EFI PIX] ${method} ${endpoint}`);
  const response = await httpsRequestWithCert(options, postData);
  
  return { 
    success: response.status >= 200 && response.status < 300, 
    status: response.status, 
    data: response.data 
  };
};

// Requisição Cobranças (sem certificado)
export const makeCobrancaRequest = async (method: string, endpoint: string, data: any = null) => {
  const token = await getCobrancaAccessToken();
  const postData = data ? JSON.stringify(data) : null;

  const options: https.RequestOptions = {
    hostname: getCobrancaApiUrl(env.EFI_SANDBOX),
    port: 443,
    path: endpoint,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(postData && { 'Content-Length': Buffer.byteLength(postData) }),
    },
  };

  console.log(`[EFI Cobranca] ${method} ${endpoint}`);
  const response = await httpsRequestNoCert(options, postData);
  
  return { 
    success: response.status >= 200 && response.status < 300, 
    status: response.status, 
    data: response.data 
  };
};

// Gerar TxId para PIX
export const generateTxId = (): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 35 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// Detectar bandeira do cartão
export const detectCardBrand = (number: string): string => {
  const cleanNumber = (number || '').replace(/\D/g, '');
  
  if (/^4/.test(cleanNumber)) return 'visa';
  if (/^5[1-5]/.test(cleanNumber)) return 'mastercard';
  if (/^3[47]/.test(cleanNumber)) return 'amex';
  if (/^6(?:011|5)/.test(cleanNumber)) return 'discover';
  if (/^(?:2131|1800|35)/.test(cleanNumber)) return 'jcb';
  if (/^3(?:0[0-5]|[68])/.test(cleanNumber)) return 'diners';
  if (/^(636368|438935|504175|451416|636297|5067|4576|4011|506699)/.test(cleanNumber)) return 'elo';
  if (/^(606282|3841)/.test(cleanNumber)) return 'hipercard';
  
  return 'visa';
};

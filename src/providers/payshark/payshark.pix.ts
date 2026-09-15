import QRCode from 'qrcode';
import { env } from '../../config/env';
import { paysharkRequest } from './payshark.client';

export interface PaySharkPixChargeData {
  value: number; // em reais (ex: 49.90) — convertido internamente para centavos
  description: string;
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
  ip?: string;
}

export interface PaySharkPixChargeResult {
  success: boolean;
  transactionId?: string;
  pixCode?: string;
  pixQrCode?: string;
  error?: string;
  debug?: any;
}

/**
 * Telefone do pagador: DDD + número (10/11 dígitos), opcionalmente com o 55.
 * A plataforma recusa cobrança sem telefone válido — mesma regra do Shark Hub.
 */
const normalizePayerPhone = (value?: string): string | null => {
  const digits = (value || '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return digits;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
};

/**
 * Cria uma cobrança PIX na Pay Shark.
 * Endpoint: POST /v1/payment (method: "PIX"), token padrão.
 * Docs: https://app.gatewaypayshark.com.br/docs/payment/create-payment
 *
 * Valores em centavos. O copia-e-cola volta em `data.copypaste`; o QR Code é
 * gerado localmente a partir dele.
 */
export const createPaySharkPixCharge = async (
  data: PaySharkPixChargeData,
): Promise<PaySharkPixChargeResult> => {
  const amountInCents = Math.round(data.value * 100);
  const notificationUrl = data.postbackUrl || env.PAYSHARK_WEBHOOK_URL || '';
  const payerPhone = normalizePayerPhone(data.customerPhone);

  if (!payerPhone) {
    const missing = !(data.customerPhone || '').trim();
    return {
      success: false,
      error: missing
        ? 'Telefone do pagador é obrigatório para gerar o PIX.'
        : 'Telefone do pagador inválido. Envie DDD e número, somente dígitos.',
      debug: {
        code: missing ? 'PAYER_PHONE_REQUIRED' : 'PAYER_PHONE_INVALID',
      },
    };
  }

  const description = (data.description || 'Pagamento').substring(0, 100);

  const payload: any = {
    amount: amountInCents,
    currency: 'BRL',
    method: 'PIX',
    description,
    externalRef: data.externalRef,
    ...(notificationUrl ? { notificationUrl } : {}),
    ...(data.ip ? { ip: data.ip } : {}),
    payer: {
      name: data.customerName,
      email: data.customerEmail,
      taxId: (data.customerCpf || '').replace(/\D/g, ''),
      phone: payerPhone,
    },
    items: [
      {
        quantity: 1,
        name: description,
        price: amountInCents,
        type: 'DIGITAL',
      },
    ],
  };

  console.log('[PAYSHARK PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await paysharkRequest('POST', '/payment', payload, { auth: 'api' });

  if (!result.success) {
    console.error('[PAYSHARK PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao criar cobrança PIX na Pay Shark',
      debug: result.data,
    };
  }

  const transaction = result.data;
  const pixCopyPaste: string = transaction?.data?.copypaste || '';

  if (!pixCopyPaste || !transaction?.id) {
    console.error('[PAYSHARK PIX] Cobrança criada sem copia-e-cola/id:', transaction);
    return {
      success: false,
      error: 'Pay Shark não retornou o código PIX',
      debug: transaction,
    };
  }

  let pixQrCodeBase64 = '';
  try {
    pixQrCodeBase64 = await QRCode.toDataURL(pixCopyPaste, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (qrError) {
    console.error('[PAYSHARK PIX] Erro ao gerar QR Code:', qrError);
  }

  console.log('[PAYSHARK PIX] Cobrança criada:', transaction.id);

  return {
    success: true,
    transactionId: String(transaction.id),
    pixCode: pixCopyPaste,
    pixQrCode: pixQrCodeBase64,
  };
};

/**
 * Mapeia o status de PAGAMENTO da Pay Shark para o vocabulário interno.
 * Estados: PENDING, PROCESSING, PAID, REFUSED, REFUNDED, MED, CHARGEDBACK.
 */
export const mapPaySharkPaymentStatus = (status?: string): string => {
  const s = (status || '').toUpperCase();
  if (s === 'PAID') return 'RECEIVED';
  if (s === 'PENDING' || s === 'PROCESSING') return 'PENDING';
  if (s === 'REFUSED') return 'REFUSED';
  if (s === 'REFUNDED' || s === 'CHARGEDBACK' || s === 'MED') return 'REFUNDED';
  return 'PENDING';
};

/**
 * Consulta um pagamento.
 * Endpoint: GET /v1/payment/:id (token padrão)
 */
export const getPaySharkTransaction = async (transactionId: string) => {
  const result = await paysharkRequest('GET', `/payment/${transactionId}`, null, { auth: 'api' });

  if (!result.success) {
    return { success: false, error: result.data?.message || 'Erro ao consultar transação' };
  }

  const transaction = result.data;
  return {
    success: true,
    data: transaction,
    status: mapPaySharkPaymentStatus(transaction?.status),
    paysharkStatus: transaction?.status,
  };
};

/**
 * Saque PIX (transferência).
 * Endpoint: POST /v1/transfer — exige o token de SAQUE (API Withdrawal Credentials).
 * Docs: https://app.gatewaypayshark.com.br/docs/transfer/create-transfer
 *
 * A resposta vem com status IN_QUEUE/IN_ANALYSIS/PROCESSING; a confirmação
 * (COMPLETED/FAILED/REFUSED) chega pelo webhook em `${PAYSHARK_WEBHOOK_URL}/transfer`.
 */
export const createPaySharkPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description?: string;
  postbackUrl?: string;
  externalRef?: string;
}): Promise<{
  success: boolean;
  transferId?: string;
  endToEndId?: string;
  status?: string;
  error?: string;
  debug?: any;
}> => {
  if (!env.PAYSHARK_WITHDRAW_KEY) {
    return {
      success: false,
      error: 'PAYSHARK_WITHDRAW_KEY não configurada — saque automático indisponível.',
    };
  }

  const amountInCents = Math.round(data.value * 100);
  const transferWebhook = env.PAYSHARK_WEBHOOK_URL ? `${env.PAYSHARK_WEBHOOK_URL}/transfer` : '';
  const notificationUrl = data.postbackUrl || transferWebhook;

  // pixKeyType aceitos: CPF, CNPJ, EMAIL, PHONE, EVP, COPYPASTE
  const pixKeyTypeMap: Record<string, string> = {
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'EMAIL',
    phone: 'PHONE',
    telefone: 'PHONE',
    random: 'EVP',
    aleatoria: 'EVP',
    evp: 'EVP',
    copypaste: 'COPYPASTE',
  };

  const payload: any = {
    amount: amountInCents,
    method: 'PIX',
    externalRef: data.externalRef,
    ...(notificationUrl ? { notificationUrl } : {}),
    pix: {
      pixKeyType: pixKeyTypeMap[(data.pixKeyType || '').toLowerCase()] || 'CPF',
      pixKey: data.pixKey,
    },
  };

  console.log('[PAYSHARK TRANSFER] Criando saque:', JSON.stringify(payload));

  const result = await paysharkRequest('POST', '/transfer', payload, { auth: 'withdraw' });

  if (!result.success) {
    console.error('[PAYSHARK TRANSFER] Erro:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao processar saque na Pay Shark',
      debug: result.data,
    };
  }

  const transfer = result.data;
  const status = String(transfer?.status || '').toUpperCase();

  // Recusa síncrona: não tratar como enviado
  if (status === 'REFUSED' || status === 'FAILED') {
    return {
      success: false,
      status,
      error: transfer?.message || `Saque recusado pela Pay Shark (${status})`,
      debug: transfer,
    };
  }

  console.log('[PAYSHARK TRANSFER] Saque criado:', transfer?.id, status);

  return {
    success: true,
    transferId: String(transfer?.id),
    endToEndId: transfer?.data?.e2e || transfer?.id,
    status,
  };
};

/**
 * Consulta uma transferência.
 * Endpoint: GET /v1/transfer/:id (token de saque)
 */
export const getPaySharkTransfer = async (transferId: string) => {
  const result = await paysharkRequest('GET', `/transfer/${transferId}`, null, { auth: 'withdraw' });
  if (!result.success) {
    return { success: false, error: result.data?.message || 'Erro ao consultar transferência' };
  }
  return { success: true, data: result.data, status: String(result.data?.status || '').toUpperCase() };
};

/**
 * Saldo da loja.
 * Endpoint: GET /v1/balance (token de saque). Valores em centavos.
 * Docs: https://app.gatewaypayshark.com.br/docs/store/balance
 */
export const getPaySharkBalance = async (): Promise<{
  available: number;
  reserved: number;
} | null> => {
  try {
    if (!env.PAYSHARK_WITHDRAW_KEY) return null;
    const result = await paysharkRequest('GET', '/balance', null, { auth: 'withdraw' });
    if (!result.success || !result.data) return null;

    const data = result.data;
    const available = Number(data.available ?? 0) / 100;
    const transfersPending = Number(data?.transfers?.pending ?? 0) / 100;
    const reservePending = Number(data?.reserve?.pending ?? 0) / 100;

    return { available, reserved: transfersPending + reservePending };
  } catch (error) {
    console.error('[PAYSHARK] Erro ao consultar saldo:', error);
    return null;
  }
};

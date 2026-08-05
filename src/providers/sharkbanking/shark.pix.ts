import { sharkRequest } from './shark.client';
import { env } from '../../config/env';
import QRCode from 'qrcode';

export interface SharkPixChargeData {
  value: number;
  description: string;
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
}

export interface SharkPixChargeResult {
  success: boolean;
  transactionId?: string;
  pixCode?: string;
  pixQrCode?: string;
  secureUrl?: string;
  error?: string;
  debug?: any;
}

const normalizePayerPhone = (value?: string): string | null => {
  const digits = (value || '').replace(/\D/g, '');

  // Accepts DDD + number (10/11 digits), optionally prefixed with Brazil's DDI.
  if (digits.length === 10 || digits.length === 11) return digits;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;

  return null;
};

export const createSharkPixCharge = async (data: SharkPixChargeData): Promise<SharkPixChargeResult> => {
  const amountInCents = Math.round(data.value * 100);
  const notificationUrl = data.postbackUrl || env.SHARK_WEBHOOK_URL || '';
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
        details: {
          'payer.phone': missing
            ? 'Payer phone is required.'
            : 'Payer phone must contain DDD and number.',
        },
      },
    };
  }

  const payload: any = {
    amount: amountInCents,
    currency: 'BRL',
    method: 'PIX',
    description: (data.description || 'Pagamento').substring(0, 100),
    externalRef: data.externalRef,
    notificationUrl,
    payer: {
      name: data.customerName,
      email: data.customerEmail,
      taxId: (data.customerCpf || '').replace(/\D/g, ''),
      phone: payerPhone,
    },
    items: [
      {
        quantity: 1,
        name: (data.description || 'Pagamento').substring(0, 100),
        price: amountInCents,
        type: 'DIGITAL',
      },
    ],
  };

  console.log('[SHARK PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await sharkRequest('POST', '/payment', payload, { auth: 'api' });

  if (!result.success) {
    console.error('[SHARK PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao criar cobrança PIX no Shark Hub',
      debug: result.data,
    };
  }

  const transaction = result.data;
  const pixCopyPaste = transaction?.data?.copypaste || '';
  let pixQrCodeBase64 = '';

  if (pixCopyPaste) {
    try {
      pixQrCodeBase64 = await QRCode.toDataURL(pixCopyPaste, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      console.log('[SHARK PIX] QR Code image gerada com sucesso');
    } catch (qrError) {
      console.error('[SHARK PIX] Erro ao gerar QR Code image:', qrError);
    }
  }

  console.log('[SHARK PIX] Cobrança criada:', transaction.id);

  return {
    success: true,
    transactionId: String(transaction.id),
    pixCode: pixCopyPaste,
    pixQrCode: pixQrCodeBase64,
  };
};

const mapSharkHubPaymentStatus = (status: string): string => {
  const s = (status || '').toUpperCase();
  if (s === 'PAID') return 'RECEIVED';
  if (s === 'PENDING' || s === 'PROCESSING') return 'PENDING';
  if (s === 'REFUSED') return 'REFUSED';
  if (s === 'REFUNDED' || s === 'CHARGEDBACK' || s === 'MED') return 'REFUNDED';
  return 'PENDING';
};

export const getSharkTransaction = async (transactionId: string) => {
  const result = await sharkRequest('GET', `/payment/${transactionId}`, null, { auth: 'api' });

  if (!result.success) {
    return {
      success: false,
      error: result.data?.message || 'Erro ao consultar transação',
    };
  }

  const transaction = result.data;
  const status = mapSharkHubPaymentStatus(transaction.status);

  return {
    success: true,
    data: transaction,
    status,
    sharkStatus: transaction.status,
  };
};

export const createSharkPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description?: string;
  postbackUrl?: string;
  externalRef?: string;
}) => {
  const amountInCents = Math.round(data.value * 100);
  const transferWebhook = env.SHARK_WEBHOOK_URL ? `${env.SHARK_WEBHOOK_URL}/transfer` : '';
  const notificationUrl = data.postbackUrl || transferWebhook;

  const pixKeyTypeMap: Record<string, string> = {
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'EMAIL',
    phone: 'PHONE',
    random: 'EVP',
    evp: 'EVP',
    copypaste: 'COPYPASTE',
  };

  const payload: any = {
    amount: amountInCents,
    method: 'PIX',
    externalRef: data.externalRef,
    notificationUrl,
    pix: {
      pixKeyType: pixKeyTypeMap[(data.pixKeyType || '').toLowerCase()] || 'CPF',
      pixKey: data.pixKey,
    },
  };

  console.log('[SHARK TRANSFER] Criando saque:', JSON.stringify(payload));

  const result = await sharkRequest('POST', '/transfer', payload, { auth: 'withdraw' });

  if (!result.success) {
    console.error('[SHARK TRANSFER] Erro:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao processar saque no Shark Hub',
      debug: result.data,
    };
  }

  const transfer = result.data;
  console.log('[SHARK TRANSFER] Saque criado:', transfer.id);

  return {
    success: true,
    transferId: String(transfer.id),
    endToEndId: transfer?.data?.e2e || transfer.id,
    status: transfer.status,
  };
};

export const getSharkBalance = async (): Promise<{
  available: number;
  reserved: number;
} | null> => {
  try {
    if (!env.SHARK_WITHDRAW_KEY) return null;
    const result = await sharkRequest('GET', '/balance', null, { auth: 'withdraw' });
    if (!result.success) return null;
    const data = result.data;
    if (!data) return null;

    const available = Number(data.available ?? 0) / 100;
    const transfersPending = Number(data?.transfers?.pending ?? 0) / 100;
    const reservePending = Number(data?.reserve?.pending ?? 0) / 100;

    return {
      available,
      reserved: transfersPending + reservePending,
    };
  } catch (error) {
    console.error('[SHARK] Erro ao consultar saldo:', error);
    return null;
  }
};

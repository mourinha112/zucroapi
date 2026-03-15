import { sharkRequest } from './shark.client';
import { env } from '../../config/env';
import QRCode from 'qrcode';

export interface SharkPixChargeData {
  value: number; // valor em reais (ex: 49.90)
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
  pixQrCode?: string; // base64 da imagem
  secureUrl?: string;
  error?: string;
  debug?: any;
}

/**
 * Criar cobrança PIX via SharkBanking
 * POST /v1/transactions
 */
export const createSharkPixCharge = async (data: SharkPixChargeData): Promise<SharkPixChargeResult> => {
  // SharkBanking usa valor em centavos
  const amountInCents = Math.round(data.value * 100);

  const payload: any = {
    amount: amountInCents,
    paymentMethod: 'pix',
    customer: {
      name: data.customerName,
      email: data.customerEmail,
      document: {
        number: (data.customerCpf || '').replace(/\D/g, ''),
        type: (data.customerCpf || '').replace(/\D/g, '').length > 11 ? 'cnpj' : 'cpf',
      },
    },
    items: [
      {
        title: data.description.substring(0, 100),
        unitPrice: amountInCents,
        quantity: 1,
        tangible: false,
      },
    ],
    postbackUrl: data.postbackUrl || env.SHARK_WEBHOOK_URL || '',
    ip: '127.0.0.1',
  };

  if (data.customerPhone) {
    payload.customer.phone = data.customerPhone.replace(/\D/g, '');
  }

  if (data.externalRef) {
    payload.externalRef = data.externalRef;
  }

  console.log('[SHARK PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await sharkRequest('POST', '/transactions', payload);

  if (!result.success) {
    console.error('[SHARK PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao criar cobrança PIX no SharkBanking',
      debug: result.data,
    };
  }

  const transaction = result.data;
  const pixCopyPaste = transaction.pix?.qrcode || '';
  let pixQrCodeBase64 = '';

  // Gerar imagem QR Code a partir do código copia-e-cola
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
    secureUrl: transaction.secureUrl,
  };
};

/**
 * Consultar transação no SharkBanking
 * GET /v1/transactions/{id}
 */
export const getSharkTransaction = async (transactionId: string) => {
  const result = await sharkRequest('GET', `/transactions/${transactionId}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.message || 'Erro ao consultar transação',
    };
  }

  const transaction = result.data;

  // Mapear status do SharkBanking para ZucroPay
  let status = 'PENDING';
  if (transaction.status === 'paid' || transaction.status === 'approved') {
    status = 'RECEIVED';
  } else if (transaction.status === 'waiting_payment' || transaction.status === 'pending') {
    status = 'PENDING';
  } else if (transaction.status === 'refused') {
    status = 'REFUSED';
  } else if (transaction.status === 'refunded') {
    status = 'REFUNDED';
  } else if (transaction.status === 'cancelled') {
    status = 'CANCELLED';
  } else if (transaction.status === 'chargeback' || transaction.status === 'in_protest') {
    status = 'REFUNDED';
  }

  return {
    success: true,
    data: transaction,
    status,
    sharkStatus: transaction.status,
  };
};

/**
 * Criar transferência PIX (saque) via SharkBanking
 * POST /v1/transfers
 */
export const createSharkPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description?: string;
  postbackUrl?: string;
}) => {
  const amountInCents = Math.round(data.value * 100);

  // Mapear tipo de chave para o formato do SharkBanking
  const pixKeyTypeMap: Record<string, string> = {
    cpf: 'cpf',
    cnpj: 'cnpj',
    email: 'email',
    phone: 'phone',
    random: 'evp',
    evp: 'evp',
  };

  const payload = {
    method: 'fiat',
    amount: amountInCents,
    pixKey: data.pixKey,
    pixKeyType: pixKeyTypeMap[data.pixKeyType] || 'cpf',
    netPayout: false, // taxa descontada do valor solicitado
    postbackUrl: data.postbackUrl || env.SHARK_WEBHOOK_URL || '',
  };

  console.log('[SHARK TRANSFER] Criando saque:', JSON.stringify(payload));

  const result = await sharkRequest('POST', '/transfers', payload, {
    'x-withdraw-key': env.SHARK_WITHDRAW_KEY || '',
  });

  if (!result.success) {
    console.error('[SHARK TRANSFER] Erro:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao processar saque no SharkBanking',
      debug: result.data,
    };
  }

  const transfer = result.data;
  console.log('[SHARK TRANSFER] Saque criado:', transfer.id);

  return {
    success: true,
    transferId: String(transfer.id),
    endToEndId: transfer.pixEnd2EndId || transfer.id,
    status: transfer.status,
  };
};

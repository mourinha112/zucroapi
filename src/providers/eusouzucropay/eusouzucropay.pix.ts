import { eusouzucropayRequest } from './eusouzucropay.client';
import { env } from '../../config/env';
import QRCode from 'qrcode';

export interface EuSouZucroPayPixChargeData {
  value: number; // valor em reais (ex: 49.90)
  description: string;
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
}

export interface EuSouZucroPayPixChargeResult {
  success: boolean;
  transactionId?: string;
  pixCode?: string;
  pixQrCode?: string; // base64 da imagem
  error?: string;
  debug?: any;
}

/**
 * Criar cobrança PIX via EuSouZucroPay
 * POST /v1/transactions
 */
export const createEuSouZucroPayPixCharge = async (data: EuSouZucroPayPixChargeData): Promise<EuSouZucroPayPixChargeResult> => {
  // EuSouZucroPay usa valor em centavos
  const amountInCents = Math.round(data.value * 100);

  const payload: any = {
    amount: amountInCents,
    payment_method: 'PIX',
    customer: {
      name: data.customerName,
      email: data.customerEmail,
      phone: (data.customerPhone || '').replace(/\D/g, ''),
      document: {
        number: (data.customerCpf || '').replace(/\D/g, ''),
        type: (data.customerCpf || '').replace(/\D/g, '').length > 11 ? 'CNPJ' : 'CPF',
      },
    },
    items: [
      {
        title: (data.description || 'Pagamento').substring(0, 100).padEnd(3, ' '),
        unit_price: amountInCents,
        quantity: 1,
        tangible: false,
        ...(data.externalRef && { external_ref: data.externalRef }),
      },
    ],
  };

  // EuSouZucroPay aceita postback_url no body
  if (data.postbackUrl || env.EUSOUZUCROPAY_WEBHOOK_URL) {
    payload.postback_url = data.postbackUrl || env.EUSOUZUCROPAY_WEBHOOK_URL;
  }

  console.log('[EUSOUZUCROPAY PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await eusouzucropayRequest('POST', '/transactions', payload);

  if (!result.success) {
    console.error('[EUSOUZUCROPAY PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao criar cobrança PIX no EuSouZucroPay',
      debug: result.data,
    };
  }

  const transaction = result.data;
  const pixCopyPaste = transaction.pix?.copy_paste || '';
  let pixQrCodeBase64 = '';

  // Gerar imagem QR Code a partir do código copia-e-cola
  if (pixCopyPaste) {
    try {
      pixQrCodeBase64 = await QRCode.toDataURL(pixCopyPaste, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      console.log('[EUSOUZUCROPAY PIX] QR Code image gerada com sucesso');
    } catch (qrError) {
      console.error('[EUSOUZUCROPAY PIX] Erro ao gerar QR Code image:', qrError);
    }
  }

  console.log('[EUSOUZUCROPAY PIX] Cobrança criada:', transaction.id);

  return {
    success: true,
    transactionId: String(transaction.id),
    pixCode: pixCopyPaste,
    pixQrCode: pixQrCodeBase64,
  };
};

/**
 * Consultar transação no EuSouZucroPay
 * GET /v1/transactions/{id}
 */
export const getEuSouZucroPayTransaction = async (transactionId: string) => {
  const result = await eusouzucropayRequest('GET', `/transactions/${transactionId}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.message || 'Erro ao consultar transação',
    };
  }

  const transaction = result.data?.data || result.data;

  // Mapear status do EuSouZucroPay para ZucroPay
  let status = 'PENDING';
  if (transaction.status === 'PAID' || transaction.status === 'APPROVED') {
    status = 'RECEIVED';
  } else if (transaction.status === 'WAITING_PAYMENT' || transaction.status === 'PENDING') {
    status = 'PENDING';
  } else if (transaction.status === 'REFUSED') {
    status = 'REFUSED';
  } else if (transaction.status === 'REFUNDED') {
    status = 'REFUNDED';
  } else if (transaction.status === 'CANCELLED') {
    status = 'CANCELLED';
  } else if (transaction.status === 'CHARGEBACK' || transaction.status === 'IN_PROTEST') {
    status = 'REFUNDED';
  }

  return {
    success: true,
    data: transaction,
    status,
    eusouzucropayStatus: transaction.status,
  };
};

/**
 * Criar transferência PIX (saque) via EuSouZucroPay
 * POST /v1/transfers
 */
export const createEuSouZucroPayPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description?: string;
}) => {
  const amountInCents = Math.round(data.value * 100);

  // Mapear tipo de chave para o formato do EuSouZucroPay (uppercase)
  const pixKeyTypeMap: Record<string, string> = {
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'EMAIL',
    phone: 'PHONE',
    random: 'EVP',
    evp: 'EVP',
  };

  const payload = {
    amount: amountInCents,
    pix_key: data.pixKey,
    pix_key_type: pixKeyTypeMap[data.pixKeyType] || 'CPF',
  };

  console.log('[EUSOUZUCROPAY TRANSFER] Criando saque:', JSON.stringify(payload));

  const result = await eusouzucropayRequest('POST', '/transfers', payload, {
    'x-withdrawal-key': env.EUSOUZUCROPAY_WITHDRAW_KEY || '',
  });

  if (!result.success) {
    console.error('[EUSOUZUCROPAY TRANSFER] Erro:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error || 'Erro ao processar saque no EuSouZucroPay',
      debug: result.data,
    };
  }

  const transfer = result.data?.data || result.data;
  console.log('[EUSOUZUCROPAY TRANSFER] Saque criado:', transfer.id);

  return {
    success: true,
    transferId: String(transfer.id),
    endToEndId: transfer.end_to_end || transfer.id,
    status: transfer.status,
  };
};

/**
 * Consulta o saldo da empresa no EuSouZucroPay.
 * GET /company/balance retorna { available, reserved } em centavos.
 */
export const getEuSouZucroPayBalance = async (): Promise<{
  available: number;
  reserved: number;
} | null> => {
  try {
    if (!env.EUSOUZUCROPAY_PUBLIC_KEY || !env.EUSOUZUCROPAY_SECRET_KEY) return null;
    const result = await eusouzucropayRequest('GET', '/company/balance');
    if (!result.success) return null;
    const data = result.data?.data || result.data;
    if (!data) return null;
    return {
      available: Number(data.available ?? data.balance ?? 0) / 100,
      reserved: Number(data.reserved ?? data.reserved_balance ?? 0) / 100,
    };
  } catch (error) {
    console.error('[EUSOUZUCROPAY] Erro ao consultar saldo:', error);
    return null;
  }
};

import { xflowRequest } from './xflow.client';
import { env } from '../../config/env';
import QRCode from 'qrcode';

export interface XflowPixChargeData {
  value: number; // em reais (ex: 49.90) — convertido internamente para centavos
  description: string;
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
}

export interface XflowPixChargeResult {
  success: boolean;
  transactionId?: string;
  pixCode?: string;
  pixQrCode?: string;
  error?: string;
  debug?: any;
}

/**
 * Cria uma cobrança PIX via XFlow Hub.
 * Endpoint: POST /v1/transactions
 * Docs: https://app.xflow-hub.com/docs
 *
 * XFlow trabalha em centavos. `amount` precisa bater exatamente com a soma
 * de `unit_price * quantity` dos items, senão a API rejeita.
 */
export const createXflowPixCharge = async (
  data: XflowPixChargeData,
): Promise<XflowPixChargeResult> => {
  const amountInCents = Math.round(data.value * 100);
  const cpfDigits = (data.customerCpf || '').replace(/\D/g, '');
  const phoneDigits = (data.customerPhone || '').replace(/\D/g, '');

  const payload: any = {
    amount: amountInCents,
    payment_method: 'PIX',
    items: [
      {
        title: (data.description || 'Pagamento').substring(0, 100),
        unit_price: amountInCents,
        quantity: 1,
        tangible: false,
        ...(data.externalRef ? { external_ref: data.externalRef } : {}),
      },
    ],
    customer: {
      name: data.customerName,
      email: data.customerEmail,
      ...(phoneDigits ? { phone: phoneDigits } : {}),
      document: {
        number: cpfDigits,
        type: cpfDigits.length > 11 ? 'CNPJ' : 'CPF',
      },
    },
  };

  // Só envia postback_url se não há webhook global configurado (doc: campo é ignorado se houver).
  const postback = data.postbackUrl || env.XFLOW_WEBHOOK_URL;
  if (postback) {
    payload.postback_url = postback;
  }

  console.log('[XFLOW PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await xflowRequest('POST', '/transactions', payload);

  if (!result.success) {
    console.error('[XFLOW PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao criar cobrança PIX no XFlow Hub',
      debug: result.data,
    };
  }

  const transaction = result.data;
  const pixCopyPaste: string = transaction.pix?.copy_paste || '';
  let pixQrCodeBase64 = '';

  // XFlow só retorna copy-paste — geramos a imagem do QR Code local.
  if (pixCopyPaste) {
    try {
      pixQrCodeBase64 = await QRCode.toDataURL(pixCopyPaste, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (qrError) {
      console.error('[XFLOW PIX] Erro ao gerar QR Code:', qrError);
    }
  }

  console.log('[XFLOW PIX] Cobrança criada:', transaction.id);

  return {
    success: true,
    transactionId: String(transaction.id),
    pixCode: pixCopyPaste,
    pixQrCode: pixQrCodeBase64,
  };
};

/**
 * Consulta uma transação no XFlow.
 * Endpoint: GET /v1/transactions/:id
 */
export const getXflowTransaction = async (transactionId: string) => {
  const result = await xflowRequest('GET', `/transactions/${transactionId}`);

  if (!result.success) {
    return { success: false, error: result.data?.message || 'Erro ao consultar' };
  }

  const tx = result.data?.data || result.data;
  return {
    success: true,
    data: tx,
    xflowStatus: tx?.status,
    status: mapXflowStatus(tx?.status),
  };
};

/**
 * Cria uma transferência PIX (saque) via XFlow.
 * Endpoint: POST /v1/transfers
 * Header obrigatório: x-withdrawal-key (cadastrado via painel XFlow).
 */
export const createXflowPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  postbackUrl?: string;
}): Promise<{
  success: boolean;
  transferId?: string;
  endToEndId?: string;
  status?: string;
  error?: string;
  debug?: any;
}> => {
  const amountInCents = Math.round(data.value * 100);

  // XFlow usa CPF/CNPJ/EMAIL/PHONE/EVP em maiúsculas
  const keyTypeMap: Record<string, string> = {
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'EMAIL',
    phone: 'PHONE',
    random: 'EVP',
    evp: 'EVP',
  };

  const payload: any = {
    amount: amountInCents,
    pix_key: data.pixKey,
    pix_key_type: keyTypeMap[data.pixKeyType] || 'CPF',
  };
  if (data.postbackUrl || env.XFLOW_WEBHOOK_URL) {
    payload.postback_url = data.postbackUrl || env.XFLOW_WEBHOOK_URL;
  }

  console.log('[XFLOW TRANSFER] Criando saque:', JSON.stringify(payload));

  const result = await xflowRequest('POST', '/transfers', payload, {
    'x-withdrawal-key': env.XFLOW_WITHDRAW_KEY || '',
  });

  if (!result.success) {
    console.error('[XFLOW TRANSFER] Erro:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao processar saque no XFlow Hub',
      debug: result.data,
    };
  }

  const transfer = result.data?.data || result.data;
  console.log('[XFLOW TRANSFER] Saque criado:', transfer.id);

  return {
    success: true,
    transferId: String(transfer.id),
    endToEndId: transfer.end_to_end || transfer.id,
    status: transfer.status,
  };
};

/**
 * Mapeia o status do XFlow para o vocabulário interno da ZucroPay.
 * Estados XFlow: WAITING_PAYMENT, PENDING, APPROVED, PAID, REFUSED,
 * CANCELLED, REFUNDED, IN_PROTEST, CHARGEBACK.
 */
export const mapXflowStatus = (status?: string): string => {
  switch ((status || '').toUpperCase()) {
    case 'PAID':
    case 'APPROVED':
      return 'RECEIVED';
    case 'WAITING_PAYMENT':
    case 'PENDING':
      return 'PENDING';
    case 'REFUSED':
      return 'REFUSED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REFUNDED':
    case 'CHARGEBACK':
    case 'IN_PROTEST':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
};

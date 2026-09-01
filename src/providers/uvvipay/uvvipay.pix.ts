import QRCode from 'qrcode';
import { env } from '../../config/env';
import { uvvipayIdempotencyKey, uvvipayRequest } from './uvvipay.client';

export interface UvviPayPixChargeData {
  value: number; // em reais (ex: 49.90) — convertido internamente para centavos
  description: string;
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
}

export interface UvviPayPixChargeResult {
  success: boolean;
  transactionId?: string;
  pixCode?: string;
  pixQrCode?: string;
  error?: string;
  debug?: any;
}

/** Valor mínimo aceito pela UvviPay: 100 centavos (R$ 1,00). */
const MIN_AMOUNT_CENTS = 100;
/** Teto documentado: 15.000.000 centavos (R$ 150.000,00). */
const MAX_AMOUNT_CENTS = 15000000;

/**
 * Monta o objeto `customer` no formato da UvviPay.
 * `document` é obrigatório na doc — sem CPF/CNPJ a cobrança é recusada.
 */
const buildCustomer = (data: UvviPayPixChargeData) => {
  const cpfDigits = (data.customerCpf || '').replace(/\D/g, '');
  const phoneDigits = (data.customerPhone || '').replace(/\D/g, '');

  return {
    name: (data.customerName || '').substring(0, 255),
    email: (data.customerEmail || '').substring(0, 320),
    ...(phoneDigits ? { phone: phoneDigits.substring(0, 20) } : {}),
    ...(cpfDigits
      ? {
          document: {
            number: cpfDigits,
            type: cpfDigits.length > 11 ? 'cnpj' : 'cpf',
          },
        }
      : {}),
  };
};

/**
 * Cria uma cobrança PIX via UvviPay.
 * Endpoint: POST /v1/payments  (paymentMethod: "pix")
 * Docs: https://developers.uvvipay.com.br/api-reference/payments/create
 *
 * Valores em centavos. `unitPrice * quantity` do item precisa fechar com `amount`.
 */
export const createUvviPayPixCharge = async (
  data: UvviPayPixChargeData,
): Promise<UvviPayPixChargeResult> => {
  const amountInCents = Math.round(data.value * 100);

  if (amountInCents < MIN_AMOUNT_CENTS) {
    return { success: false, error: 'Valor mínimo para PIX na UvviPay é R$ 1,00' };
  }
  if (amountInCents > MAX_AMOUNT_CENTS) {
    return { success: false, error: 'Valor acima do limite da UvviPay (R$ 150.000,00)' };
  }

  const externalId = data.externalRef || `zp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const payload: any = {
    externalId,
    amount: amountInCents,
    paymentMethod: 'pix',
    customer: buildCustomer(data),
    items: [
      {
        title: (data.description || 'Pagamento').substring(0, 100),
        quantity: 1,
        unitPrice: amountInCents,
        tangible: false,
      },
    ],
  };

  // A UvviPay entrega o webhook nos endpoints cadastrados no painel dela;
  // mandamos a URL junto quando existir, para ambientes sem cadastro global.
  const postback = data.postbackUrl || env.UVVIPAY_WEBHOOK_URL;
  if (postback) {
    payload.postbackUrl = postback;
  }

  console.log('[UVVIPAY PIX] Criando cobrança:', JSON.stringify(payload));

  const result = await uvvipayRequest('POST', '/v1/payments', payload, {
    'x-idempotency-key': uvvipayIdempotencyKey(),
  });

  if (!result.success) {
    console.error('[UVVIPAY PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao criar cobrança PIX na UvviPay',
      debug: result.data,
    };
  }

  const transaction = result.data?.data || result.data;
  // A doc retorna o copia-e-cola em `pix.qrcode`; aceitamos variações defensivamente.
  const pixCopyPaste: string =
    transaction?.pix?.qrcode ||
    transaction?.pix?.copyAndPaste ||
    transaction?.pix?.copy_paste ||
    '';

  let pixQrCodeBase64 = '';
  if (pixCopyPaste) {
    try {
      pixQrCodeBase64 = await QRCode.toDataURL(pixCopyPaste, {
        width: 400,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (qrError) {
      console.error('[UVVIPAY PIX] Erro ao gerar QR Code:', qrError);
    }
  }

  if (!pixCopyPaste) {
    console.error('[UVVIPAY PIX] Cobrança criada sem copia-e-cola:', transaction);
    return {
      success: false,
      error: 'UvviPay não retornou o código PIX',
      debug: transaction,
    };
  }

  console.log('[UVVIPAY PIX] Cobrança criada:', transaction?.id);

  return {
    success: true,
    transactionId: String(transaction?.id),
    pixCode: pixCopyPaste,
    pixQrCode: pixQrCodeBase64,
  };
};

/**
 * Consulta uma transação na UvviPay.
 * Endpoint: GET /v1/payments/:id
 */
export const getUvviPayTransaction = async (transactionId: string) => {
  const result = await uvvipayRequest('GET', `/v1/payments/${transactionId}`);

  if (!result.success) {
    return { success: false, error: result.data?.message || 'Erro ao consultar' };
  }

  const tx = result.data?.data || result.data;
  return {
    success: true,
    data: tx,
    uvvipayStatus: tx?.status,
    status: mapUvviPayStatus(tx?.status),
  };
};

/**
 * Estorna uma transação paga.
 * Endpoint: PUT /v1/payments/:id/refund
 * A UvviPay só faz estorno INTEGRAL e apenas até 180 dias após o pagamento.
 */
export const refundUvviPayPayment = async (
  transactionId: string,
): Promise<{ success: boolean; status?: string; error?: string; debug?: any }> => {
  const result = await uvvipayRequest('PUT', `/v1/payments/${transactionId}/refund`);

  if (!result.success) {
    console.error('[UVVIPAY REFUND] Erro:', result.data);
    return {
      success: false,
      error:
        result.data?.message ||
        result.data?.error ||
        'Erro ao estornar pagamento na UvviPay',
      debug: result.data,
    };
  }

  const tx = result.data?.data || result.data;
  return { success: true, status: tx?.status };
};

/**
 * Saque PIX via UvviPay.
 *
 * ⚠️ A UvviPay só expõe saque no escopo de SUBCONTA
 * (`/v1/submerchants/:id/withdrawals`) e a ZucroPay opera na conta principal,
 * sem subcontas. Por isso o saque ainda não é suportado aqui.
 *
 * Devolvemos uma falha explícita de propósito: sem esta função o despachante de
 * saque cairia no `else` e pagaria o vendedor com o saldo da SharkBanking —
 * dinheiro que entrou pela UvviPay sairia de outra adquirente. Com a falha, o
 * saque fica pendente e o admin vê o motivo, sem risco financeiro.
 */
export const createUvviPayPixTransfer = async (_data: {
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
  console.warn('[UVVIPAY TRANSFER] Saque não suportado (API exige subconta)');
  return {
    success: false,
    error:
      'Saque automático pela UvviPay ainda não está disponível (a API só permite saque por subconta). ' +
      'Pague este saque por outra adquirente ou manualmente e marque o saque como concluído.',
  };
};

/**
 * Saldo da conta na UvviPay.
 *
 * Assim como o saque, o endpoint de saldo documentado é por subconta. Enquanto
 * não usarmos subcontas, devolvemos null — o painel admin simplesmente não
 * exibe card de saldo para esta adquirente (mesmo comportamento de quando as
 * credenciais não estão configuradas).
 */
export const getUvviPayBalance = async (): Promise<{
  available: number;
  reserved: number;
} | null> => {
  return null;
};

/**
 * Mapeia o status da UvviPay para o vocabulário interno da ZucroPay.
 * Estados UvviPay: waiting_payment, paid, refused, refunded, chargedback,
 * cancelled, expired, in_analysis, failed.
 */
export const mapUvviPayStatus = (status?: string): string => {
  switch ((status || '').toLowerCase()) {
    case 'paid':
    case 'approved':
      return 'RECEIVED';
    case 'waiting_payment':
    case 'pending':
    case 'in_analysis':
      return 'PENDING';
    case 'refused':
    case 'failed':
      return 'REFUSED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'expired':
      return 'OVERDUE';
    case 'refunded':
    case 'chargedback':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
};

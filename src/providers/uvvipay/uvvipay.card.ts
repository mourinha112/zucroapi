import { env } from '../../config/env';
import { uvvipayIdempotencyKey, uvvipayRequest } from './uvvipay.client';
import { mapUvviPayStatus } from './uvvipay.pix';

export interface UvviPayCardChargeData {
  value: number; // em reais — convertido internamente para centavos
  description: string;
  installments?: number; // 1..24 (a UvviPay aceita até 24)
  customerName: string;
  customerEmail: string;
  customerCpf?: string;
  customerPhone?: string;
  postbackUrl?: string;
  externalRef?: string;
  /** IP do comprador — a UvviPay usa em antifraude. */
  ip?: string;
  card: {
    number: string;
    holderName: string;
    cvv: string;
    expirationMonth: number;
    expirationYear: number;
    brand?: string;
  };
  billingAddress?: {
    zipCode?: string;
    street?: string;
    streetNumber?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    country?: string;
  };
}

export interface UvviPayCardChargeResult {
  success: boolean;
  transactionId?: string;
  /** Status interno da ZucroPay já mapeado (RECEIVED/PENDING/REFUSED/...). */
  status?: string;
  /** Status cru devolvido pela UvviPay. */
  providerStatus?: string;
  installments?: number;
  /** true quando o emissor recusou — a tela do checkout pede outro cartão. */
  cardRefused?: boolean;
  error?: string;
  debug?: any;
}

const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 15000000;

/**
 * Mensagens de recusa em PT-BR. A UvviPay devolve o motivo em `refusedReason`
 * ou `message`; traduzimos os casos mais comuns para a tela do comprador.
 */
const friendlyRefusal = (raw?: string): string => {
  const r = (raw || '').toLowerCase();
  if (r.includes('insufficient') || r.includes('saldo')) return 'Cartão sem limite disponível.';
  if (r.includes('expired') || r.includes('expirado')) return 'Cartão expirado.';
  if (r.includes('cvv') || r.includes('security')) return 'Código de segurança (CVV) inválido.';
  if (r.includes('invalid') || r.includes('inválido')) return 'Dados do cartão inválidos.';
  if (r.includes('fraud') || r.includes('risk') || r.includes('antifraude'))
    return 'Pagamento não autorizado pelo antifraude.';
  if (r.includes('blocked') || r.includes('bloqueado')) return 'Cartão bloqueado pelo emissor.';
  if (r.includes('not_supported') || r.includes('unsupported'))
    return 'Bandeira do cartão não suportada.';
  return 'Pagamento recusado pelo emissor do cartão.';
};

/**
 * Cria uma cobrança no cartão de crédito via UvviPay.
 * Endpoint: POST /v1/payments  (paymentMethod: "credit_card")
 * Docs: https://developers.uvvipay.com.br/api-reference/payments/create
 *
 * A cobrança é autorizada de forma síncrona: a resposta já traz `paid` ou
 * `refused`. Mesmo assim o webhook é a fonte da verdade para liberar o saldo,
 * exatamente como no fluxo PIX — aqui só devolvemos o resultado imediato.
 */
export const createUvviPayCardCharge = async (
  data: UvviPayCardChargeData,
): Promise<UvviPayCardChargeResult> => {
  if (!env.UVVIPAY_CARD_ENABLED) {
    return { success: false, error: 'Pagamento com cartão pela UvviPay está desabilitado' };
  }

  const amountInCents = Math.round(data.value * 100);
  if (amountInCents < MIN_AMOUNT_CENTS) {
    return { success: false, error: 'Valor mínimo para cartão na UvviPay é R$ 1,00' };
  }
  if (amountInCents > MAX_AMOUNT_CENTS) {
    return { success: false, error: 'Valor acima do limite da UvviPay (R$ 150.000,00)' };
  }

  const installments = Math.min(24, Math.max(1, Number(data.installments || 1)));
  const cpfDigits = (data.customerCpf || '').replace(/\D/g, '');
  const phoneDigits = (data.customerPhone || '').replace(/\D/g, '');
  const cardNumber = (data.card.number || '').replace(/\D/g, '');

  if (cardNumber.length < 13 || cardNumber.length > 19) {
    return { success: false, error: 'Número do cartão inválido' };
  }
  if (!cpfDigits) {
    return { success: false, error: 'CPF/CNPJ do comprador é obrigatório para cartão' };
  }

  const externalId = data.externalRef || `zp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const payload: any = {
    externalId,
    amount: amountInCents,
    paymentMethod: 'credit_card',
    customer: {
      name: (data.customerName || '').substring(0, 255),
      email: (data.customerEmail || '').substring(0, 320),
      ...(phoneDigits ? { phone: phoneDigits.substring(0, 20) } : {}),
      document: {
        number: cpfDigits,
        type: cpfDigits.length > 11 ? 'cnpj' : 'cpf',
      },
      ...(data.billingAddress ? { address: data.billingAddress } : {}),
    },
    items: [
      {
        title: (data.description || 'Pagamento').substring(0, 100),
        quantity: 1,
        unitPrice: amountInCents,
        tangible: false,
      },
    ],
    card: {
      number: cardNumber,
      holderName: data.card.holderName,
      cvv: data.card.cvv,
      expirationMonth: Number(data.card.expirationMonth),
      expirationYear: Number(data.card.expirationYear),
      installments,
      ...(data.card.brand ? { brand: data.card.brand } : {}),
    },
    ...(data.ip ? { ip: data.ip } : {}),
  };

  const postback = data.postbackUrl || env.UVVIPAY_WEBHOOK_URL;
  if (postback) {
    payload.postbackUrl = postback;
  }

  // Log sem PAN/CVV — nunca registrar dados completos do cartão.
  console.log('[UVVIPAY CARD] Criando cobrança:', {
    externalId,
    amount: amountInCents,
    installments,
    cardLast4: cardNumber.slice(-4),
  });

  const result = await uvvipayRequest('POST', '/v1/payments', payload, {
    'x-idempotency-key': uvvipayIdempotencyKey(),
  });

  if (!result.success) {
    const raw = result.data?.refusedReason || result.data?.message || result.data?.error;
    console.error('[UVVIPAY CARD] Erro ao criar cobrança:', result.data);
    // 4xx com motivo de recusa = cartão negado (o comprador pode tentar outro);
    // demais casos são erro de integração.
    const isRefusal = result.status >= 400 && result.status < 500;
    return {
      success: false,
      cardRefused: isRefusal,
      error: isRefusal ? friendlyRefusal(raw) : raw || 'Erro ao processar cartão na UvviPay',
      debug: result.data,
    };
  }

  const transaction = result.data?.data || result.data;
  const providerStatus: string = transaction?.status || '';
  const internalStatus = mapUvviPayStatus(providerStatus);

  if (internalStatus === 'REFUSED') {
    console.warn('[UVVIPAY CARD] Recusado pelo emissor:', providerStatus);
    return {
      success: false,
      cardRefused: true,
      transactionId: transaction?.id ? String(transaction.id) : undefined,
      providerStatus,
      status: internalStatus,
      error: friendlyRefusal(transaction?.refusedReason || providerStatus),
      debug: transaction,
    };
  }

  console.log('[UVVIPAY CARD] Cobrança criada:', transaction?.id, providerStatus);

  return {
    success: true,
    transactionId: String(transaction?.id),
    status: internalStatus,
    providerStatus,
    installments,
  };
};

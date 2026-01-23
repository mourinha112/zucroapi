import { makeCobrancaRequest } from './efi.client';

export interface CardPaymentData {
  value: number;
  description: string;
  installments: number;
  paymentToken?: string;
  customer: {
    name: string;
    email: string;
    cpf: string;
    phone?: string;
    birth?: string;
  };
  billingAddress?: {
    street: string;
    number: string;
    neighborhood: string;
    zipcode: string;
    city: string;
    state: string;
  };
}

export interface CardPaymentResult {
  success: boolean;
  chargeId?: number;
  status?: string;
  installments?: number;
  error?: string;
  cardRefused?: boolean;
  canRetry?: boolean;
  debug?: any;
}

// Criar cobrança para cartão
export const createCardCharge = async (data: { value: number; description: string }) => {
  const chargeData = {
    items: [{
      name: data.description,
      value: Math.round(data.value * 100), // Valor em centavos
      amount: 1,
    }],
  };

  console.log('[CARTAO] Criando cobrança:', JSON.stringify(chargeData));
  const result = await makeCobrancaRequest('POST', '/v1/charge', chargeData);

  if (!result.success || !result.data?.data?.charge_id) {
    console.error('[CARTAO] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.message || result.data?.error_description || 'Erro ao criar cobrança',
      debug: result.data,
    };
  }

  return {
    success: true,
    chargeId: result.data.data.charge_id,
  };
};

// Pagar com token de cartão
export const payWithCardToken = async (chargeId: number, data: CardPaymentData): Promise<CardPaymentResult> => {
  const payData = {
    payment: {
      credit_card: {
        installments: data.installments || 1,
        payment_token: data.paymentToken,
        billing_address: data.billingAddress || {
          street: 'Não informado',
          number: '0',
          neighborhood: 'Não informado',
          zipcode: '00000000',
          city: 'Não informado',
          state: 'SP',
        },
        customer: {
          name: data.customer.name,
          email: data.customer.email,
          cpf: data.customer.cpf?.replace(/\D/g, ''),
          birth: data.customer.birth || '1990-01-01',
          phone_number: data.customer.phone?.replace(/\D/g, ''),
        },
      },
    },
  };

  console.log('[CARTAO] Processando pagamento com token...');
  const result = await makeCobrancaRequest('POST', `/v1/charge/${chargeId}/pay`, payData);

  if (!result.success) {
    console.error('[CARTAO] Erro ao processar pagamento:', result.data);
    
    // Traduzir erros comuns
    let errorMessage = result.data?.message || result.data?.error_description || 'Erro ao processar pagamento';
    
    // Erro de valor mínimo de parcela
    if (result.data?.code === 4600111 || (typeof errorMessage === 'string' && errorMessage.includes('R$ 5,00'))) {
      errorMessage = 'O valor mínimo por parcela é R$ 5,00. Por favor, selecione menos parcelas ou pague à vista.';
    }
    // Erro de validação de nome
    else if (result.data?.error_description?.property?.includes('name')) {
      errorMessage = 'Nome inválido. Por favor, informe o nome completo (nome e sobrenome).';
    }
    // Erro de validação de CPF
    else if (result.data?.error_description?.property?.includes('cpf')) {
      errorMessage = 'CPF inválido. Por favor, verifique o número informado.';
    }
    
    return {
      success: false,
      error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
      debug: result.data,
    };
  }

  // Verificar se o cartão foi recusado
  const paymentData = result.data?.data;
  const refusal = paymentData?.refusal;
  
  if (refusal || paymentData?.status === 'unpaid') {
    console.log('[CARTAO] Cartão recusado:', refusal);
    return {
      success: false,
      error: refusal?.reason || 'Transação não autorizada. Tente outro cartão ou método de pagamento.',
      cardRefused: true,
      canRetry: refusal?.retry || true,
    };
  }

  const status = paymentData?.status === 'approved' ? 'RECEIVED' : 'PENDING';
  console.log('[CARTAO] Status do pagamento:', status);

  return {
    success: true,
    chargeId,
    status,
    installments: data.installments,
  };
};

// Criar link de pagamento (alternativa para quando não tem token)
export const createPaymentLink = async (chargeId: number) => {
  const linkData = {
    message: 'Pague sua compra',
    expire_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 24h
    request_delivery_address: false,
    payment_method: 'credit_card',
  };

  const result = await makeCobrancaRequest('POST', `/v1/charge/${chargeId}/link`, linkData);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.message || 'Erro ao criar link de pagamento',
    };
  }

  return {
    success: true,
    paymentUrl: result.data?.data?.payment_url,
  };
};

// Consultar cobrança
export const getCardCharge = async (chargeId: number) => {
  const result = await makeCobrancaRequest('GET', `/v1/charge/${chargeId}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.message || 'Erro ao consultar cobrança',
    };
  }

  return {
    success: true,
    data: result.data?.data,
    status: result.data?.data?.status,
  };
};

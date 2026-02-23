import { makeAsaasRequest } from './asaas.client';

export interface AsaasCardPaymentData {
  customerId: string;
  value: number;
  installmentCount?: number;
  description: string;
  billing?: {
    name: string;
    document: string;
  };
  creditCard?: {
    holderName: string;
    number: string;
    expiryMonth: string;
    expiryYear: string;
    ccv: string;
  };
  creditCardHolderInfo?: {
    name: string;
    document: string;
    email: string;
    phone: string;
    address: {
      province: string;
      city: string;
      complement: string;
      street: string;
      streetNumber: string;
      postalCode: number;
    };
  };
}

export interface AsaasCardPaymentResult {
  success: boolean;
  paymentId?: string;
  status?: string;
  error?: string;
  debug?: any;
}

// Criar pagamento com cartão de crédito via Asaas
export const createAsaasCardPayment = async (data: AsaasCardPaymentData): Promise<AsaasCardPaymentResult> => {
  try {
    // Primeiro cria a cobrança
    const chargeData: any = {
      customer: data.customerId,
      billingType: 'CREDIT_CARD',
      value: data.value,
      description: data.description,
      dueDate: new Date().toISOString().split('T')[0],
    };

    // Se tem informações do cartão, adiciona
    if (data.creditCard && data.creditCardHolderInfo) {
      chargeData.creditCard = {
        holderName: data.creditCard.holderName,
        number: data.creditCard.number.replace(/\s/g, ''),
        expiryMonth: data.creditCard.expiryMonth,
        expiryYear: data.creditCard.expiryYear,
        ccv: data.creditCard.ccv,
      };
      
      chargeData.creditCardHolderInfo = data.creditCardHolderInfo;
    }

    if (data.installmentCount && data.installmentCount > 1) {
      chargeData.installmentCount = data.installmentCount;
    }

    console.log('[ASAAS CARD] Criando pagamento:', JSON.stringify(chargeData));

    const result = await makeAsaasRequest('POST', '/v3/payments', chargeData);

    if (!result.success) {
      console.error('[ASAAS CARD] Erro na resposta:', result.data);
      return {
        success: false,
        error: result.data?.errors?.[0]?.description || 'Erro ao processar cartão',
        debug: result,
      };
    }

    const paymentData = result.data;
    console.log('[ASAAS CARD] Pagamento criado:', paymentData);

    return {
      success: true,
      paymentId: paymentData.id,
      status: paymentData.status,
      debug: paymentData,
    };
  } catch (error: any) {
    console.error('[ASAAS CARD] Erro:', error);
    return {
      success: false,
      error: error.message || 'Erro ao processar pagamento com cartão',
      debug: error,
    };
  }
};

// Criar token de cartão via Asaas
export const createAsaasCardToken = async (cardData: {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
}): Promise<{ success: boolean; token?: string; error?: string }> => {
  try {
    const tokenData = {
      billingType: 'CREDIT_CARD',
      creditCard: {
        holderName: cardData.holderName,
        number: cardData.number.replace(/\s/g, ''),
        expiryMonth: cardData.expiryMonth,
        expiryYear: cardData.expiryYear,
        ccv: cardData.ccv,
      },
    };

    console.log('[ASAAS CARD TOKEN] Criando token:', tokenData);

    const result = await makeAsaasRequest('POST', '/v3/cards/tokenize', tokenData);

    if (!result.success) {
      console.error('[ASAAS CARD TOKEN] Erro:', result.data);
      return {
        success: false,
        error: result.data?.errors?.[0]?.description || 'Erro ao tokenizar cartão',
      };
    }

    const tokenResult = result.data;
    console.log('[ASAAS CARD TOKEN] Token criado:', tokenResult);

    return {
      success: true,
      token: tokenResult.creditCardToken,
    };
  } catch (error: any) {
    console.error('[ASAAS CARD TOKEN] Erro:', error);
    return {
      success: false,
      error: error.message || 'Erro ao tokenizar cartão',
    };
  }
};

// Pagar com token de cartão (já tokenizado)
export const payWithAsaasCardToken = async (
  customerId: string,
  value: number,
  token: string,
  installmentCount: number,
  holderInfo: {
    name: string;
    document: string;
    email: string;
    phone: string;
    address?: {
      province: string;
      city: string;
      complement: string;
      street: string;
      streetNumber: string;
      postalCode: string;
    };
  },
  description: string
): Promise<AsaasCardPaymentResult> => {
  try {
    const paymentData: any = {
      customer: customerId,
      billingType: 'CREDIT_CARD',
      value: value,
      description: description,
      dueDate: new Date().toISOString().split('T')[0],
      creditCardToken: token,
      creditCardHolderInfo: {
        name: holderInfo.name,
        document: holderInfo.document,
        email: holderInfo.email,
        phone: holderInfo.phone,
        address: holderInfo.address || {
          province: 'SP',
          city: 'São Paulo',
          complement: '',
          street: 'Rua Teste',
          streetNumber: '123',
          postalCode: '01001000',
        },
      },
    };

    if (installmentCount > 1) {
      paymentData.installmentCount = installmentCount;
    }

    console.log('[ASAAS CARD TOKEN] Pagando com token:', paymentData);

    const result = await makeAsaasRequest('POST', '/v3/payments', paymentData);

    if (!result.success) {
      console.error('[ASAAS CARD TOKEN] Erro:', result.data);
      return {
        success: false,
        error: result.data?.errors?.[0]?.description || 'Erro ao processar pagamento',
        debug: result,
      };
    }

    const paymentResult = result.data;
    console.log('[ASAAS CARD TOKEN] Pagamento criado:', paymentResult);

    return {
      success: true,
      paymentId: paymentResult.id,
      status: paymentResult.status,
      debug: paymentResult,
    };
  } catch (error: any) {
    console.error('[ASAAS CARD TOKEN] Erro:', error);
    return {
      success: false,
      error: error.message || 'Erro ao processar pagamento com cartão',
      debug: error,
    };
  }
};

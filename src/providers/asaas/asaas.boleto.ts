import { makeAsaasRequest, generateExternalReference } from './asaas.client';

export interface AsaasBoletoData {
  value: number;
  description: string;
  customerAsaasId: string; // ID do cliente no Asaas
  externalReference?: string;
  dueDate?: string; // YYYY-MM-DD
}

export interface AsaasBoletoResult {
  success: boolean;
  paymentId?: string;
  boletoUrl?: string;
  barcode?: string;
  dueDate?: string;
  externalReference?: string;
  error?: string;
  debug?: any;
}

// Criar cobrança de boleto no Asaas
export const createAsaasBoletoCharge = async (data: AsaasBoletoData): Promise<AsaasBoletoResult> => {
  const externalReference = data.externalReference || generateExternalReference();
  console.log('[ASAAS BOLETO] Criando cobrança de boleto:', externalReference);

  // Calcular data de vencimento (hoje + 3 dias se não fornecida)
  const dueDate = data.dueDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const chargeData = {
    customer: data.customerAsaasId,
    billingType: 'BOLETO',
    value: data.value,
    dueDate,
    description: data.description,
    externalReference,
  };

  console.log('[ASAAS BOLETO] Dados da cobrança:', JSON.stringify(chargeData));
  const result = await makeAsaasRequest('POST', '/payments', chargeData);

  if (!result.success) {
    console.error('[ASAAS BOLETO] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.errors?.[0]?.description || result.data?.message || 'Erro ao criar cobrança de boleto',
      debug: result.data,
    };
  }

  const paymentId = result.data.id;
  console.log('[ASAAS BOLETO] Cobrança criada:', paymentId);

  // Buscar dados do boleto (URL e código de barras)
  const paymentResult = await makeAsaasRequest('GET', `/payments/${paymentId}`);

  let boletoUrl = '';
  let barcode = '';

  if (paymentResult.success) {
    boletoUrl = paymentResult.data.boletoUrl || '';
    barcode = paymentResult.data.boleto?.barcode || paymentResult.data.identificationField || '';
    console.log('[ASAAS BOLETO] Dados do boleto obtidos com sucesso');
  } else {
    console.error('[ASAAS BOLETO] Erro ao obter dados do boleto:', paymentResult.data);
  }

  return {
    success: true,
    paymentId,
    boletoUrl,
    barcode,
    dueDate,
    externalReference,
  };
};

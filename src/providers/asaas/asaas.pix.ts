import { makeAsaasRequest, generateExternalReference } from './asaas.client';

export interface AsaasPixChargeData {
  value: number;
  description: string;
  customerAsaasId: string; // ID do cliente no Asaas
  externalReference?: string;
  dueDate?: string; // YYYY-MM-DD
}

export interface AsaasPixChargeResult {
  success: boolean;
  paymentId?: string;
  pixCode?: string;
  pixQrCode?: string;
  externalReference?: string;
  error?: string;
  debug?: any;
}

// Criar cobrança PIX no Asaas
export const createAsaasPixCharge = async (data: AsaasPixChargeData): Promise<AsaasPixChargeResult> => {
  const externalReference = data.externalReference || generateExternalReference();
  console.log('[ASAAS PIX] Criando cobrança PIX:', externalReference);

  // Calcular data de vencimento (hoje + 1 dia se não fornecida)
  const dueDate = data.dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const chargeData = {
    customer: data.customerAsaasId,
    billingType: 'PIX',
    value: data.value,
    dueDate,
    description: data.description,
    externalReference,
  };

  console.log('[ASAAS PIX] Dados da cobrança:', JSON.stringify(chargeData));
  const result = await makeAsaasRequest('POST', '/payments', chargeData);

  if (!result.success) {
    console.error('[ASAAS PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.errors?.[0]?.description || result.data?.message || 'Erro ao criar cobrança PIX',
      debug: result.data,
    };
  }

  const paymentId = result.data.id;
  console.log('[ASAAS PIX] Cobrança criada:', paymentId);

  // Buscar QR Code PIX
  const qrResult = await makeAsaasRequest('GET', `/payments/${paymentId}/pixQrCode`);
  
  let pixCode = '';
  let pixQrCode = '';

  if (qrResult.success) {
    pixCode = qrResult.data.payload || '';
    pixQrCode = qrResult.data.encodedImage ? `data:image/png;base64,${qrResult.data.encodedImage}` : '';
    console.log('[ASAAS PIX] QR Code obtido com sucesso');
  } else {
    console.error('[ASAAS PIX] Erro ao obter QR Code:', qrResult.data);
  }

  return {
    success: true,
    paymentId,
    pixCode,
    pixQrCode,
    externalReference,
  };
};

// Consultar cobrança no Asaas
export const getAsaasPayment = async (paymentId: string) => {
  console.log('[ASAAS] Consultando cobrança:', paymentId);
  const result = await makeAsaasRequest('GET', `/payments/${paymentId}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.errors?.[0]?.description || 'Erro ao consultar cobrança',
    };
  }

  return {
    success: true,
    data: result.data,
    status: result.data.status,
  };
};

// Criar transferência PIX (saque) no Asaas
export const createAsaasPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description: string;
}) => {
  console.log('[ASAAS] Criando transferência PIX:', data.value);

  // Mapear tipo de chave PIX
  const pixKeyTypeMap: Record<string, string> = {
    cpf: 'CPF',
    cnpj: 'CNPJ',
    email: 'EMAIL',
    phone: 'PHONE',
    random: 'EVP',
  };

  const transferData = {
    value: data.value,
    bankAccount: {
      bank: {
        ispb: '', // Deixar vazio para PIX
      },
      ownerName: 'Destinatário',
      pixAddressKey: data.pixKey,
      pixAddressKeyType: pixKeyTypeMap[data.pixKeyType] || 'EVP',
    },
    operationType: 'PIX',
    description: data.description,
  };

  console.log('[ASAAS] Dados da transferência:', JSON.stringify(transferData));
  const result = await makeAsaasRequest('POST', '/transfers', transferData);

  if (!result.success) {
    console.error('[ASAAS] Erro na transferência:', result.data);
    return {
      success: false,
      error: result.data?.errors?.[0]?.description || result.data?.message || 'Erro ao processar transferência',
      debug: result.data,
    };
  }

  console.log('[ASAAS] Transferência realizada:', result.data);

  return {
    success: true,
    transferId: result.data.id,
    status: result.data.status,
  };
};

// Criar ou obter cliente no Asaas
export const createAsaasCustomer = async (data: {
  name: string;
  cpfCnpj: string;
  email?: string;
  phone?: string;
}) => {
  console.log('[ASAAS] Criando/obtendo cliente:', data.cpfCnpj);

  const customerData = {
    name: data.name,
    cpfCnpj: data.cpfCnpj.replace(/\D/g, ''),
    email: data.email,
    phone: data.phone?.replace(/\D/g, ''),
  };

  const result = await makeAsaasRequest('POST', '/customers', customerData);

  if (!result.success) {
    // Se já existe ou deu qualquer erro, tenta buscar pelo CPF/CNPJ
    console.log('[ASAAS] Erro ao criar cliente, tentando buscar existente...', result.data);
    
    try {
      const searchResult = await makeAsaasRequest('GET', `/customers?cpfCnpj=${customerData.cpfCnpj}`);
      if (searchResult.success && searchResult.data?.data?.[0]) {
        console.log('[ASAAS] Cliente existente encontrado:', searchResult.data.data[0].id);
        return {
          success: true,
          customerId: searchResult.data.data[0].id,
          customer: searchResult.data.data[0],
        };
      }
    } catch (searchErr) {
      console.error('[ASAAS] Erro ao buscar cliente existente:', searchErr);
    }

    return {
      success: false,
      error: result.data?.errors?.[0]?.description || result.data?.message || 'Erro ao criar cliente no gateway',
      debug: result.data,
    };
  }

  return {
    success: true,
    customerId: result.data.id,
    customer: result.data,
  };
};

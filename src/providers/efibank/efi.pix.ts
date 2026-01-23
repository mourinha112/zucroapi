import { makePixRequest, generateTxId } from './efi.client';
import { env } from '../../config/env';

export interface PixChargeData {
  value: number;
  description: string;
  customerCpf?: string;
  customerName?: string;
  expirationSeconds?: number;
}

export interface PixChargeResult {
  success: boolean;
  txid?: string;
  pixCode?: string;
  pixQrCode?: string;
  error?: string;
  debug?: any;
}

// Criar cobrança PIX
export const createPixCharge = async (data: PixChargeData): Promise<PixChargeResult> => {
  const txid = generateTxId();
  console.log('[PIX] Criando cobrança PIX com txid:', txid);

  const pixData: any = {
    calendario: { 
      expiracao: data.expirationSeconds || 3600 
    },
    valor: { 
      original: data.value.toFixed(2) 
    },
    chave: env.EFI_PIX_KEY,
    solicitacaoPagador: data.description,
  };

  // Adicionar devedor se tiver CPF
  if (data.customerCpf) {
    pixData.devedor = {
      cpf: data.customerCpf.replace(/\D/g, '').slice(0, 11),
      nome: data.customerName || 'Cliente',
    };
  }

  console.log('[PIX] Dados da cobrança:', JSON.stringify(pixData));
  const result = await makePixRequest('PUT', `/v2/cob/${txid}`, pixData);

  if (!result.success) {
    console.error('[PIX] Erro ao criar cobrança:', result.data);
    return {
      success: false,
      error: result.data?.mensagem || result.data?.message || 'Erro ao criar cobrança PIX',
      debug: result.data,
    };
  }

  console.log('[PIX] Cobrança criada:', result.data);

  // Buscar QR Code
  let pixCode = result.data.pixCopiaECola || '';
  let pixQrCode = '';

  if (result.data.loc?.id) {
    console.log('[PIX] Buscando QR Code, location:', result.data.loc.id);
    const qrResult = await makePixRequest('GET', `/v2/loc/${result.data.loc.id}/qrcode`);
    
    if (qrResult.success) {
      pixCode = pixCode || qrResult.data.qrcode || '';
      pixQrCode = qrResult.data.imagemQrcode || '';
      console.log('[PIX] QR Code obtido com sucesso');
    } else {
      console.error('[PIX] Erro ao obter QR Code:', qrResult.data);
    }
  }

  return {
    success: true,
    txid,
    pixCode,
    pixQrCode,
  };
};

// Consultar cobrança PIX
export const getPixCharge = async (txid: string) => {
  console.log('[PIX] Consultando cobrança:', txid);
  const result = await makePixRequest('GET', `/v2/cob/${txid}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.mensagem || 'Erro ao consultar cobrança',
    };
  }

  return {
    success: true,
    data: result.data,
    status: result.data.status,
  };
};

// Criar transferência PIX (saque) - Endpoint correto da EFI: /v2/gn/pix/:idEnvio
export const createPixTransfer = async (data: {
  value: number;
  pixKey: string;
  pixKeyType: string;
  description: string;
}) => {
  // ID único para o envio (máx 35 caracteres alfanuméricos)
  const idEnvio = `zp${Date.now()}`.substring(0, 35);
  console.log('[PIX] Criando transferência (envio):', idEnvio);
  console.log('[PIX] Chave destino:', data.pixKey);
  console.log('[PIX] Valor:', data.value.toFixed(2));

  const transferData = {
    valor: data.value.toFixed(2),
    pagador: {
      chave: env.EFI_PIX_KEY,
      infoPagador: data.description.substring(0, 140), // máx 140 caracteres
    },
    favorecido: {
      chave: data.pixKey,
    },
  };

  console.log('[PIX] Dados do envio:', JSON.stringify(transferData));

  // Endpoint correto para envio de PIX na EFI: /v2/gn/pix/:idEnvio
  const result = await makePixRequest('PUT', `/v2/gn/pix/${idEnvio}`, transferData);

  if (!result.success) {
    console.error('[PIX] Erro na transferência:', result.data);
    return {
      success: false,
      error: result.data?.mensagem || result.data?.erro?.motivo || result.data?.message || 'Erro ao processar transferência',
      debug: result.data,
    };
  }

  console.log('[PIX] Transferência realizada com sucesso:', result.data);

  return {
    success: true,
    idEnvio,
    endToEndId: result.data.endToEndId || result.data.e2eId,
    status: result.data.status,
  };
};

// Consultar transferência PIX
export const getPixTransfer = async (e2eId: string) => {
  const result = await makePixRequest('GET', `/v2/pix/${e2eId}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.mensagem || 'Erro ao consultar transferência',
    };
  }

  return {
    success: true,
    data: result.data,
    status: result.data.status,
  };
};

// ============================================
// CONFIGURAÇÃO DE WEBHOOK PIX
// ============================================

// Configurar webhook PIX na EfiBank
export const configurePixWebhook = async (webhookUrl: string) => {
  const pixKey = env.EFI_PIX_KEY;
  console.log(`[PIX] Configurando webhook para chave: ${pixKey}`);
  console.log(`[PIX] URL do webhook: ${webhookUrl}`);

  const result = await makePixRequest('PUT', `/v2/webhook/${pixKey}`, {
    webhookUrl,
  });

  if (!result.success) {
    console.error('[PIX] Erro ao configurar webhook:', result.data);
    return {
      success: false,
      error: result.data?.mensagem || result.data?.message || 'Erro ao configurar webhook',
      debug: result.data,
    };
  }

  console.log('[PIX] Webhook configurado com sucesso');
  return {
    success: true,
    data: result.data,
  };
};

// Consultar webhook PIX configurado
export const getPixWebhook = async () => {
  const pixKey = env.EFI_PIX_KEY;
  console.log(`[PIX] Consultando webhook da chave: ${pixKey}`);

  const result = await makePixRequest('GET', `/v2/webhook/${pixKey}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.mensagem || 'Webhook não configurado',
      debug: result.data,
    };
  }

  return {
    success: true,
    webhookUrl: result.data.webhookUrl,
    data: result.data,
  };
};

// Remover webhook PIX
export const deletePixWebhook = async () => {
  const pixKey = env.EFI_PIX_KEY;
  console.log(`[PIX] Removendo webhook da chave: ${pixKey}`);

  const result = await makePixRequest('DELETE', `/v2/webhook/${pixKey}`);

  if (!result.success) {
    return {
      success: false,
      error: result.data?.mensagem || 'Erro ao remover webhook',
    };
  }

  return {
    success: true,
  };
};

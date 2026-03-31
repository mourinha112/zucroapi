import { prisma } from '../../config/database';

// Taxas padrão da plataforma (fallback se não existir no banco)
export const DEFAULT_RATES = {
  pix_rate: 4.99,        // % taxa PIX
  card_rate: 4.99,       // % taxa cartão (mantido para compatibilidade)
  boleto_rate: 4.99,     // % taxa boleto (mantido para compatibilidade)
  fixed_fee: 0,          // Sem taxa fixa
  installment_fee: 0,    // Sem juros de parcelamento (somente PIX)
  reserve_percent: 0.05, // 5% de reserva
  reserve_days: 30,      // Dias para liberar reserva
  withdrawal_fee: 10.00, // Taxa de saque
  max_installments: 1,   // Somente à vista (PIX)
  min_pix_value: 1.00,   // Valor mínimo PIX
  min_card_value: 5.00,  // Valor mínimo cartão
};

export interface SellerRates {
  pix_rate: number;
  card_rate: number;
  boleto_rate: number;
  fixed_fee: number;
  installment_fee: number;
  reserve_percent: number;
  reserve_days: number;
  withdrawal_fee?: number;
  max_installments?: number;
  min_pix_value?: number;
  min_card_value?: number;
}

export interface FeeCalculationResult {
  grossValue: number;         // Valor total cobrado do cliente
  baseValue: number;          // Valor base do produto
  platformFee: number;        // Taxa da plataforma (sempre do vendedor)
  installmentFee: number;     // Juros de parcelamento (pode ser do comprador)
  netValue: number;           // Valor líquido pro vendedor
  reserveAmount: number;      // Valor da reserva
  sellerReceives: number;     // Valor que vai pro saldo disponível
  feePayer: 'seller' | 'buyer';
  installments: number;
  rates: SellerRates;
}

// Cache das taxas globais (atualiza a cada 5 minutos)
let cachedPlatformRates: SellerRates | null = null;
let cacheTime: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// Buscar taxas globais da plataforma do banco de dados
export const getPlatformRates = async (): Promise<SellerRates> => {
  // Retornar cache se ainda válido
  if (cachedPlatformRates && Date.now() - cacheTime < CACHE_DURATION) {
    return cachedPlatformRates;
  }

  try {
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'default' },
    });

    if (settings) {
      cachedPlatformRates = {
        pix_rate: Number(settings.pix_rate),
        card_rate: Number(settings.card_rate),
        boleto_rate: Number(settings.boleto_rate),
        fixed_fee: Number(settings.fixed_fee),
        installment_fee: Number(settings.installment_fee),
        reserve_percent: Number(settings.reserve_percent),
        reserve_days: settings.reserve_days,
        withdrawal_fee: Number(settings.withdrawal_fee),
        max_installments: settings.max_installments,
        min_pix_value: Number(settings.min_pix_value),
        min_card_value: Number(settings.min_card_value),
      };
    } else {
      // Criar registro padrão se não existir
      await prisma.platformSettings.create({
        data: {
          id: 'default',
          pix_rate: DEFAULT_RATES.pix_rate,
          card_rate: DEFAULT_RATES.card_rate,
          boleto_rate: DEFAULT_RATES.boleto_rate,
          fixed_fee: DEFAULT_RATES.fixed_fee,
          installment_fee: DEFAULT_RATES.installment_fee,
          reserve_percent: DEFAULT_RATES.reserve_percent,
          reserve_days: DEFAULT_RATES.reserve_days,
          withdrawal_fee: DEFAULT_RATES.withdrawal_fee,
          max_installments: DEFAULT_RATES.max_installments,
          min_pix_value: DEFAULT_RATES.min_pix_value,
          min_card_value: DEFAULT_RATES.min_card_value,
        },
      });
      cachedPlatformRates = { ...DEFAULT_RATES };
    }

    cacheTime = Date.now();
    return cachedPlatformRates;
  } catch (error) {
    console.error('[FEE] Erro ao buscar taxas da plataforma:', error);
    return { ...DEFAULT_RATES };
  }
};

// Invalidar cache (chamar após atualizar taxas)
export const invalidatePlatformRatesCache = () => {
  cachedPlatformRates = null;
  cacheTime = 0;
};

// Mesclar taxas personalizadas do usuário com as globais da plataforma
export const getEffectiveRates = async (customRates?: Partial<SellerRates> | null): Promise<SellerRates> => {
  const platformRates = await getPlatformRates();
  const rates = { ...platformRates };
  
  if (customRates) {
    if (customRates.pix_rate !== undefined && customRates.pix_rate > 0) {
      rates.pix_rate = customRates.pix_rate;
    }
    if (customRates.card_rate !== undefined && customRates.card_rate > 0) {
      rates.card_rate = customRates.card_rate;
    }
    if (customRates.boleto_rate !== undefined && customRates.boleto_rate > 0) {
      rates.boleto_rate = customRates.boleto_rate;
    }
    if (customRates.fixed_fee !== undefined && customRates.fixed_fee >= 0) {
      rates.fixed_fee = customRates.fixed_fee;
    }
    if (customRates.installment_fee !== undefined && customRates.installment_fee >= 0) {
      rates.installment_fee = customRates.installment_fee;
    }
    if (customRates.reserve_percent !== undefined && customRates.reserve_percent >= 0) {
      rates.reserve_percent = customRates.reserve_percent;
    }
    if (customRates.withdrawal_fee !== undefined && customRates.withdrawal_fee >= 0) {
      rates.withdrawal_fee = customRates.withdrawal_fee;
    }
  }
  
  return rates;
};

// Versão síncrona para compatibilidade (usa cache ou fallback)
export const getEffectiveRatesSync = (customRates?: Partial<SellerRates> | null): SellerRates => {
  const platformRates = cachedPlatformRates || { ...DEFAULT_RATES };
  const rates = { ...platformRates };
  
  if (customRates) {
    if (customRates.pix_rate !== undefined && customRates.pix_rate > 0) {
      rates.pix_rate = customRates.pix_rate;
    }
    if (customRates.card_rate !== undefined && customRates.card_rate > 0) {
      rates.card_rate = customRates.card_rate;
    }
    if (customRates.boleto_rate !== undefined && customRates.boleto_rate > 0) {
      rates.boleto_rate = customRates.boleto_rate;
    }
    if (customRates.fixed_fee !== undefined && customRates.fixed_fee >= 0) {
      rates.fixed_fee = customRates.fixed_fee;
    }
    if (customRates.installment_fee !== undefined && customRates.installment_fee >= 0) {
      rates.installment_fee = customRates.installment_fee;
    }
    if (customRates.reserve_percent !== undefined && customRates.reserve_percent >= 0) {
      rates.reserve_percent = customRates.reserve_percent;
    }
  }
  
  return rates;
};

/**
 * VENDEDOR PAGA TUDO
 * Taxa da plataforma (% + fixo) + juros de parcelamento são descontados do vendedor
 * Cliente paga exatamente o valor do produto
 */
export const calculateCardFeeSellerPays = (
  value: number,
  installments: number,
  rates: SellerRates
): FeeCalculationResult => {
  const ratePercent = rates.card_rate / 100;
  const installmentPercent = rates.installment_fee / 100;
  
  // Taxa da plataforma = valor * taxa% + taxa fixa
  let platformFee = (value * ratePercent) + rates.fixed_fee;
  
  // Juros de parcelamento = valor * juros% * parcelas
  let installmentFee = 0;
  if (installments > 1) {
    installmentFee = value * installmentPercent * installments;
  }
  
  // Total descontado = taxa plataforma + juros parcelamento
  const totalFee = platformFee + installmentFee;
  
  // Limitar taxa total a 50% do valor
  const maxFee = value * 0.5;
  const actualFee = Math.min(totalFee, maxFee);
  
  // Se limitou, ajustar proporcionalmente
  if (actualFee < totalFee) {
    const ratio = actualFee / totalFee;
    platformFee = platformFee * ratio;
    installmentFee = installmentFee * ratio;
  }
  
  const valueAfterFees = Math.max(0, value - platformFee - installmentFee);
  const reserveAmount = Math.max(0, valueAfterFees * rates.reserve_percent);
  const netValue = Math.max(0, valueAfterFees - reserveAmount);
  
  return {
    grossValue: value,           // Cliente paga valor original
    baseValue: value,
    platformFee,
    installmentFee,
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'seller',
    installments,
    rates,
  };
};

/**
 * COMPRADOR PAGA JUROS (apenas juros de parcelamento)
 * Taxa da plataforma (% + fixo) é descontada do VENDEDOR
 * Juros de parcelamento são cobrados do COMPRADOR (adicionados ao valor)
 */
export const calculateCardFeeBuyerPays = (
  baseValue: number,
  installments: number,
  rates: SellerRates
): FeeCalculationResult => {
  const ratePercent = rates.card_rate / 100;
  const installmentPercent = rates.installment_fee / 100;
  
  // Juros que o comprador paga (adicionado ao valor)
  let installmentFee = 0;
  if (installments > 1) {
    installmentFee = baseValue * installmentPercent * installments;
  }
  
  // Valor total que o cliente paga = base + juros
  const grossValue = baseValue + installmentFee;
  
  // Taxa da plataforma sempre vem do vendedor (% do valor base + fixo)
  const platformFee = (baseValue * ratePercent) + rates.fixed_fee;
  
  // Vendedor recebe: valor base - taxa plataforma
  const valueAfterPlatformFee = Math.max(0, baseValue - platformFee);
  const reserveAmount = Math.max(0, valueAfterPlatformFee * rates.reserve_percent);
  const netValue = Math.max(0, valueAfterPlatformFee - reserveAmount);
  
  return {
    grossValue,                  // Cliente paga valor + juros
    baseValue,
    platformFee,
    installmentFee,
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'buyer',
    installments,
    rates,
  };
};

/**
 * PIX - VENDEDOR PAGA
 * Taxa da plataforma é descontada do vendedor
 * Cliente paga exatamente o valor do produto
 */
export const calculatePixFeeSellerPays = (
  value: number,
  rates: SellerRates
): FeeCalculationResult => {
  const ratePercent = rates.pix_rate / 100;
  
  // Taxa = valor * taxa% + taxa fixa
  let platformFee = (value * ratePercent) + rates.fixed_fee;
  
  // Limitar taxa a 50% do valor
  if (platformFee > value * 0.5) {
    platformFee = value * 0.5;
  }
  
  const valueAfterFees = Math.max(0, value - platformFee);
  const reserveAmount = Math.max(0, valueAfterFees * rates.reserve_percent);
  const netValue = Math.max(0, valueAfterFees - reserveAmount);
  
  return {
    grossValue: value,
    baseValue: value,
    platformFee,
    installmentFee: 0,
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'seller',
    installments: 1,
    rates,
  };
};

/**
 * PIX - COMPRADOR PAGA (não faz sentido para PIX pois não tem parcelamento)
 * Mantido para compatibilidade, mas funciona igual ao vendedor paga
 * Pois PIX não tem juros de parcelamento
 */
export const calculatePixFeeBuyerPays = (
  value: number,
  rates: SellerRates
): FeeCalculationResult => {
  // PIX não tem parcelamento, então "comprador paga" não muda nada
  // A taxa da plataforma SEMPRE é do vendedor
  return calculatePixFeeSellerPays(value, rates);
};

/**
 * Calcular valor total para o comprador (quando ele paga juros)
 * Usado para mostrar no checkout quanto o cliente vai pagar
 */
export const calculateTotalForBuyer = (
  baseValue: number,
  billingType: 'PIX' | 'CREDIT_CARD' | 'BOLETO',
  installments: number,
  feePayer: 'seller' | 'buyer',
  rates: SellerRates
): number => {
  // Se vendedor paga tudo, cliente paga só o valor base
  if (feePayer === 'seller') {
    return baseValue;
  }
  
  // PIX e Boleto não têm parcelamento, então não tem juros adicionais
  if (billingType !== 'CREDIT_CARD') {
    return baseValue;
  }
  
  // Cartão com comprador pagando juros
  if (installments <= 1) {
    return baseValue; // À vista não tem juros
  }
  
  // Calcular juros de parcelamento
  const installmentFee = baseValue * (rates.installment_fee / 100) * installments;
  
  return baseValue + installmentFee;
};

/**
 * Calcular valor da parcela
 */
export const calculateInstallmentValue = (
  baseValue: number,
  installments: number,
  feePayer: 'seller' | 'buyer',
  rates: SellerRates
): { installmentValue: number; totalValue: number; installmentFee: number } => {
  if (installments <= 1) {
    return {
      installmentValue: baseValue,
      totalValue: baseValue,
      installmentFee: 0,
    };
  }
  
  let installmentFee = 0;
  
  // Se comprador paga, adiciona juros ao total
  if (feePayer === 'buyer') {
    installmentFee = baseValue * (rates.installment_fee / 100) * installments;
  }
  
  const totalValue = baseValue + installmentFee;
  const installmentValue = totalValue / installments;
  
  return {
    installmentValue,
    totalValue,
    installmentFee,
  };
};

/**
 * Aplica taxas específicas por adquirente.
 * Se o seller tem custom rate, a taxa dele prevalece.
 * Enki padrão: 3.50% + R$2.50 fixo por transação PIX.
 */
export const applyProviderRateOverrides = (
  rates: SellerRates,
  provider: string,
  hasCustomRates?: boolean
): SellerRates => {
  if (provider === 'enki' && !hasCustomRates) {
    return {
      ...rates,
      pix_rate: 3.50,
      fixed_fee: 2.50,
    };
  }
  if (provider === 'eusouzucropay' && !hasCustomRates) {
    return {
      ...rates,
      pix_rate: 4.99,
      fixed_fee: 2.50,
    };
  }
  return rates;
};

// Calcular data de liberação da reserva
export const calculateReleaseDate = (days?: number): Date => {
  const releaseDate = new Date();
  releaseDate.setDate(releaseDate.getDate() + (days || DEFAULT_RATES.reserve_days));
  return releaseDate;
};

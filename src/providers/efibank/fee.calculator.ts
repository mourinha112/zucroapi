// Taxas padrão da plataforma
export const DEFAULT_RATES = {
  pix_rate: 5.99,        // % taxa PIX
  card_rate: 5.99,       // % taxa cartão
  boleto_rate: 5.99,     // % taxa boleto
  fixed_fee: 2.50,       // Taxa fixa por transação
  installment_fee: 2.49, // % adicional por parcela
  reserve_percent: 0.05, // 5% de reserva
  reserve_days: 30,      // Dias para liberar reserva
};

export interface SellerRates {
  pix_rate: number;
  card_rate: number;
  boleto_rate: number;
  fixed_fee: number;
  installment_fee: number;
  reserve_percent: number;
  reserve_days: number;
}

export interface FeeCalculationResult {
  grossValue: number;       // Valor bruto cobrado
  baseValue: number;        // Valor do produto
  platformFee: number;      // Taxa da plataforma
  netValue: number;         // Valor líquido pro vendedor
  reserveAmount: number;    // Valor da reserva
  sellerReceives: number;   // Valor que vai pro saldo disponível
  feePayer: 'seller' | 'buyer';
  installments: number;
  rates: SellerRates;
}

// Mesclar taxas personalizadas com padrão
export const getEffectiveRates = (customRates?: Partial<SellerRates> | null): SellerRates => {
  const rates = { ...DEFAULT_RATES };
  
  if (customRates) {
    if (customRates.pix_rate && customRates.pix_rate > 0) {
      rates.pix_rate = customRates.pix_rate;
    }
    if (customRates.card_rate && customRates.card_rate > 0) {
      rates.card_rate = customRates.card_rate;
    }
    if (customRates.boleto_rate && customRates.boleto_rate > 0) {
      rates.boleto_rate = customRates.boleto_rate;
    }
  }
  
  return rates;
};

// Calcular taxa para cartão quando VENDEDOR paga
export const calculateCardFeeSellerPays = (
  value: number,
  installments: number,
  rates: SellerRates
): FeeCalculationResult => {
  const ratePercent = rates.card_rate / 100;
  const installmentPercent = rates.installment_fee / 100;
  
  // Taxa = (valor * taxa%) + taxa_fixa + (valor * taxa_parcela% * parcelas)
  let platformFee = (value * ratePercent) + rates.fixed_fee;
  platformFee += value * installmentPercent * installments;
  
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
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'seller',
    installments,
    rates,
  };
};

// Calcular taxa para cartão quando COMPRADOR paga
export const calculateCardFeeBuyerPays = (
  baseValue: number,
  totalPaid: number,
  installments: number,
  rates: SellerRates
): FeeCalculationResult => {
  // O comprador já pagou o valor com taxas embutidas
  const buyerPaidFee = totalPaid - baseValue;
  
  // Taxa da plataforma = taxa fixa + o que o comprador pagou a mais
  const platformFee = rates.fixed_fee + buyerPaidFee;
  
  // Valor após taxa fixa
  const valueAfterFixedFee = Math.max(0, baseValue - rates.fixed_fee);
  
  // Reserva sobre valor após taxa fixa
  const reserveAmount = Math.max(0, valueAfterFixedFee * rates.reserve_percent);
  
  // Líquido
  const netValue = Math.max(0, valueAfterFixedFee - reserveAmount);
  
  return {
    grossValue: totalPaid,
    baseValue,
    platformFee,
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'buyer',
    installments,
    rates,
  };
};

// Calcular taxa para PIX quando VENDEDOR paga
export const calculatePixFeeSellerPays = (
  value: number,
  rates: SellerRates
): FeeCalculationResult => {
  const ratePercent = rates.pix_rate / 100;
  
  // Taxa = (valor * taxa%) + taxa_fixa
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
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'seller',
    installments: 1,
    rates,
  };
};

// Calcular taxa para PIX quando COMPRADOR paga
export const calculatePixFeeBuyerPays = (
  baseValue: number,
  totalPaid: number,
  rates: SellerRates
): FeeCalculationResult => {
  const buyerPaidFee = totalPaid - baseValue;
  const platformFee = rates.fixed_fee + buyerPaidFee;
  
  const valueAfterFixedFee = Math.max(0, baseValue - rates.fixed_fee);
  const reserveAmount = Math.max(0, valueAfterFixedFee * rates.reserve_percent);
  const netValue = Math.max(0, valueAfterFixedFee - reserveAmount);
  
  return {
    grossValue: totalPaid,
    baseValue,
    platformFee,
    netValue,
    reserveAmount,
    sellerReceives: netValue,
    feePayer: 'buyer',
    installments: 1,
    rates,
  };
};

// Calcular valor total para comprador (quando ele paga taxas)
export const calculateTotalForBuyer = (
  baseValue: number,
  billingType: 'PIX' | 'CREDIT_CARD' | 'BOLETO',
  installments: number,
  rates: SellerRates
): number => {
  let ratePercent: number;
  
  switch (billingType) {
    case 'PIX':
      ratePercent = rates.pix_rate / 100;
      break;
    case 'CREDIT_CARD':
      ratePercent = rates.card_rate / 100;
      break;
    case 'BOLETO':
      ratePercent = rates.boleto_rate / 100;
      break;
    default:
      ratePercent = rates.pix_rate / 100;
  }
  
  // Taxa base
  let fee = (baseValue * ratePercent) + rates.fixed_fee;
  
  // Taxa de parcelamento (só para cartão)
  if (billingType === 'CREDIT_CARD' && installments > 1) {
    fee += baseValue * (rates.installment_fee / 100) * installments;
  }
  
  return baseValue + fee;
};

// Calcular data de liberação da reserva
export const calculateReleaseDate = (days: number = DEFAULT_RATES.reserve_days): Date => {
  const releaseDate = new Date();
  releaseDate.setDate(releaseDate.getDate() + days);
  return releaseDate;
};

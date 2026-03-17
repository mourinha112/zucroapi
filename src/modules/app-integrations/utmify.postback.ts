import { prisma } from '../../config/database';

interface UtmifyPaymentData {
  paymentId: string;
  sellerId: string;
  value: number;
  netValue: number;
  platformFee: number;
  status: 'paid' | 'refunded' | 'chargedback';
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  customerDocument?: string;
  productName: string;
  productId?: string;
  createdAt: string;
  approvedAt?: string;
  refundedAt?: string;
}

export async function sendUtmifyPostback(data: UtmifyPaymentData): Promise<void> {
  try {
    // Buscar integração UTMify ativa do seller
    const integration = await prisma.appIntegration.findUnique({
      where: {
        user_id_app_id: { user_id: data.sellerId, app_id: 'utmify' },
      },
    });

    if (!integration || !integration.active || !integration.api_token) {
      return; // Seller não tem UTMify configurado
    }

    // Mapear status
    const statusMap: Record<string, string> = {
      paid: 'paid',
      refunded: 'refunded',
      chargedback: 'chargedback',
    };

    const totalInCents = Math.round(data.value * 100);
    const feeInCents = Math.round(data.platformFee * 100);
    const commissionInCents = Math.round(data.netValue * 100);

    const payload = {
      orderId: data.paymentId,
      platform: 'ZucroPay',
      paymentMethod: 'pix',
      status: statusMap[data.status] || 'paid',
      createdAt: data.createdAt,
      approvedDate: data.approvedAt || null,
      refundedAt: data.refundedAt || null,
      customer: {
        name: data.customerName,
        email: data.customerEmail,
        phone: data.customerPhone || null,
        document: data.customerDocument || null,
      },
      products: [
        {
          id: data.productId || data.paymentId,
          name: data.productName,
          planId: null,
          planName: null,
          quantity: 1,
          priceInCents: totalInCents,
        },
      ],
      trackingParameters: {
        src: null,
        sck: null,
        utm_source: null,
        utm_campaign: null,
        utm_medium: null,
        utm_content: null,
        utm_term: null,
      },
      commission: {
        totalPriceInCents: totalInCents,
        gatewayFeeInCents: feeInCents,
        userCommissionInCents: commissionInCents,
        currency: 'BRL',
      },
    };

    console.log(`[UTMify] Enviando postback para seller ${data.sellerId}: order=${data.paymentId} status=${data.status}`);

    const response = await fetch('https://api.utmify.com.br/api-credentials/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': integration.api_token,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[UTMify] Erro ${response.status}: ${responseText}`);
    } else {
      console.log(`[UTMify] Postback enviado com sucesso: ${responseText}`);
    }
  } catch (error: any) {
    console.error('[UTMify] Erro ao enviar postback:', error.message);
  }
}

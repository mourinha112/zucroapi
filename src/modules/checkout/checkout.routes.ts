import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { authenticate, standardRateLimit } from '../../middlewares';

const saveCustomizationSchema = z.object({
  productId: z.string().or(z.number()).transform(String),
  
  // Imagens
  logoUrl: z.string().optional().nullable(),
  bannerUrl: z.string().optional().nullable(),
  backgroundUrl: z.string().optional().nullable(),
  
  // Cores
  primaryColor: z.string().default('#5818C8'),
  secondaryColor: z.string().default('#7B2FF7'),
  backgroundColor: z.string().default('#FFFFFF'),
  textColor: z.string().default('#333333'),
  buttonColor: z.string().default('#5818C8'),
  
  // Cronômetro
  timerEnabled: z.boolean().default(false),
  timerMinutes: z.number().min(1).max(60).default(15),
  timerMessage: z.string().default('Oferta expira em:'),
  
  // Textos personalizados
  customTitle: z.string().optional().nullable(),
  customDescription: z.string().optional().nullable(),
  customButtonText: z.string().optional().nullable(),
  successMessage: z.string().optional().nullable(),
  
  // Configurações avançadas
  showLogo: z.boolean().default(true),
  showBanner: z.boolean().default(true),
  showTimer: z.boolean().default(false),
  showStock: z.boolean().default(true),
  allowQuantity: z.boolean().default(true),
});

export async function checkoutRoutes(app: FastifyInstance) {
  // Obter customização do checkout
  app.get('/customization', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const { productId } = request.query as { productId?: string };

    if (!productId) {
      return reply.send({ success: true, customization: null });
    }

    // Verificar se o produto pertence ao usuário
    const product = await prisma.product.findFirst({
      where: { id: productId, user_id: decoded.id },
      include: { checkout_customization: true },
    });

    if (!product) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    return reply.send({
      success: true,
      customization: product.checkout_customization ? {
        productId: product.id,
        logoUrl: product.checkout_customization.logo_url,
        bannerUrl: product.checkout_customization.banner_url,
        backgroundUrl: product.checkout_customization.background_url,
        primaryColor: product.checkout_customization.primary_color,
        secondaryColor: product.checkout_customization.secondary_color,
        backgroundColor: product.checkout_customization.background_color,
        textColor: product.checkout_customization.text_color,
        buttonColor: product.checkout_customization.button_color,
        timerEnabled: product.checkout_customization.timer_enabled,
        timerMinutes: product.checkout_customization.timer_minutes,
        timerMessage: product.checkout_customization.timer_message,
        customTitle: product.checkout_customization.custom_title,
        customDescription: product.checkout_customization.custom_description,
        customButtonText: product.checkout_customization.custom_button_text,
        successMessage: product.checkout_customization.success_message,
        showLogo: product.checkout_customization.show_logo,
        showBanner: product.checkout_customization.show_banner,
        showTimer: product.checkout_customization.show_timer,
        showStock: product.checkout_customization.show_stock,
        allowQuantity: product.checkout_customization.allow_quantity,
      } : null,
    });
  });

  // Salvar customização do checkout
  app.post('/customization', {
    preHandler: [standardRateLimit, authenticate],
  }, async (request, reply) => {
    const decoded = request.user as { id: string };
    const body = saveCustomizationSchema.parse(request.body);

    // Verificar se o produto pertence ao usuário
    const product = await prisma.product.findFirst({
      where: { id: body.productId, user_id: decoded.id },
    });

    if (!product) {
      return reply.status(404).send({ error: 'Produto não encontrado' });
    }

    // Upsert da customização
    const customization = await prisma.checkoutCustomization.upsert({
      where: { product_id: body.productId },
      create: {
        product_id: body.productId,
        logo_url: body.logoUrl,
        banner_url: body.bannerUrl,
        background_url: body.backgroundUrl,
        primary_color: body.primaryColor,
        secondary_color: body.secondaryColor,
        background_color: body.backgroundColor,
        text_color: body.textColor,
        button_color: body.buttonColor,
        timer_enabled: body.timerEnabled,
        timer_minutes: body.timerMinutes,
        timer_message: body.timerMessage,
        custom_title: body.customTitle,
        custom_description: body.customDescription,
        custom_button_text: body.customButtonText,
        success_message: body.successMessage,
        show_logo: body.showLogo,
        show_banner: body.showBanner,
        show_timer: body.showTimer,
        show_stock: body.showStock,
        allow_quantity: body.allowQuantity,
      },
      update: {
        logo_url: body.logoUrl,
        banner_url: body.bannerUrl,
        background_url: body.backgroundUrl,
        primary_color: body.primaryColor,
        secondary_color: body.secondaryColor,
        background_color: body.backgroundColor,
        text_color: body.textColor,
        button_color: body.buttonColor,
        timer_enabled: body.timerEnabled,
        timer_minutes: body.timerMinutes,
        timer_message: body.timerMessage,
        custom_title: body.customTitle,
        custom_description: body.customDescription,
        custom_button_text: body.customButtonText,
        success_message: body.successMessage,
        show_logo: body.showLogo,
        show_banner: body.showBanner,
        show_timer: body.showTimer,
        show_stock: body.showStock,
        allow_quantity: body.allowQuantity,
        updated_at: new Date(),
      },
    });

    return reply.send({ success: true, customization });
  });

  // Obter customização pública (para checkout público)
  app.get('/customization/public/:productId', {
    preHandler: [standardRateLimit],
  }, async (request, reply) => {
    const { productId } = request.params as { productId: string };

    const customization = await prisma.checkoutCustomization.findUnique({
      where: { product_id: productId },
    });

    if (!customization) {
      return reply.send({ success: true, customization: null });
    }

    return reply.send({
      success: true,
      customization: {
        logoUrl: customization.logo_url,
        bannerUrl: customization.banner_url,
        backgroundUrl: customization.background_url,
        primaryColor: customization.primary_color,
        secondaryColor: customization.secondary_color,
        backgroundColor: customization.background_color,
        textColor: customization.text_color,
        buttonColor: customization.button_color,
        timerEnabled: customization.timer_enabled,
        timerMinutes: customization.timer_minutes,
        timerMessage: customization.timer_message,
        customTitle: customization.custom_title,
        customDescription: customization.custom_description,
        customButtonText: customization.custom_button_text,
        successMessage: customization.success_message,
        showLogo: customization.show_logo,
        showBanner: customization.show_banner,
        showTimer: customization.show_timer,
        showStock: customization.show_stock,
        allowQuantity: customization.allow_quantity,
      },
    });
  });
}

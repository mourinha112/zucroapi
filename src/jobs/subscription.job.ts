/**
 * Job para processar cobranças de assinaturas recorrentes
 * Deve ser executado diariamente (ex: a cada 1 hora)
 * 
 * No PM2, configure para rodar a cada hora:
 * pm2 start src/jobs/subscription.job.ts --name subscription-job --cron "* * * * *"
 */

import { prisma } from '../config/database';

// Intervalo em milliseconds (1 hora)
const CHECK_INTERVAL = 60 * 60 * 1000;

interface SubscriptionData {
  id: string;
  user_id: string;
  customer_email: string;
  customer_name?: string;
  customer_document?: string;
  status: string;
  next_billing_date: Date;
  cancel_at_period_end: boolean;
  plan: {
    id: string;
    name: string;
    interval: string;
    interval_count: number;
    price: any; // Decimal do Prisma
    max_installments: number;
    user: {
      efi_customer_id?: string;
    };
  };
}

async function processSubscriptionPayment(subscription: SubscriptionData) {
  console.log(`[Subscription] Processando cobrança para assinatura ${subscription.id}`);
  
  try {
    const now = new Date();
    const nextBilling = new Date(subscription.next_billing_date);
    
    // Verificar se já é hora de cobrar
    if (nextBilling > now) {
      console.log(`[Subscription] Assinatura ${subscription.id} ainda não venceu`);
      return;
    }

    const priceValue = Number(subscription.plan.price);
    
    // Criar registro de cobrança
    const subscriptionPayment = await (prisma as any).subscriptionPayment?.create({
      data: {
        subscription_id: subscription.id,
        amount: priceValue,
        status: 'pending',
        billing_date: now,
      },
    }).catch(() => null);

    // TODO: Aqui você integraria com o gateway de pagamento (EfiBank/Asaas)
    // Por enquanto, apenas registramos a cobrança como pendente
    
    // Exemplo de como seria com EfiBank:
    /*
    const customer = await prisma.user.findUnique({
      where: { id: subscription.user_id },
      select: { efi_customer_id: true }
    });

    if (customer?.efi_customer_id) {
      const chargeResult = await createCardCharge({
        customerId: customer.efi_customer_id,
        value: priceValue,
        installments: subscription.plan.max_installments,
        description: `Assinatura ${subscription.plan.name}`,
      });
      
      // Atualizar status da cobrança
      if (subscriptionPayment) {
        await (prisma as any).subscriptionPayment.update({
          where: { id: subscriptionPayment.id },
          data: {
            external_payment_id: chargeResult.charge_id,
            status: 'paid',
            paid_at: new Date(),
          },
        });
      }
    }
    */

    // Calcular próximo período
    const nextPeriod = calculateNextPeriod(
      now,
      subscription.plan.interval,
      subscription.plan.interval_count
    );

    // Atualizar assinatura
    await (prisma as any).subscription?.update({
      where: { id: subscription.id },
      data: {
        current_period_start: now,
        current_period_end: nextPeriod,
        next_billing_date: nextPeriod,
        updated_at: new Date(),
      },
    }).catch(() => {});

    console.log(`[Subscription] Cobrança processada com sucesso para ${subscription.id}`);
    
  } catch (error) {
    console.error(`[Subscription] Erro ao processar assinatura ${subscription.id}:`, error);
    
    // Registrar falha
    try {
      await (prisma as any).subscriptionPayment?.create({
        data: {
          subscription_id: subscription.id,
          amount: Number(subscription.plan.price),
          status: 'failed',
          billing_date: new Date(),
          failure_reason: String(error),
        },
      });
    } catch (e) {
      // Ignore if table doesn't exist
    }
  }
}

function calculateNextPeriod(startDate: Date, interval: string, intervalCount: number): Date {
  const date = new Date(startDate);
  
  switch (interval) {
    case 'week':
      date.setDate(date.getDate() * intervalCount);
      break;
    case 'month':
      date.setMonth(date.getMonth() + intervalCount);
      break;
    case 'year':
      date.setFullYear(date.getFullYear() + intervalCount);
      break;
  }
  
  return date;
}

export async function processDueSubscriptions() {
  console.log('[Subscription] Verificando assinaturas para cobrança...');
  
  try {
    // Buscar assinaturas ativas que precisam ser cobradas
    // Usa 'as any' porque a tabela pode não existir ainda
    const subscriptions = await (prisma as any).subscription?.findMany({
      where: {
        status: 'active',
        next_billing_date: {
          lte: new Date(),
        },
      },
      include: {
        plan: {
          include: {
            user: {
              select: { efi_customer_id: true },
            },
          },
        },
      },
    }) || [];

    console.log(`[Subscription] Encontradas ${subscriptions.length} assinaturas para processar`);

    // Processar cada assinatura
    for (const subscription of subscriptions as SubscriptionData[]) {
      await processSubscriptionPayment(subscription);
    }

    console.log('[Subscription] Verificação de cobranças concluída');
    
  } catch (error) {
    console.error('[Subscription] Erro ao processar cobranças:', error);
  }
}

// Função para iniciar o job (quando chamado diretamente)
export async function startSubscriptionJob() {
  console.log('[Subscription] Job de cobranças recorrentes iniciado');
  
  // Executar imediatamente
  await processDueSubscriptions();
  
  // Executar a cada intervalo
  setInterval(async () => {
    await processDueSubscriptions();
  }, CHECK_INTERVAL);
}

// Se executado diretamente (node src/jobs/subscription.job.ts)
if (require.main === module) {
  startSubscriptionJob()
    .then(() => console.log('Job de assinaturas iniciado'))
    .catch(console.error);
}

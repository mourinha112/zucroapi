import { prisma } from '../config/database';
import { createPixCharge, createCardCharge } from '../providers/efibank/efi.pix';
import { getEffectiveRates } from '../providers/efibank/fee.calculator';

/**
 * Job para processar cobranças de assinaturas recorrentes
 * Deve ser executado diariamente (ex: a cada 1 hora)
 * 
 * No PM2, configure para rodar a cada hora:
 * pm2 start src/jobs/subscription.job.ts --name subscription-job --cron "* * * * *"
 */

// Intervalo em milliseconds (1 hora)
const CHECK_INTERVAL = 60 * 60 * 1000;

interface SubscriptionWithPlan {
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
    price: number;
    max_installments: number;
    user: {
      efi_customer_id?: string;
    };
  };
}

async function processSubscriptionPayment(subscription: SubscriptionWithPlan) {
  console.log(`[Subscription] Processando cobrança para assinatura ${subscription.id}`);
  
  try {
    const now = new Date();
    const nextBilling = new Date(subscription.next_billing_date);
    
    // Verificar se já é hora de cobrar
    if (nextBilling > now) {
      console.log(`[Subscription] Assinatura ${subscription.id} ainda não venceu`);
      return;
    }

    // Criar registro de cobrança
    const subscriptionPayment = await prisma.subscriptionPayment.create({
      data: {
        subscription_id: subscription.id,
        amount: Number(subscription.plan.price),
        status: 'pending',
        billing_date: now,
      },
    });

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
        value: Number(subscription.plan.price),
        installments: subscription.plan.max_installments,
        description: `Assinatura ${subscription.plan.name}`,
      });
      
      // Atualizar status da cobrança
      await prisma.subscriptionPayment.update({
        where: { id: subscriptionPayment.id },
        data: {
          external_payment_id: chargeResult.charge_id,
          status: 'paid',
          paid_at: new Date(),
        },
      });
    }
    */

    // Calcular próximo período
    const nextPeriod = calculateNextPeriod(
      now,
      subscription.plan.interval,
      subscription.plan.interval_count
    );

    // Atualizar assinatura
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        current_period_start: now,
        current_period_end: nextPeriod,
        next_billing_date: nextPeriod,
        updated_at: new Date(),
      },
    });

    console.log(`[Subscription] Cobrança processada com sucesso para ${subscription.id}`);
    
  } catch (error) {
    console.error(`[Subscription] Erro ao processar assinatura ${subscription.id}:`, error);
    
    // Registrar falha
    await prisma.subscriptionPayment.create({
      data: {
        subscription_id: subscription.id,
        amount: Number(subscription.plan.price),
        status: 'failed',
        billing_date: new Date(),
        failure_reason: String(error),
      },
    });
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
    const subscriptions = await prisma.subscription.findMany({
      where: {
        status: 'active',
        next_billing_date: {
          lte: new Date(), // menores ou iguais a agora
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
    });

    console.log(`[Subscription] Encontradas ${subscriptions.length} assinaturas para processar`);

    // Processar cada assinatura
    for (const subscription of subscriptions as SubscriptionWithPlan[]) {
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

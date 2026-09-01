import { prisma } from '../../config/database';
import { computeSplitDistribution } from './split.service';
import { calculateReleaseDate } from '../../providers/efibank/fee.calculator';

type CreditParams = {
  payment: {
    id: string;
    user_id: string;
    value: any;
    description: string | null;
    payment_link_id: string | null;
    has_split: boolean;
    metadata: any;
  };
  providerLabel: 'asaas' | 'sharkbanking' | 'enki' | 'eusouzucropay' | 'efibank' | 'xflow' | 'uvvipay';
  feeCalc: { netValue: number; platformFee: number; reserveAmount: number };
  rates: { reserve_days: number };
  providerTransactionId?: string;
};

/**
 * Credita o pagamento de forma idempotente, respeitando splits.
 * - Atualiza net_value no payment
 * - Cria BalanceReserve do dono (reserva de segurança)
 * - Cria uma Transaction do tipo deposit para o dono (líquido - splits)
 * - Para cada split: credita o recipient, cria Transaction e marca o PaymentSplit como credited
 * - Atualiza paymentLink.total_received
 *
 * O dono sempre absorve taxa do gateway e reserva (modelo Jumpfy).
 * Os recipients recebem o valor "limpo" configurado.
 */
export async function creditPaymentOnReceive(params: CreditParams): Promise<void> {
  const { payment, providerLabel, feeCalc, rates, providerTransactionId } = params;
  const grossValue = Number(payment.value);

  // Atualiza net_value e metadata (mesma lógica que estava inline nos webhooks)
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      net_value: feeCalc.netValue,
      metadata: JSON.parse(
        JSON.stringify({
          ...(payment.metadata as any),
          platform_fee: feeCalc.platformFee,
          reserve_amount: feeCalc.reserveAmount,
          provider: providerLabel,
        }),
      ),
    },
  });

  let splitRows: Array<{
    id: string;
    recipient_id: string;
    type: string;
    amount: any;
    percent: any;
    description: string | null;
  }> = [];

  if (payment.has_split) {
    splitRows = await prisma.paymentSplit.findMany({
      where: { payment_id: payment.id, status: 'pending' },
    });
  }

  const { recipientCredits, totalSplitCents } = computeSplitDistribution({
    grossValue,
    netValue: feeCalc.netValue,
    splits: splitRows,
  });

  const netCents = Math.round(feeCalc.netValue * 100);
  const ownerCreditCents = Math.max(0, netCents - totalSplitCents);
  const ownerCredit = ownerCreditCents / 100;

  // --- Crédito para os recipients ---
  for (const split of splitRows) {
    const creditCents = recipientCredits.get(split.id) ?? 0;
    if (creditCents <= 0) {
      // Sem valor: marca como credited com 0 pra não reprocessar
      await prisma.paymentSplit.update({
        where: { id: split.id },
        data: { status: 'credited', computed_value: 0, credited_at: new Date() },
      });
      continue;
    }

    const creditValue = creditCents / 100;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: split.recipient_id },
        data: { balance: { increment: creditValue } },
      }),
      prisma.paymentSplit.update({
        where: { id: split.id },
        data: {
          status: 'credited',
          computed_value: creditValue,
          credited_at: new Date(),
        },
      }),
      prisma.transaction.create({
        data: {
          user_id: split.recipient_id,
          type: 'split_received',
          amount: creditValue,
          status: 'completed',
          description: `Split recebido - ${payment.description || 'Pagamento ZucroPay'}`,
          metadata: {
            payment_id: payment.id,
            split_id: split.id,
            provider: providerLabel,
            origin_user_id: payment.user_id,
            split_type: split.type,
          },
        },
      }),
    ]);
  }

  // --- Crédito para o dono (líquido - splits) ---
  await prisma.user.update({
    where: { id: payment.user_id },
    data: {
      balance: { increment: ownerCredit },
      reserved_balance: { increment: feeCalc.reserveAmount },
    },
  });

  await prisma.balanceReserve.create({
    data: {
      user_id: payment.user_id,
      payment_id: payment.id,
      original_amount: grossValue,
      reserve_amount: feeCalc.reserveAmount,
      status: 'held',
      release_date: calculateReleaseDate(rates.reserve_days),
      description: `Reserva 5% - ${payment.description}`,
    },
  });

  await prisma.transaction.create({
    data: {
      user_id: payment.user_id,
      type: 'deposit',
      amount: ownerCredit,
      status: 'completed',
      description: payment.has_split
        ? `PIX recebido (${providerLabel}) com split - ${payment.description}`
        : `PIX recebido (${providerLabel}) - ${payment.description}`,
      metadata: {
        payment_id: payment.id,
        billing_type: 'PIX',
        provider: providerLabel,
        gross_value: grossValue,
        platform_fee: feeCalc.platformFee,
        reserve_amount: feeCalc.reserveAmount,
        split_total: totalSplitCents / 100,
        has_split: payment.has_split,
        ...(providerTransactionId ? { provider_transaction_id: providerTransactionId } : {}),
      },
    },
  });

  if (payment.payment_link_id) {
    await prisma.paymentLink.update({
      where: { id: payment.payment_link_id },
      data: { total_received: { increment: grossValue } },
    });
  }

  console.log(
    `[CREDIT] ${providerLabel} payment=${payment.id} gross=R$${grossValue.toFixed(2)} ` +
      `net=R$${feeCalc.netValue.toFixed(2)} splits=${splitRows.length} ` +
      `splitTotal=R$${(totalSplitCents / 100).toFixed(2)} owner=R$${ownerCredit.toFixed(2)}`,
  );
}

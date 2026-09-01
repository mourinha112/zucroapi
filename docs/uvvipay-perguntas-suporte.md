# Perguntas para o suporte da UvviPay

Contexto para enviar junto: a ZucroPay é uma **plataforma de pagamentos**. Nós
recebemos as vendas dos nossos vendedores e precisamos **repassar o dinheiro a
eles automaticamente via PIX**, sem intervenção manual no painel.

A dúvida central é se conseguimos fazer isso **na conta principal** (como já
fazemos com outras adquirentes) ou se seremos obrigados a usar subcontas.

---

## 1. Saque/repasse na conta principal (a mais importante)

Existe algum endpoint de **saque, transferência ou payout PIX na conta
principal** (organização), permitindo enviar valor para uma **chave PIX de
destino informada na requisição**?

Nas outras adquirentes que usamos isso existe como `POST /transfers` com um
header de chave de saque. Na documentação pública da UvviPay só encontramos
saque no escopo de subconta (`POST /v1/submerchants/withdrawals`).

- Se existir: qual o caminho, corpo da requisição e como habilitamos?
- Se não existir: confirmam que **subcontas é o único caminho** para repasse
  automático?

## 2. Corpo do saque de subconta

A documentação não detalha os campos de `POST /v1/submerchants/withdrawals`.
Podem enviar o **schema completo do corpo** e um exemplo de request/response?

Especificamente: **é possível informar uma chave PIX de destino no pedido**, ou
o valor vai obrigatoriamente para a conta/chave cadastrada na subconta?

## 3. Regras do saque

- Valor mínimo e taxa por saque
- Prazo de liquidação (D+0? D+1?)
- Precisa de aprovação manual no painel ou é automático via API?
- Existe webhook de mudança de status do saque? Quais eventos?

## 4. Subcontas: KYC

- Podemos enviar os documentos por **URL** (já os armazenamos no nosso servidor)
  ou apenas como arquivo binário em `multipart/form-data`?
- Qual o **prazo médio de aprovação** do KYC?
- Existe **webhook de mudança de status da subconta**
  (`pending` → `kyc_approved` → `active`)? Quais os nomes dos eventos?
- Uma subconta com KYC pendente pode **receber** pagamentos, ou só após `active`?

## 5. Direcionar a venda para a subconta

Qual a **estrutura exata do objeto `subMerchant`** no `POST /v1/payments`?
Ele aceita `internalId` (UUID da subconta) ou só `documentNumber`/`documentType`?

Como fica o **split** nesse caso: conseguimos reter a nossa taxa de plataforma e
creditar o restante na subconta do vendedor na mesma transação?

## 6. Cartão de crédito

- O 3DS é **obrigatório** para `paymentMethod: credit_card` ou é opcional?
- Há exigência de tokenização (Cofre) ou podemos enviar o PAN direto na
  requisição server-to-server?
- Parcelamento: até 24x conforme a doc? Quem paga os juros (nós ou o comprador)?

## 7. Ambiente de testes

Existe **sandbox/homologação** com credenciais de teste e cartões de teste?
Qual a URL base?

---

## Dados úteis do nosso lado

- Webhook já configurado: `https://api.appzucropay.com/api/webhooks/uvvipay`
- Validamos a assinatura HMAC-SHA256 (`X-UvviPay-Signature` sobre
  `"{timestamp}.{corpo}"`) com janela de 5 minutos
- Já tratamos os eventos `transaction.*`

# Bug: XFlow PIX - "Failed to generate PIX QR code" / PIX_CREATION_FAILED

**Data:** 13/04/2026  
**Reportado por:** Seller usando XFlow via API  
**Severidade:** Alta - bloqueia geração de PIX para sellers XFlow via API

---

## Erro retornado

```json
502 Bad Gateway
{
  "error": "Failed to generate PIX QR code",
  "detail": "{\"error\":\"Falha ao processar pagamento. Tente novamente mais tarde.\",\"code\":\"PIX_CREATION_FAILED\"}"
}
```

---

## Causa raiz

O schema de validação da rota `POST /api/v1/charges` permite que `customer`, `cpf_cnpj` e `email` sejam **opcionais**. Quando o seller não envia esses campos, o payload enviado ao XFlow fica com `document.number` vazio:

```js
// integrations.routes.ts:179-181
customerName: body.customer?.name || 'Cliente',
customerEmail: body.customer?.email || '',
customerCpf: body.customer?.cpf_cnpj,  // undefined

// xflow.pix.ts:37
const cpfDigits = (data.customerCpf || '').replace(/\D/g, ''); // ''

// xflow.pix.ts:56-59 — payload enviado ao XFlow
document: {
  number: '',    // VAZIO → XFlow rejeita
  type: 'CPF',
}
```

A API do XFlow **exige CPF/CNPJ válido** para criar transação PIX. O campo `document` é enviado sempre, mesmo quando está vazio, causando a rejeição.

---

## Arquivos envolvidos

| Arquivo | Linhas | O que faz |
|---------|--------|-----------|
| `src/modules/integrations/integrations.routes.ts` | 24-38 | Schema de validação (`createChargeSchema`) |
| `src/modules/integrations/integrations.routes.ts` | 176-184 | Montagem do `chargePayload` |
| `src/modules/integrations/integrations.routes.ts` | 186-201 | Chamada ao XFlow e tratamento de erro |
| `src/providers/xflow/xflow.pix.ts` | 36-61 | Montagem do payload para API do XFlow |
| `src/providers/xflow/xflow.client.ts` | 27-61 | Client HTTP do XFlow (throw em erro de rede) |
| `src/modules/payments/payments.routes.ts` | ~345-390 | Checkout route (mesmo problema existe aqui) |

---

## Opcoes de fix

### Opcao 1: Nao enviar `document` se CPF estiver vazio (fix no provider)

**Arquivo:** `src/providers/xflow/xflow.pix.ts` linhas 52-60

```ts
// ANTES
customer: {
  name: data.customerName,
  email: data.customerEmail,
  ...(phoneDigits ? { phone: phoneDigits } : {}),
  document: {
    number: cpfDigits,
    type: cpfDigits.length > 11 ? 'CNPJ' : 'CPF',
  },
},

// DEPOIS
customer: {
  name: data.customerName,
  email: data.customerEmail,
  ...(phoneDigits ? { phone: phoneDigits } : {}),
  ...(cpfDigits
    ? {
        document: {
          number: cpfDigits,
          type: cpfDigits.length > 11 ? 'CNPJ' : 'CPF',
        },
      }
    : {}),
},
```

**Pros:** Fix simples, nao quebra quem ja envia CPF  
**Contras:** Se o XFlow exigir document obrigatoriamente, vai falhar com outro erro generico  

---

### Opcao 2: Tornar `cpf_cnpj` obrigatorio quando provider e XFlow (validacao na rota)

**Arquivo:** `src/modules/integrations/integrations.routes.ts` linhas 172-184

```ts
// Adicionar antes de montar chargePayload
if (sellerProvider === 'xflow') {
  if (!body.customer?.cpf_cnpj) {
    return reply.status(422).send({
      error: 'O campo customer.cpf_cnpj é obrigatório para pagamentos PIX nesta conta.',
      code: 'MISSING_CUSTOMER_DOCUMENT',
    });
  }
  if (!body.customer?.email) {
    return reply.status(422).send({
      error: 'O campo customer.email é obrigatório para pagamentos PIX nesta conta.',
      code: 'MISSING_CUSTOMER_EMAIL',
    });
  }
}
```

**Pros:** Erro claro e especifico pro integrador, evita chamada desnecessaria ao XFlow  
**Contras:** Validacao acoplada ao provider dentro da rota, pode precisar replicar em outras rotas (checkout)  

---

### Opcao 3: Validacao dentro do provider XFlow (retornar erro antes de chamar a API)

**Arquivo:** `src/providers/xflow/xflow.pix.ts` no inicio da funcao `createXflowPixCharge`

```ts
export const createXflowPixCharge = async (
  data: XflowPixChargeData,
): Promise<XflowPixChargeResult> => {
  const cpfDigits = (data.customerCpf || '').replace(/\D/g, '');

  // Validacoes obrigatorias do XFlow
  if (!cpfDigits) {
    return {
      success: false,
      error: 'CPF/CNPJ do cliente é obrigatório para cobranças via XFlow.',
    };
  }
  if (!data.customerEmail) {
    return {
      success: false,
      error: 'Email do cliente é obrigatório para cobranças via XFlow.',
    };
  }

  // ... resto da funcao
```

**Pros:** Validacao encapsulada no provider, qualquer rota que chamar XFlow ja recebe o erro correto  
**Contras:** Retorna como `chargeRes.error` generico, caller precisa tratar  

---

### Opcao 4: Tornar campos obrigatorios no schema global da API

**Arquivo:** `src/modules/integrations/integrations.routes.ts` linhas 24-38

```ts
// ANTES
customer: z.object({
  name: z.string(),
  email: z.string().email().optional(),
  cpf_cnpj: z.string().optional(),
  phone: z.string().optional(),
}).optional(),

// DEPOIS
customer: z.object({
  name: z.string(),
  email: z.string().email(),           // obrigatorio
  cpf_cnpj: z.string().min(11),        // obrigatorio
  phone: z.string().optional(),
}),                                     // obrigatorio
```

**Pros:** Resolve de vez pra todos os providers, dados do customer sempre completos  
**Contras:** Breaking change na API — integradores que nao enviam customer/cpf vao quebrar (inclusive os que usam providers que nao exigem CPF)  

---

### Opcao 5: Combinar opcao 3 + opcao 1 (recomendada)

Validar dentro do provider XFlow **e** nao enviar `document` vazio como fallback:

1. Em `xflow.pix.ts`: adicionar validacao de CPF/email no inicio (opcao 3)
2. Em `xflow.pix.ts`: condicionar envio de `document` ao cpfDigits existir (opcao 1)
3. Em `integrations.routes.ts` e `payments.routes.ts`: melhorar mensagem de erro para XFlow

```ts
// xflow.pix.ts — validacao + payload seguro
if (!cpfDigits) {
  return { success: false, error: 'CPF/CNPJ do cliente é obrigatório para cobranças via XFlow.' };
}

// payload com document condicional (defesa extra)
customer: {
  name: data.customerName,
  email: data.customerEmail || 'noreply@zucropay.com',
  ...(phoneDigits ? { phone: phoneDigits } : {}),
  ...(cpfDigits ? { document: { number: cpfDigits, type: cpfDigits.length > 11 ? 'CNPJ' : 'CPF' } } : {}),
},
```

**Pros:** Dupla protecao, erro claro, funciona em todas as rotas que usam XFlow  
**Contras:** Nenhum significativo  

---

### Opcao 6: Fix no client para nao fazer throw em erro de rede (problema secundario do 502)

**Arquivo:** `src/providers/xflow/xflow.client.ts` linha 57-60

```ts
// ANTES
} catch (error: any) {
  console.error('[XFLOW] Request Error:', error.message);
  throw error;  // causa 502 se nao tratado na rota
}

// DEPOIS
} catch (error: any) {
  console.error('[XFLOW] Request Error:', error.message);
  return {
    success: false,
    status: 0,
    data: { message: `Erro de conexão com XFlow: ${error.message}` },
  };
}
```

**Pros:** Elimina o 502, erro de rede vira resposta tratada  
**Contras:** Pode mascarar problemas de infra (timeout, DNS, etc)  

---

## Recomendacao final

Aplicar **opcao 5 + opcao 6** juntas:

1. Validacao de campos obrigatorios dentro do provider XFlow (nao envia request invalido)
2. Payload seguro com `document` condicional (defesa em profundidade)
3. Client XFlow nao faz throw (elimina 502 por erro de rede)
4. Aplicar o mesmo fix na rota de checkout (`payments.routes.ts`) que tem o mesmo fluxo

Isso cobre tanto o cenario de dados faltando quanto o cenario de falha de rede, sem breaking change na API publica.

---

## Como testar

```bash
# Sem CPF — deve retornar erro claro
curl -X POST https://api.zucropay.com/api/v1/charges \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "billing_type": "PIX",
    "value": 10.00,
    "customer": { "name": "Teste" }
  }'
# Esperado: 400 com "CPF/CNPJ do cliente é obrigatório para cobranças via XFlow"

# Com CPF — deve funcionar
curl -X POST https://api.zucropay.com/api/v1/charges \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "billing_type": "PIX",
    "value": 10.00,
    "customer": {
      "name": "Teste",
      "email": "teste@email.com",
      "cpf_cnpj": "12345678901"
    }
  }'
# Esperado: 200 com pixCode e pixQrCode
```

# ZucroPay API - Backend

Sistema de pagamentos completo com integração EfiBank (Gerencianet), suporte a PIX, Cartão de Crédito e Boleto.

## 🚀 Tecnologias

| Tecnologia | Versão | Descrição |
|------------|--------|-----------|
| **Node.js** | 18+ | Runtime JavaScript |
| **TypeScript** | 5.x | Tipagem estática |
| **Fastify** | 4.x | Framework web de alta performance |
| **Prisma** | 5.x | ORM para PostgreSQL |
| **PostgreSQL** | 14+ | Banco de dados relacional |
| **Redis** | 6.x | Cache e rate limiting |
| **BullMQ** | 4.x | Filas de processamento assíncrono |
| **EfiBank SDK** | - | Integração PIX, Cartão e Boleto |

---

## 📁 Estrutura do Projeto

```
zucropay-api/
├── prisma/
│   ├── schema.prisma          # Modelos do banco de dados
│   └── migrations/            # Migrações SQL
├── src/
│   ├── app.ts                 # Entry point da aplicação
│   ├── config/
│   │   └── env.ts             # Variáveis de ambiente
│   ├── modules/
│   │   ├── admin/
│   │   │   └── admin.routes.ts    # Rotas do painel admin
│   │   ├── auth/
│   │   │   ├── auth.routes.ts     # Rotas de autenticação
│   │   │   └── auth.service.ts    # Serviços de auth
│   │   ├── payments/
│   │   │   └── payments.routes.ts # Rotas de pagamentos
│   │   ├── integrations/
│   │   │   └── integrations.routes.ts # API para integrações externas
│   │   ├── webhooks/
│   │   │   └── webhooks.routes.ts # Webhooks EfiBank
│   │   ├── products/
│   │   │   └── products.routes.ts # CRUD de produtos
│   │   └── users/
│   │       └── users.routes.ts    # Gestão de usuários
│   ├── providers/
│   │   └── efibank/
│   │       ├── efi.client.ts      # Cliente HTTP para EfiBank
│   │       ├── efi.pix.ts         # Funções PIX (cobrar/enviar)
│   │       ├── efi.card.ts        # Funções Cartão de Crédito
│   │       └── fee.calculator.ts  # Cálculo de taxas
│   ├── queues/
│   │   └── webhook.queue.ts       # Processamento de webhooks
│   └── middlewares/
│       └── auth.middleware.ts     # Autenticação JWT
├── .env                       # Variáveis de ambiente
├── ecosystem.config.js        # Configuração PM2
└── package.json
```

---

## 🗄️ Modelos do Banco de Dados

### Principais Tabelas

| Tabela | Descrição |
|--------|-----------|
| `users` | Usuários da plataforma (vendedores) |
| `admin_credentials` | Administradores e gerentes |
| `payments` | Transações de pagamento |
| `withdrawals` | Solicitações de saque |
| `products` | Produtos para venda |
| `api_keys` | Chaves de API para integrações |
| `user_custom_rates` | Taxas personalizadas por usuário |
| `platform_settings` | Configurações globais (taxas padrão) |
| `user_verifications` | Verificação de identidade |
| `admin_logs` | Logs de ações administrativas |
| `push_subscriptions` | Assinaturas de notificações push |

---

## 🔌 API Endpoints

### Autenticação (`/api/auth`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/login` | Login de usuário |
| POST | `/register` | Registro de novo usuário |
| POST | `/admin/login` | Login de admin/gerente |
| POST | `/forgot-password` | Recuperação de senha |
| POST | `/reset-password` | Reset de senha |

### Pagamentos (`/api/payments`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/checkout` | Criar checkout (PIX/Cartão/Boleto) |
| GET | `/checkout/:id` | Consultar status do checkout |
| POST | `/withdraw` | Solicitar saque |
| GET | `/history` | Histórico de transações |

### Integrações (`/api/v1`) - Via API Key

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/charges` | Criar cobrança PIX |
| GET | `/charges/:id` | Consultar cobrança |
| GET | `/balance` | Consultar saldo |

### Admin (`/api/admin`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/stats` | Estatísticas do dashboard |
| GET | `/users` | Listar usuários |
| GET | `/users/:id` | Detalhes do usuário |
| POST | `/users/:id/approve` | Aprovar usuário |
| POST | `/users/:id/reject` | Rejeitar usuário |
| POST | `/users/:id/block` | Bloquear usuário |
| POST | `/users/:id/rates` | Definir taxas customizadas |
| GET | `/users/:id/custom-rates` | Ver taxas do usuário |
| GET | `/withdrawals` | Listar saques |
| POST | `/withdrawals/:id/status` | Aprovar/Rejeitar/Completar saque |
| GET | `/verifications` | Listar verificações pendentes |
| POST | `/verifications/:id/approve` | Aprovar verificação |
| POST | `/verifications/:id/reject` | Rejeitar verificação |
| GET | `/sales` | Listar vendas |
| GET | `/transactions` | Listar transações |
| GET | `/products` | Listar produtos |
| GET | `/managers` | Listar gerentes |
| POST | `/managers` | Criar gerente |
| DELETE | `/managers/:id` | Remover gerente |
| GET | `/platform-rates` | Ver taxas globais |
| PUT | `/platform-rates` | Atualizar taxas globais |

### Webhooks (`/api/webhooks`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/efi/pix` | Webhook PIX da EfiBank |
| POST | `/efi/card` | Webhook Cartão da EfiBank |

---

## 💰 Sistema de Taxas

### Taxas Globais (Padrão)

Configuráveis via Admin Panel em `platform_settings`:

| Taxa | Valor Padrão | Descrição |
|------|--------------|-----------|
| `pix_rate` | 5.99% | Taxa PIX |
| `card_rate` | 5.99% | Taxa Cartão base |
| `boleto_rate` | 5.99% | Taxa Boleto |
| `fixed_fee` | R$ 2,50 | Taxa fixa por transação |
| `installment_fee` | 2.49% | Taxa por parcela (cartão) |
| `withdrawal_fee` | R$ 2,00 | Taxa de saque |
| `reserve_percent` | 5% | Reserva de segurança |
| `reserve_days` | 30 | Dias para liberar reserva |

### Taxas Personalizadas

Cada usuário pode ter taxas customizadas em `user_custom_rates`.

### Cálculo de Taxas

```typescript
// PIX - Vendedor paga
valor_liquido = valor_bruto - (valor_bruto * pix_rate / 100) - fixed_fee

// Cartão - Vendedor paga (com parcelas)
taxa_total = card_rate + (parcelas - 1) * installment_fee
valor_liquido = valor_bruto - (valor_bruto * taxa_total / 100) - fixed_fee

// Cartão - Comprador paga juros
// Vendedor recebe: valor_bruto - (valor_bruto * card_rate / 100) - fixed_fee
// Comprador paga: valor_bruto + juros das parcelas
```

---

## 🔐 Autenticação

### JWT Token

- **Usuários**: Token com `type: 'user'`
- **Admins**: Token com `type: 'admin'`, `role: 'admin' | 'gerente'`

### API Keys

Para integrações externas via header `X-API-Key`:

```bash
curl -X POST https://api.appzucropay.com/api/v1/charges \
  -H "X-API-Key: zp_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"value": 100, "description": "Produto"}'
```

---

## 📤 PIX - Envio (Saques)

### Fluxo de Saque Automático

1. Usuário solicita saque → Status: `pending`
2. Admin aprova → Sistema envia PIX automaticamente via EfiBank
3. PIX enviado com sucesso → Status: `completed`
4. Se erro → Retorna erro, status permanece `pending`

### Endpoint EfiBank para Envio

```
PUT /v2/gn/pix/:idEnvio
```

Payload:
```json
{
  "valor": "100.00",
  "pagador": {
    "chave": "chave_pix_da_plataforma",
    "infoPagador": "Saque ZucroPay"
  },
  "favorecido": {
    "chave": "chave_pix_do_usuario"
  }
}
```

---

## 🔄 Redis

Usado para:

1. **Rate Limiting** - Limitar requisições por IP/usuário
2. **Cache** - Cache de taxas da plataforma
3. **BullMQ** - Filas de processamento de webhooks

### Comandos Úteis

```bash
# Limpar rate limits
redis-cli FLUSHALL

# Ver chaves
redis-cli KEYS "*"

# Monitorar em tempo real
redis-cli MONITOR
```

---

## 🚀 Deploy

### Requisitos

- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- PM2 (gerenciador de processos)
- Nginx (proxy reverso)
- Certificado SSL (Let's Encrypt)

### Variáveis de Ambiente (.env)

```env
PORT=3000
NODE_ENV=production

# PostgreSQL
DATABASE_URL="postgresql://user:password@localhost:5432/zucropay"

# JWT
JWT_SECRET=your_jwt_secret_here
JWT_EXPIRES_IN=7d

# Redis
REDIS_URL=redis://localhost:6379

# EfiBank
EFI_CLIENT_ID=your_client_id
EFI_CLIENT_SECRET=your_client_secret
EFI_PIX_KEY=your_pix_key
EFI_CERTIFICATE_BASE64=base64_encoded_certificate
EFI_SANDBOX=false

# VAPID (Push Notifications)
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
VAPID_EMAIL=contato@zucropay.com

# Frontend URL
FRONTEND_URL=https://appzucropay.com
```

### Comandos de Deploy

```bash
# Instalar dependências
npm install

# Gerar Prisma Client
npx prisma generate

# Aplicar migrações
npx prisma db push

# Build
npm run build

# Iniciar com PM2
pm2 start ecosystem.config.js

# Ver logs
pm2 logs zucropay-api

# Reiniciar
pm2 restart zucropay-api
```

### Nginx Config

```nginx
server {
    listen 443 ssl http2;
    server_name api.appzucropay.com;

    ssl_certificate /etc/letsencrypt/live/api.appzucropay.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.appzucropay.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 📊 Logs e Monitoramento

```bash
# Logs em tempo real
pm2 logs zucropay-api

# Apenas erros
pm2 logs zucropay-api --err

# Últimas N linhas
pm2 logs zucropay-api --lines 100

# Status
pm2 status

# Monitoramento
pm2 monit
```

---

## 🛠️ Troubleshooting

### Rate Limit (429)

```bash
redis-cli FLUSHALL
pm2 restart zucropay-api
```

### Erro de Conexão PostgreSQL

```bash
# Verificar status
sudo systemctl status postgresql

# Reiniciar
sudo systemctl restart postgresql
```

### Erro de PIX/EfiBank

1. Verificar certificado no `.env`
2. Verificar se chave PIX está correta
3. Ver logs: `pm2 logs zucropay-api --lines 50`

---

## 📝 Changelog Recente

### v2.0.0 (Janeiro 2026)

- ✅ Sistema de taxas globais configuráveis pelo Admin
- ✅ Taxas personalizadas por usuário
- ✅ Saque automático via PIX (endpoint `/v2/gn/pix/:idEnvio`)
- ✅ Botões de Aprovar/Rejeitar/Completar saques no Admin
- ✅ Sistema de gerentes (sub-admins)
- ✅ Redesign das páginas Login/Register
- ✅ Dashboard Admin com tema roxo ZucroPay
- ✅ Integração completa com API v1 para desenvolvedores

---

## 📄 Licença

Proprietário - ZucroPay © 2026

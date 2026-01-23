# ZucroPay API

Backend da plataforma de pagamentos ZucroPay.

## Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Fastify
- **Linguagem:** TypeScript
- **Banco de Dados:** PostgreSQL 16
- **Cache/Filas:** Redis + BullMQ
- **ORM:** Prisma
- **Autenticação:** JWT

## Estrutura do Projeto

```
src/
├── app.ts                 # Entry point
├── config/
│   ├── database.ts        # Prisma client
│   ├── env.ts             # Environment variables
│   └── redis.ts           # Redis connection
├── modules/
│   ├── auth/              # Login, registro, JWT
│   ├── users/             # Perfil, saldo, dashboard
│   ├── products/          # CRUD de produtos
│   ├── payments/          # Pagamentos, checkout, links
│   ├── webhooks/          # Webhooks EfiBank
│   ├── withdrawals/       # Saques
│   ├── admin/             # Painel administrativo
│   └── integrations/      # API pública (API Keys)
├── providers/
│   └── efibank/           # Integração EfiBank
│       ├── efi.client.ts  # HTTP client mTLS
│       ├── efi.pix.ts     # PIX
│       ├── efi.card.ts    # Cartão/Boleto
│       └── fee.calculator.ts # Cálculo de taxas
└── queues/
    └── webhook.queue.ts   # Processamento assíncrono
```

## Setup Local

```bash
# 1. Clonar repositório
git clone <repo-url>
cd zucropay-api

# 2. Instalar dependências
npm install

# 3. Configurar ambiente
cp env.example.txt .env
# Editar .env com suas credenciais

# 4. Gerar Prisma Client
npm run db:generate

# 5. Rodar migrations (se necessário)
npm run db:migrate

# 6. Iniciar em desenvolvimento
npm run dev
```

## Deploy na VPS

### Opção 1: Com Docker

```bash
# Na VPS
cd /home/zucropay
git clone <repo-url> zucropay-api
cd zucropay-api

# Configurar .env
cp env.example.txt .env
nano .env

# Deploy
chmod +x deploy.sh
sudo ./deploy.sh
```

### Opção 2: Com PM2 (sem Docker)

```bash
# Instalar dependências globais
npm install -g pm2

# Clone e setup
cd /home/zucropay
git clone <repo-url> zucropay-api
cd zucropay-api

# Configurar .env
cp env.example.txt .env
nano .env

# Deploy
chmod +x deploy-pm2.sh
./deploy-pm2.sh

# Configurar Nginx
sudo cp nginx/nginx-pm2.conf /etc/nginx/sites-available/zucropay-api
sudo ln -s /etc/nginx/sites-available/zucropay-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL
sudo certbot --nginx -d api.appzucropay.com
```

## API Endpoints

### Autenticação
- `POST /api/auth/login` - Login usuário
- `POST /api/auth/admin/login` - Login admin
- `POST /api/auth/register` - Registro
- `GET /api/auth/me` - Usuário atual
- `POST /api/auth/refresh` - Renovar token

### Usuários
- `GET /api/users/profile` - Perfil
- `PUT /api/users/profile` - Atualizar perfil
- `GET /api/users/balance` - Saldo
- `GET /api/users/dashboard` - Dashboard

### Produtos
- `GET /api/products` - Listar
- `POST /api/products` - Criar
- `GET /api/products/:id` - Detalhes
- `PUT /api/products/:id` - Atualizar
- `DELETE /api/products/:id` - Deletar

### Pagamentos
- `GET /api/payments` - Listar pagamentos
- `GET /api/payments/:id` - Detalhes
- `GET /api/payments/links` - Listar links
- `POST /api/payments/links` - Criar link
- `POST /api/payments/checkout` - Checkout público
- `GET /api/payments/checkout/:linkId` - Dados do link

### Saques
- `GET /api/withdrawals` - Listar
- `POST /api/withdrawals` - Solicitar saque
- `GET /api/withdrawals/:id` - Detalhes

### Webhooks
- `POST /api/webhooks/efi` - Webhook EfiBank (PIX)
- `POST /api/webhooks/efi/cobranca` - Webhook cobranças
- `GET /api/webhooks` - Listar webhooks do usuário
- `POST /api/webhooks` - Criar webhook
- `DELETE /api/webhooks/:id` - Deletar

### Admin
- `GET /api/admin/dashboard` - Estatísticas
- `GET /api/admin/users` - Listar usuários
- `POST /api/admin/users/:id/approve` - Aprovar usuário
- `POST /api/admin/users/:id/reject` - Rejeitar usuário
- `GET /api/admin/withdrawals` - Listar saques
- `POST /api/admin/withdrawals/:id/approve` - Aprovar saque
- `POST /api/admin/withdrawals/:id/reject` - Rejeitar saque
- `POST /api/admin/users/:id/rates` - Definir taxas

### API Pública (Integradores)
- `GET /api/v1` - Documentação
- `POST /api/v1/charges` - Criar cobrança
- `GET /api/v1/charges` - Listar cobranças
- `GET /api/v1/charges/:id` - Detalhes da cobrança
- `GET /api/v1/balance` - Saldo
- `POST /api/v1/keys` - Gerar API Key
- `GET /api/v1/keys` - Listar API Keys
- `DELETE /api/v1/keys/:id` - Revogar API Key

## Autenticação de Integradores

Integradores externos usam API Keys:

```bash
# 1. Gerar API Key (no dashboard ou via API autenticada)
POST /api/v1/keys
Authorization: Bearer <jwt_token>

# Resposta (chave mostrada apenas uma vez!)
{
  "id": "...",
  "key": "zp_a8f3d2e1c4b5...",
  "warning": "Guarde esta chave..."
}

# 2. Usar API Key nas requisições
POST /api/v1/charges
X-Api-Key: zp_a8f3d2e1c4b5...

# Ou
Authorization: Bearer zp_a8f3d2e1c4b5...
```

## Exemplo: Criar Cobrança PIX

```bash
curl -X POST https://api.appzucropay.com/api/v1/charges \
  -H "X-Api-Key: zp_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "billing_type": "PIX",
    "value": 99.90,
    "description": "Produto XYZ",
    "customer": {
      "name": "João Silva",
      "cpf_cnpj": "12345678901"
    }
  }'
```

Resposta:
```json
{
  "id": "payment_123",
  "object": "charge",
  "billing_type": "PIX",
  "status": "PENDING",
  "value": 99.90,
  "net_value": 91.45,
  "platform_fee": 8.45,
  "pix": {
    "txid": "abc123...",
    "qr_code": "data:image/png;base64,...",
    "copy_paste": "00020126..."
  }
}
```

## Scripts

```bash
npm run dev          # Desenvolvimento
npm run build        # Build produção
npm run start        # Iniciar produção
npm run db:generate  # Gerar Prisma Client
npm run db:migrate   # Rodar migrations
npm run db:push      # Push schema (dev)
npm run db:studio    # Prisma Studio
```

## Variáveis de Ambiente

Ver `env.example.txt` para lista completa.

## Licença

Proprietário - ZucroPay

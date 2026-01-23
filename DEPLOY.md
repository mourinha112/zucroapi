# Deploy do ZucroPay Backend no VPS

## Pré-requisitos no VPS
- Ubuntu 20.04+ ou Debian 11+
- PostgreSQL instalado e configurado
- Redis instalado

---

## PASSO 1: Preparar o VPS

### 1.1 Conectar via SSH
```bash
ssh usuario@SEU_IP_DO_VPS
```

### 1.2 Atualizar o sistema
```bash
sudo apt update && sudo apt upgrade -y
```

### 1.3 Instalar Node.js 20 LTS
```bash
# Instalar via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar versão
node -v  # deve mostrar v20.x.x
npm -v
```

### 1.4 Instalar PM2 (Gerenciador de Processos)
```bash
sudo npm install -g pm2
```

### 1.5 Instalar Git
```bash
sudo apt install -y git
```

---

## PASSO 2: Configurar Repositório Git

### 2.1 No seu PC Windows - Criar repositório no GitHub

1. Acesse https://github.com/new
2. Crie um repositório privado chamado `zucropay-api`
3. No terminal do VS Code (na pasta zucropay-api):

```bash
# Inicializar Git (se ainda não fez)
git init

# Adicionar todos os arquivos
git add .

# Fazer primeiro commit
git commit -m "Initial commit - ZucroPay API"

# Adicionar remote (substitua SEU_USUARIO)
git remote add origin https://github.com/SEU_USUARIO/zucropay-api.git

# Enviar para GitHub
git branch -M main
git push -u origin main
```

### 2.2 No VPS - Clonar o repositório

```bash
# Criar pasta para aplicações
sudo mkdir -p /var/www
cd /var/www

# Clonar repositório (substitua SEU_USUARIO)
sudo git clone https://github.com/SEU_USUARIO/zucropay-api.git

# Dar permissão para seu usuário
sudo chown -R $USER:$USER /var/www/zucropay-api

# Entrar na pasta
cd zucropay-api
```

---

## PASSO 3: Configurar Variáveis de Ambiente

### 3.1 Criar arquivo .env
```bash
cd /var/www/zucropay-api
nano .env
```

### 3.2 Colar o conteúdo (EDITE COM SEUS VALORES):
```env
# Servidor
PORT=3000
NODE_ENV=production

# Banco de Dados PostgreSQL (mesmo VPS = localhost)
DATABASE_URL="postgresql://zucropay_user:SUA_SENHA_DO_POSTGRES@localhost:5432/zucropay?schema=public"

# JWT - GERE UMA CHAVE ÚNICA!
# Execute: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=COLE_A_CHAVE_GERADA_AQUI
JWT_EXPIRES_IN=7d

# Redis (mesmo VPS = localhost)
REDIS_URL=redis://localhost:6379

# Gateway EFI (configure depois se necessário)
EFI_CLIENT_ID=
EFI_CLIENT_SECRET=
EFI_PIX_KEY=
EFI_CERTIFICATE_BASE64=
EFI_SANDBOX=true

# VAPID (gere com: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=mailto:seu@email.com

# Frontend URL (domínio da Vercel)
FRONTEND_URL=https://zucropay.vercel.app
```

Salvar: `Ctrl+O`, Enter, `Ctrl+X`

---

## PASSO 4: Instalar Dependências e Build

```bash
cd /var/www/zucropay-api

# Instalar dependências
npm install

# Gerar cliente Prisma
npx prisma generate

# Sincronizar banco de dados
npx prisma db push

# Fazer build do TypeScript
npm run build
```

---

## PASSO 5: Criar Pasta de Uploads

```bash
mkdir -p /var/www/zucropay-api/uploads/verifications
chmod 755 /var/www/zucropay-api/uploads
```

---

## PASSO 6: Iniciar com PM2

### 6.1 Criar arquivo de configuração PM2
```bash
nano /var/www/zucropay-api/ecosystem.config.js
```

Cole:
```javascript
module.exports = {
  apps: [{
    name: 'zucropay-api',
    script: 'dist/app.js',
    cwd: '/var/www/zucropay-api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/www/zucropay-api/logs/error.log',
    out_file: '/var/www/zucropay-api/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
```

### 6.2 Criar pasta de logs
```bash
mkdir -p /var/www/zucropay-api/logs
```

### 6.3 Iniciar aplicação
```bash
cd /var/www/zucropay-api
pm2 start ecosystem.config.js

# Verificar status
pm2 status

# Ver logs em tempo real
pm2 logs zucropay-api
```

### 6.4 Configurar PM2 para iniciar no boot
```bash
pm2 startup
# Copie e execute o comando que aparecer

pm2 save
```

---

## PASSO 7: Configurar Nginx (Proxy Reverso)

### 7.1 Instalar Nginx
```bash
sudo apt install -y nginx
```

### 7.2 Criar configuração
```bash
sudo nano /etc/nginx/sites-available/zucropay-api
```

Cole (substitua SEU_DOMINIO ou use o IP):
```nginx
server {
    listen 80;
    server_name api.seudominio.com;  # ou o IP do VPS

    # Tamanho máximo de upload (10MB)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # Servir arquivos de upload estáticos
    location /uploads/ {
        alias /var/www/zucropay-api/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 7.3 Ativar o site
```bash
sudo ln -s /etc/nginx/sites-available/zucropay-api /etc/nginx/sites-enabled/

# Testar configuração
sudo nginx -t

# Reiniciar Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
```

---

## PASSO 8: Configurar Firewall

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

---

## PASSO 9: SSL com Let's Encrypt (OPCIONAL mas recomendado)

```bash
# Instalar Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obter certificado (substitua o domínio)
sudo certbot --nginx -d api.seudominio.com

# Renovação automática
sudo systemctl enable certbot.timer
```

---

## PASSO 10: Atualizar o Frontend (Vercel)

No seu projeto frontend (zucropay), edite o arquivo de configuração da API:

```typescript
// src/config/config.ts ou onde estiver a URL da API
const API_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api.seudominio.com'  // ou http://SEU_IP_VPS
  : 'http://localhost:3000';
```

---

## Comandos Úteis

### PM2
```bash
pm2 status              # Ver status
pm2 logs zucropay-api   # Ver logs
pm2 restart zucropay-api # Reiniciar
pm2 stop zucropay-api   # Parar
pm2 delete zucropay-api # Remover
```

### Atualizar código (quando fizer push)
```bash
cd /var/www/zucropay-api
git pull origin main
npm install
npm run build
npx prisma generate
pm2 restart zucropay-api
```

### Ver logs de erro
```bash
tail -f /var/www/zucropay-api/logs/error.log
```

### Verificar se Redis está rodando
```bash
redis-cli ping  # deve retornar PONG
```

### Verificar PostgreSQL
```bash
sudo systemctl status postgresql
```

---

## Estrutura Final no VPS

```
/var/www/zucropay-api/
├── dist/                 # Código compilado
├── node_modules/         # Dependências
├── prisma/               # Schema do banco
├── uploads/              # Arquivos enviados
│   └── verifications/    # Documentos KYC
├── logs/                 # Logs PM2
├── .env                  # Variáveis de ambiente
├── ecosystem.config.js   # Config PM2
└── package.json
```

---

## Checklist Final

- [ ] Node.js 20 instalado
- [ ] PM2 instalado
- [ ] Git instalado
- [ ] Repositório clonado
- [ ] .env configurado
- [ ] npm install executado
- [ ] prisma generate executado
- [ ] prisma db push executado
- [ ] npm run build executado
- [ ] PM2 iniciado e salvo
- [ ] Nginx configurado
- [ ] Firewall configurado
- [ ] Frontend atualizado com URL do backend

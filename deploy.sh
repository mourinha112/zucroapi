#!/bin/bash
# Script de Deploy - ZucroPay API
# Executar na VPS como: chmod +x deploy.sh && ./deploy.sh

set -e

echo "=========================================="
echo "  ZucroPay API - Deploy Script"
echo "=========================================="

# Cores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Verificar se está rodando como root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Execute como root: sudo ./deploy.sh${NC}"
  exit 1
fi

# Diretório do projeto
PROJECT_DIR="/home/zucropay/zucropay-api"
DOMAIN="api.appzucropay.com"

echo -e "${YELLOW}[1/8] Atualizando sistema...${NC}"
apt update && apt upgrade -y

echo -e "${YELLOW}[2/8] Instalando Docker...${NC}"
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  rm get-docker.sh
  usermod -aG docker zucropay
fi

echo -e "${YELLOW}[3/8] Instalando Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null; then
  apt install -y docker-compose-plugin
fi

echo -e "${YELLOW}[4/8] Instalando Certbot...${NC}"
apt install -y certbot

echo -e "${YELLOW}[5/8] Configurando diretórios...${NC}"
mkdir -p $PROJECT_DIR/nginx/ssl
mkdir -p $PROJECT_DIR/nginx/certbot
chown -R zucropay:zucropay $PROJECT_DIR

echo -e "${YELLOW}[6/8] Verificando .env...${NC}"
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo -e "${RED}Arquivo .env não encontrado!${NC}"
  echo "Crie o arquivo $PROJECT_DIR/.env com as variáveis de ambiente"
  exit 1
fi

echo -e "${YELLOW}[7/8] Obtendo certificado SSL...${NC}"
# Primeiro, iniciar nginx sem SSL para obter o certificado
if [ ! -f "$PROJECT_DIR/nginx/ssl/fullchain.pem" ]; then
  echo "Iniciando nginx para validação do certificado..."
  
  # Usar config inicial sem SSL
  cp $PROJECT_DIR/nginx/nginx-initial.conf $PROJECT_DIR/nginx/nginx.conf.bak
  cp $PROJECT_DIR/nginx/nginx-initial.conf $PROJECT_DIR/nginx/nginx.conf
  
  # Iniciar apenas nginx e api
  cd $PROJECT_DIR
  docker compose up -d api redis
  sleep 5
  
  # Parar nginx do docker para liberar porta 80
  docker compose stop nginx 2>/dev/null || true
  
  # Obter certificado
  certbot certonly --standalone -d $DOMAIN --non-interactive --agree-tos --email admin@appzucropay.com
  
  # Copiar certificados
  cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem $PROJECT_DIR/nginx/ssl/
  cp /etc/letsencrypt/live/$DOMAIN/privkey.pem $PROJECT_DIR/nginx/ssl/
  
  # Restaurar config com SSL
  mv $PROJECT_DIR/nginx/nginx.conf.bak $PROJECT_DIR/nginx/nginx.conf
  
  echo -e "${GREEN}Certificado SSL obtido com sucesso!${NC}"
fi

echo -e "${YELLOW}[8/8] Iniciando containers...${NC}"
cd $PROJECT_DIR

# Pull das imagens
docker compose pull

# Build da API
docker compose build api

# Rodar migrations do Prisma
docker compose run --rm api npx prisma migrate deploy

# Iniciar todos os serviços
docker compose up -d

# Aguardar
sleep 10

# Verificar status
echo ""
echo -e "${GREEN}=========================================="
echo "  Deploy concluído!"
echo "==========================================${NC}"
echo ""
docker compose ps
echo ""
echo -e "${GREEN}API disponível em: https://$DOMAIN${NC}"
echo ""

# Configurar renovação automática do certificado
echo "0 0 1 * * certbot renew --quiet && cp /etc/letsencrypt/live/$DOMAIN/*.pem $PROJECT_DIR/nginx/ssl/ && docker compose restart nginx" | crontab -

echo -e "${YELLOW}Renovação automática do certificado configurada (mensal)${NC}"

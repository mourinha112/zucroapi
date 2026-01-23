#!/bin/bash
# Deploy com PM2 (sem Docker)
# Executar: chmod +x deploy-pm2.sh && ./deploy-pm2.sh

set -e

echo "=========================================="
echo "  ZucroPay API - Deploy com PM2"
echo "=========================================="

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="/home/zucropay/zucropay-api"
DOMAIN="api.appzucropay.com"

echo -e "${YELLOW}[1/7] Atualizando código...${NC}"
cd $PROJECT_DIR
git pull origin main

echo -e "${YELLOW}[2/7] Instalando dependências...${NC}"
npm ci

echo -e "${YELLOW}[3/7] Gerando Prisma Client...${NC}"
npx prisma generate

echo -e "${YELLOW}[4/7] Rodando migrations...${NC}"
npx prisma migrate deploy

echo -e "${YELLOW}[5/7] Building TypeScript...${NC}"
npm run build

echo -e "${YELLOW}[6/7] Criando diretório de logs...${NC}"
mkdir -p logs

echo -e "${YELLOW}[7/7] Reiniciando PM2...${NC}"
pm2 startOrRestart ecosystem.config.js --env production

pm2 save

echo ""
echo -e "${GREEN}=========================================="
echo "  Deploy concluído!"
echo "==========================================${NC}"
echo ""
pm2 status
echo ""
echo -e "${GREEN}API rodando em: https://$DOMAIN${NC}"

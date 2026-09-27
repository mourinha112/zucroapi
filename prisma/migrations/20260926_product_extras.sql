-- Configurações extras do editor de produto (upsell, frete, cupons progressivos, afiliados).
-- Seguro de rodar mais de uma vez.
ALTER TABLE products ADD COLUMN IF NOT EXISTS extras JSONB;

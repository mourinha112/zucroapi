-- ============================================
-- MIGRAÇÃO: Payment Splits
-- Divisão automática de pagamentos entre recipients
-- Execute este SQL no banco PostgreSQL
-- ============================================

-- ============================================
-- ALTER: payments.has_split
-- ============================================
ALTER TABLE "payments"
    ADD COLUMN IF NOT EXISTS "has_split" BOOLEAN NOT NULL DEFAULT false;

-- ============================================
-- TABELA: payment_splits
-- Uma linha por recipient dentro de um payment
-- ============================================
CREATE TABLE IF NOT EXISTS "payment_splits" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "payment_id"     UUID NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
    "recipient_id"   UUID NOT NULL REFERENCES "users"("id")    ON DELETE CASCADE,
    "type"           VARCHAR(10) NOT NULL,           -- 'amount' | 'percent'
    "amount"         DECIMAL(10,2),
    "percent"        DECIMAL(5,2),
    "computed_value" DECIMAL(10,2),
    "status"         VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | credited | reversed
    "description"    TEXT,
    "credited_at"    TIMESTAMPTZ,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "payment_splits_payment_id_idx"   ON "payment_splits" ("payment_id");
CREATE INDEX IF NOT EXISTS "payment_splits_recipient_id_idx" ON "payment_splits" ("recipient_id");

-- ============================================
-- TABELA: product_split_rules
-- Regras fixas por produto (aplicadas em toda venda)
-- ============================================
CREATE TABLE IF NOT EXISTS "product_split_rules" (
    "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"   UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "recipient_id" UUID NOT NULL REFERENCES "users"("id")    ON DELETE CASCADE,
    "type"         VARCHAR(10) NOT NULL,              -- 'amount' | 'percent'
    "amount"       DECIMAL(10,2),
    "percent"      DECIMAL(5,2),
    "description"  TEXT,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_split_rules_product_id_idx" ON "product_split_rules" ("product_id");

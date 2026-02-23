-- ============================================
-- MIGRAÇÃO: OrderBump e Subscription
-- Execute este SQL no seu banco de dados PostgreSQL
-- ============================================

-- ============================================
-- TABELA: order_bumps
-- ============================================
CREATE TABLE IF NOT EXISTS "order_bumps" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "product_id" UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "bump_product_id" UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "original_price" DECIMAL(10,2),
    "discount_type" VARCHAR(20) DEFAULT 'percentage',
    "discount_value" DECIMAL(10,2) DEFAULT 0,
    "show_in_checkout" BOOLEAN DEFAULT true,
    "show_image" BOOLEAN DEFAULT true,
    "position" INTEGER DEFAULT 0,
    "min_quantity" INTEGER DEFAULT 1,
    "active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TABELA: subscription_plans
-- ============================================
CREATE TABLE IF NOT EXISTS "subscription_plans" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "interval" VARCHAR(20) DEFAULT 'month',
    "interval_count" INTEGER DEFAULT 1,
    "price" DECIMAL(10,2) NOT NULL,
    "trial_days" INTEGER DEFAULT 0,
    "max_installments" INTEGER DEFAULT 1,
    "cancel_at_end" BOOLEAN DEFAULT true,
    "active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TABELA: subscriptions
-- ============================================
CREATE TABLE IF NOT EXISTS "subscriptions" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "customer_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "customer_email" VARCHAR(200) NOT NULL,
    "customer_name" VARCHAR(200),
    "customer_document" VARCHAR(20),
    "subscription_plan_id" UUID NOT NULL REFERENCES "subscription_plans"("id") ON DELETE RESTRICT,
    "external_subscription_id" VARCHAR(100),
    "status" VARCHAR(20) DEFAULT 'active',
    "current_period_start" TIMESTAMPTZ NOT NULL,
    "current_period_end" TIMESTAMPTZ NOT NULL,
    "next_billing_date" TIMESTAMPTZ NOT NULL,
    "cancel_at_period_end" BOOLEAN DEFAULT false,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TABELA: subscription_payments
-- ============================================
CREATE TABLE IF NOT EXISTS "subscription_payments" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
    "payment_id" UUID REFERENCES "payments"("id") ON DELETE SET NULL,
    "external_payment_id" VARCHAR(100),
    "amount" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(20) DEFAULT 'pending',
    "billing_date" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "failure_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ÍNDICES PARA PERFORMANCE
-- ============================================
CREATE INDEX IF NOT EXISTS "idx_order_bumps_product_id" ON "order_bumps"("product_id");
CREATE INDEX IF NOT EXISTS "idx_order_bumps_user_id" ON "order_bumps"("user_id");
CREATE INDEX IF NOT EXISTS "idx_subscription_plans_user_id" ON "subscription_plans"("user_id");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_user_id" ON "subscriptions"("user_id");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_customer_id" ON "subscriptions"("customer_id");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_plan_id" ON "subscriptions"("subscription_plan_id");
CREATE INDEX IF NOT EXISTS "idx_subscription_payments_subscription_id" ON "subscription_payments"("subscription_id");

-- ============================================
-- COLUNA: product.is_subscription (produto é assinatura?)
-- ============================================
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_subscription" BOOLEAN DEFAULT false;

-- ============================================
-- COLUNA: payment.subscription_id (vinculo com assinatura)
-- ============================================
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "subscription_id" UUID REFERENCES "subscriptions"("id") ON DELETE SET NULL;

-- ============================================
-- FIM DA MIGRAÇÃO
-- ============================================

-- CreateTable
CREATE TABLE IF NOT EXISTS "platform_settings" (
    "id" VARCHAR(50) NOT NULL DEFAULT 'default',
    "pix_rate" DECIMAL(5,2) NOT NULL DEFAULT 5.99,
    "card_rate" DECIMAL(5,2) NOT NULL DEFAULT 5.99,
    "boleto_rate" DECIMAL(5,2) NOT NULL DEFAULT 5.99,
    "fixed_fee" DECIMAL(10,2) NOT NULL DEFAULT 2.50,
    "installment_fee" DECIMAL(5,2) NOT NULL DEFAULT 2.49,
    "reserve_percent" DECIMAL(5,4) NOT NULL DEFAULT 0.05,
    "reserve_days" INTEGER NOT NULL DEFAULT 30,
    "withdrawal_fee" DECIMAL(10,2) NOT NULL DEFAULT 2.00,
    "max_installments" INTEGER NOT NULL DEFAULT 12,
    "min_pix_value" DECIMAL(10,2) NOT NULL DEFAULT 1.00,
    "min_card_value" DECIMAL(10,2) NOT NULL DEFAULT 5.00,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- Insert default settings
INSERT INTO "platform_settings" ("id", "pix_rate", "card_rate", "boleto_rate", "fixed_fee", "installment_fee", "reserve_percent", "reserve_days", "withdrawal_fee", "max_installments", "min_pix_value", "min_card_value")
VALUES ('default', 5.99, 5.99, 5.99, 2.50, 2.49, 0.05, 30, 2.00, 12, 1.00, 5.00)
ON CONFLICT ("id") DO NOTHING;

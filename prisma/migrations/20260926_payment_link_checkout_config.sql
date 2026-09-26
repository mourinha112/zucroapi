-- Configuração do checkout (editor Vega / Las Vegas) por link de pagamento.
-- Seguro de rodar mais de uma vez.
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS checkout_config JSONB;

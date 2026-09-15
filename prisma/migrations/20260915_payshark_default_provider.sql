-- Pay Shark vira a adquirente padrão para contas novas.
-- Seguro de rodar mais de uma vez.

ALTER TABLE users ALTER COLUMN payment_provider SET DEFAULT 'payshark';

-- OPCIONAL — migrar TODOS os vendedores existentes para a Pay Shark de uma vez.
-- Não roda por padrão: a partir daí os saques desses vendedores saem do saldo
-- da Pay Shark (e não da adquirente onde as vendas antigas entraram).
-- Vendas já criadas continuam sendo confirmadas pelo webhook da adquirente
-- original (as rotas antigas permanecem ativas).
--
-- UPDATE users SET payment_provider = 'payshark', updated_at = NOW()
--  WHERE payment_provider <> 'payshark';

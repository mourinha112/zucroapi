-- Fluxo "Ativar conta" (wizard CPF/CNPJ + documentos + KYC facial + Pix) guardado em JSON no usuário.
-- account_status já existe (pending | pending_review | active | approved | rejected | blocked | suspended).
-- Seguro de rodar mais de uma vez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation JSONB;

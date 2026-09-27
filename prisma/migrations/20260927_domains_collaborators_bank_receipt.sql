-- Domínios próprios, colaboradores, dados bancários/Pix do vendedor, adquirentes por vendedor,
-- recuperação de senha e comprovante de pagamento. Seguro de rodar mais de uma vez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_code VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_agency VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_type VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pix_key VARCHAR(140);
ALTER TABLE users ADD COLUMN IF NOT EXISTS pix_key_type VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquirer_settings JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_name VARCHAR(200);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_uploaded_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(253) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  method VARCHAR(20) NOT NULL DEFAULT 'cname',
  cname_target VARCHAR(253) NOT NULL,
  verified_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  verification_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS domains_user_id_idx ON domains(user_id);
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS domain_id UUID REFERENCES domains(id);
CREATE TABLE IF NOT EXISTS collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(200) NOT NULL,
  name VARCHAR(200),
  permissions JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'invited',
  invite_token VARCHAR(80),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, email)
);

-- Dispositivos/sessões do usuário: alimenta a aba Dispositivos das Configurações.
-- Seguro de rodar mais de uma vez (IF NOT EXISTS em tudo).

CREATE TABLE IF NOT EXISTS user_devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) NOT NULL,
  user_agent  TEXT,
  ip_address  VARCHAR(64),
  browser     VARCHAR(60),
  os          VARCHAR(40),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_devices_user_id_fingerprint_key
  ON user_devices (user_id, fingerprint);

CREATE INDEX IF NOT EXISTS user_devices_user_id_last_seen_idx
  ON user_devices (user_id, last_seen);

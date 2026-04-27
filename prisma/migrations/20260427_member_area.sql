-- ============================================
-- MIGRAÇÃO: Área de Membros / Infoproduto
-- Adiciona suporte a produtos com área de membros (módulos, aulas, materiais)
-- e funcionalidades complementares: turmas, pixels de rastreamento, lista de espera.
-- ============================================

-- ============================================
-- ALTER: products
-- ============================================
ALTER TABLE "products"
    ADD COLUMN IF NOT EXISTS "product_type" VARCHAR(20) NOT NULL DEFAULT 'link',
    ADD COLUMN IF NOT EXISTS "cover_url" TEXT,
    ADD COLUMN IF NOT EXISTS "subtitle" VARCHAR(200),
    ADD COLUMN IF NOT EXISTS "member_area_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "support_email" VARCHAR(180),
    ADD COLUMN IF NOT EXISTS "welcome_message" TEXT,
    ADD COLUMN IF NOT EXISTS "slug" VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_idx" ON "products" ("slug") WHERE "slug" IS NOT NULL;

-- ============================================
-- TABELA: product_modules
-- Módulos da área de membros (ex.: "Introdução", "Módulo 1 - Fundamentos")
-- ============================================
CREATE TABLE IF NOT EXISTS "product_modules" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"  UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "title"       VARCHAR(200) NOT NULL,
    "description" TEXT,
    "cover_url"   TEXT,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_modules_product_id_idx" ON "product_modules" ("product_id");
CREATE INDEX IF NOT EXISTS "product_modules_position_idx"  ON "product_modules" ("product_id", "position");

-- ============================================
-- TABELA: product_lessons
-- Aulas dentro de cada módulo
-- video_provider: 'youtube' | 'vimeo' | 'panda' | 'url' | 'upload'
-- ============================================
CREATE TABLE IF NOT EXISTS "product_lessons" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "module_id"      UUID NOT NULL REFERENCES "product_modules"("id") ON DELETE CASCADE,
    "title"          VARCHAR(200) NOT NULL,
    "description"    TEXT,
    "video_provider" VARCHAR(20),
    "video_url"      TEXT,
    "duration_seconds" INTEGER,
    "position"       INTEGER NOT NULL DEFAULT 0,
    "is_free"        BOOLEAN NOT NULL DEFAULT false,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_lessons_module_id_idx" ON "product_lessons" ("module_id");
CREATE INDEX IF NOT EXISTS "product_lessons_position_idx" ON "product_lessons" ("module_id", "position");

-- ============================================
-- TABELA: product_lesson_materials
-- Arquivos/recursos extras anexados a uma aula (PDF, ZIP, link, etc.)
-- ============================================
CREATE TABLE IF NOT EXISTS "product_lesson_materials" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "lesson_id"   UUID NOT NULL REFERENCES "product_lessons"("id") ON DELETE CASCADE,
    "name"        VARCHAR(200) NOT NULL,
    "type"        VARCHAR(20) NOT NULL DEFAULT 'file',
    "file_url"    TEXT NOT NULL,
    "size_bytes"  BIGINT,
    "position"    INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_lesson_materials_lesson_id_idx" ON "product_lesson_materials" ("lesson_id");

-- ============================================
-- TABELA: product_classes
-- Turmas (cohorts) opcionais por produto
-- ============================================
CREATE TABLE IF NOT EXISTS "product_classes" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"  UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "name"        VARCHAR(200) NOT NULL,
    "description" TEXT,
    "start_date"  TIMESTAMPTZ,
    "end_date"    TIMESTAMPTZ,
    "max_seats"   INTEGER,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_classes_product_id_idx" ON "product_classes" ("product_id");

-- ============================================
-- TABELA: product_tracking_pixels
-- Pixels de rastreamento (facebook, google, tiktok, kwai, custom)
-- ============================================
CREATE TABLE IF NOT EXISTS "product_tracking_pixels" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"  UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "platform"    VARCHAR(30) NOT NULL,
    "pixel_id"    VARCHAR(120),
    "access_token" TEXT,
    "events"      JSONB,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_tracking_pixels_product_id_idx" ON "product_tracking_pixels" ("product_id");

-- ============================================
-- TABELA: product_waitlist
-- Lista de espera para produtos não disponíveis ou com vagas limitadas
-- ============================================
CREATE TABLE IF NOT EXISTS "product_waitlist" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"  UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "name"        VARCHAR(200) NOT NULL,
    "email"       VARCHAR(200) NOT NULL,
    "phone"       VARCHAR(40),
    "metadata"    JSONB,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "product_waitlist_product_id_idx" ON "product_waitlist" ("product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "product_waitlist_unique_email_idx" ON "product_waitlist" ("product_id", "email");

-- ============================================
-- TABELA: product_member_access
-- Cada compra confirmada gera um acesso para o e-mail do comprador.
-- Permite login na área de membros mesmo sem conta de seller.
-- ============================================
CREATE TABLE IF NOT EXISTS "product_member_access" (
    "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "product_id"   UUID NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
    "payment_id"   UUID REFERENCES "payments"("id") ON DELETE SET NULL,
    "buyer_email"  VARCHAR(200) NOT NULL,
    "buyer_name"   VARCHAR(200),
    "buyer_phone"  VARCHAR(40),
    "access_token" VARCHAR(80) NOT NULL,
    "class_id"     UUID REFERENCES "product_classes"("id") ON DELETE SET NULL,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_access_at" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "product_member_access_product_id_idx" ON "product_member_access" ("product_id");
CREATE INDEX IF NOT EXISTS "product_member_access_email_idx"     ON "product_member_access" ("buyer_email");
CREATE UNIQUE INDEX IF NOT EXISTS "product_member_access_token_idx" ON "product_member_access" ("access_token");

-- ============================================
-- TABELA: product_lesson_progress
-- Marca aulas como concluídas/em andamento para cada acesso de membro.
-- ============================================
CREATE TABLE IF NOT EXISTS "product_lesson_progress" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "access_id"      UUID NOT NULL REFERENCES "product_member_access"("id") ON DELETE CASCADE,
    "lesson_id"      UUID NOT NULL REFERENCES "product_lessons"("id") ON DELETE CASCADE,
    "completed"      BOOLEAN NOT NULL DEFAULT false,
    "watched_seconds" INTEGER NOT NULL DEFAULT 0,
    "completed_at"   TIMESTAMPTZ,
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_lesson_progress_unique_idx"
    ON "product_lesson_progress" ("access_id", "lesson_id");

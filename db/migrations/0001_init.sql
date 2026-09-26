-- ============================================================================
--  RasaBhojan / CafePOS — MySQL 8.4 LTS schema  (migration 0001_init)
-- ----------------------------------------------------------------------------
--  Source of truth: the LIVE Supabase project (introspected 2026-09-19), NOT the
--  older supabase_*.sql files (they have drifted from production).
--
--  Rules used for the port
--    * Same table + column names as Supabase, so the Flutter models' fromJson()
--      keep working and the ETL is a straight copy.
--    * uuid          -> CHAR(36) ascii_bin   (ids are generated as UUIDv7 in Node)
--    * timestamptz   -> DATETIME(3), always UTC  (connection time_zone = '+00:00')
--    * numeric(p,s)  -> DECIMAL(p,s)             (same precision as live)
--    * boolean       -> TINYINT(1)               (driver casts to true/false)
--    * text          -> VARCHAR(n) when short/indexed, TEXT otherwise
--
--  Deliberate deviations from Supabase ("corrections") are tagged  [FIX n]  and
--  explained in PLAN.md §3.
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ─── 1. company_master ──────────────────────────────────────────────────────
CREATE TABLE company_master (
  id                    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_code          VARCHAR(30)   NOT NULL,
  company_name          VARCHAR(200)  NOT NULL,
  address               TEXT          NULL,
  city                  VARCHAR(100)  NULL,
  state                 VARCHAR(100)  NULL,
  country               VARCHAR(100)  NULL DEFAULT 'India',
  phone                 VARCHAR(30)   NULL,
  email                 VARCHAR(190)  NULL,
  has_gst               TINYINT(1)    NOT NULL DEFAULT 0,
  gstin                 VARCHAR(20)   NULL,
  pan_number            VARCHAR(20)   NULL,
  has_table_management  TINYINT(1)    NOT NULL DEFAULT 1,
  has_item_variants     TINYINT(1)    NOT NULL DEFAULT 0,
  currency_code         VARCHAR(8)    NOT NULL DEFAULT 'INR',
  timezone              VARCHAR(64)   NOT NULL DEFAULT 'Asia/Kolkata',
  logo_url              VARCHAR(1024) NULL,
  is_active             TINYINT(1)    NOT NULL DEFAULT 1,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  show_item_images      TINYINT(1)    NOT NULL DEFAULT 1,
  is_verified           TINYINT(1)    NOT NULL DEFAULT 0,
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_code (company_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 2. company_hsn ─────────────────────────────────────────────────────────
CREATE TABLE company_hsn (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hsn_code    VARCHAR(20)   NOT NULL,
  description VARCHAR(255)  NULL,
  gst_rate    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  cgst_rate   DECIMAL(5,2)  NOT NULL DEFAULT 0,
  sgst_rate   DECIMAL(5,2)  NOT NULL DEFAULT 0,
  igst_rate   DECIMAL(5,2)  NOT NULL DEFAULT 0,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hsn_company_code (company_id, hsn_code),
  CONSTRAINT fk_hsn_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 3. company_print_config ────────────────────────────────────────────────
CREATE TABLE company_print_config (
  id              CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  printer_type    VARCHAR(30)  NOT NULL DEFAULT 'thermal_80mm',
  paper_size      VARCHAR(20)  NOT NULL DEFAULT '80mm',
  print_logo      TINYINT(1)   NOT NULL DEFAULT 1,
  print_gstin     TINYINT(1)   NOT NULL DEFAULT 1,
  print_hsn       TINYINT(1)   NOT NULL DEFAULT 0,
  print_qr_code   TINYINT(1)   NOT NULL DEFAULT 0,
  header_text     TEXT         NULL,
  footer_text     TEXT         NULL,
  copies_bill     INT          NOT NULL DEFAULT 1,
  copies_kot      INT          NOT NULL DEFAULT 1,
  auto_print_kot  TINYINT(1)   NOT NULL DEFAULT 1,
  auto_print_bill TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_print_company (company_id),
  CONSTRAINT fk_print_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 4. user_profiles ───────────────────────────────────────────────────────
-- [FIX 1] `password` (plaintext in Supabase) -> `password_hash` (argon2id).
-- [FIX 2] employee_code unique per company, not globally.
-- Owner (platform super-admin) has company_id NULL.
CREATE TABLE user_profiles (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  employee_code  VARCHAR(30)   NOT NULL,
  user_name      VARCHAR(120)  NOT NULL,
  username       VARCHAR(50)   NOT NULL,
  password_hash  VARCHAR(255)  NOT NULL,
  user_role      VARCHAR(20)   NOT NULL,
  mob_number     VARCHAR(30)   NULL,
  user_email     VARCHAR(190)  NULL,
  user_active    TINYINT(1)    NOT NULL DEFAULT 1,
  last_login     DATETIME(3)   NULL,
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  avatar_url     VARCHAR(1024) NULL,
  pan_no         VARCHAR(20)   NULL,
  aadhaar_no     VARCHAR(20)   NULL,
  address        TEXT          NULL,
  dob            DATE          NULL,
  date_of_join   DATE          NULL,
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  is_login       TINYINT(1)    NOT NULL DEFAULT 0,
  -- new: auth hardening
  token_version  INT UNSIGNED  NOT NULL DEFAULT 0,      -- bump => all issued JWTs invalid
  failed_logins  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until   DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_username (username),
  UNIQUE KEY uq_user_company_empcode (company_id, employee_code),
  KEY ix_user_email (user_email),                       -- NOT unique: live data has a shared email
  KEY ix_user_company_active (company_id, user_active),
  CONSTRAINT chk_user_role CHECK (user_role IN ('owner','admin','manager','cashier','waiter','kitchen')),
  CONSTRAINT fk_user_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 5. user_permission / user_preference ───────────────────────────────────
CREATE TABLE user_permission (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  can_view_dashboard  TINYINT(1) NOT NULL DEFAULT 0,
  can_create_bill     TINYINT(1) NOT NULL DEFAULT 1,
  can_edit_bill       TINYINT(1) NOT NULL DEFAULT 0,
  can_cancel_bill     TINYINT(1) NOT NULL DEFAULT 0,
  can_apply_discount  TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_items    TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_tables   TINYINT(1) NOT NULL DEFAULT 0,
  can_view_reports    TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_users    TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_settings TINYINT(1) NOT NULL DEFAULT 0,
  can_void_items      TINYINT(1) NOT NULL DEFAULT 0,
  can_manage_stock    TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_perm_user (user_id),
  CONSTRAINT fk_perm_user FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_preference (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ui_theme_type  VARCHAR(20) NOT NULL DEFAULT 'system',
  primary_color  VARCHAR(20) NULL DEFAULT '#000000',
  accent_color   VARCHAR(20) NULL DEFAULT '#2563EB',
  font_size      VARCHAR(20) NOT NULL DEFAULT 'medium',
  layout_mode    VARCHAR(20) NOT NULL DEFAULT 'compact',
  dark_mode      TINYINT(1)  NOT NULL DEFAULT 0,
  chosen_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pref_user (user_id),
  CONSTRAINT fk_pref_user FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 6. auth_session  (NEW — refresh tokens; replaces trust-the-client login) ─
CREATE TABLE auth_session (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  refresh_token_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,   -- sha256(hex); raw token never stored
  device_label        VARCHAR(100) NULL,
  ip                  VARCHAR(45)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at          DATETIME(3)  NOT NULL,
  revoked_at          DATETIME(3)  NULL,
  revoked_reason      VARCHAR(40)  NULL,     -- logout | force_logout | replaced | password_changed | deactivated
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (refresh_token_hash),
  KEY ix_session_user (user_id, revoked_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES user_profiles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 7. table_master ────────────────────────────────────────────────────────
-- [FIX 3] table_number unique per company (Supabase allows duplicates).
CREATE TABLE table_master (
  id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_number     VARCHAR(30)  NOT NULL,
  section          VARCHAR(60)  NULL DEFAULT 'Main',
  seating_capacity INT          NOT NULL DEFAULT 4,
  qr_code          TEXT         NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_table_company_number (company_id, table_number),
  CONSTRAINT fk_table_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 8. table_session ───────────────────────────────────────────────────────
-- [FIX 4] At most ONE open session per table, enforced by the database.
-- MySQL has no partial unique index, so a generated column is NULL unless the
-- session is open; UNIQUE ignores NULLs. (Supabase does check-then-insert in the
-- client, so two waiters saving the same table at once can open two sessions.)
CREATE TABLE table_session (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  opened_by   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  opened_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at   DATETIME(3)  NULL,
  status      VARCHAR(10)  NOT NULL DEFAULT 'open',
  total_pax   INT          NOT NULL DEFAULT 1,
  open_table_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
      GENERATED ALWAYS AS (IF(status = 'open', table_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_one_open_per_table (open_table_key),
  KEY ix_session_table_status (table_id, status),
  KEY ix_session_company_status (company_id, status),
  CONSTRAINT chk_session_status CHECK (status IN ('open','billed','closed')),
  CONSTRAINT fk_session_table   FOREIGN KEY (table_id)   REFERENCES table_master (id),
  CONSTRAINT fk_session_opener  FOREIGN KEY (opened_by)  REFERENCES user_profiles (id),
  CONSTRAINT fk_session_company FOREIGN KEY (company_id) REFERENCES company_master (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 9. table_cover ─────────────────────────────────────────────────────────
CREATE TABLE table_cover (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_session_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cover_number      INT          NOT NULL,
  label             VARCHAR(100) NULL,
  pax               INT          NULL DEFAULT 1,
  status            VARCHAR(10)  NOT NULL DEFAULT 'active',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cover_session_number (table_session_id, cover_number),
  KEY ix_cover_company (company_id),
  CONSTRAINT chk_cover_status CHECK (status IN ('active','billed','merged')),
  CONSTRAINT fk_cover_session FOREIGN KEY (table_session_id) REFERENCES table_session (id) ON DELETE CASCADE,
  CONSTRAINT fk_cover_company FOREIGN KEY (company_id)       REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 10. item_master  (= ITEM GROUP) ────────────────────────────────────────
-- [FIX 5] item_code unique per company (Supabase: globally unique, so two cafes
--         cannot both use code "001").
-- [FIX 6] 12 single-column indexes on booleans/sync_version dropped; replaced by
--         3 composites that match the real queries.
-- default_variant_id has NO foreign key: item_master <-> item_variant would be a
-- circular FK (Supabase uses DEFERRABLE, MySQL cannot). The service validates it
-- and clears it before deleting a group.
CREATE TABLE item_master (
  id                    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hsn_id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_code             VARCHAR(40)   NOT NULL,
  item_name             VARCHAR(200)  NOT NULL,
  description           TEXT          NULL,
  base_rate             DECIMAL(10,2) NOT NULL DEFAULT 0,
  has_variants          TINYINT(1)    NOT NULL DEFAULT 0,
  is_taxable            TINYINT(1)    NOT NULL DEFAULT 1,
  is_active             TINYINT(1)    NOT NULL DEFAULT 1,
  image_url             VARCHAR(1024) NULL,
  display_order         INT           NOT NULL DEFAULT 0,
  section_label         VARCHAR(100)  NULL,
  color_tag             VARCHAR(30)   NULL,
  food_type             VARCHAR(20)   NOT NULL DEFAULT 'veg',
  short_name            VARCHAR(100)  NULL,
  local_name            VARCHAR(200)  NULL,
  search_keywords       TEXT          NULL,
  badge                 VARCHAR(50)   NULL,
  is_featured           TINYINT(1)    NOT NULL DEFAULT 0,
  is_recommended        TINYINT(1)    NOT NULL DEFAULT 0,
  preparation_time      SMALLINT      NULL,
  default_variant_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  is_online_visible     TINYINT(1)    NOT NULL DEFAULT 1,
  is_pos_visible        TINYINT(1)    NOT NULL DEFAULT 1,
  is_qr_visible         TINYINT(1)    NOT NULL DEFAULT 1,
  is_self_order_visible TINYINT(1)    NOT NULL DEFAULT 1,
  stock_enabled         TINYINT(1)    NOT NULL DEFAULT 0,
  unlimited_stock       TINYINT(1)    NOT NULL DEFAULT 1,
  sold_out              TINYINT(1)    NOT NULL DEFAULT 0,
  packing_charge        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  loyalty_enabled       TINYINT(1)    NOT NULL DEFAULT 1,
  discount_allowed      TINYINT(1)    NOT NULL DEFAULT 1,
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sync_version          BIGINT        NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_item_company_code (company_id, item_code),
  KEY ix_item_company_order (company_id, display_order),
  KEY ix_item_company_active (company_id, is_active, display_order),
  KEY ix_item_hsn (hsn_id),
  CONSTRAINT chk_item_rate_nonneg  CHECK (base_rate >= 0),
  CONSTRAINT fk_item_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_item_hsn     FOREIGN KEY (hsn_id)     REFERENCES company_hsn (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 11. item_variant  (= SELLING ITEM) ─────────────────────────────────────
-- [FIX 7] exactly one default variant per group, enforced (generated-column unique).
-- [FIX 6] 12 single-column indexes -> 4 targeted ones.
CREATE TABLE item_variant (
  id                    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  variant_name          VARCHAR(200)  NOT NULL,
  rate_override         DECIMAL(10,2) NULL,                 -- legacy; pricing uses base_rate
  is_active             TINYINT(1)    NOT NULL DEFAULT 1,
  image_url             VARCHAR(1024) NULL,
  hsn_id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  inclusive_rate        DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_rate_inclusive     TINYINT(1)    NOT NULL DEFAULT 0,
  description           TEXT          NULL,
  display_order         INT           NOT NULL DEFAULT 0,
  is_available          TINYINT(1)    NOT NULL DEFAULT 1,
  base_rate             DECIMAL(10,2) NOT NULL DEFAULT 0,   -- 0 => inherit group base_rate
  sku                   VARCHAR(100)  NULL,
  barcode               VARCHAR(100)  NULL,
  short_name            VARCHAR(100)  NULL,
  local_name            VARCHAR(200)  NULL,
  print_name            VARCHAR(200)  NULL,
  kitchen_name          VARCHAR(200)  NULL,
  calories              DECIMAL(8,2)  NULL,
  portion_size          VARCHAR(50)   NULL,
  unit                  VARCHAR(30)   NULL,
  preparation_time      SMALLINT      NULL,
  is_default            TINYINT(1)    NOT NULL DEFAULT 0,
  is_popular            TINYINT(1)    NOT NULL DEFAULT 0,
  is_new                TINYINT(1)    NOT NULL DEFAULT 0,
  is_recommended        TINYINT(1)    NOT NULL DEFAULT 0,
  badge                 VARCHAR(50)   NULL,
  online_visible        TINYINT(1)    NOT NULL DEFAULT 1,
  pos_visible           TINYINT(1)    NOT NULL DEFAULT 1,
  qr_visible            TINYINT(1)    NOT NULL DEFAULT 1,
  self_order_visible    TINYINT(1)    NOT NULL DEFAULT 1,
  dine_in_available     TINYINT(1)    NOT NULL DEFAULT 1,
  takeaway_available    TINYINT(1)    NOT NULL DEFAULT 1,
  delivery_available    TINYINT(1)    NOT NULL DEFAULT 1,
  stock_enabled         TINYINT(1)    NOT NULL DEFAULT 0,
  unlimited_stock       TINYINT(1)    NOT NULL DEFAULT 1,
  current_stock         DECIMAL(10,3) NOT NULL DEFAULT 0,
  reorder_level         DECIMAL(10,3) NULL,
  packing_charge        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  service_charge        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  search_keywords       TEXT          NULL,
  display_color         VARCHAR(20)   NULL,
  sort_priority         SMALLINT      NOT NULL DEFAULT 0,
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  food_type             VARCHAR(20)   NOT NULL DEFAULT 'veg',
  default_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
      GENERATED ALWAYS AS (IF(is_default = 1, item_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_variant_one_default (default_key),
  UNIQUE KEY uq_variant_item_name (item_id, variant_name),
  KEY ix_variant_item_order (item_id, display_order, variant_name),
  KEY ix_variant_pos (item_id, is_active, is_available),
  KEY ix_variant_barcode (barcode),
  KEY ix_variant_hsn (hsn_id),
  CONSTRAINT chk_variant_rate_nonneg CHECK (base_rate >= 0),
  CONSTRAINT fk_variant_item FOREIGN KEY (item_id) REFERENCES item_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_variant_hsn  FOREIGN KEY (hsn_id)  REFERENCES company_hsn (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 12. bill_master ────────────────────────────────────────────────────────
-- [FIX 8] bill_number unique per company (Supabase: globally unique).
-- [FIX 9] at most ONE open bill per cover, enforced by the database.
-- Bill numbers come from bill_counter (below), never from MAX()+1.
CREATE TABLE bill_master (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_session_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  billed_by         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_number       VARCHAR(40)   NOT NULL,
  bill_type         VARCHAR(10)   NOT NULL DEFAULT 'dine_in',
  bill_date         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  subtotal          DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_type     VARCHAR(10)   NULL,
  taxable_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  cgst_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  sgst_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  igst_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_paid       DECIMAL(12,2) NOT NULL DEFAULT 0,
  change_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_mode      VARCHAR(10)   NOT NULL DEFAULT 'cash',
  payment_ref       VARCHAR(100)  NULL,
  status            VARCHAR(10)   NOT NULL DEFAULT 'open',
  notes             TEXT          NULL,
  is_printed        TINYINT(1)    NOT NULL DEFAULT 0,
  printed_at        DATETIME(3)   NULL,
  cover_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  open_cover_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
      GENERATED ALWAYS AS (IF(status = 'open', cover_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_company_number (company_id, bill_number),
  UNIQUE KEY uq_bill_one_open_per_cover (open_cover_key),
  KEY ix_bill_company_date   (company_id, bill_date),
  KEY ix_bill_company_status (company_id, status, bill_date),
  KEY ix_bill_session        (table_session_id, status),
  KEY ix_bill_cover          (cover_id),
  CONSTRAINT chk_bill_type     CHECK (bill_type IN ('dine_in','takeaway','delivery')),
  CONSTRAINT chk_bill_disc     CHECK (discount_type IS NULL OR discount_type IN ('percent','flat')),
  CONSTRAINT chk_bill_pay      CHECK (payment_mode IN ('cash','card','upi','split')),
  CONSTRAINT chk_bill_status   CHECK (status IN ('open','paid','cancelled')),
  CONSTRAINT fk_bill_company FOREIGN KEY (company_id)       REFERENCES company_master (id),
  CONSTRAINT fk_bill_user    FOREIGN KEY (billed_by)        REFERENCES user_profiles (id),
  CONSTRAINT fk_bill_session FOREIGN KEY (table_session_id) REFERENCES table_session (id),
  CONSTRAINT fk_bill_cover   FOREIGN KEY (cover_id)         REFERENCES table_cover (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 13. bill_item ──────────────────────────────────────────────────────────
-- kot_status is unused in production (all 382 rows are 'pending'; the KDS uses
-- kot_item.status). Kept only for column parity; not read or written by the API.
CREATE TABLE bill_item (
  id                  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  variant_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_name_snapshot  VARCHAR(255)  NOT NULL,
  rate_snapshot       DECIMAL(10,2) NOT NULL,
  qty                 DECIMAL(8,3)  NOT NULL DEFAULT 1,
  gross_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  hsn_code_snapshot   VARCHAR(20)   NULL,
  gst_rate_snapshot   DECIMAL(5,2)  NOT NULL DEFAULT 0,
  cgst_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  sgst_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  igst_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes               TEXT          NULL,
  kot_status          VARCHAR(10)   NOT NULL DEFAULT 'pending',
  kot_printed_at      DATETIME(3)   NULL,
  PRIMARY KEY (id),
  KEY ix_bi_bill (bill_id),
  KEY ix_bi_item (item_id),
  KEY ix_bi_variant (variant_id),
  CONSTRAINT chk_bi_kot_status CHECK (kot_status IN ('pending','sent','done','void')),
  CONSTRAINT fk_bi_bill    FOREIGN KEY (bill_id)    REFERENCES bill_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_item    FOREIGN KEY (item_id)    REFERENCES item_master (id) ON DELETE SET NULL,
  CONSTRAINT fk_bi_variant FOREIGN KEY (variant_id) REFERENCES item_variant (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 14. kot_master / kot_item ──────────────────────────────────────────────
-- [FIX 10] kot_number unique per company (Supabase has NO constraint and the live
--          data already contains 5 duplicated numbers from a client-side race).
CREATE TABLE kot_master (
  id                CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  table_session_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kot_number        VARCHAR(40)  NOT NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status            VARCHAR(15)  NOT NULL DEFAULT 'pending',
  is_printed        TINYINT(1)   NOT NULL DEFAULT 0,
  cover_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kot_company_number (company_id, kot_number),
  KEY ix_kot_company_created (company_id, created_at),
  KEY ix_kot_bill (bill_id),
  KEY ix_kot_session (table_session_id),
  KEY ix_kot_cover (cover_id),
  CONSTRAINT chk_kot_status CHECK (status IN ('pending','in_progress','done','cancelled')),
  CONSTRAINT fk_kot_bill    FOREIGN KEY (bill_id)          REFERENCES bill_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_kot_company FOREIGN KEY (company_id)       REFERENCES company_master (id),
  CONSTRAINT fk_kot_session FOREIGN KEY (table_session_id) REFERENCES table_session (id),
  CONSTRAINT fk_kot_user    FOREIGN KEY (created_by)       REFERENCES user_profiles (id),
  CONSTRAINT fk_kot_cover   FOREIGN KEY (cover_id)         REFERENCES table_cover (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE kot_item (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kot_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bill_item_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  qty           DECIMAL(8,3) NOT NULL DEFAULT 1,
  notes         TEXT         NULL,
  status        VARCHAR(15)  NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id),
  KEY ix_ki_kot (kot_id),
  KEY ix_ki_bill_item (bill_item_id),
  CONSTRAINT chk_ki_status CHECK (status IN ('pending','in_progress','done','void')),
  CONSTRAINT fk_ki_kot       FOREIGN KEY (kot_id)       REFERENCES kot_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_ki_bill_item FOREIGN KEY (bill_item_id) REFERENCES bill_item (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 15. Inventory ──────────────────────────────────────────────────────────
-- All three tables are EMPTY in production today, so precision is chosen freely.
-- Ledger qty needs more scale than bill qty: recipe qty (4dp) x sold qty (3dp).
CREATE TABLE raw_material (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name           VARCHAR(150)  NOT NULL,
  unit           VARCHAR(20)   NOT NULL DEFAULT 'unit',
  opening_stock  DECIMAL(14,3) NOT NULL DEFAULT 0,
  reorder_level  DECIMAL(14,3) NOT NULL DEFAULT 0,
  cost_per_unit  DECIMAL(12,4) NOT NULL DEFAULT 0,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_rm_company (company_id, is_active, name),
  CONSTRAINT fk_rm_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE variant_recipe (
  id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_variant_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  raw_material_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  qty_per_unit     DECIMAL(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recipe_variant_material (item_variant_id, raw_material_id),
  KEY ix_recipe_material (raw_material_id),
  CONSTRAINT fk_recipe_variant  FOREIGN KEY (item_variant_id) REFERENCES item_variant (id) ON DELETE CASCADE,
  CONSTRAINT fk_recipe_material FOREIGN KEY (raw_material_id) REFERENCES raw_material (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Replaces the Postgres trigger deduct_stock_on_kot(): the API now writes the
-- 'consumed' rows in the same transaction as the KOT, so the logic is versioned
-- with the code. UNIQUE(kot_item_id, raw_material_id) makes a retry idempotent
-- (manual rows have kot_item_id NULL and are unaffected: UNIQUE ignores NULLs).
CREATE TABLE stock_ledger (
  id               CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id       CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  raw_material_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  movement_type    VARCHAR(20)   NOT NULL DEFAULT 'adjustment',
  qty              DECIMAL(16,6) NOT NULL,
  kot_item_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  staff_id         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  note             TEXT          NULL,
  shift_label      VARCHAR(50)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ledger_kot_material (kot_item_id, raw_material_id),
  KEY ix_ledger_material_qty (raw_material_id, qty),            -- index-only SUM(qty)
  KEY ix_ledger_company_type_time (company_id, movement_type, created_at),
  KEY ix_ledger_staff (staff_id),
  CONSTRAINT fk_ledger_company  FOREIGN KEY (company_id)      REFERENCES company_master (id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_material FOREIGN KEY (raw_material_id) REFERENCES raw_material (id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_kot_item FOREIGN KEY (kot_item_id)     REFERENCES kot_item (id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_staff    FOREIGN KEY (staff_id)        REFERENCES user_profiles (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 16. Company self-registration / push ───────────────────────────────────
-- otp_code stays readable on purpose: the owner dashboard displays it. In the
-- Node API only role=owner can list it (in Supabase the RPC is granted to anon).
CREATE TABLE company_registration (
  id            CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  company_id    CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  company_name  VARCHAR(200) NULL,
  owner_name    VARCHAR(120) NULL,
  owner_email   VARCHAR(190) NULL,
  owner_phone   VARCHAR(30)  NULL,
  otp_code      VARCHAR(10)  NOT NULL,
  status        VARCHAR(10)  NOT NULL DEFAULT 'pending',   -- pending | verified | expired
  attempts      INT          NOT NULL DEFAULT 0,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_reg_status (status, created_at),
  CONSTRAINT fk_reg_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE super_admin_devices (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fcm_token   VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label       VARCHAR(100) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_token (fcm_token(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 17. Gapless numbering  (NEW) ───────────────────────────────────────────
-- [FIX 11] Supabase computes "latest bill_number ORDER BY bill_number DESC" in the
-- client: it is racy, and it sorts as TEXT, so ".../999" > ".../1000" and the 1000th
-- bill of a financial year collides with an existing number. A counter row locked
-- inside the bill transaction is atomic and gapless (rollback => no number burned),
-- which is also what GST invoice-series rules expect.
--   INSERT INTO bill_counter (company_id, fy, last_seq) VALUES (?, ?, LAST_INSERT_ID(1))
--     ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1);
--   SELECT LAST_INSERT_ID();   -- the allocated number
CREATE TABLE bill_counter (
  company_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fy          VARCHAR(7)   NOT NULL,                 -- '2026-27' (April–March)
  last_seq    INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fy),
  CONSTRAINT fk_billctr_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE kot_counter (
  company_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kot_day     DATE         NOT NULL,                 -- company-local business date
  last_seq    INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, kot_day),
  CONSTRAINT fk_kotctr_company FOREIGN KEY (company_id) REFERENCES company_master (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 18. Idempotency + audit  (NEW) ─────────────────────────────────────────
-- The app times out at 15 s (safeApiCall). If the server committed but the reply
-- was lost, a manual retry would create a duplicate bill/KOT. Clients send an
-- Idempotency-Key; a replay returns the stored response. Purged after 24 h.
CREATE TABLE idempotency_key (
  user_id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idem_key         CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint         VARCHAR(80)  NOT NULL,
  request_hash     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_status  SMALLINT     NULL,                -- NULL while the first request is still running
  response_body    JSON         NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, idem_key),
  KEY ix_idem_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action      VARCHAR(50)  NOT NULL,                 -- bill.cancel | bill.edit | user.force_logout | price.change ...
  entity      VARCHAR(50)  NOT NULL,
  entity_id   CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  meta        JSON         NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_company_time (company_id, created_at),
  KEY ix_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─── 19. Views (parity with Supabase) ───────────────────────────────────────
-- Note: is_low_stock is a computed BIGINT here (not TINYINT(1)), so the API's
-- response mapper must coerce it to boolean — the driver typeCast cannot.
CREATE OR REPLACE VIEW v_current_stock AS
SELECT rm.id, rm.company_id, rm.name, rm.unit, rm.opening_stock, rm.reorder_level,
       rm.opening_stock + l.net AS current_stock,
       (rm.opening_stock + l.net) <= rm.reorder_level AS is_low_stock
  FROM raw_material rm
  JOIN LATERAL (SELECT COALESCE(SUM(sl.qty), 0) AS net
                  FROM stock_ledger sl
                 WHERE sl.raw_material_id = rm.id) l
 WHERE rm.is_active = 1;

CREATE OR REPLACE VIEW v_staff_consumption AS
SELECT sl.staff_id, up.user_name AS staff_name,
       rm.id AS raw_material_id, rm.name AS raw_material_name, rm.unit, rm.company_id,
       SUM(-sl.qty) AS total_consumed
  FROM stock_ledger sl
  JOIN raw_material rm ON rm.id = sl.raw_material_id
  LEFT JOIN user_profiles up ON up.id = sl.staff_id
 WHERE sl.movement_type = 'consumed'
 GROUP BY sl.staff_id, up.user_name, rm.id, rm.name, rm.unit, rm.company_id;

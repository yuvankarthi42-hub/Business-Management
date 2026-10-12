-- BillPoodum — MySQL 8 schema
-- Mirrors the mock data model in src/core/types.ts (camelCase in TS = snake_case here).
-- Phone numbers: always E.164 ("+" country code + national number, digits only, max 16 chars),
-- e.g. +919876543210. Validate with the rules in src/core/phone.ts before saving.
-- Principles: generic core entities, business_id on every row (multi-tenant), branch_id on
-- transactional rows (multi-branch ready), money as DECIMAL(12,2), no hard deletes of
-- financial rows (status / voided flags + audit_logs).

SET NAMES utf8mb4;

-- ---------------------------------------------------------------- Business configuration

CREATE TABLE businesses (
  id               VARCHAR(40)  PRIMARY KEY,
  name             VARCHAR(150) NOT NULL,
  category         ENUM('retail','food','restaurant','service') NOT NULL,
  sub_type         VARCHAR(80)  NOT NULL,
  logo_emoji       VARCHAR(16)  NOT NULL DEFAULT '🏪',
  logo_url         VARCHAR(500) NULL,
  address          VARCHAR(500) NOT NULL DEFAULT '',
  phone            VARCHAR(16)  NOT NULL DEFAULT '',   -- E.164
  default_country  CHAR(2)      NOT NULL DEFAULT 'IN', -- ISO 3166-1; default code for mobile numbers
  email            VARCHAR(150) NOT NULL DEFAULT '',
  gstin            VARCHAR(30)  NOT NULL DEFAULT '',
  currency         CHAR(3)      NOT NULL DEFAULT 'INR',
  currency_symbol  VARCHAR(4)   NOT NULL DEFAULT '₹',
  timezone         VARCHAR(50)  NOT NULL DEFAULT 'Asia/Kolkata',
  terminology      JSON NOT NULL,          -- {"product":{"singular":"Menu Item","plural":"Menu Items"}, ...}
  modules          JSON NOT NULL,          -- {"billing":true,"tables":false,...}
  billing_settings JSON NOT NULL,          -- prefixes, tax mode, payment methods, order types, footer
  onboarded        TINYINT(1)   NOT NULL DEFAULT 0,
  -- Customer account, managed only by the product admin
  status           ENUM('active','deactivated') NOT NULL DEFAULT 'active',
  sub_start_at     DATETIME(3)  NULL,
  sub_end_at       DATETIME(3)  NULL,                 -- after this the account is read-only
  max_branches     SMALLINT     NOT NULL DEFAULT 1,   -- pricing is per branch
  admin_note       VARCHAR(500) NOT NULL DEFAULT '',
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE branches (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  address     VARCHAR(500) NOT NULL DEFAULT '',
  phone       VARCHAR(16)  NOT NULL DEFAULT '',   -- E.164
  is_default  TINYINT(1)   NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  invoice_prefix      VARCHAR(10) NULL,        -- own bill series, e.g. 'AD-'; NULL = business series
  next_invoice_number BIGINT      NULL,
  printer     JSON         NULL,                -- receipt printer setup for this branch: {transport, paper, mode, autoPrint, copies, cut, drawer, baudRate}
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX ix_branch_business (business_id)
) ENGINE=InnoDB;

CREATE TABLE tax_rates (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,
  rate        DECIMAL(5,2) NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
) ENGINE=InnoDB;

-- Gap-free document numbers per business/branch. Lock the row with SELECT ... FOR UPDATE
-- inside the billing transaction, increment, then insert the invoice.
CREATE TABLE sequences (
  business_id VARCHAR(40) NOT NULL,
  branch_id   VARCHAR(40) NOT NULL,
  name        ENUM('invoice','order','kot','credit_note') NOT NULL,
  prefix      VARCHAR(20) NOT NULL DEFAULT '',
  next_value  BIGINT      NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, branch_id, name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Users & roles

CREATE TABLE roles (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,
  permissions JSON NOT NULL,                 -- ["*"] or ["billing.create","orders.view",...]
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  UNIQUE KEY uq_role_name (business_id, name)
) ENGINE=InnoDB;

CREATE TABLE users (
  id            VARCHAR(40)  PRIMARY KEY,
  business_id   VARCHAR(40)  NOT NULL,
  branch_id     VARCHAR(40)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(16)  NOT NULL,              -- E.164, login ID (unique)
  email         VARCHAR(150) NOT NULL DEFAULT '',
  password_hash VARCHAR(100) NOT NULL,      -- bcrypt; never store plain passwords
  role_id       VARCHAR(40)  NOT NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  language      VARCHAR(8)   NOT NULL DEFAULT 'en',  -- app language: en, ta, …
  username      VARCHAR(30)  NULL UNIQUE,
  pay_type      ENUM('monthly','daily') NULL,         -- staff pay; NULL = not on payroll
  pay_amount    DECIMAL(10,2) NOT NULL DEFAULT 0,
  commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,     -- % of the staff member's net sales            -- owner login given by the product admin
  last_login_at DATETIME(3)  NULL,                   -- real sign-ins only (not support views)
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by    VARCHAR(40)  NULL,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by    VARCHAR(40)  NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (branch_id)   REFERENCES branches(id),
  FOREIGN KEY (role_id)     REFERENCES roles(id),
  UNIQUE KEY uq_user_phone (phone)
) ENGINE=InnoDB;

-- Which branches a staff member may work in (owner role = all). users.branch_id is their default.
CREATE TABLE user_branches (
  user_id   VARCHAR(40) NOT NULL,
  branch_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (user_id)   REFERENCES users(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Catalogue

CREATE TABLE categories (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  emoji       VARCHAR(16)  NOT NULL DEFAULT '⭐',
  image_url   VARCHAR(500) NULL,                    -- compressed photo (≤ 50 KB)
  thumb_url   VARCHAR(500) NULL,                    -- 320 px copy for lists
  sort        INT          NOT NULL DEFAULT 0,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
) ENGINE=InnoDB;

CREATE TABLE products (
  id              VARCHAR(40)   PRIMARY KEY,
  business_id     VARCHAR(40)   NOT NULL,
  category_id     VARCHAR(40)   NULL,
  name            VARCHAR(150)  NOT NULL,
  kind            ENUM('goods','service') NOT NULL DEFAULT 'goods',
  emoji           VARCHAR(16)   NOT NULL DEFAULT '🍽️',
  image_url       VARCHAR(500)  NULL,              -- compressed photo (≤ 50 KB WebP, 800 px max)
  thumb_url       VARCHAR(500)  NULL,              -- 320 px copy for lists and billing tiles
  sku             VARCHAR(40)   NOT NULL DEFAULT '',
  barcode         VARCHAR(40)   NOT NULL DEFAULT '',
  unit            VARCHAR(20)   NOT NULL DEFAULT 'pc',
  price           DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost_price      DECIMAL(12,2) NOT NULL DEFAULT 0,
  wholesale_price DECIMAL(12,2) NULL,            -- second price list (contractor rate); NULL = retail price
  tax_rate_id     VARCHAR(40)   NULL,
  track_stock     TINYINT(1)    NOT NULL DEFAULT 0,
  track_expiry    TINYINT(1)    NOT NULL DEFAULT 0,  -- stock kept in batches with expiry dates (FEFO)
  stock           DECIMAL(12,3) NOT NULL DEFAULT 0,   -- per-branch stock moves to branch_stock when multi-branch goes live
  low_stock_at    DECIMAL(12,3) NOT NULL DEFAULT 0,
  is_veg          TINYINT(1)    NOT NULL DEFAULT 1,
  send_to_kitchen TINYINT(1)    NOT NULL DEFAULT 1,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id),
  INDEX ix_product_business (business_id, active),
  INDEX ix_product_barcode (business_id, barcode)
) ENGINE=InnoDB;

CREATE TABLE product_variants (
  id         VARCHAR(40)   PRIMARY KEY,
  product_id VARCHAR(40)   NOT NULL,
  name       VARCHAR(60)   NOT NULL,
  price      DECIMAL(12,2) NOT NULL,
  wholesale_price DECIMAL(12,2) NULL,
  sort       INT NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE product_addons (
  id         VARCHAR(40)   PRIMARY KEY,
  product_id VARCHAR(40)   NOT NULL,
  name       VARCHAR(60)   NOT NULL,
  price      DECIMAL(12,2) NOT NULL,
  sort       INT NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stock is per branch; products.stock is only a cached total.
CREATE TABLE branch_stock (
  branch_id  VARCHAR(40)   NOT NULL,
  product_id VARCHAR(40)   NOT NULL,
  qty        DECIMAL(12,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, product_id),
  FOREIGN KEY (branch_id)  REFERENCES branches(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Customers

CREATE TABLE customers (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  phone       VARCHAR(16)  NOT NULL DEFAULT '',   -- E.164 (unique per business when set)
  email       VARCHAR(150) NOT NULL DEFAULT '',
  address     VARCHAR(500) NOT NULL DEFAULT '',
  notes       VARCHAR(500) NOT NULL DEFAULT '',
  marketing_opt_in TINYINT(1) NOT NULL DEFAULT 1,
  price_tier  ENUM('retail','wholesale') NOT NULL DEFAULT 'retail',  -- wholesale = contractor / second price list
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX ix_customer_phone (business_id, phone)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Offers (WhatsApp share)

CREATE TABLE campaigns (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  date        DATE         NOT NULL,
  channel     ENUM('whatsapp') NOT NULL DEFAULT 'whatsapp',
  message     TEXT         NOT NULL,
  product_ids JSON         NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by  VARCHAR(40)  NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  INDEX ix_campaign_date (business_id, date)
) ENGINE=InnoDB;

CREATE TABLE campaign_sends (
  campaign_id VARCHAR(40) NOT NULL,
  customer_id VARCHAR(40) NOT NULL,
  sent_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_by     VARCHAR(40) NOT NULL,
  PRIMARY KEY (campaign_id, customer_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Restaurant module

CREATE TABLE dining_tables (
  id          VARCHAR(40) PRIMARY KEY,
  business_id VARCHAR(40) NOT NULL,
  branch_id   VARCHAR(40) NOT NULL,
  label       VARCHAR(20) NOT NULL,
  floor       VARCHAR(60) NOT NULL DEFAULT 'Main',
  seats       INT         NOT NULL DEFAULT 4,
  merged_into VARCHAR(40) NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (branch_id)   REFERENCES branches(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Orders / invoices

CREATE TABLE orders (
  id             VARCHAR(40)   PRIMARY KEY,
  business_id    VARCHAR(40)   NOT NULL,
  branch_id      VARCHAR(40)   NOT NULL,
  number         VARCHAR(30)   NOT NULL,
  invoice_number VARCHAR(30)   NULL,
  type           ENUM('counter','dine_in','takeaway','delivery') NOT NULL,
  source         ENUM('pos','mobile','table') NOT NULL DEFAULT 'pos',
  table_id       VARCHAR(40)   NULL,
  customer_id    VARCHAR(40)   NULL,
  status         ENUM('open','completed','cancelled') NOT NULL DEFAULT 'open',
  payment_status ENUM('unpaid','partial','paid') NOT NULL DEFAULT 'unpaid',
  notes          VARCHAR(500)  NOT NULL DEFAULT '',
  subtotal       DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax            DECIMAL(12,2) NOT NULL DEFAULT 0,
  round_off      DECIMAL(6,2)  NOT NULL DEFAULT 0,
  total          DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid           DECIMAL(12,2) NOT NULL DEFAULT 0,
  balance        DECIMAL(12,2) NOT NULL DEFAULT 0,
  billed_at      DATETIME(3)   NULL,
  cancelled_at   DATETIME(3)   NULL,
  cancel_reason  VARCHAR(200)  NULL,
  qr_status      ENUM('pending','accepted','rejected') NULL,
  fulfilment     ENUM('new','packing','ready','delivered') NULL,  -- customer-order board stage
  guest_name     VARCHAR(120)  NULL,
  guest_phone    VARCHAR(16)   NULL,                -- E.164
  guest_address  VARCHAR(500)  NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (branch_id)   REFERENCES branches(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (table_id)    REFERENCES dining_tables(id),
  UNIQUE KEY uq_order_number (business_id, branch_id, number),
  UNIQUE KEY uq_invoice_number (business_id, branch_id, invoice_number),
  INDEX ix_order_billed (business_id, branch_id, status, billed_at),
  INDEX ix_order_open (business_id, branch_id, status, table_id),
  INDEX ix_order_customer (customer_id, status)
) ENGINE=InnoDB;

-- Line items are snapshots: name/price/tax are copied so later catalogue edits never change old bills.
CREATE TABLE order_items (
  id           VARCHAR(40)   PRIMARY KEY,
  order_id     VARCHAR(40)   NOT NULL,
  product_id   VARCHAR(40)   NOT NULL,
  name         VARCHAR(150)  NOT NULL,
  variant_id   VARCHAR(40)   NULL,
  variant_name VARCHAR(60)   NULL,
  addons       JSON          NOT NULL,      -- [{"id","name","price"}]
  qty          DECIMAL(12,3) NOT NULL,
  unit         VARCHAR(20)   NOT NULL,
  unit_price   DECIMAL(12,2) NOT NULL,      -- base/variant + add-ons
  price_tier   ENUM('retail','wholesale') NOT NULL DEFAULT 'retail',
  tax_rate     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  notes        VARCHAR(200)  NOT NULL DEFAULT '',
  kot_qty      DECIMAL(12,3) NOT NULL DEFAULT 0,
  FOREIGN KEY (order_id)   REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX ix_item_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE payments (
  id          VARCHAR(40)   PRIMARY KEY,
  business_id VARCHAR(40)   NOT NULL,
  branch_id   VARCHAR(40)   NOT NULL,
  order_id    VARCHAR(40)   NULL,
  customer_id VARCHAR(40)   NULL,
  method      ENUM('cash','upi','card','bank','credit','credit_note') NOT NULL,
  kind        ENUM('sale','due_collection','refund') NOT NULL DEFAULT 'sale',
  amount      DECIMAL(12,2) NOT NULL,
  reference   VARCHAR(80)   NOT NULL DEFAULT '',
  voided      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (order_id)    REFERENCES orders(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  INDEX ix_payment_date (business_id, branch_id, created_at),
  INDEX ix_payment_order (order_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Kitchen module

CREATE TABLE kitchen_tickets (
  id           VARCHAR(40) PRIMARY KEY,
  business_id  VARCHAR(40) NOT NULL,
  branch_id    VARCHAR(40) NOT NULL,
  number       VARCHAR(20) NOT NULL,
  order_id     VARCHAR(40) NOT NULL,
  order_number VARCHAR(30) NOT NULL,
  order_type   ENUM('counter','dine_in','takeaway','delivery') NOT NULL,
  table_label  VARCHAR(20) NULL,
  status       ENUM('new','preparing','ready','completed','cancelled') NOT NULL DEFAULT 'new',
  status_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  INDEX ix_kot_status (business_id, branch_id, status, created_at)
) ENGINE=InnoDB;

CREATE TABLE kitchen_ticket_items (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(40)   NOT NULL,
  name      VARCHAR(250)  NOT NULL,
  qty       DECIMAL(12,3) NOT NULL,
  notes     VARCHAR(200)  NOT NULL DEFAULT '',
  is_veg    TINYINT(1)    NOT NULL DEFAULT 1,
  FOREIGN KEY (ticket_id) REFERENCES kitchen_tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Expenses & inventory

CREATE TABLE expenses (
  id          VARCHAR(40)   PRIMARY KEY,
  business_id VARCHAR(40)   NOT NULL,
  branch_id   VARCHAR(40)   NOT NULL,
  date        DATETIME(3)   NOT NULL,
  category    ENUM('purchase','salary','rent','electricity','transport','maintenance','other') NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  method      ENUM('cash','upi','card','bank','credit') NOT NULL,
  notes       VARCHAR(300)  NOT NULL DEFAULT '',
  voided      TINYINT(1)    NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  INDEX ix_expense_date (business_id, branch_id, date)
) ENGINE=InnoDB;

CREATE TABLE stock_movements (
  id            VARCHAR(40)   PRIMARY KEY,
  business_id   VARCHAR(40)   NOT NULL,
  branch_id     VARCHAR(40)   NOT NULL,
  product_id    VARCHAR(40)   NOT NULL,
  type          ENUM('opening','purchase','sale','damage','wastage','adjustment','return') NOT NULL,
  qty           DECIMAL(12,3) NOT NULL,   -- signed
  balance_after DECIMAL(12,3) NOT NULL,
  ref_id        VARCHAR(40)   NULL,       -- order / purchase id
  note          VARCHAR(200)  NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX ix_stock_product (product_id, created_at)
) ENGINE=InnoDB;

-- Batches with expiry (only for products.track_expiry). Sales consume first-expiry-first-out;
-- stock_movements stay the source of truth for quantity history.
CREATE TABLE stock_batches (
  id           VARCHAR(40)   PRIMARY KEY,
  business_id  VARCHAR(40)   NOT NULL,
  branch_id    VARCHAR(40)   NOT NULL,
  product_id   VARCHAR(40)   NOT NULL,
  batch_no     VARCHAR(40)   NOT NULL DEFAULT '',
  expiry       DATE          NULL,
  qty          DECIMAL(12,3) NOT NULL DEFAULT 0,   -- remaining
  received_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), updated_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id),
  INDEX ix_batch_expiry (business_id, branch_id, expiry),
  INDEX ix_batch_product (product_id, branch_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Audit

CREATE TABLE audit_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  entity      VARCHAR(40)  NOT NULL,
  entity_id   VARCHAR(40)  NOT NULL,
  action      VARCHAR(40)  NOT NULL,
  user_id     VARCHAR(40)  NOT NULL,
  at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  detail      VARCHAR(500) NOT NULL DEFAULT '',
  INDEX ix_audit_entity (business_id, entity, entity_id),
  INDEX ix_audit_time (business_id, at)
) ENGINE=InnoDB;


-- ---------- Product admin (platform level, not per business) ----------

CREATE TABLE platform_admins (
  id            VARCHAR(40)  PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  username      VARCHAR(30)  NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('super','manager','support') NOT NULL DEFAULT 'support',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE subscription_periods (
  id              VARCHAR(40)  PRIMARY KEY,
  business_id     VARCHAR(40)  NOT NULL,
  kind            ENUM('new','renew','extend','change') NOT NULL,
  start_at        DATETIME(3)  NOT NULL,
  end_at          DATETIME(3)  NOT NULL,
  months          TINYINT      NULL,                 -- NULL = custom end date
  branches        SMALLINT     NOT NULL,
  price_per_branch DECIMAL(10,2) NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  note            VARCHAR(300) NOT NULL DEFAULT '',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by      VARCHAR(40)  NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX (business_id, created_at)
);

-- Kept after a customer is deleted (no FK on business_id).
CREATE TABLE admin_audit_logs (
  id            VARCHAR(40)  PRIMARY KEY,
  at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  admin_id      VARCHAR(40)  NOT NULL,
  admin_name    VARCHAR(120) NOT NULL,
  action        VARCHAR(20)  NOT NULL,   -- create, update, password, renew, branch_limit, activate, deactivate, delete, settings
  business_id   VARCHAR(40)  NULL,
  business_name VARCHAR(150) NOT NULL DEFAULT '',
  detail        VARCHAR(500) NOT NULL DEFAULT '',
  INDEX (business_id), INDEX (at)
);

CREATE TABLE platform_settings (
  id                     TINYINT PRIMARY KEY DEFAULT 1,
  price_per_branch_month DECIMAL(10,2) NOT NULL DEFAULT 499
);

-- Feature releases: off / selected customers / all customers.
CREATE TABLE feature_flags (
  feature_key VARCHAR(40) PRIMARY KEY,               -- e.g. 'whatsapp'
  mode        ENUM('off','selected','all') NOT NULL DEFAULT 'off',
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by  VARCHAR(40) NULL
);
CREATE TABLE feature_flag_customers (
  feature_key VARCHAR(40) NOT NULL,
  business_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (feature_key, business_id),
  FOREIGN KEY (feature_key) REFERENCES feature_flags(feature_key) ON DELETE CASCADE,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

-- ---------- WhatsApp Business integration (per customer) ----------

CREATE TABLE whatsapp_accounts (
  business_id      VARCHAR(40)  PRIMARY KEY,
  enabled          TINYINT(1)   NOT NULL DEFAULT 1,
  provider         VARCHAR(20)  NOT NULL DEFAULT 'meta_cloud',
  business_number  VARCHAR(16)  NOT NULL DEFAULT '',   -- E.164, the customer's own number
  waba_id          VARCHAR(20)  NOT NULL DEFAULT '',
  phone_number_id  VARCHAR(20)  NOT NULL DEFAULT '',
  access_token_enc VARBINARY(2048) NULL,              -- AES-GCM encrypted; never returned to the browser
  token_last4      CHAR(4)      NOT NULL DEFAULT '',
  verified_name    VARCHAR(150) NULL,
  quality_rating   VARCHAR(10)  NULL,
  verified_at      DATETIME(3)  NULL,
  auto_send_bill   TINYINT(1)   NOT NULL DEFAULT 0,
  finished_at      DATETIME(3)  NULL,
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE whatsapp_templates (
  business_id   VARCHAR(40)  NOT NULL,
  kind          ENUM('offer','bill') NOT NULL,
  meta_name     VARCHAR(80)  NOT NULL,                 -- daily_offer / bill_receipt (+ language)
  language      VARCHAR(8)   NOT NULL,                 -- en / ta
  category      ENUM('MARKETING','UTILITY') NOT NULL,
  body          TEXT         NOT NULL,                 -- {{field}} placeholders, mapped to {{1}}… when submitting
  attach        TINYINT(1)   NOT NULL DEFAULT 1,       -- image (offer) / PDF document (bill) header
  status        ENUM('draft','pending','approved','rejected') NOT NULL DEFAULT 'draft',
  reject_reason VARCHAR(500) NULL,
  meta_id       VARCHAR(40)  NULL,
  submitted_at  DATETIME(3)  NULL,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, kind),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE whatsapp_messages (
  id            VARCHAR(40)  PRIMARY KEY,
  business_id   VARCHAR(40)  NOT NULL,
  kind          ENUM('bill','offer','test') NOT NULL,
  to_number     VARCHAR(16)  NOT NULL,
  customer_id   VARCHAR(40)  NULL,
  ref_id        VARCHAR(40)  NULL,                     -- order id / campaign id
  body          TEXT         NOT NULL,
  attachment    VARCHAR(200) NULL,
  meta_message_id VARCHAR(80) NULL,
  status        ENUM('sent','delivered','read','failed') NOT NULL DEFAULT 'sent',  -- updated by Meta's webhook
  error         VARCHAR(300) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by    VARCHAR(40)  NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX (business_id, created_at), INDEX (meta_message_id)
);

-- Every stored photo (product / category). Files live in object storage; this keeps their facts.
CREATE TABLE media_files (
  id             VARCHAR(40)  PRIMARY KEY,
  business_id    VARCHAR(40)  NOT NULL,
  url            VARCHAR(500) NOT NULL,
  thumb_url      VARCHAR(500) NOT NULL,
  format         ENUM('webp','jpeg') NOT NULL,
  bytes          INT          NOT NULL,               -- always ≤ 51200
  width          SMALLINT     NOT NULL,
  height         SMALLINT     NOT NULL,
  quality        TINYINT      NOT NULL,
  original_bytes INT          NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by     VARCHAR(40)  NOT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- Returns, refunds & credit notes

CREATE TABLE sale_returns (
  id              VARCHAR(40)   PRIMARY KEY,
  business_id     VARCHAR(40)   NOT NULL,
  branch_id       VARCHAR(40)   NOT NULL,
  number          VARCHAR(30)   NOT NULL,              -- CN-1001 (sequences.name = 'credit_note')
  order_id        VARCHAR(40)   NOT NULL,
  customer_id     VARCHAR(40)   NULL,
  reason          ENUM('damaged','wrong_item','not_needed','expired','other') NOT NULL,
  note            VARCHAR(300)  NOT NULL DEFAULT '',
  total           DECIMAL(12,2) NOT NULL,
  due_adjusted    DECIMAL(12,2) NOT NULL DEFAULT 0,      -- taken off the bill's balance first
  refunded        DECIMAL(12,2) NOT NULL DEFAULT 0,      -- paid back (payments.kind = 'refund')
  refund_method   ENUM('cash','upi','card','bank') NULL,
  credit_issued   DECIMAL(12,2) NOT NULL DEFAULT 0,      -- or kept as a credit note
  credit_remaining DECIMAL(12,2) NOT NULL DEFAULT 0,     -- reduced by payments.method = 'credit_note'
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  UNIQUE KEY uq_return_number (business_id, number),
  INDEX ix_return_date (business_id, branch_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE sale_return_items (
  id            VARCHAR(40)   PRIMARY KEY,
  return_id     VARCHAR(40)   NOT NULL,
  order_item_id VARCHAR(40)   NOT NULL,
  qty           DECIMAL(12,3) NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,                -- incl. tax, after the bill's discount share
  restock       TINYINT(1)    NOT NULL DEFAULT 1,      -- 1 → stock_movements reason 'return'; 0 = damaged
  FOREIGN KEY (return_id) REFERENCES sale_returns(id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id) REFERENCES order_items(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Staff attendance & salary

CREATE TABLE attendance (
  business_id VARCHAR(40) NOT NULL,
  user_id     VARCHAR(40) NOT NULL,
  day         DATE        NOT NULL,
  status      ENUM('present','half','absent','leave') NOT NULL,
  in_time     TIME        NULL,
  note        VARCHAR(200) NOT NULL DEFAULT '',
  marked_by   VARCHAR(40) NOT NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE staff_advances (
  id          VARCHAR(40)   PRIMARY KEY,
  business_id VARCHAR(40)   NOT NULL,
  user_id     VARCHAR(40)   NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  method      ENUM('cash','upi','bank') NOT NULL,
  note        VARCHAR(200)  NOT NULL DEFAULT '',
  expense_id  VARCHAR(40)   NOT NULL,                  -- also booked as a salary expense
  salary_id   VARCHAR(40)   NULL,                      -- set when deducted from a salary
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE salary_payments (
  id            VARCHAR(40)   PRIMARY KEY,
  business_id   VARCHAR(40)   NOT NULL,
  user_id       VARCHAR(40)   NOT NULL,
  month         CHAR(7)       NOT NULL,                -- 2026-10
  days_worked   DECIMAL(4,1)  NOT NULL,
  base          DECIMAL(10,2) NOT NULL,
  commission    DECIMAL(10,2) NOT NULL DEFAULT 0,
  bonus         DECIMAL(10,2) NOT NULL DEFAULT 0,
  deductions    DECIMAL(10,2) NOT NULL DEFAULT 0,
  advances      DECIMAL(10,2) NOT NULL DEFAULT 0,
  net           DECIMAL(10,2) NOT NULL,
  method        ENUM('cash','upi','bank') NOT NULL,
  expense_id    VARCHAR(40)   NOT NULL,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_salary_month (user_id, month),          -- no double pay
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- Renewal reminders
-- platform_settings key 'reminders' = {enabled, daysBefore, template, supportContact}; key 'whatsapp' = platform WhatsApp account + template status; businesses.reminders_paused TINYINT(1).

CREATE TABLE reminder_log (
  id          VARCHAR(40)  PRIMARY KEY,
  business_id VARCHAR(40)  NOT NULL,
  period_end  DATETIME(3)  NOT NULL,                   -- which plan end this reminder is for
  days_left   SMALLINT     NOT NULL,
  channel     ENUM('whatsapp') NOT NULL DEFAULT 'whatsapp',
  to_number   VARCHAR(16)  NOT NULL,
  message     TEXT         NOT NULL,
  status      ENUM('sent','failed') NOT NULL,
  error       VARCHAR(300) NULL,
  `trigger`   ENUM('auto','manual') NOT NULL,
  admin_id    VARCHAR(40)  NULL,
  sent_on     DATE         NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_reminder_day (business_id, channel, sent_on),  -- the daily job skips a business already reminded today
  INDEX (business_id, period_end),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- Support tickets

CREATE TABLE tickets (
  id            VARCHAR(40)  PRIMARY KEY,
  number        VARCHAR(20)  NOT NULL UNIQUE,          -- T-1001
  business_id   VARCHAR(40)  NOT NULL,
  user_id       VARCHAR(40)  NOT NULL,
  subject       VARCHAR(120) NOT NULL,
  category      ENUM('billing','printer','stock','whatsapp','account','other') NOT NULL,
  priority      ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status        ENUM('open','in_progress','waiting','resolved','closed') NOT NULL DEFAULT 'open',
  assigned_to   VARCHAR(40)  NULL,                     -- platform_admins.id
  page          VARCHAR(200) NOT NULL DEFAULT '',
  browser       VARCHAR(300) NOT NULL DEFAULT '',
  app_version   VARCHAR(30)  NOT NULL DEFAULT '',
  unread_for_admin    TINYINT(1) NOT NULL DEFAULT 1,
  unread_for_customer TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX (business_id, updated_at), INDEX (status, updated_at),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE ticket_messages (
  id          VARCHAR(40)  PRIMARY KEY,
  ticket_id   VARCHAR(40)  NOT NULL,
  from_side   ENUM('customer','admin') NOT NULL,
  author_id   VARCHAR(40)  NOT NULL,
  author_name VARCHAR(120) NOT NULL,
  body        TEXT         NOT NULL,
  images      JSON         NOT NULL,                   -- up to 5 screenshot URLs (≤ 1600 px, ≤ 200 KB each)
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

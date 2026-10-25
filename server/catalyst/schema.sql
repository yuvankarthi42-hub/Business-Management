-- =====================================================================================================
--  BillPoodum — Zoho Catalyst Data Store schema
-- =====================================================================================================
--
--  Written as SQL-style DDL for reading and review. Catalyst tables are created in the console / CLI,
--  so each line maps 1:1 to a Catalyst column:
--
--    VARCHAR(n)      → Var Char, Max Length n (n ≤ 255)
--    TEXT            → Text (≤ 10,000 chars) — used for JSON documents and long text
--    ENCRYPTED       → Encrypted text (tokens, secrets)
--    BIGINT / INT / DOUBLE / BOOLEAN / DATE / DATETIME → same Catalyst types
--    FK → table [CASCADE | NULL]  → Foreign Key, Parent Table = table, On Delete = Cascade / Null
--    NOT NULL        → IsMandatory      UNIQUE → IsUnique      SEARCH → Search Index      PII → PII/ePHI
--    DEFAULT x       → Default Value
--
--  CONVENTIONS
--  1. Primary key: Catalyst's automatic ROWID (BigInt) in every table. ROWID, CREATORID, CREATEDTIME and
--     MODIFIEDTIME exist on every table and are NOT repeated below. Every foreign key points to a ROWID.
--  2. Multi-tenant: every customer-owned table has business_id (FK → businesses, CASCADE) so one business
--     can be exported or deleted completely; branch-level rows also carry branch_id. Every query from the
--     backend filters by business_id taken from the signed-in session — never from the request.
--  3. Money: BIGINT in minor units (paise) — *_minor columns. ₹ 1,234.50 → 123450. No Double for money.
--     Quantity: BIGINT in thousandths — *_milli (2.5 kg → 2500, 3 pcs → 3000).
--     Percent: INT in basis points — *_bp (18 % → 1800).
--  4. Fixed lists ("enums"): VARCHAR with the allowed values in the comment; the backend validates them.
--  5. Composite uniqueness: Catalyst's IsUnique works on one column, so a uniq_key column holds the
--     combined value, built by the backend, e.g. '<business_id>:<phone>'.
--  6. Joins only follow foreign keys and at most 4 per ZCQL query, so names that a list needs are copied
--     (snapshots such as order_items.product_name). Snapshots also keep old bills correct after edits.
--  7. Never hard-delete business records: is_active / is_voided / deleted_at. Bills and payments are
--     never updated after they are final — corrections are new rows (refund, return, void).
--  8. Optimistic locking: row_version INT on rows edited from many devices; updates check and add 1.
--  9. Offline / retry safety: client_uuid VARCHAR(40) UNIQUE on rows a device creates (bills, payments,
--     KOTs, returns), so a re-sent request never creates a duplicate.
-- 10. Created / changed by: created_by / updated_by = the app user (FK → users). CREATORID is the
--     Catalyst account and stays as the technical owner.
-- 11. Files (photos, screenshots, posters) live in Stratus; tables keep only the object key (media_files).
-- 12. Flexible settings: JSON in TEXT columns, each with a schema_version, so new options need no new column.
-- 13. REQ FK → x NULL: the backend always fills it, but IsMandatory is left off because the parent (a user,
--     admin, product…) is only soft-deleted; On Delete = Null keeps history rows if one is ever removed.
--     Plain FK → x CASCADE rows belong to the parent and go with it (business delete wipes everything).
--
-- =====================================================================================================


-- =====================================================================================================
--  1. PLATFORM (product admin)
-- =====================================================================================================

CREATE TABLE platform_admins (
  name             VARCHAR(120) NOT NULL,
  username         VARCHAR(40)  NOT NULL UNIQUE,
  email            VARCHAR(150) PII,
  password_hash    VARCHAR(100) NOT NULL,               -- bcrypt
  token_version    INT          NOT NULL DEFAULT 1,     -- +1 on password change / sign out everywhere
  failed_logins    INT          NOT NULL DEFAULT 0,
  locked_until     DATETIME,
  role             INT          NOT NULL,               -- AdminRole: 1 super, 2 manager, 3 support
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_login_at    DATETIME
);

-- Key / value platform settings: 'pricing', 'reminders', 'whatsapp', …
-- 'reminders' = {enabled, daysBefore, supportContact, lastRunOn} — the daily Cron skips when lastRunOn = today,
-- so a re-run never sends twice. Reminder history = whatsapp_messages (kind 'renewal_reminder').
CREATE TABLE platform_settings (
  setting_key      VARCHAR(60)  NOT NULL UNIQUE,
  value_json       TEXT         NOT NULL,
  schema_version   INT          NOT NULL DEFAULT 1,
  updated_by       BIGINT       FK → platform_admins NULL
);

-- Secrets (WhatsApp tokens etc.) — the only place they are kept. Never returned to a browser.
CREATE TABLE secrets (
  owner_type       INT          NOT NULL,               -- SecretOwner: 1 platform, 2 business
  business_id      BIGINT       FK → businesses CASCADE, -- NULL for platform secrets
  kind             INT          NOT NULL,               -- SecretKind: 1 whatsapp_token
  value            ENCRYPTED    NOT NULL,
  last4            VARCHAR(4),
  uniq_key         VARCHAR(120) NOT NULL UNIQUE         -- '<owner_type>:<business_id|0>:<kind>'
);

-- Plans the product sells (today: price per branch per month). Lets pricing change without code.
CREATE TABLE plans (
  code             VARCHAR(30)  NOT NULL UNIQUE,        -- standard | …
  name             VARCHAR(80)  NOT NULL,
  price_per_branch_month_minor BIGINT NOT NULL,
  features_json    TEXT,                                -- feature keys included
  is_active        BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE feature_flags (
  feature_key      VARCHAR(40)  NOT NULL UNIQUE,        -- whatsapp | …
  name             VARCHAR(80)  NOT NULL,
  rollout          INT          NOT NULL DEFAULT 1,     -- Rollout: 1 off, 2 selected, 3 all
  description      VARCHAR(255),
  updated_by       BIGINT       FK → platform_admins NULL
);


-- =====================================================================================================
--  2. BUSINESS (tenant) & BRANCHES
-- =====================================================================================================

CREATE TABLE businesses (
  name             VARCHAR(150) NOT NULL SEARCH,
  category         INT          NOT NULL,               -- BusinessCategory: 1 retail, 2 food, 3 restaurant, 4 service
  sub_type         VARCHAR(60)  NOT NULL,               -- Supermarket | Hardware | Fast Food | Bakery | … (picks terminology & defaults)
  phone            VARCHAR(16)  SEARCH PII,             -- E.164
  email            VARCHAR(150) PII,
  address          VARCHAR(255),
  city             VARCHAR(80),
  state            VARCHAR(80),
  country_code     VARCHAR(2)   NOT NULL DEFAULT 'IN',  -- ISO 3166
  currency_code    VARCHAR(3)   NOT NULL DEFAULT 'INR', -- ISO 4217
  currency_symbol  VARCHAR(5)   NOT NULL DEFAULT '₹',
  timezone         VARCHAR(40)  NOT NULL DEFAULT 'Asia/Kolkata',
  gstin            VARCHAR(15),
  logo_media_id    BIGINT,                              -- → media_files.ROWID (no FK: media_files refers back here).
                                                        -- NULL = the app shows the default icon for category / sub_type; no emoji column.
  status           INT          NOT NULL DEFAULT 1,     -- BusinessStatus: 1 active, 2 deactivated
  plan_id          BIGINT       FK → plans NULL,
  max_branches     INT          NOT NULL DEFAULT 1,
  subscription_start_at DATETIME,
  subscription_end_at   DATETIME,                       -- after this: read-only
  reminders_paused BOOLEAN      NOT NULL DEFAULT false,
  admin_note       VARCHAR(255),                        -- product admin only, never shown to the customer
  onboarded_at     DATETIME,
  deleted_at       DATETIME,                            -- set when the admin deletes the customer (download the export first)
  -- Directory for the product admin's customer list (copies kept up to date by the API, so the list never
  -- has to open every shop's own database):
  owner_user_id    BIGINT,                              -- → users.ROWID of the owner login (in the shop's database)
  owner_name       VARCHAR(120),
  owner_username   VARCHAR(40),
  owner_phone      VARCHAR(16)  PII,                    -- E.164, the owner's sign-in mobile (renewal reminders go here)
  owner_email      VARCHAR(150) PII,
  branches_used    INT          NOT NULL DEFAULT 1,
  last_login_at    DATETIME,                            -- newest sign-in of any user of this shop
  last_activity_at DATETIME,                            -- newest change (updated at most once an hour)
  row_version      INT          NOT NULL DEFAULT 1
);

-- Key / value business settings: 'billing', 'terminology', 'modules', 'qr', 'wholesale', … (JSON each).
CREATE TABLE business_settings (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  setting_key      VARCHAR(40)  NOT NULL,
  value_json       TEXT         NOT NULL,
  schema_version   INT          NOT NULL DEFAULT 1,
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE,        -- '<business_id>:<setting_key>'
  updated_by       BIGINT       FK → users NULL
);

CREATE TABLE subscription_periods (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  kind             INT          NOT NULL,               -- PeriodKind: 1 new, 2 renew, 3 extend, 4 change
  start_at         DATETIME     NOT NULL,
  end_at           DATETIME     NOT NULL,
  months           INT,                                 -- NULL for custom dates
  branches         INT          NOT NULL,
  price_per_branch_minor BIGINT NOT NULL,               -- rate used (prices can change later)
  amount_minor     BIGINT       NOT NULL,
  payment_ref      VARCHAR(80),
  note             VARCHAR(255),
  admin_id         BIGINT       REQ FK → platform_admins NULL
);

-- Features released to selected customers (feature_flags.rollout = 'selected').
CREATE TABLE feature_flag_businesses (
  feature_flag_id  BIGINT       NOT NULL FK → feature_flags CASCADE,
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  uniq_key         VARCHAR(60)  NOT NULL UNIQUE         -- '<feature_flag_id>:<business_id>'
);

CREATE TABLE branches (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(120) NOT NULL,
  code             VARCHAR(10),                         -- short code, e.g. ADY
  address          VARCHAR(255),
  phone            VARCHAR(16)  PII,
  gstin            VARCHAR(15),                         -- a branch in another state has its own GSTIN
  is_default       BOOLEAN      NOT NULL DEFAULT false,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  invoice_prefix   VARCHAR(10),                         -- own bill series, e.g. 'AD-'; NULL = business series
  printer_json     TEXT,                                -- receipt printer setup: {transport, paper, mode, autoPrint, copies, cut, drawer, baudRate}
  row_version      INT          NOT NULL DEFAULT 1
);

-- Number series (bill, order, KOT, credit note, ticket …). Read-and-increment with row_version check.
CREATE TABLE sequences (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       FK → branches CASCADE,  -- NULL = business-wide series
  name             INT          NOT NULL,               -- SequenceName: 1 invoice, 2 order, 3 kot, 4 credit_note, 5 purchase
  prefix           VARCHAR(20)  NOT NULL DEFAULT '',
  next_value       BIGINT       NOT NULL DEFAULT 1,
  fiscal_year      VARCHAR(9),                          -- '2026-27' when the series restarts every April
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE,        -- '<business_id>:<branch_id|0>:<name>:<fiscal_year|->'
  row_version      INT          NOT NULL DEFAULT 1
);

-- POS devices (counters, waiter phones, kitchen screens). For offline sync.
CREATE TABLE devices (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  name             VARCHAR(80)  NOT NULL,               -- 'Counter 1'
  kind             INT          NOT NULL,               -- DeviceKind: 1 counter, 2 waiter, 3 kitchen, 4 display
  device_uuid      VARCHAR(40)  NOT NULL UNIQUE,
  platform         INT,                                -- DevicePlatform: 1 web, 2 android, 3 ios
  app_version      VARCHAR(20),
  last_seen_at     DATETIME,
  last_sync_at     DATETIME,
  is_active        BOOLEAN      NOT NULL DEFAULT true
);

-- Images and files stored in Stratus.
CREATE TABLE media_files (
  business_id      BIGINT       FK → businesses CASCADE, -- NULL = platform file
  purpose          INT          NOT NULL,               -- MediaPurpose: 1 product, 2 category, 3 logo, 4 ticket, 5 poster
  bucket           VARCHAR(60)  NOT NULL,
  object_key       VARCHAR(255) NOT NULL UNIQUE,        -- '<business_id>/products/<uuid>.webp'
  thumb_key        VARCHAR(255),
  content_type     VARCHAR(40)  NOT NULL,               -- image/webp | application/zip | …
  bytes            BIGINT       NOT NULL,               -- photos ≤ 51,200
  width            INT,
  height           INT,
  original_bytes   BIGINT,
  created_by       BIGINT       FK → users NULL
);


-- =====================================================================================================
--  3. USERS, ROLES & PERMISSIONS
-- =====================================================================================================

CREATE TABLE roles (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(60)  NOT NULL,               -- Owner | Manager | Cashier | Waiter | Kitchen | custom
  system_key       INT,                                -- RoleKey: 1 owner, 2 manager, 3 cashier, 4 waiter, 5 kitchen; NULL = custom role
  is_all_access    BOOLEAN      NOT NULL DEFAULT false, -- owner
  uniq_key         VARCHAR(100) NOT NULL UNIQUE         -- '<business_id>:<lower(name)>'
);

CREATE TABLE role_permissions (
  role_id          BIGINT       NOT NULL FK → roles CASCADE,
  permission       VARCHAR(40)  NOT NULL,               -- billing.create | orders.cancel | reports.profit | …
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE         -- '<role_id>:<permission>'
);

CREATE TABLE users (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  role_id          BIGINT       REQ FK → roles NULL,
  default_branch_id BIGINT      FK → branches NULL,
  name             VARCHAR(120) NOT NULL SEARCH,
  phone            VARCHAR(16)  NOT NULL UNIQUE SEARCH PII, -- E.164, sign-in ID
  email            VARCHAR(150) PII,
  username         VARCHAR(40)  UNIQUE,                 -- owner login created by the product admin
  catalyst_user_id BIGINT       UNIQUE,                 -- only if Catalyst Authentication is used later
  password_hash    VARCHAR(100),                        -- bcrypt of the password the admin gives; never plain text
  can_login        BOOLEAN      NOT NULL DEFAULT true,  -- false = staff who don't use the app (cleaners, helpers): attendance & salary only
  must_change_password BOOLEAN  NOT NULL DEFAULT true,  -- ask for a new password on first sign-in
  password_changed_at DATETIME,
  failed_logins    INT          NOT NULL DEFAULT 0,     -- lock for 15 min after 5 wrong tries
  locked_until     DATETIME,
  token_version    INT          NOT NULL DEFAULT 1,     -- in the sign-in token; +1 on password reset / turn off → old sessions end
  language         VARCHAR(5)   NOT NULL DEFAULT 'en',  -- en | ta | …
  pin_hash         VARCHAR(100),                        -- optional quick PIN for shared counters (bcrypt)
  -- staff pay
  pay_type         INT,                                -- PayType: 1 monthly, 2 daily; NULL = not on payroll
  pay_amount_minor BIGINT       NOT NULL DEFAULT 0,
  commission_bp    INT          NOT NULL DEFAULT 0,     -- % of own net sales
  joined_on        DATE,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_login_at    DATETIME,
  row_version      INT          NOT NULL DEFAULT 1
);

-- Branches a staff member may work in (all-access roles don't need rows).
CREATE TABLE user_branches (
  user_id          BIGINT       NOT NULL FK → users CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  uniq_key         VARCHAR(60)  NOT NULL UNIQUE         -- '<user_id>:<branch_id>'
);


-- =====================================================================================================
--  4. CATALOGUE (products / menu)
-- =====================================================================================================

CREATE TABLE tax_rates (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(40)  NOT NULL,               -- 'GST 5%'
  rate_bp          INT          NOT NULL,               -- 500
  is_inclusive     BOOLEAN      NOT NULL DEFAULT false, -- prices include tax
  is_default       BOOLEAN      NOT NULL DEFAULT false,
  is_active        BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE categories (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  parent_id        BIGINT       FK → categories NULL,   -- sub-categories later
  name             VARCHAR(80)  NOT NULL SEARCH,
  emoji            VARCHAR(8),
  image_media_id   BIGINT       FK → media_files NULL,
  hsn_code         VARCHAR(10),                         -- default HSN / SAC for items in this category (item's own wins)
  sort_order       INT          NOT NULL DEFAULT 0,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  uniq_key         VARCHAR(120) NOT NULL UNIQUE         -- '<business_id>:<lower(name)>'
);

CREATE TABLE products (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  category_id      BIGINT       FK → categories NULL,
  tax_rate_id      BIGINT       FK → tax_rates NULL,
  name             VARCHAR(150) NOT NULL SEARCH,
  name_local       VARCHAR(150) SEARCH,                 -- Tamil name for bills / labels
  kind             INT          NOT NULL DEFAULT 1,     -- ProductKind: 1 goods, 2 service
  sku              VARCHAR(40),
  barcode          VARCHAR(40)  SEARCH,
  barcode_key      VARCHAR(80)  UNIQUE,                 -- '<business_id>:<barcode>' (NULL when no barcode)
  hsn_code         VARCHAR(10),
  unit             VARCHAR(10)  NOT NULL DEFAULT 'pc',  -- pc | kg | g | ltr | ml | pack | box | bottle | plate | … (open list: templates and CSV add more)
  price_minor      BIGINT       NOT NULL DEFAULT 0,     -- retail price (default price list)
  mrp_minor        BIGINT,
  cost_minor       BIGINT,
  is_veg           BOOLEAN,                             -- food only
  sends_to_kitchen BOOLEAN      NOT NULL DEFAULT true,  -- KOT
  track_stock      BOOLEAN      NOT NULL DEFAULT false,
  track_batches    BOOLEAN      NOT NULL DEFAULT false, -- batch & expiry
  low_stock_milli  BIGINT       NOT NULL DEFAULT 0,
  image_media_id   BIGINT       FK → media_files NULL,
  emoji            VARCHAR(8),
  details_json     TEXT,                                -- textile shops: {"design","fabric","colour","size"} (printed on price stickers)
  sort_order       INT          NOT NULL DEFAULT 0,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE product_variants (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  name             VARCHAR(60)  NOT NULL,               -- Half | Full | 500 ml
  price_minor      BIGINT       NOT NULL,
  barcode          VARCHAR(40),
  barcode_key      VARCHAR(80)  UNIQUE,
  sort_order       INT          NOT NULL DEFAULT 0,
  is_active        BOOLEAN      NOT NULL DEFAULT true
);

CREATE TABLE product_addons (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  name             VARCHAR(60)  NOT NULL,               -- Extra cheese
  price_minor      BIGINT       NOT NULL DEFAULT 0,
  sort_order       INT          NOT NULL DEFAULT 0,
  is_active        BOOLEAN      NOT NULL DEFAULT true
);

-- Price lists: Retail (default) + any number of others (Contractor, Wholesale, Dealer…).
CREATE TABLE price_lists (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(60)  NOT NULL,               -- 'Contractor rate'
  is_default       BOOLEAN      NOT NULL DEFAULT false, -- retail = products.price_minor
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  uniq_key         VARCHAR(100) NOT NULL UNIQUE         -- '<business_id>:<lower(name)>'
);

-- Price of an item (or one of its sizes) on a non-default price list. Missing row → retail price.
CREATE TABLE product_prices (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  price_list_id    BIGINT       NOT NULL FK → price_lists CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  variant_id       BIGINT       FK → product_variants CASCADE,
  price_minor      BIGINT       NOT NULL,
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE         -- '<price_list_id>:<product_id>:<variant_id|0>'
);

-- Daily specials (offer price / tag for a date).
CREATE TABLE daily_specials (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       FK → branches CASCADE,  -- NULL = all branches
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  special_date     DATE         NOT NULL,
  offer_price_minor BIGINT,
  tag              VARCHAR(40),                         -- 'Chef’s special'
  sort_order       INT          NOT NULL DEFAULT 0
);


-- =====================================================================================================
--  5. INVENTORY & PURCHASES
-- =====================================================================================================

-- Current stock per item per branch (kept in step with stock_movements by the backend).
CREATE TABLE branch_stock (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  qty_milli        BIGINT       NOT NULL DEFAULT 0,
  uniq_key         VARCHAR(60)  NOT NULL UNIQUE,        -- '<branch_id>:<product_id>'
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE suppliers (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(150) NOT NULL SEARCH,
  phone            VARCHAR(16)  SEARCH PII,
  gstin            VARCHAR(15),
  address          VARCHAR(255),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  state_code       VARCHAR(2),                          -- GST state (01–38); from the GSTIN when given — decides IGST vs CGST + SGST
  opening_balance_minor BIGINT  NOT NULL DEFAULT 0,     -- owed to the supplier before using the app (+) or advance paid (−)
  notes            VARCHAR(255),
  name_key         VARCHAR(200),                        -- '<business_id>:<lower(name)>' — duplicate check (enforced by the API)
  row_version      INT          NOT NULL DEFAULT 1
);

-- Purchase / stock-in bills.
CREATE TABLE purchases (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  supplier_id      BIGINT       FK → suppliers NULL,
  number           VARCHAR(30)  NOT NULL,
  supplier_bill_no VARCHAR(40),
  purchase_date    DATE         NOT NULL,
  subtotal_minor   BIGINT       NOT NULL DEFAULT 0,
  tax_minor        BIGINT       NOT NULL DEFAULT 0,
  total_minor      BIGINT       NOT NULL DEFAULT 0,
  paid_minor       BIGINT       NOT NULL DEFAULT 0,
  status           INT          NOT NULL DEFAULT 2,     -- PurchaseStatus: 1 draft, 2 final, 3 void
  note             VARCHAR(255),
  created_by       BIGINT       REQ FK → users NULL,
  client_uuid      VARCHAR(40),                         -- retry safety (checked by the API before insert)
  is_igst          BOOLEAN      NOT NULL DEFAULT false, -- supplier in another state: tax is IGST (input credit)
  round_off_minor  BIGINT       NOT NULL DEFAULT 0,
  void_reason      VARCHAR(255),
  voided_at        DATETIME,
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE purchase_items (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  purchase_id      BIGINT       NOT NULL FK → purchases CASCADE,
  product_id       BIGINT       REQ FK → products NULL,
  product_name     VARCHAR(150) NOT NULL,               -- snapshot
  qty_milli        BIGINT       NOT NULL,
  cost_minor       BIGINT       NOT NULL,               -- per unit
  tax_bp           INT          NOT NULL DEFAULT 0,
  batch_no         VARCHAR(40),
  expiry_date      DATE,
  unit             VARCHAR(10),
  hsn_code         VARCHAR(10),
  taxable_minor    BIGINT,                              -- qty × cost (before GST)
  tax_minor        BIGINT,
  sort_order       INT          NOT NULL DEFAULT 0
);

-- Money paid to a supplier (at purchase, or later against the balance). Voided, never edited.
CREATE TABLE supplier_payments (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  supplier_id      BIGINT       NOT NULL FK → suppliers CASCADE,
  purchase_id      BIGINT       FK → purchases NULL,    -- paid with this purchase bill; NULL = against the balance
  client_uuid      VARCHAR(40)  NOT NULL UNIQUE,
  method           INT          NOT NULL,               -- PayMethod: 1 cash, 2 upi, 3 card, 4 bank
  amount_minor     BIGINT       NOT NULL,
  paid_on          DATE         NOT NULL,
  reference        VARCHAR(80),
  note             VARCHAR(255),
  is_voided        BOOLEAN      NOT NULL DEFAULT false,
  voided_at        DATETIME,
  created_by       BIGINT       REQ FK → users NULL
);

-- Batches with expiry (milk, bread, medicines). Sold first-expiry-first-out.
CREATE TABLE stock_batches (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  purchase_item_id BIGINT       FK → purchase_items NULL,
  batch_no         VARCHAR(40),
  expiry_date      DATE,
  qty_in_milli     BIGINT       NOT NULL,
  qty_left_milli   BIGINT       NOT NULL,
  cost_minor       BIGINT,
  row_version      INT          NOT NULL DEFAULT 1
);

-- Every stock change. The ledger that branch_stock / stock_batches are rebuilt from.
CREATE TABLE stock_movements (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  product_id       BIGINT       NOT NULL FK → products CASCADE,
  batch_id         BIGINT       FK → stock_batches NULL,
  reason           INT          NOT NULL,               -- StockReason: 1 opening, 2 purchase, 3 sale, 4 return, 5 wastage, 6 damage, 7 expired, 8 adjustment, 9 transfer_in, 10 transfer_out
  qty_milli        BIGINT       NOT NULL,               -- + in, − out
  balance_milli    BIGINT       NOT NULL,               -- stock after this movement
  ref_type         INT,                                -- StockRef: 1 order, 2 purchase, 3 return, 4 transfer
  ref_id           BIGINT,                              -- ROWID in that table
  note             VARCHAR(255),
  created_by       BIGINT       FK → users NULL
);


-- =====================================================================================================
--  6. CUSTOMERS
-- =====================================================================================================

CREATE TABLE customers (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(120) NOT NULL SEARCH PII,
  phone            VARCHAR(16)  SEARCH PII,             -- E.164
  phone_key        VARCHAR(60)  UNIQUE,                 -- '<business_id>:<phone>' (NULL when no phone)
  email            VARCHAR(150) PII,
  address          VARCHAR(255) PII,
  gstin            VARCHAR(15),                         -- B2B bills
  price_list_id    BIGINT       FK → price_lists NULL,  -- NULL = retail
  credit_limit_minor BIGINT,
  marketing_opt_in BOOLEAN      NOT NULL DEFAULT true,
  notes            VARCHAR(255),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  row_version      INT          NOT NULL DEFAULT 1,
  state_code       VARCHAR(2),                          -- GST place of supply (from the GSTIN when given)
  points_balance   INT          NOT NULL DEFAULT 0      -- loyalty points (sum of customer_points; kept for quick reads)
);

-- Loyalty points: every earn / use / reversal / expiry / manual change, with the balance after it.
CREATE TABLE customer_points (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       FK → branches NULL,
  customer_id      BIGINT       NOT NULL FK → customers CASCADE,
  order_id         BIGINT       FK → orders NULL,
  return_id        BIGINT       FK → sale_returns NULL,
  kind             INT          NOT NULL,               -- PointsKind: 1 earn, 2 redeem, 3 return, 4 cancel, 5 expire, 6 adjust
  points           INT          NOT NULL,               -- + added, − taken
  balance_after    INT          NOT NULL,
  remaining        INT          NOT NULL DEFAULT 0,     -- earned points not yet used or expired (used oldest first)
  expires_on       DATE,                                -- earned points only; NULL = never
  note             VARCHAR(150),
  created_by       BIGINT       FK → users NULL
);


-- =====================================================================================================
--  7. SALES — tables, orders, bills, payments, kitchen
-- =====================================================================================================

CREATE TABLE dining_tables (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  label            VARCHAR(20)  NOT NULL,               -- T1, Patio 2
  area             VARCHAR(40),
  seats            INT          NOT NULL DEFAULT 4,
  qr_token         VARCHAR(40)  UNIQUE,                 -- QR menu link for this table
  merged_into_id   BIGINT       FK → dining_tables NULL, -- tables merged for a big group → the main table
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE         -- '<branch_id>:<lower(label)>'
);

-- An order becomes a bill when it is completed (invoice_number is given then).
CREATE TABLE orders (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  device_id        BIGINT       FK → devices NULL,
  client_uuid      VARCHAR(40)  NOT NULL UNIQUE,        -- idempotency / offline
  order_number     VARCHAR(30)  NOT NULL,               -- #2209
  invoice_number   VARCHAR(30),                         -- INV-11186, set on completion
  invoice_key      VARCHAR(80)  UNIQUE,                 -- '<business_id>:<invoice_number>'
  order_type       INT          NOT NULL,               -- OrderType: 1 dine_in, 2 takeaway, 3 delivery, 4 counter
  source           INT          NOT NULL DEFAULT 1,     -- OrderSource: 1 pos, 2 mobile, 3 table, 4 qr
  status           INT          NOT NULL,               -- OrderStatus: 1 open, 2 completed, 3 cancelled
  table_id         BIGINT       FK → dining_tables NULL,
  customer_id      BIGINT       FK → customers NULL,
  customer_name    VARCHAR(120) PII,                    -- snapshot / walk-in guest
  customer_phone   VARCHAR(16)  PII,
  customer_address VARCHAR(255) PII,                    -- delivery / QR takeaway
  qr_status        INT,                                 -- QrStatus: 1 pending, 2 accepted, 3 rejected; NULL = not a QR order
  fulfilment       INT,                                 -- Fulfilment: 1 new, 2 packing, 3 ready, 4 delivered; NULL = normal counter bill
  price_list_id    BIGINT       FK → price_lists NULL,
  guests           INT,
  subtotal_minor   BIGINT       NOT NULL DEFAULT 0,
  discount_minor   BIGINT       NOT NULL DEFAULT 0,
  discount_note    VARCHAR(100),
  tax_minor        BIGINT       NOT NULL DEFAULT 0,
  service_charge_minor BIGINT   NOT NULL DEFAULT 0,
  round_off_minor  BIGINT       NOT NULL DEFAULT 0,     -- ±
  total_minor      BIGINT       NOT NULL DEFAULT 0,
  paid_minor       BIGINT       NOT NULL DEFAULT 0,
  balance_minor    BIGINT       NOT NULL DEFAULT 0,     -- due (credit)
  returned_minor   BIGINT       NOT NULL DEFAULT 0,     -- sum of sale_returns
  tax_breakup_json TEXT,                                -- [{rate_bp, taxable_minor, cgst_minor, sgst_minor, igst_minor}]
  note             VARCHAR(255),
  billed_at        DATETIME,
  cancelled_at     DATETIME,
  cancel_reason    VARCHAR(255),
  created_by       BIGINT       REQ FK → users NULL, -- staff on the bill (commission)
  salesperson_id   BIGINT       FK → users NULL,        -- who sold it (textile counters); NULL = the person who made the bill
  customer_gstin   VARCHAR(15),                         -- snapshot at billing: B2B tax invoice
  place_of_supply  VARCHAR(2),                          -- GST state code of the customer (snapshot); NULL = shop's state
  is_igst          BOOLEAN      NOT NULL DEFAULT false, -- other-state customer: IGST instead of CGST + SGST
  points_redeemed  INT          NOT NULL DEFAULT 0,     -- loyalty points used on this bill
  points_value_minor BIGINT     NOT NULL DEFAULT 0,     -- their value (part of discount_minor, given before GST)
  points_earned    INT          NOT NULL DEFAULT 0,
  points_balance_after INT,                             -- customer's points after this bill (printed)
  updated_by       BIGINT       FK → users NULL,
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE order_items (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  order_id         BIGINT       NOT NULL FK → orders CASCADE,
  product_id       BIGINT       FK → products NULL,
  variant_id       BIGINT       FK → product_variants NULL,
  product_name     VARCHAR(150) NOT NULL,               -- snapshot: 'French Fries'
  variant_name     VARCHAR(60),                         -- snapshot: 'Regular'
  unit             VARCHAR(10)  NOT NULL,
  qty_milli        BIGINT       NOT NULL,
  unit_price_minor BIGINT       NOT NULL,               -- base / size price + add-ons
  hsn_code         VARCHAR(10),                         -- snapshot at billing (item's, else its category's)
  list_price_minor BIGINT,                              -- catalogue price when the price was changed at the counter (NULL = not changed)
  taxable_minor    BIGINT,                              -- value before GST after the bill discount (set at billing)
  mrp_minor        BIGINT,                              -- printed MRP per unit when it is above the price ("You saved" on the bill)
  price_list_id    BIGINT       FK → price_lists NULL,  -- which list priced it
  discount_minor   BIGINT       NOT NULL DEFAULT 0,
  tax_bp           INT          NOT NULL DEFAULT 0,
  tax_minor        BIGINT       NOT NULL DEFAULT 0,
  line_total_minor BIGINT       NOT NULL,
  cost_minor       BIGINT,                              -- snapshot for profit reports
  note             VARCHAR(150),                        -- 'less spicy'
  kot_qty_milli    BIGINT       NOT NULL DEFAULT 0,     -- qty already sent to the kitchen (next KOT sends qty − this)
  sort_order       INT          NOT NULL DEFAULT 0
);

CREATE TABLE order_item_addons (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  order_item_id    BIGINT       NOT NULL FK → order_items CASCADE,
  addon_id         BIGINT       FK → product_addons NULL,
  name             VARCHAR(60)  NOT NULL,               -- snapshot
  price_minor      BIGINT       NOT NULL
);

-- Batch(es) a sold line came from (FEFO), so a return goes back to the same batch.
CREATE TABLE order_item_batches (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  order_item_id    BIGINT       NOT NULL FK → order_items CASCADE,
  batch_id         BIGINT       REQ FK → stock_batches NULL,
  qty_milli        BIGINT       NOT NULL
);

-- Returns / credit notes.
CREATE TABLE sale_returns (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  order_id         BIGINT       REQ FK → orders NULL,
  customer_id      BIGINT       FK → customers NULL,
  client_uuid      VARCHAR(40)  NOT NULL UNIQUE,
  number           VARCHAR(30)  NOT NULL,               -- CN-1001
  number_key       VARCHAR(80)  NOT NULL UNIQUE,        -- '<business_id>:<number>'
  invoice_number   VARCHAR(30)  NOT NULL,               -- snapshot of the bill
  reason           INT          NOT NULL,               -- ReturnReason: 1 damaged, 2 wrong_item, 3 not_needed, 4 expired, 5 quality, 6 other
  settle           INT          NOT NULL,               -- ReturnSettle: 1 refund, 2 exchange, 3 credit_note
  note             VARCHAR(255),
  total_minor      BIGINT       NOT NULL,
  tax_minor        BIGINT       NOT NULL DEFAULT 0,     -- tax share of the total
  due_adjusted_minor BIGINT     NOT NULL DEFAULT 0,     -- taken off the bill's balance first
  refunded_minor   BIGINT       NOT NULL DEFAULT 0,
  refund_method    INT,                                -- PayMethod: 1 cash, 2 upi, 3 card, 4 bank, 5 credit_note
  credit_issued_minor BIGINT    NOT NULL DEFAULT 0,
  credit_remaining_minor BIGINT NOT NULL DEFAULT 0,     -- reduced by payments with method credit_note
  credit_expires_on DATE,
  created_by       BIGINT       REQ FK → users NULL,
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE sale_return_items (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  return_id        BIGINT       NOT NULL FK → sale_returns CASCADE,
  order_item_id    BIGINT       REQ FK → order_items NULL,
  product_id       BIGINT       FK → products NULL,
  product_name     VARCHAR(150) NOT NULL,               -- snapshot
  unit             VARCHAR(10)  NOT NULL,
  qty_milli        BIGINT       NOT NULL,
  unit_price_minor BIGINT       NOT NULL,
  amount_minor     BIGINT       NOT NULL,               -- incl. tax, after the bill's discount share
  restock          BOOLEAN      NOT NULL DEFAULT true   -- false = damaged, not back on the shelf
);

-- Every money movement: sale, due collection, refund. Never edited — voided and re-entered.
CREATE TABLE payments (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  order_id         BIGINT       FK → orders NULL,       -- NULL for a due collection across bills
  customer_id      BIGINT       FK → customers NULL,
  return_id        BIGINT       FK → sale_returns NULL, -- refund of / payment with this credit note
  client_uuid      VARCHAR(40)  NOT NULL UNIQUE,
  kind             INT          NOT NULL,               -- PaymentKind: 1 sale, 2 due_collection, 3 refund
  method           INT          NOT NULL,               -- PayMethod: 1 cash, 2 upi, 3 card, 4 bank, 5 credit_note
  amount_minor     BIGINT       NOT NULL,
  reference        VARCHAR(80),                         -- UPI ref / card last 4
  is_voided        BOOLEAN      NOT NULL DEFAULT false,
  voided_at        DATETIME,
  void_reason      VARCHAR(255),
  created_by       BIGINT       REQ FK → users NULL
);

-- Due collected once and spread across several bills.
CREATE TABLE payment_allocations (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  payment_id       BIGINT       NOT NULL FK → payments CASCADE,
  order_id         BIGINT       REQ FK → orders NULL,
  amount_minor     BIGINT       NOT NULL
);

CREATE TABLE kitchen_tickets (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  order_id         BIGINT       NOT NULL FK → orders CASCADE,
  client_uuid      VARCHAR(40)  NOT NULL UNIQUE,
  number           VARCHAR(20)  NOT NULL,               -- KOT-0014
  order_number     VARCHAR(30)  NOT NULL,               -- snapshot for the kitchen screen
  order_type       INT          NOT NULL,               -- OrderType (snapshot)
  station          VARCHAR(30),                         -- kitchen | bar | grill (later)
  status           INT          NOT NULL DEFAULT 1,     -- KotStatus: 1 new, 2 preparing, 3 ready, 4 completed, 5 cancelled
  table_label      VARCHAR(20),                         -- snapshot
  started_at       DATETIME,
  ready_at         DATETIME,
  completed_at     DATETIME,                            -- served / handed over
  created_by       BIGINT       FK → users NULL,
  row_version      INT          NOT NULL DEFAULT 1
);

CREATE TABLE kitchen_ticket_items (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  ticket_id        BIGINT       NOT NULL FK → kitchen_tickets CASCADE,
  order_item_id    BIGINT       FK → order_items NULL,
  name             VARCHAR(150) NOT NULL,               -- snapshot with size / add-ons
  qty_milli        BIGINT       NOT NULL,
  is_veg           BOOLEAN,
  note             VARCHAR(150)
);

-- Browser push for the QR / order tracking page ("Notify me when ready"). Removed when the order is done or after a day.
CREATE TABLE push_subscriptions (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  order_id         BIGINT       NOT NULL FK → orders CASCADE,
  endpoint         VARCHAR(500) NOT NULL,               -- push service URL (Google / Apple / Mozilla)
  p256dh           VARCHAR(120) NOT NULL,               -- the browser's public key (base64url)
  auth_secret      VARCHAR(40)  NOT NULL,               -- the browser's auth secret (base64url)
  uniq_key         VARCHAR(80)  NOT NULL UNIQUE,        -- '<order_id>:<hash of endpoint>'
  last_stamp       VARCHAR(40),                         -- status last sent, so each change is sent once
  expires_at       DATETIME     NOT NULL
);


-- =====================================================================================================
--  8. EXPENSES & STAFF
-- =====================================================================================================

CREATE TABLE expense_categories (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  name             VARCHAR(60)  NOT NULL,               -- Purchase | Salary | Rent | Electricity | Transport | Maintenance | Other | custom
  system_key       INT,                                -- ExpenseKey: 1 purchase, 2 salary, 3 rent, 4 electricity, 5 transport, 6 maintenance, 7 other
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  uniq_key         VARCHAR(100) NOT NULL UNIQUE         -- '<business_id>:<lower(name)>'
);

CREATE TABLE expenses (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  category_id      BIGINT       REQ FK → expense_categories NULL,
  expense_date     DATETIME     NOT NULL,
  amount_minor     BIGINT       NOT NULL,
  method           INT          NOT NULL,               -- PayMethod: 1 cash, 2 upi, 3 card, 4 bank, 5 credit_note
  notes            VARCHAR(255),
  ref_type         INT,                                -- ExpenseRef: 1 salary, 2 advance, 3 purchase, 4 supplier_payment
  ref_id           BIGINT,
  is_voided        BOOLEAN      NOT NULL DEFAULT false,
  created_by       BIGINT       REQ FK → users NULL
);

CREATE TABLE attendance (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       NOT NULL FK → branches CASCADE,
  user_id          BIGINT       NOT NULL FK → users CASCADE,
  work_date        DATE         NOT NULL,
  status           INT          NOT NULL,               -- AttendanceStatus: 1 present, 2 half, 3 absent, 4 leave
  in_time          VARCHAR(5),                          -- '09:30'
  out_time         VARCHAR(5),
  note             VARCHAR(150),
  marked_by        BIGINT       REQ FK → users NULL,
  uniq_key         VARCHAR(60)  NOT NULL UNIQUE         -- '<user_id>:<work_date>'
);

CREATE TABLE salary_payments (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  user_id          BIGINT       REQ FK → users NULL,
  month            VARCHAR(7)   NOT NULL,               -- '2026-10'
  -- snapshot of how it was worked out, so an old salary slip reprints exactly
  pay_type         INT          NOT NULL,               -- PayType
  rate_minor       BIGINT       NOT NULL,               -- monthly salary or daily rate at that time
  days_in_month    INT          NOT NULL,
  present_days     INT          NOT NULL DEFAULT 0,
  half_days        INT          NOT NULL DEFAULT 0,
  leave_days       INT          NOT NULL DEFAULT 0,
  absent_days      INT          NOT NULL DEFAULT 0,
  unmarked_days    INT          NOT NULL DEFAULT 0,
  commission_sales_minor BIGINT NOT NULL DEFAULT 0,     -- net sales the commission was worked out on
  base_minor       BIGINT       NOT NULL,
  commission_minor BIGINT       NOT NULL DEFAULT 0,
  bonus_minor      BIGINT       NOT NULL DEFAULT 0,
  deduction_minor  BIGINT       NOT NULL DEFAULT 0,
  advances_minor   BIGINT       NOT NULL DEFAULT 0,
  net_minor        BIGINT       NOT NULL,
  method           INT          NOT NULL,               -- PayMethod
  note             VARCHAR(150),
  expense_id       BIGINT       FK → expenses NULL,
  paid_by          BIGINT       REQ FK → users NULL,
  uniq_key         VARCHAR(40)  NOT NULL UNIQUE         -- '<user_id>:<month>' — no double pay
);

CREATE TABLE staff_advances (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  user_id          BIGINT       REQ FK → users NULL,
  amount_minor     BIGINT       NOT NULL,
  method           INT          NOT NULL,               -- PayMethod
  given_on         DATE         NOT NULL,
  note             VARCHAR(150),
  expense_id       BIGINT       FK → expenses NULL,
  salary_payment_id BIGINT      FK → salary_payments NULL, -- set when deducted
  given_by         BIGINT       REQ FK → users NULL
);


-- =====================================================================================================
--  9. WHATSAPP & OFFERS (customer's own WhatsApp)
-- =====================================================================================================

CREATE TABLE whatsapp_accounts (
  business_id      BIGINT       NOT NULL UNIQUE FK → businesses CASCADE, -- one per business
  provider         INT          NOT NULL DEFAULT 1,     -- WaProvider: 1 meta_cloud
  business_number  VARCHAR(16),                         -- empty until the shop connects its account
  waba_id          VARCHAR(25),
  phone_number_id  VARCHAR(25),
  secret_id        BIGINT       FK → secrets NULL,      -- access token
  verified_name    VARCHAR(120),
  quality          INT,                                 -- WaQuality: 1 high, 2 medium, 3 low
  verified_at      DATETIME,
  auto_send_bill   BOOLEAN      NOT NULL DEFAULT false,
  setup_done_at    DATETIME,
  status           INT          NOT NULL DEFAULT 1      -- WaAccountStatus: 1 setup, 2 connected, 3 disconnected
);

-- Message templates — the customer's (business_id set) and the platform's (business_id NULL).
CREATE TABLE whatsapp_templates (
  business_id      BIGINT       FK → businesses CASCADE,
  kind             INT          NOT NULL,               -- WaTemplateKind: 1 bill, 2 offer, 3 renewal_reminder
  language         VARCHAR(5)   NOT NULL,               -- en | ta
  body             TEXT         NOT NULL,
  attach           BOOLEAN      NOT NULL DEFAULT false, -- PDF / poster header
  meta_template_name VARCHAR(80),
  status           INT          NOT NULL DEFAULT 1,     -- WaTemplateStatus: 1 draft, 2 pending, 3 approved, 4 rejected
  reject_reason    VARCHAR(255),
  submitted_at     DATETIME,
  approved_at      DATETIME,
  uniq_key         VARCHAR(60)  NOT NULL UNIQUE         -- '<business_id|platform>:<kind>'
);

CREATE TABLE campaigns (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  channel          INT          NOT NULL DEFAULT 1,     -- Channel: 1 whatsapp
  campaign_date    DATE         NOT NULL,
  message          TEXT         NOT NULL,               -- offer details (up to 300 characters)
  product_ids_json TEXT,
  poster_media_id  BIGINT       FK → media_files NULL,
  sent_count       INT          NOT NULL DEFAULT 0,
  created_by       BIGINT       REQ FK → users NULL
);

-- Every WhatsApp message: bills, offers, tests, and platform renewal reminders (business_id = customer).
CREATE TABLE whatsapp_messages (
  business_id      BIGINT       FK → businesses CASCADE,
  sender           INT          NOT NULL,               -- WaSender: 1 business, 2 platform
  kind             INT          NOT NULL,               -- WaMessageKind: 1 bill, 2 offer, 3 test, 4 renewal_reminder
  to_number        VARCHAR(16)  NOT NULL PII,
  customer_id      BIGINT       FK → customers NULL,
  order_id         BIGINT       FK → orders NULL,
  campaign_id      BIGINT       FK → campaigns NULL,
  template_id      BIGINT       FK → whatsapp_templates NULL,
  body             TEXT         NOT NULL,
  attachment_media_id BIGINT    FK → media_files NULL,
  meta_message_id  VARCHAR(80)  UNIQUE,                 -- updated by Meta's webhook
  status           INT          NOT NULL DEFAULT 1,     -- WaMessageStatus: 1 queued, 2 sent, 3 delivered, 4 read, 5 failed
  error            VARCHAR(255),
  status_at        DATETIME,
  created_by       BIGINT       FK → users NULL
);


-- =====================================================================================================
-- 10. PRODUCT ADMIN — support, audit
--     No health / error table: errors, slow calls and API counts come from Catalyst DevOps (APM, Logs, Metrics).
--     No import table: CSV import is one click (rows saved in batches); the summary goes to audit_logs (action import).
--     Data export has no table: one button builds the Excel / ZIP right away (who exported → audit logs).
-- =====================================================================================================

CREATE TABLE support_tickets (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  user_id          BIGINT       REQ FK → users NULL,
  number           VARCHAR(20)  NOT NULL UNIQUE,        -- T-1001
  subject          VARCHAR(120) NOT NULL SEARCH,
  category         INT          NOT NULL,               -- TicketCategory: 1 billing, 2 printer, 3 stock, 4 whatsapp, 5 account, 6 other
  priority         INT          NOT NULL DEFAULT 2,     -- TicketPriority: 1 low, 2 normal, 3 high, 4 urgent
  status           INT          NOT NULL DEFAULT 1,     -- TicketStatus: 1 open, 2 in_progress, 3 waiting, 4 resolved, 5 closed
  assigned_to      BIGINT       FK → platform_admins NULL,
  page             VARCHAR(200),
  browser          VARCHAR(255),
  app_version      VARCHAR(20),
  device_id        BIGINT       FK → devices NULL,
  user_name        VARCHAR(120),                        -- snapshot of who raised it (the admin inbox reads no shop data)
  user_phone       VARCHAR(16)  PII,
  unread_for_admin BOOLEAN      NOT NULL DEFAULT true,
  unread_for_customer BOOLEAN   NOT NULL DEFAULT false,
  last_message_at  DATETIME     NOT NULL,
  resolved_at      DATETIME
);

CREATE TABLE ticket_messages (
  ticket_id        BIGINT       NOT NULL FK → support_tickets CASCADE,
  from_side        INT          NOT NULL,               -- TicketSide: 1 customer, 2 admin
  user_id          BIGINT       FK → users NULL,
  admin_id         BIGINT       FK → platform_admins NULL,
  author_name      VARCHAR(120) NOT NULL,
  body             TEXT
);

CREATE TABLE ticket_attachments (
  message_id       BIGINT       NOT NULL FK → ticket_messages CASCADE,
  media_id         BIGINT       NOT NULL FK → media_files CASCADE, -- screenshots ≤ 1600 px / 200 KB, up to 5
  sort_order       INT          NOT NULL DEFAULT 0
);

-- What the shop's staff did (Settings → Audit log).
CREATE TABLE audit_logs (
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  branch_id        BIGINT       FK → branches NULL,
  user_id          BIGINT       FK → users NULL,
  support_admin_id BIGINT       FK → platform_admins NULL, -- set during a support view
  entity           INT          NOT NULL,               -- AuditEntity: 1 order, 2 payment, 3 product, 4 category, 5 customer, 6 inventory, 7 expense, 8 user, 9 role, 10 branch, 11 settings, 12 whatsapp, 13 return, 14 staff, 15 table
  entity_id        BIGINT,
  action           INT          NOT NULL,               -- AuditAction: 1 create, 2 update, 3 delete, 4 cancel, 5 void, 6 login, 7 printer, 8 enable, 9 disconnect, 10 import, 11 export
  detail           VARCHAR(255),
  changes_json     TEXT                                 -- {field: [old, new]}
);

-- What the product admin team did.
CREATE TABLE admin_audit_logs (
  admin_id         BIGINT       REQ FK → platform_admins NULL,
  admin_name       VARCHAR(120) NOT NULL,               -- snapshot
  business_id      BIGINT       FK → businesses NULL,   -- NULL after the customer is deleted
  business_name    VARCHAR(150),                        -- snapshot (kept after delete)
  action           INT          NOT NULL,               -- AdminAction: 1 create, 2 update, 3 password, 4 renew, 5 branch_limit, 6 activate, 7 deactivate, 8 delete, 9 settings, 10 login, 11 export, 12 reminder, 13 support_start, 14 support_end, 15 admin_create, 16 admin_update, 17 feature
  detail           VARCHAR(255),
  ip               VARCHAR(45)
);

-- Sign-in names → which shop they belong to. Usernames, mobile numbers and emails are unique across every
-- shop and admin, and with one database per shop this is how sign-in finds the right one.
CREATE TABLE login_names (
  login            VARCHAR(160) NOT NULL UNIQUE,        -- lower-case username, E.164 mobile or lower-case email
  kind             INT          NOT NULL,               -- LoginKind: 1 username, 2 phone, 3 email
  business_id      BIGINT       NOT NULL FK → businesses CASCADE,
  user_id          BIGINT       NOT NULL                -- → users.ROWID in the shop's database
);

-- Where each shop's own database is (Turso: one database per shop). Not used when everything is in one database.
CREATE TABLE shop_databases (
  business_id      BIGINT       NOT NULL UNIQUE FK → businesses CASCADE,
  db_name          VARCHAR(64)  NOT NULL UNIQUE,
  db_url           VARCHAR(255),
  db_token         ENCRYPTED,                           -- this database's own access token (Turso), encrypted
  schema_version   VARCHAR(40),                         -- newest migration applied
  status           INT          NOT NULL DEFAULT 1      -- ShopDbStatus: 1 creating, 2 ready, 3 failed, 4 deleting
);

-- =====================================================================================================
--  ORDER OF CREATION (parents before children)
--   plans, platform_admins, platform_settings, feature_flags → businesses → secrets, business_settings,
--   subscription_periods, feature_flag_businesses, branches, sequences, devices, roles, role_permissions,
--   users, user_branches, media_files → catalogue → inventory → customers → sales → expenses & staff →
--   whatsapp → product admin tables.
--   (Create columns that point "forward", e.g. platform_settings.updated_by, after both tables exist.)
-- =====================================================================================================

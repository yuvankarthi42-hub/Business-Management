-- GST (HSN on categories and bill lines, B2B / IGST on bills), purchases & suppliers, loyalty points.

ALTER TABLE "categories" ADD COLUMN "hsn_code" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "state_code" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "opening_balance_minor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "suppliers" ADD COLUMN "notes" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "name_key" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchases" ADD COLUMN "client_uuid" TEXT;
ALTER TABLE "purchases" ADD COLUMN "is_igst" INTEGER NOT NULL DEFAULT 0 CHECK ("is_igst" IN (0, 1));
ALTER TABLE "purchases" ADD COLUMN "round_off_minor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "purchases" ADD COLUMN "void_reason" TEXT;
ALTER TABLE "purchases" ADD COLUMN "voided_at" TEXT;
ALTER TABLE "purchases" ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_items" ADD COLUMN "unit" TEXT;
ALTER TABLE "purchase_items" ADD COLUMN "hsn_code" TEXT;
ALTER TABLE "purchase_items" ADD COLUMN "taxable_minor" INTEGER;
ALTER TABLE "purchase_items" ADD COLUMN "tax_minor" INTEGER;
ALTER TABLE "purchase_items" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "state_code" TEXT;
ALTER TABLE "customers" ADD COLUMN "points_balance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "customer_gstin" TEXT;
ALTER TABLE "orders" ADD COLUMN "place_of_supply" TEXT;
ALTER TABLE "orders" ADD COLUMN "is_igst" INTEGER NOT NULL DEFAULT 0 CHECK ("is_igst" IN (0, 1));
ALTER TABLE "orders" ADD COLUMN "points_redeemed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "points_value_minor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "points_earned" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "points_balance_after" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "hsn_code" TEXT;
ALTER TABLE "order_items" ADD COLUMN "taxable_minor" INTEGER;

-- Money paid to a supplier (at purchase, or later against the balance). Voided, never edited.
CREATE TABLE IF NOT EXISTS "supplier_payments" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "branch_id"                INTEGER  NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "supplier_id"              INTEGER  NOT NULL REFERENCES "suppliers"("id") ON DELETE CASCADE,
  "purchase_id"              INTEGER  REFERENCES "purchases"("id") ON DELETE SET NULL,  -- paid with this purchase bill; NULL = against the balance
  "client_uuid"              TEXT     NOT NULL UNIQUE,  -- max 40
  "method"                   INTEGER  NOT NULL CHECK ("method" >= 1),  -- PayMethod: 1 cash, 2 upi, 3 card, 4 bank
  "amount_minor"             INTEGER  NOT NULL,
  "paid_on"                  TEXT     NOT NULL CHECK ("paid_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  "reference"                TEXT,  -- max 80
  "note"                     TEXT,  -- max 255
  "is_voided"                INTEGER  NOT NULL DEFAULT 0 CHECK ("is_voided" IN (0, 1)),
  "voided_at"                TEXT,
  "created_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;

CREATE TRIGGER IF NOT EXISTS "supplier_payments_updated_at" AFTER UPDATE ON "supplier_payments" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "supplier_payments" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;

CREATE INDEX IF NOT EXISTS "ix_supplier_payments_business_id" ON "supplier_payments" ("business_id");
CREATE INDEX IF NOT EXISTS "ix_supplier_payments_branch_id" ON "supplier_payments" ("branch_id");
CREATE INDEX IF NOT EXISTS "ix_supplier_payments_supplier_id" ON "supplier_payments" ("supplier_id");
CREATE INDEX IF NOT EXISTS "ix_supplier_payments_purchase_id" ON "supplier_payments" ("purchase_id");
CREATE INDEX IF NOT EXISTS "ix_supplier_payments_created_by" ON "supplier_payments" ("created_by");


-- Loyalty points: every earn / use / reversal / expiry / manual change, with the balance after it.
CREATE TABLE IF NOT EXISTS "customer_points" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "branch_id"                INTEGER  REFERENCES "branches"("id") ON DELETE SET NULL,
  "customer_id"              INTEGER  NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "order_id"                 INTEGER  REFERENCES "orders"("id") ON DELETE SET NULL,
  "return_id"                INTEGER  REFERENCES "sale_returns"("id") ON DELETE SET NULL,
  "kind"                     INTEGER  NOT NULL CHECK ("kind" >= 1),  -- PointsKind: 1 earn, 2 redeem, 3 return, 4 cancel, 5 expire, 6 adjust
  "points"                   INTEGER  NOT NULL,  -- + added, − taken
  "balance_after"            INTEGER  NOT NULL,
  "remaining"                INTEGER  NOT NULL DEFAULT 0,  -- earned points not yet used or expired (used oldest first)
  "expires_on"               TEXT     CHECK ("expires_on" IS NULL OR "expires_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),  -- earned points only; NULL = never
  "note"                     TEXT,  -- max 150
  "created_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;

CREATE TRIGGER IF NOT EXISTS "customer_points_updated_at" AFTER UPDATE ON "customer_points" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "customer_points" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;

CREATE INDEX IF NOT EXISTS "ix_customer_points_business_id" ON "customer_points" ("business_id");
CREATE INDEX IF NOT EXISTS "ix_customer_points_branch_id" ON "customer_points" ("branch_id");
CREATE INDEX IF NOT EXISTS "ix_customer_points_customer_id" ON "customer_points" ("customer_id");
CREATE INDEX IF NOT EXISTS "ix_customer_points_order_id" ON "customer_points" ("order_id");
CREATE INDEX IF NOT EXISTS "ix_customer_points_return_id" ON "customer_points" ("return_id");
CREATE INDEX IF NOT EXISTS "ix_customer_points_created_by" ON "customer_points" ("created_by");

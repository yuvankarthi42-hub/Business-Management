-- Bill format per branch (Settings → Printer and bill). Only adds a table: a branch without a row prints the classic bill.

CREATE TABLE IF NOT EXISTS "bill_formats" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "branch_id"                INTEGER  NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "kind"                     INTEGER  NOT NULL DEFAULT 1 CHECK ("kind" >= 1),  -- BillKind: 1 thermal (later: A4 invoice, estimate, delivery challan)
  "format_json"              TEXT     NOT NULL,  -- {layout, cols, qtyDecimals, name1, name2, address, phone2, title, cashSales, footer1, footer2, top, bottom}
  "schema_version"           INTEGER  NOT NULL DEFAULT 1,
  "uniq_key"                 TEXT     NOT NULL UNIQUE,  -- max 80 · '<branch_id>:<kind>'
  "updated_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "row_version"              INTEGER  NOT NULL DEFAULT 1,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;

CREATE TRIGGER IF NOT EXISTS "bill_formats_updated_at" AFTER UPDATE ON "bill_formats" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "bill_formats" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;
CREATE INDEX IF NOT EXISTS "ix_bill_formats_business_id" ON "bill_formats" ("business_id");
CREATE INDEX IF NOT EXISTS "ix_bill_formats_branch_id" ON "bill_formats" ("branch_id");
CREATE INDEX IF NOT EXISTS "ix_bill_formats_updated_by" ON "bill_formats" ("updated_by");

-- Service jobs (repairs, laundry, tailoring…): an item the shop takes in, its stages, and its bill at delivery.
-- Only adds two tables: shops without the Service jobs module never use them.
CREATE TABLE IF NOT EXISTS "service_jobs" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "branch_id"                INTEGER  NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "customer_id"              INTEGER  REFERENCES "customers"("id") ON DELETE SET NULL,
  "order_id"                 INTEGER  REFERENCES "orders"("id") ON DELETE SET NULL,  -- the bill, made at delivery
  "advance_payment_id"       INTEGER  REFERENCES "payments"("id") ON DELETE SET NULL,  -- the advance taken at drop-off
  "client_uuid"              TEXT     NOT NULL UNIQUE,  -- max 40 · a re-sent request never makes a second job
  "job_number"               TEXT     NOT NULL,  -- max 30 · J-1042
  "number_key"               TEXT     NOT NULL UNIQUE,  -- max 80 · '<business_id>:<job_number>'
  "stage"                    INTEGER  NOT NULL CHECK ("stage" >= 1),  -- JobStage: 1 received, 2 checking, 3 approval, 4 parts, 5 repairing, 6 ready, 7 delivered, 8 cancelled, 9 returned, 10 washing, 11 ironing, 12 cutting, 13 stitching, 14 trial, 15 in_progress
  "stage_at"                 TEXT     NOT NULL,  -- when it reached this stage
  "item"                     TEXT     NOT NULL,  -- max 80 · Mobile | Laptop | Saree | Shirt …
  "brand_model"              TEXT,  -- max 120 · Redmi Note 12
  "serial"                   TEXT,  -- max 40 · IMEI / serial number
  "serial_key"               TEXT,  -- max 80 · '<business_id>:<serial digits/letters, lower case>' (search)
  "colour"                   TEXT,  -- max 30
  "problem"                  TEXT     NOT NULL,  -- max 500
  "accessories"              TEXT,  -- max 255 · what came with it (charger, cover, SIM…)
  "condition_note"           TEXT,  -- max 255 · scratches, dead, wet…
  "estimate_minor"           INTEGER,
  "advance_minor"            INTEGER  NOT NULL DEFAULT 0,
  "promised_at"              TEXT,  -- ready by
  "technician_id"            INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "customer_name"            TEXT,  -- max 120 · snapshot (the board shows it without reading customers)
  "customer_phone"           TEXT,  -- max 16 · E.164 snapshot
  "phone_key"                TEXT,  -- max 16 · digits of the phone (search)
  "delivered_at"             TEXT,
  "close_reason"             TEXT,  -- max 255 · cancelled / returned: why
  "created_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "row_version"              INTEGER  NOT NULL DEFAULT 1,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;
CREATE TRIGGER IF NOT EXISTS "service_jobs_updated_at" AFTER UPDATE ON "service_jobs" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "service_jobs" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;
CREATE INDEX IF NOT EXISTS "ix_service_jobs_business_id_branch_id_stage_promised_at" ON "service_jobs" ("business_id", "branch_id", "stage", "promised_at");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_business_id_branch_id_stage_stage_at" ON "service_jobs" ("business_id", "branch_id", "stage", "stage_at");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_business_id_phone_key" ON "service_jobs" ("business_id", "phone_key");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_business_id_serial_key" ON "service_jobs" ("business_id", "serial_key");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_branch_id" ON "service_jobs" ("branch_id");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_customer_id" ON "service_jobs" ("customer_id");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_order_id" ON "service_jobs" ("order_id");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_advance_payment_id" ON "service_jobs" ("advance_payment_id");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_technician_id" ON "service_jobs" ("technician_id");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_created_by" ON "service_jobs" ("created_by");
CREATE INDEX IF NOT EXISTS "ix_service_jobs_updated_by" ON "service_jobs" ("updated_by");
CREATE TABLE IF NOT EXISTS "service_job_events" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "job_id"                   INTEGER  NOT NULL REFERENCES "service_jobs"("id") ON DELETE CASCADE,
  "from_stage"               INTEGER,  -- JobStage (NULL for the first one)
  "to_stage"                 INTEGER  NOT NULL,  -- JobStage
  "note"                     TEXT,  -- max 255
  "created_by"               INTEGER  REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;
CREATE TRIGGER IF NOT EXISTS "service_job_events_updated_at" AFTER UPDATE ON "service_job_events" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "service_job_events" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;
CREATE INDEX IF NOT EXISTS "ix_service_job_events_job_id_created_at" ON "service_job_events" ("job_id", "created_at");
CREATE INDEX IF NOT EXISTS "ix_service_job_events_business_id" ON "service_job_events" ("business_id");
CREATE INDEX IF NOT EXISTS "ix_service_job_events_created_by" ON "service_job_events" ("created_by");

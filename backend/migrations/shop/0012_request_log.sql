-- Writes saved once per request (K-7): the same request sent again gets the saved answer instead of saving twice.

CREATE TABLE IF NOT EXISTS "request_log" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "uniq_key"                 TEXT     NOT NULL UNIQUE,  -- max 80 · '<business_id>:<request id>'
  "name"                     TEXT     NOT NULL,  -- max 60 · the action, e.g. inventory.adjust
  "answer_json"              TEXT,  -- its answer as JSON (NULL: too big to keep)
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;

CREATE TRIGGER IF NOT EXISTS "request_log_updated_at" AFTER UPDATE ON "request_log" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "request_log" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;

CREATE INDEX IF NOT EXISTS "ix_request_log_business_id_created_at" ON "request_log" ("business_id", "created_at");

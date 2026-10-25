-- Order tracking: look up an order by its number (QR / track page), and browser push ("Notify me when ready").

CREATE INDEX IF NOT EXISTS "ix_orders_business_id_order_number" ON "orders" ("business_id", "order_number");

-- Browser push for the QR / order tracking page ("Notify me when ready"). Removed when the order is done or after a day.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,  -- ROWID
  "business_id"              INTEGER  NOT NULL,  -- → businesses.id in the platform database (checked by the API)
  "order_id"                 INTEGER  NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "endpoint"                 TEXT     NOT NULL,  -- max 500 · push service URL (Google / Apple / Mozilla)
  "p256dh"                   TEXT     NOT NULL,  -- max 120 · the browser's public key (base64url)
  "auth_secret"              TEXT     NOT NULL,  -- max 40 · the browser's auth secret (base64url)
  "uniq_key"                 TEXT     NOT NULL UNIQUE,  -- max 80 · '<order_id>:<hash of endpoint>'
  "last_stamp"               TEXT,  -- max 40 · status last sent, so each change is sent once
  "expires_at"               TEXT     NOT NULL,
  "created_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- CREATEDTIME
  "updated_at"               TEXT     NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- MODIFIEDTIME
) STRICT;

CREATE TRIGGER IF NOT EXISTS "push_subscriptions_updated_at" AFTER UPDATE ON "push_subscriptions" FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"
BEGIN UPDATE "push_subscriptions" SET "updated_at" = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "id" = NEW."id"; END;

CREATE INDEX IF NOT EXISTS "ix_push_subscriptions_business_id_expires_at" ON "push_subscriptions" ("business_id", "expires_at");
CREATE INDEX IF NOT EXISTS "ix_push_subscriptions_order_id" ON "push_subscriptions" ("order_id");

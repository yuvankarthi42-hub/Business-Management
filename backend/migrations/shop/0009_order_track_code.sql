-- QR order tracking by a random code instead of the order's row id (anyone could count through row ids).
-- Empty on older orders: their tracking links keep working for the 2-day tracking window, then stop.

ALTER TABLE "orders" ADD COLUMN "track_code" TEXT;

CREATE INDEX IF NOT EXISTS "ix_orders_business_id_track_code" ON "orders" ("business_id", "track_code");

-- Silk & textile shops: fabric / colour / size on products (price stickers), MRP per bill line ("You saved"),
-- and the salesperson on a bill (commission goes to them instead of the person at the counter).
ALTER TABLE "products" ADD COLUMN "details_json" TEXT;
ALTER TABLE "order_items" ADD COLUMN "mrp_minor" INTEGER;
ALTER TABLE "orders" ADD COLUMN "salesperson_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "ix_orders_salesperson_id" ON "orders" ("salesperson_id");

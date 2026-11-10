-- Large shops' light product index on each device: "what changed since" reads (products and stock) by time.
CREATE INDEX IF NOT EXISTS "ix_products_business_id_updated_at" ON "products" ("business_id", "updated_at");
CREATE INDEX IF NOT EXISTS "ix_branch_stock_business_id_updated_at" ON "branch_stock" ("business_id", "updated_at");

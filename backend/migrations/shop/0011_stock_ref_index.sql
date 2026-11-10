-- A bill's stock movements (its sale, cancel, and its credit notes' returns) by reference: cancel / return give back
-- only what the bill actually took out.
CREATE INDEX IF NOT EXISTS "ix_stock_movements_business_id_ref_type_ref_id" ON "stock_movements" ("business_id", "ref_type", "ref_id");

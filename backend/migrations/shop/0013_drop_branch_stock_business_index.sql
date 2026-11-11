-- branch_stock's (business_id, updated_at) index (0010) also serves every "by business" read: the old one-column
-- index is no longer needed (one index fewer to update on every bill line's stock change).
DROP INDEX IF EXISTS "ix_branch_stock_business_id";

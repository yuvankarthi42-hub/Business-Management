-- Small shared cache for every API instance (Turso setup): QR menu / report copies, version stamps, rate limits.
-- Replaces Catalyst Cache there (cheaper: a Turso row read costs almost nothing). Old rows are removed as they expire.
CREATE TABLE IF NOT EXISTS "kv_cache" (
  "key"                      TEXT     PRIMARY KEY,
  "value"                    TEXT     NOT NULL,
  "expires_at"               INTEGER  NOT NULL   -- ms since 1970
) STRICT;
CREATE INDEX IF NOT EXISTS "ix_kv_cache_expires_at" ON "kv_cache" ("expires_at");

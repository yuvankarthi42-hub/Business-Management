-- Each shop database gets its own access token (made with the Turso API when the shop is created), so the
-- platform's TURSO_AUTH_TOKEN never has to open shop databases. Encrypted by the API (SECRETS_KEY).
ALTER TABLE "shop_databases" ADD COLUMN "db_token" TEXT;

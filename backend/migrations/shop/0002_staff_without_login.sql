-- Staff who don't use the app (cleaners, helpers, drivers): kept for attendance and salary, never sign in.
ALTER TABLE "users" ADD COLUMN "can_login" INTEGER NOT NULL DEFAULT 1 CHECK ("can_login" IN (0, 1));

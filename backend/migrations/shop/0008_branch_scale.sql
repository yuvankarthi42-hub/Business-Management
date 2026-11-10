-- Weighing scale per branch (Settings → Printer, scale and bill). Empty = no scale: weights are typed as before.

ALTER TABLE "branches" ADD COLUMN "scale_json" TEXT;

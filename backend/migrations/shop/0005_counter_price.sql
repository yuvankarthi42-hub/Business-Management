-- Price changed at the counter (price change / line discount): the catalogue price it replaced.
ALTER TABLE "order_items" ADD COLUMN "list_price_minor" INTEGER;

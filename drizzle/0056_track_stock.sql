ALTER TABLE "products" ADD COLUMN "track_stock" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- food shops sell made-to-order plates: their existing products stop counting stock (owners can switch it back per product)
UPDATE products SET track_stock = false FROM tenants WHERE products.tenant_id = tenants.id AND tenants.shop_type = 'food';

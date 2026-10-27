-- Food counter tables: tenant isolation, till cache refresh on food changes, and the new till permissions (Phase 1b-1).
ALTER TABLE food_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON food_settings USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE branch_order_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON branch_order_counters USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sold_out ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sold_out USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE kitchen_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON kitchen_orders USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE packing_ticks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON packing_ticks USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON food_settings FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON sold_out FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
-- tills cache each branch's service modes, so a change to them refreshes the tills too
DROP TRIGGER device_cache_version ON branches;
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER UPDATE ON branches FOR EACH ROW
  WHEN ((OLD.name, OLD.branch_code, OLD.service_modes) IS DISTINCT FROM (NEW.name, NEW.branch_code, NEW.service_modes))
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
-- existing sellers in food shops gain the two food till permissions; narrow custom roles (stock-only staff) and other shops do not
UPDATE users u SET permissions = u.permissions || array['mark_sold_out', 'run_kitchen']
  FROM tenants t
  WHERE t.id = u.tenant_id AND 'kitchen' = ANY(t.modules) AND 'make_sale' = ANY(u.permissions) AND NOT ('run_kitchen' = ANY(u.permissions));

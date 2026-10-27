-- Add-ons: tenant isolation and till cache refresh when groups, options, or item links change (Phase 1b-4).
ALTER TABLE add_on_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON add_on_groups USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE add_on_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON add_on_options USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE variant_add_on_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON variant_add_on_groups USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON add_on_groups FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON add_on_options FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON variant_add_on_groups FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');

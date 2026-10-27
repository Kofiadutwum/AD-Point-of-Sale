-- Food menu tables: tenant isolation, till cache refresh on combo changes, append-only wastage, and the kitchen stock permission (Phase 1b-2).
ALTER TABLE combo_slots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON combo_slots USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE combo_choices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON combo_choices USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE pot_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pot_records USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE wastage_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON wastage_entries USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON combo_slots FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON combo_choices FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
REVOKE UPDATE, DELETE ON wastage_entries FROM pos_app;
--> statement-breakpoint
-- existing sellers in food shops can record pots and wastage; narrow custom roles and other shops are left alone
UPDATE users u SET permissions = u.permissions || array['record_kitchen_stock']
  FROM tenants t
  WHERE t.id = u.tenant_id AND 'kitchen' = ANY(t.modules) AND 'make_sale' = ANY(u.permissions) AND NOT ('record_kitchen_stock' = ANY(u.permissions));

-- Offline and MFA tables: pos_app sees only rows of the tenant in app.tenant_id (same policy as 0002_rls.sql).
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mfa_recovery_codes USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE mfa_challenges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON mfa_challenges USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE held_sales ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON held_sales USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE device_cache_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON device_cache_versions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Tills poll device_cache_versions; any change to data they cache bumps it (spec 6.10: refresh after catalogue changes).
CREATE FUNCTION bump_device_cache_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
  -- TG_ARGV[0] names the tenant column: 'id' on tenants, 'tenant_id' elsewhere
  t := (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> TG_ARGV[0])::uuid;
  INSERT INTO device_cache_versions AS v (tenant_id, version) VALUES (t, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET version = v.version + 1;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON variant_units FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON barcodes FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON tax_rules FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON price_lists FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON price_list_items FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON product_images FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('id');
--> statement-breakpoint
-- Columns that change on every sale, stock receipt, or sign-in must not make every till refetch.
CREATE TRIGGER device_cache_version AFTER INSERT OR DELETE ON variants FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version_update AFTER UPDATE ON variants FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'average_cost') IS DISTINCT FROM (to_jsonb(NEW) - 'average_cost'))
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version_update AFTER UPDATE ON users FOR EACH ROW
  WHEN ((OLD.name, OLD.permissions, OLD.branch_ids, OLD.pin_hash, OLD.status, OLD.pin_locked_until)
    IS DISTINCT FROM (NEW.name, NEW.permissions, NEW.branch_ids, NEW.pin_hash, NEW.status, NEW.pin_locked_until))
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR DELETE ON registers FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version_update AFTER UPDATE ON registers FOR EACH ROW
  WHEN ((OLD.name, OLD.register_code, OLD.branch_id, OLD.device_token_hash, OLD.status)
    IS DISTINCT FROM (NEW.name, NEW.register_code, NEW.branch_id, NEW.device_token_hash, NEW.status))
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER UPDATE ON branches FOR EACH ROW
  WHEN ((OLD.name, OLD.branch_code) IS DISTINCT FROM (NEW.name, NEW.branch_code))
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER UPDATE ON held_sales FOR EACH ROW
  WHEN (OLD.resolved_at IS DISTINCT FROM NEW.resolved_at)
  EXECUTE FUNCTION bump_device_cache_version('tenant_id');

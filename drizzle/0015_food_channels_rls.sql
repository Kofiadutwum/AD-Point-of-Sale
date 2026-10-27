-- Sales channels: tenant isolation, till cache refresh on channel changes, and the channel permissions (Phase 1b-3).
ALTER TABLE sales_channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_channels USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel_payouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_payouts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel_receivables ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_receivables USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER device_cache_version AFTER INSERT OR UPDATE OR DELETE ON sales_channels FOR EACH ROW EXECUTE FUNCTION bump_device_cache_version('tenant_id');
--> statement-breakpoint
-- sellers in food shops can enter channel orders; owners and managers can set up channels and record payouts
UPDATE users u SET permissions = u.permissions || array['enter_channel_orders']
  FROM tenants t
  WHERE t.id = u.tenant_id AND 'kitchen' = ANY(t.modules) AND 'make_sale' = ANY(u.permissions) AND NOT ('enter_channel_orders' = ANY(u.permissions));
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['manage_channels'] WHERE role_preset IN ('owner', 'manager') AND NOT ('manage_channels' = ANY(permissions));

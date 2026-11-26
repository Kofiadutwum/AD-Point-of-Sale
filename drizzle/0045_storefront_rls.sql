-- Storefront stats: tenant isolation; storefront permission (Phase 2-7).
ALTER TABLE storefront_stats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON storefront_stats USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['manage_storefront'] WHERE role_preset IN ('owner', 'manager') AND NOT ('manage_storefront' = ANY(permissions));

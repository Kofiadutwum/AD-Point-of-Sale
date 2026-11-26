-- Returns and approvals: tenant isolation and the return permissions (Phase 1b-7).
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON returns USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON return_lines USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approvals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- everyone who sells can take returns; owners and managers can refund freely and by another method
UPDATE users SET permissions = permissions || array['process_return'] WHERE 'make_sale' = ANY(permissions) AND NOT ('process_return' = ANY(permissions));
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['refund_without_approval', 'refund_other_method'] WHERE role_preset IN ('owner', 'manager') AND NOT ('refund_without_approval' = ANY(permissions));

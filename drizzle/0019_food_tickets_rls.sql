-- Tables and tickets: tenant isolation and the ticket permissions (Phase 1b-5). Tickets are online only, so no till cache trigger.
ALTER TABLE dining_tables ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON dining_tables USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tickets USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE ticket_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ticket_lines USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- sellers in food shops can take table orders; owners and managers can approve voids of items already sent
UPDATE users u SET permissions = u.permissions || array['take_orders']
  FROM tenants t
  WHERE t.id = u.tenant_id AND 'kitchen' = ANY(t.modules) AND 'make_sale' = ANY(u.permissions) AND NOT ('take_orders' = ANY(u.permissions));
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['void_sent_items'] WHERE role_preset IN ('owner', 'manager') AND NOT ('void_sent_items' = ANY(permissions));

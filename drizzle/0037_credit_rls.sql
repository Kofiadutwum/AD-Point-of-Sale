-- Customer ledger: tenant isolation; credit permissions (Phase 2-2).
ALTER TABLE customer_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON customer_ledger USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['sell_on_credit'] WHERE role_preset IN ('owner', 'manager') AND NOT ('sell_on_credit' = ANY(permissions));
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['receive_debt_payment'] WHERE 'make_sale' = ANY(permissions) AND NOT ('receive_debt_payment' = ANY(permissions));

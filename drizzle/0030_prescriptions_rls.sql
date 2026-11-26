-- Prescriptions: tenant isolation; owners and managers may dispense (Phase 1b-9).
ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON prescriptions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
UPDATE users SET permissions = permissions || array['dispense_prescription'] WHERE role_preset IN ('owner', 'manager') AND NOT ('dispense_prescription' = ANY(permissions));

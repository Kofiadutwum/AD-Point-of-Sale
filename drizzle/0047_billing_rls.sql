-- Billing (Phase 3): tenant isolation for checkouts; platform-only tables; plan prices (spec 4.27, monthly, billed yearly).
ALTER TABLE subscription_checkouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscription_checkouts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE processed_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE signup_verifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO plans (id, name, price_pesewas, limits, modules) VALUES
  ('starter', 'Starter', 15000, '{"branches":1,"registers":2,"staff":10,"products":2000,"sms_per_month":200}', '{}'),
  ('pro', 'Pro', 60000, '{"branches":5,"registers":15,"staff":50,"products":20000,"sms_per_month":1500}', '{}')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE plans SET price_pesewas = 30000 WHERE id = 'standard' AND price_pesewas = 0;

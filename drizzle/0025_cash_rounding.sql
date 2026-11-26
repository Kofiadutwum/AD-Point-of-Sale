ALTER TABLE "sales" ADD COLUMN "rounding_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cash_rounding_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_cash_rounding" CHECK ("tenants"."cash_rounding_step" in (0, 5, 10, 50, 100));
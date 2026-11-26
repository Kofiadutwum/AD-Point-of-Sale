CREATE TABLE "prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"patient_name" text NOT NULL,
	"prescriber_name" text NOT NULL,
	"facility" text NOT NULL,
	"prescription_date" date NOT NULL,
	"recorded_by" uuid NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescriptions_sale_line" UNIQUE("tenant_id","sale_line_id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "otc_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "expiry_warning_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_sale_line_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_expiry_warning" CHECK ("tenants"."expiry_warning_days" between 1 and 365);
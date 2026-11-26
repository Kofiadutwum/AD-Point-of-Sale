CREATE TABLE "counter_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"business_date" date NOT NULL,
	"lines" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"sale_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counter_orders_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "counter_orders_number" UNIQUE("tenant_id","branch_id","business_date","order_number"),
	CONSTRAINT "counter_orders_status" CHECK ("counter_orders"."status" in ('awaiting_payment', 'paid', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "salesperson_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "counter_order_expiry_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "counter_orders" ADD CONSTRAINT "counter_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_orders" ADD CONSTRAINT "counter_orders_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_orders" ADD CONSTRAINT "counter_orders_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_orders" ADD CONSTRAINT "counter_orders_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_salesperson_fk" FOREIGN KEY ("tenant_id","salesperson_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_counter_order_expiry" CHECK ("tenants"."counter_order_expiry_minutes" between 5 and 1440);
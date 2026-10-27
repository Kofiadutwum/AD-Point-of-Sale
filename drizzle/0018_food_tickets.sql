CREATE TABLE "dining_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'free' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dining_tables_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "dining_tables_status" CHECK ("dining_tables"."status" in ('free', 'ordering', 'waiting_for_food', 'bill_printed'))
);
--> statement-breakpoint
CREATE TABLE "ticket_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"by_amount" boolean DEFAULT false NOT NULL,
	"amount_pesewas" integer,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"station" text NOT NULL,
	"kitchen_status" text DEFAULT 'new' NOT NULL,
	"sent_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" uuid,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_lines_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ticket_lines_line_no" UNIQUE("ticket_id","line_no"),
	CONSTRAINT "ticket_lines_station" CHECK ("ticket_lines"."station" in ('kitchen', 'bar', 'grill')),
	CONSTRAINT "ticket_lines_status" CHECK ("ticket_lines"."kitchen_status" in ('new', 'sent', 'ready', 'void')),
	CONSTRAINT "ticket_lines_void" CHECK ("ticket_lines"."kitchen_status" <> 'void' or "ticket_lines"."void_reason" is not null),
	CONSTRAINT "ticket_lines_quantity" CHECK ("ticket_lines"."quantity" > 0),
	CONSTRAINT "ticket_lines_note" CHECK (length("ticket_lines"."note") <= 140)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"table_id" uuid,
	"label" text NOT NULL,
	"waiter_id" uuid NOT NULL,
	"dining_option" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sale_id" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tickets_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "tickets_sale" UNIQUE("tenant_id","sale_id"),
	CONSTRAINT "tickets_status" CHECK ("tickets"."status" in ('open', 'paid', 'merged', 'cancelled')),
	CONSTRAINT "tickets_dining" CHECK ("tickets"."dining_option" in ('eat_in', 'takeaway', 'delivery')),
	CONSTRAINT "tickets_paid" CHECK ("tickets"."status" <> 'paid' or "tickets"."sale_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "kitchen_station" text DEFAULT 'kitchen' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "service_charge_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "service_charge_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_unit_fk" FOREIGN KEY ("tenant_id","variant_id","unit_id") REFERENCES "public"."variant_units"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."dining_tables"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_waiter_fk" FOREIGN KEY ("tenant_id","waiter_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dining_tables_name" ON "dining_tables" USING btree ("tenant_id","branch_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_open_table" ON "tickets" USING btree ("tenant_id","table_id") WHERE "tickets"."status" = 'open' and "tickets"."table_id" is not null;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_kitchen_station" CHECK ("products"."kitchen_station" in ('kitchen', 'bar', 'grill'));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_service_charge" CHECK ("sales"."service_charge_pesewas" >= 0);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_service_charge" CHECK ("tenants"."service_charge_bp" between 0 and 2500);
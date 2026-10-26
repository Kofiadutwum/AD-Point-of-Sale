CREATE TABLE "branch_order_counters" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "branch_order_counters_pk" PRIMARY KEY("tenant_id","branch_id","business_date")
);
--> statement-breakpoint
CREATE TABLE "food_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"pack_variant_id" uuid,
	"pack_fee_mode" text DEFAULT 'per_order' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_settings_pack_fee_mode" CHECK ("food_settings"."pack_fee_mode" in ('per_item', 'per_order'))
);
--> statement-breakpoint
CREATE TABLE "kitchen_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid,
	"order_number" text NOT NULL,
	"business_date" date NOT NULL,
	"dining_option" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"needs_packing" boolean NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"handed_to" text,
	CONSTRAINT "kitchen_orders_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_orders_sale" UNIQUE("tenant_id","sale_id"),
	CONSTRAINT "kitchen_orders_status" CHECK ("kitchen_orders"."status" in ('preparing', 'ready', 'collected', 'handed_over', 'cancelled')),
	CONSTRAINT "kitchen_orders_dining_option" CHECK ("kitchen_orders"."dining_option" in ('eat_in', 'takeaway', 'delivery'))
);
--> statement-breakpoint
CREATE TABLE "packing_ticks" (
	"tenant_id" uuid NOT NULL,
	"kitchen_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"packed_by" uuid NOT NULL,
	"packed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "packing_ticks_pk" PRIMARY KEY("kitchen_order_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "sold_out" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sold_out_pk" PRIMARY KEY("tenant_id","branch_id","variant_id","business_date")
);
--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "needs_pack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "service_mode" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "dining_option" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "service_modes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "board_token_hash" text;--> statement-breakpoint
ALTER TABLE "branch_order_counters" ADD CONSTRAINT "branch_order_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_order_counters" ADD CONSTRAINT "branch_order_counters_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_settings" ADD CONSTRAINT "food_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_settings" ADD CONSTRAINT "food_settings_pack_fk" FOREIGN KEY ("tenant_id","pack_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_ticks" ADD CONSTRAINT "packing_ticks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_ticks" ADD CONSTRAINT "packing_ticks_order_fk" FOREIGN KEY ("tenant_id","kitchen_order_id") REFERENCES "public"."kitchen_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_ticks" ADD CONSTRAINT "packing_ticks_packed_by_fk" FOREIGN KEY ("tenant_id","packed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out" ADD CONSTRAINT "sold_out_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out" ADD CONSTRAINT "sold_out_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out" ADD CONSTRAINT "sold_out_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out" ADD CONSTRAINT "sold_out_set_by_fk" FOREIGN KEY ("tenant_id","set_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_orders_day" ON "kitchen_orders" USING btree ("tenant_id","branch_id","business_date","status");--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_board_token_hash_unique" UNIQUE("board_token_hash");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_service_mode" CHECK ("sales"."service_mode" in ('counter', 'quick'));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_dining_option" CHECK ("sales"."dining_option" in ('eat_in', 'takeaway', 'delivery'));--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_service_modes" CHECK ("branches"."service_modes" <@ array['counter', 'table', 'quick']::text[]);
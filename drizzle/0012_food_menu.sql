CREATE TABLE "combo_choices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"upgrade_pesewas" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "combo_choices_slot_variant" UNIQUE("slot_id","variant_id"),
	CONSTRAINT "combo_choices_upgrade" CHECK ("combo_choices"."upgrade_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "combo_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"combo_variant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_choices" integer NOT NULL,
	"max_choices" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "combo_slots_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "combo_slots_choices" CHECK (0 <= "combo_slots"."min_choices" and "combo_slots"."min_choices" <= "combo_slots"."max_choices" and "combo_slots"."max_choices" >= 1)
);
--> statement-breakpoint
CREATE TABLE "pot_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"cooked" numeric(14, 3) DEFAULT '0' NOT NULL,
	"carried_in" numeric(14, 3) DEFAULT '0' NOT NULL,
	"leftover" numeric(14, 3),
	"expected_pesewas" integer,
	"actual_pesewas" integer,
	"variance_pesewas" integer,
	"flagged" boolean DEFAULT false NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "pot_records_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "pot_records_day" UNIQUE("tenant_id","branch_id","variant_id","business_date"),
	CONSTRAINT "pot_records_cooked" CHECK ("pot_records"."cooked" >= 0),
	CONSTRAINT "pot_records_leftover" CHECK ("pot_records"."leftover" >= 0 and "pot_records"."leftover" <= "pot_records"."cooked")
);
--> statement-breakpoint
CREATE TABLE "wastage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"reason" text NOT NULL,
	"cost_pesewas" integer NOT NULL,
	"pot_record_id" uuid,
	"note" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wastage_entries_quantity" CHECK ("wastage_entries"."quantity" > 0),
	CONSTRAINT "wastage_entries_reason" CHECK ("wastage_entries"."reason" in ('spoiled', 'dropped', 'staff_meal', 'leftover')),
	CONSTRAINT "wastage_entries_cost" CHECK ("wastage_entries"."cost_pesewas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "variants" DROP CONSTRAINT "variants_kind";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reference";--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "sell_by_amount" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "min_amount_pesewas" integer;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "value_per_pot_pesewas" integer;--> statement-breakpoint
ALTER TABLE "food_settings" ADD COLUMN "keep_pot_leftovers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "food_settings" ADD COLUMN "pot_variance_limit_bp" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "by_amount" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "choices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "combo_choices" ADD CONSTRAINT "combo_choices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_choices" ADD CONSTRAINT "combo_choices_slot_fk" FOREIGN KEY ("tenant_id","slot_id") REFERENCES "public"."combo_slots"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_choices" ADD CONSTRAINT "combo_choices_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combo_slots" ADD CONSTRAINT "combo_slots_combo_fk" FOREIGN KEY ("tenant_id","combo_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pot_records" ADD CONSTRAINT "pot_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pot_records" ADD CONSTRAINT "pot_records_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pot_records" ADD CONSTRAINT "pot_records_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pot_records" ADD CONSTRAINT "pot_records_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_pot_fk" FOREIGN KEY ("tenant_id","pot_record_id") REFERENCES "public"."pot_records"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_entries" ADD CONSTRAINT "wastage_entries_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_by_amount" CHECK (not "variants"."sell_by_amount" or (coalesce("variants"."min_amount_pesewas", 0) >= 1 and "variants"."kind" in ('standard', 'recipe')));--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_value_per_pot" CHECK ("variants"."value_per_pot_pesewas" > 0);--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_kind" CHECK ("variants"."kind" in ('standard', 'bundle', 'recipe', 'combo'));--> statement-breakpoint
ALTER TABLE "food_settings" ADD CONSTRAINT "food_settings_pot_variance_limit" CHECK ("food_settings"."pot_variance_limit_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type" CHECK ("stock_movements"."type" in ('opening_stock', 'received', 'sale', 'used_in_production', 'waste'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reference" CHECK ("stock_movements"."reference_type" in ('stock_receipt', 'sale', 'pot_record', 'wastage'));
CREATE TABLE "production_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"ingredient_variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_ingredients_pair" UNIQUE("tenant_id","variant_id","ingredient_variant_id"),
	CONSTRAINT "production_ingredients_quantity" CHECK ("production_ingredients"."quantity" > 0),
	CONSTRAINT "production_ingredients_not_self" CHECK ("production_ingredients"."variant_id" <> "production_ingredients"."ingredient_variant_id")
);
--> statement-breakpoint
CREATE TABLE "production_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_runs_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "production_runs_quantity" CHECK ("production_runs"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reference";--> statement-breakpoint
ALTER TABLE "production_ingredients" ADD CONSTRAINT "production_ingredients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_ingredients" ADD CONSTRAINT "production_ingredients_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_ingredients" ADD CONSTRAINT "production_ingredients_ingredient_fk" FOREIGN KEY ("tenant_id","ingredient_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type" CHECK ("stock_movements"."type" in ('opening_stock', 'received', 'sale', 'used_in_production', 'waste', 'return_restock', 'produced'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reference" CHECK ("stock_movements"."reference_type" in ('stock_receipt', 'sale', 'pot_record', 'wastage', 'return', 'production'));
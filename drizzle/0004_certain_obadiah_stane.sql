CREATE TABLE "barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "barcodes_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_variant_id" uuid NOT NULL,
	"component_variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "components_pair" UNIQUE("parent_variant_id","component_variant_id"),
	CONSTRAINT "components_not_self" CHECK ("components"."parent_variant_id" <> "components"."component_variant_id"),
	CONSTRAINT "components_quantity" CHECK ("components"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"min_quantity" numeric(14, 3) DEFAULT '1' NOT NULL,
	"price_pesewas" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_items_break" UNIQUE("price_list_id","unit_id","min_quantity"),
	CONSTRAINT "price_list_items_min" CHECK ("price_list_items"."min_quantity" > 0),
	CONSTRAINT "price_list_items_price" CHECK ("price_list_items"."price_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"branch_id" uuid,
	"starts_on" date,
	"ends_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_lists_kind" CHECK ("price_lists"."kind" in ('retail', 'wholesale', 'customer_group', 'branch')),
	CONSTRAINT "price_lists_branch" CHECK (("price_lists"."kind" = 'branch') = ("price_lists"."branch_id" is not null)),
	CONSTRAINT "price_lists_retail_undated" CHECK ("price_lists"."kind" <> 'retail' or ("price_lists"."starts_on" is null and "price_lists"."ends_on" is null)),
	CONSTRAINT "price_lists_dates" CHECK ("price_lists"."ends_on" >= "price_lists"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "product_images_bytes" CHECK ("product_images"."bytes" between 1 and 30720),
	CONSTRAINT "product_images_sort" CHECK ("product_images"."sort_order" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"brand" text,
	"tax_rule_id" uuid,
	"tracking" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"show_on_storefront" boolean DEFAULT false NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"generic_name" text,
	"strength" text,
	"dosage_form" text,
	"registration_number" text,
	"prescription_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_tracking" CHECK ("products"."tracking" in ('none', 'batch', 'serial')),
	CONSTRAINT "products_status" CHECK ("products"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"levies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vat_on_levies" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_rules_rate" CHECK ("tax_rules"."rate_bp" between 0 and 10000),
	CONSTRAINT "tax_rules_default_active" CHECK (not ("tax_rules"."is_default" and not "tax_rules"."active"))
);
--> statement-breakpoint
CREATE TABLE "variant_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"factor" numeric(14, 3) NOT NULL,
	"price_pesewas" integer,
	"sellable" boolean DEFAULT true NOT NULL,
	"purchasable" boolean DEFAULT true NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_units_tenant_variant_id" UNIQUE("tenant_id","variant_id","id"),
	CONSTRAINT "variant_units_factor" CHECK (("variant_units"."is_base" and "variant_units"."factor" = 1 and "variant_units"."price_pesewas" is null) or (not "variant_units"."is_base" and "variant_units"."factor" > 1)),
	CONSTRAINT "variant_units_price" CHECK ("variant_units"."price_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"sku" text,
	"allows_fractions" boolean DEFAULT false NOT NULL,
	"base_price_pesewas" integer NOT NULL,
	"average_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(14, 3),
	"scale_item_code" integer,
	"sellable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "variants_sku" UNIQUE("tenant_id","sku"),
	CONSTRAINT "variants_scale_code" UNIQUE("tenant_id","scale_item_code"),
	CONSTRAINT "variants_kind" CHECK ("variants"."kind" in ('standard', 'bundle', 'recipe')),
	CONSTRAINT "variants_status" CHECK ("variants"."status" in ('active', 'archived')),
	CONSTRAINT "variants_price" CHECK ("variants"."base_price_pesewas" >= 0),
	CONSTRAINT "variants_cost" CHECK ("variants"."average_cost" >= 0),
	CONSTRAINT "variants_reorder" CHECK ("variants"."reorder_level" >= 0),
	CONSTRAINT "variants_scale_code_positive" CHECK ("variants"."scale_item_code" > 0)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tax_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "scale_barcode" jsonb;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_unit_fk" FOREIGN KEY ("tenant_id","variant_id","unit_id") REFERENCES "public"."variant_units"("tenant_id","variant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_parent_fk" FOREIGN KEY ("tenant_id","parent_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_part_fk" FOREIGN KEY ("tenant_id","component_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_unit_fk" FOREIGN KEY ("tenant_id","variant_id","unit_id") REFERENCES "public"."variant_units"("tenant_id","variant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_rule_fk" FOREIGN KEY ("tenant_id","tax_rule_id") REFERENCES "public"."tax_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_units" ADD CONSTRAINT "variant_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_units" ADD CONSTRAINT "variant_units_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name" ON "categories" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_retail" ON "price_lists" USING btree ("tenant_id") WHERE "price_lists"."kind" = 'retail';--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_per_branch" ON "price_lists" USING btree ("tenant_id","branch_id") WHERE "price_lists"."kind" = 'branch';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_name" ON "tax_rules" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_one_default" ON "tax_rules" USING btree ("tenant_id") WHERE "tax_rules"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "variant_units_one_base" ON "variant_units" USING btree ("variant_id") WHERE "variant_units"."is_base";--> statement-breakpoint
CREATE UNIQUE INDEX "variant_units_name" ON "variant_units" USING btree ("variant_id",lower("name"));

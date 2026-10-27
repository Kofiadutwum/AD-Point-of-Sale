CREATE TABLE "add_on_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_choices" integer DEFAULT 0 NOT NULL,
	"max_choices" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "add_on_groups_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "add_on_groups_choices" CHECK ("add_on_groups"."min_choices" between 0 and 20 and "add_on_groups"."max_choices" between 1 and 20 and "add_on_groups"."min_choices" <= "add_on_groups"."max_choices")
);
--> statement-breakpoint
CREATE TABLE "add_on_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_pesewas" integer DEFAULT 0 NOT NULL,
	"ingredient_variant_id" uuid,
	"ingredient_quantity" numeric(14, 3),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "add_on_options_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "add_on_options_price" CHECK ("add_on_options"."price_pesewas" >= 0),
	CONSTRAINT "add_on_options_ingredient" CHECK (("add_on_options"."ingredient_variant_id" is null) = ("add_on_options"."ingredient_quantity" is null) and ("add_on_options"."ingredient_quantity" is null or "add_on_options"."ingredient_quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "variant_add_on_groups" (
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "variant_add_on_groups_pk" PRIMARY KEY("tenant_id","variant_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "add_on_groups" ADD CONSTRAINT "add_on_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "add_on_options" ADD CONSTRAINT "add_on_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "add_on_options" ADD CONSTRAINT "add_on_options_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."add_on_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "add_on_options" ADD CONSTRAINT "add_on_options_ingredient_fk" FOREIGN KEY ("tenant_id","ingredient_variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_add_on_groups" ADD CONSTRAINT "variant_add_on_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_add_on_groups" ADD CONSTRAINT "variant_add_on_groups_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_add_on_groups" ADD CONSTRAINT "variant_add_on_groups_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."add_on_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "add_on_groups_name" ON "add_on_groups" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_note" CHECK (length("sale_lines"."note") <= 140);
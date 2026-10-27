CREATE TABLE "channel_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"reference" text NOT NULL,
	"period_from" date,
	"period_to" date,
	"expected_pesewas" integer NOT NULL,
	"difference_pesewas" integer NOT NULL,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_payouts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "channel_payouts_reference" UNIQUE("tenant_id","channel_id","reference"),
	CONSTRAINT "channel_payouts_amount" CHECK ("channel_payouts"."amount_pesewas" > 0),
	CONSTRAINT "channel_payouts_period" CHECK ("channel_payouts"."period_to" >= "channel_payouts"."period_from")
);
--> statement-breakpoint
CREATE TABLE "channel_receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"expected_pesewas" integer NOT NULL,
	"payout_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_receivables_sale" UNIQUE("tenant_id","sale_id")
);
--> statement-breakpoint
CREATE TABLE "sales_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"price_list_id" uuid,
	"commission_bp" integer DEFAULT 0 NOT NULL,
	"collected_by" text DEFAULT 'shop' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_channels_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "sales_channels_kind" CHECK ("sales_channels"."kind" in ('delivery_app', 'phone', 'whatsapp')),
	CONSTRAINT "sales_channels_commission" CHECK ("sales_channels"."commission_bp" between 0 and 10000),
	CONSTRAINT "sales_channels_collected_by" CHECK ("sales_channels"."collected_by" in ('app', 'shop') and ("sales_channels"."kind" = 'delivery_app' or "sales_channels"."collected_by" = 'shop'))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method";--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "pickup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "pay_on_collect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD COLUMN "pending_lines" jsonb;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "external_order_id" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "commission_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_payouts" ADD CONSTRAINT "channel_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_payouts" ADD CONSTRAINT "channel_payouts_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."sales_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_payouts" ADD CONSTRAINT "channel_payouts_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_receivables" ADD CONSTRAINT "channel_receivables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_receivables" ADD CONSTRAINT "channel_receivables_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_receivables" ADD CONSTRAINT "channel_receivables_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."sales_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_receivables" ADD CONSTRAINT "channel_receivables_payout_fk" FOREIGN KEY ("tenant_id","payout_id") REFERENCES "public"."channel_payouts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_price_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channels_name" ON "sales_channels" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."sales_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."sales_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_channel_order" ON "sales" USING btree ("tenant_id","channel_id","external_order_id") WHERE "sales"."external_order_id" is not null;--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_paid" CHECK ("kitchen_orders"."pay_on_collect" or "kitchen_orders"."sale_id" is not null);--> statement-breakpoint
ALTER TABLE "kitchen_orders" ADD CONSTRAINT "kitchen_orders_pending_lines" CHECK (not "kitchen_orders"."pay_on_collect" or "kitchen_orders"."pending_lines" is not null);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement'));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_external_order" CHECK ("sales"."external_order_id" is null or "sales"."channel_id" is not null);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_commission" CHECK ("sales"."commission_pesewas" >= 0);
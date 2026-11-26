CREATE TABLE "cart_snapshots" (
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cart" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_snapshots_pk" PRIMARY KEY("tenant_id","register_id")
);
--> statement-breakpoint
CREATE TABLE "commission_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"return_id" uuid,
	"amount_pesewas" integer NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"product_id" uuid,
	"category_id" uuid,
	"percent_bp" integer,
	"fixed_pesewas" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rules_amount" CHECK (("commission_rules"."percent_bp" is null) <> ("commission_rules"."fixed_pesewas" is null) and coalesce("commission_rules"."percent_bp", 0) between 0 and 10000 and coalesce("commission_rules"."fixed_pesewas", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "coupon_uses" (
	"tenant_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_uses_pk" PRIMARY KEY("tenant_id","coupon_id","sale_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"promotion_id" uuid NOT NULL,
	"max_uses" integer,
	"per_customer_limit" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "coupons_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "customer_displays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_displays_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "customer_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"customer_id" uuid NOT NULL,
	"lines" jsonb NOT NULL,
	"total_pesewas" integer NOT NULL,
	"paid_pesewas" integer DEFAULT 0 NOT NULL,
	"due_date" date,
	"note" text,
	"sale_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_orders_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_orders_number" UNIQUE("tenant_id","number"),
	CONSTRAINT "customer_orders_kind" CHECK ("customer_orders"."kind" in ('layaway', 'special')),
	CONSTRAINT "customer_orders_status" CHECK ("customer_orders"."status" in ('open', 'ready', 'collected', 'cancelled')),
	CONSTRAINT "customer_orders_paid" CHECK ("customer_orders"."paid_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "display_pairings" (
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "display_pairings_pk" PRIMARY KEY("tenant_id","register_id")
);
--> statement-breakpoint
CREATE TABLE "gift_card_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_card_entries_type" CHECK ("gift_card_entries"."type" in ('issued', 'redeemed'))
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_sealed" text NOT NULL,
	"last4" text NOT NULL,
	"initial_pesewas" integer NOT NULL,
	"balance_pesewas" integer NOT NULL,
	"expires_on" date,
	"sale_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "gift_cards_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "gift_cards_balance" CHECK ("gift_cards"."balance_pesewas" between 0 and "gift_cards"."initial_pesewas"),
	CONSTRAINT "gift_cards_status" CHECK ("gift_cards"."status" in ('active', 'void'))
);
--> statement-breakpoint
CREATE TABLE "loyalty_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"points" integer NOT NULL,
	"sale_id" uuid,
	"expiry_checked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_entries_type" CHECK ("loyalty_entries"."type" in ('earned', 'redeemed', 'reversed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "order_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"reference" text,
	"shift_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payments_amount" CHECK ("order_payments"."amount_pesewas" <> 0),
	CONSTRAINT "order_payments_method" CHECK ("order_payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'fee'))
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"product_ids" uuid[] DEFAULT '{}' NOT NULL,
	"category_ids" uuid[] DEFAULT '{}' NOT NULL,
	"percent_bp" integer,
	"amount_pesewas" integer,
	"buy_qty" integer,
	"get_qty" integer,
	"group_qty" integer,
	"group_price_pesewas" integer,
	"min_subtotal_pesewas" integer DEFAULT 0 NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"days" integer[] DEFAULT '{}' NOT NULL,
	"start_time" text,
	"end_time" text,
	"branch_ids" uuid[] DEFAULT '{}' NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"requires_coupon" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "promotions_kind" CHECK ("promotions"."kind" in ('percent_off', 'amount_off', 'buy_x_get_y', 'multi_buy', 'cart_percent', 'cart_amount')),
	CONSTRAINT "promotions_numbers" CHECK (coalesce("promotions"."percent_bp", 0) between 0 and 10000 and coalesce("promotions"."amount_pesewas", 0) >= 0 and coalesce("promotions"."buy_qty", 1) >= 1 and coalesce("promotions"."get_qty", 1) >= 1 and coalesce("promotions"."group_qty", 2) >= 2 and coalesce("promotions"."group_price_pesewas", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_reference";--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "is_gift_card" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "loyalty_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "loyalty_code" text;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "promotion_discount_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD COLUMN "reserved" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "loyalty_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pesewas_per_point" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "point_value_pesewas" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "min_redeem_points" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "points_expiry_months" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "gift_card_expiry_months" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "layaway_min_deposit_percent" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "order_cancellation_fee_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "order_refund_as" text DEFAULT 'store_credit' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "momo_number" text;--> statement-breakpoint
ALTER TABLE "cart_snapshots" ADD CONSTRAINT "cart_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_coupon_fk" FOREIGN KEY ("tenant_id","coupon_id") REFERENCES "public"."coupons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_promotion_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_displays" ADD CONSTRAINT "customer_displays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_displays" ADD CONSTRAINT "customer_displays_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "display_pairings" ADD CONSTRAINT "display_pairings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_entries" ADD CONSTRAINT "gift_card_entries_card_fk" FOREIGN KEY ("tenant_id","gift_card_id") REFERENCES "public"."gift_cards"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_entries" ADD CONSTRAINT "loyalty_entries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."customer_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_entries_user" ON "commission_entries" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "display_pairings_code" ON "display_pairings" USING btree ("code");--> statement-breakpoint
CREATE INDEX "loyalty_entries_customer" ON "loyalty_entries" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('report', 'marketing', 'billing', 'order'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement', 'exchange_credit', 'credit', 'points', 'gift_card', 'deposit'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference" CHECK ("payments"."method" in ('cash', 'store_credit', 'exchange_credit', 'credit', 'points', 'deposit') or "payments"."reference" is not null);
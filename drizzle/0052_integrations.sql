CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "online_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"source" text DEFAULT 'storefront' NOT NULL,
	"fulfilment" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_phone" text NOT NULL,
	"delivery_address" text,
	"note" text,
	"lines" jsonb NOT NULL,
	"delivery_fee_pesewas" integer DEFAULT 0 NOT NULL,
	"total_pesewas" integer NOT NULL,
	"pay_method" text NOT NULL,
	"paid_pesewas" integer DEFAULT 0 NOT NULL,
	"payment_reference" text,
	"proof_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"sale_id" uuid,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_orders_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "online_orders_number" UNIQUE("tenant_id","number"),
	CONSTRAINT "online_orders_status" CHECK ("online_orders"."status" in ('awaiting_payment', 'proof_uploaded', 'confirmed', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "online_orders_source" CHECK ("online_orders"."source" in ('storefront', 'whatsapp', 'instagram', 'facebook', 'walk_in')),
	CONSTRAINT "online_orders_fulfilment" CHECK ("online_orders"."fulfilment" in ('pickup', 'delivery')),
	CONSTRAINT "online_orders_pay_method" CHECK ("online_orders"."pay_method" in ('paystack', 'transfer'))
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_verifications_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "shop_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"purpose" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sale" jsonb,
	"order_id" uuid,
	"sale_id" uuid,
	"channel" text,
	"authorization_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "shop_charges_reference_unique" UNIQUE("reference"),
	CONSTRAINT "shop_charges_purpose" CHECK ("shop_charges"."purpose" in ('till', 'online_order')),
	CONSTRAINT "shop_charges_status" CHECK ("shop_charges"."status" in ('pending', 'success', 'failed', 'mismatch')),
	CONSTRAINT "shop_charges_amount" CHECK ("shop_charges"."amount_pesewas" > 0)
);
--> statement-breakpoint
CREATE TABLE "shop_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"host" text NOT NULL,
	"verify_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_domains_host_unique" UNIQUE("host")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status" CHECK ("webhook_deliveries"."status" in ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "paystack_secret_sealed" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "paystack_key_hint" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "online_orders_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "online_order_expiry_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "delivery_fee_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "transfer_instructions" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_charges" ADD CONSTRAINT "shop_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_domains" ADD CONSTRAINT "shop_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_fk" FOREIGN KEY ("tenant_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_orders_phone" ON "online_orders" USING btree ("tenant_id","contact_phone");--> statement-breakpoint
CREATE INDEX "phone_verifications_phone" ON "phone_verifications" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_online_order_expiry" CHECK ("tenants"."online_order_expiry_minutes" between 10 and 10080);
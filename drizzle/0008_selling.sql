CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"price_list_id" uuid,
	"store_credit_pesewas" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_phone" UNIQUE("tenant_id","phone"),
	CONSTRAINT "customers_store_credit" CHECK ("customers"."store_credit_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"reference" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit')),
	CONSTRAINT "payments_reference" CHECK ("payments"."method" in ('cash', 'store_credit') or "payments"."reference" is not null),
	CONSTRAINT "payments_amount" CHECK ("payments"."amount_pesewas" > 0),
	CONSTRAINT "payments_status" CHECK ("payments"."status" in ('confirmed', 'pending'))
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_name" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"base_quantity" numeric(14, 3) NOT NULL,
	"unit_price_pesewas" integer NOT NULL,
	"current_price_pesewas" integer NOT NULL,
	"discount_pesewas" integer NOT NULL,
	"gross_pesewas" integer NOT NULL,
	"tax_rate_bp" integer NOT NULL,
	"tax_pesewas" integer NOT NULL,
	"total_pesewas" integer NOT NULL,
	"serials" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "sale_lines_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_lines_line_no" UNIQUE("sale_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"customer_id" uuid,
	"receipt_number" text NOT NULL,
	"status" text NOT NULL,
	"tax_mode" text NOT NULL,
	"subtotal_pesewas" integer NOT NULL,
	"discount_pesewas" integer NOT NULL,
	"tax_pesewas" integer NOT NULL,
	"total_pesewas" integer NOT NULL,
	"paid_pesewas" integer NOT NULL,
	"change_due_pesewas" integer NOT NULL,
	"from_offline" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reasons" text[] DEFAULT '{}' NOT NULL,
	"device_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"business_date" date NOT NULL,
	"share_code" text NOT NULL,
	CONSTRAINT "sales_share_code_unique" UNIQUE("share_code"),
	CONSTRAINT "sales_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "sales_receipt_number" UNIQUE("tenant_id","receipt_number"),
	CONSTRAINT "sales_status" CHECK ("sales"."status" in ('pending', 'completed')),
	CONSTRAINT "sales_tax_mode" CHECK ("sales"."tax_mode" in ('inclusive', 'exclusive'))
);
--> statement-breakpoint
CREATE TABLE "store_credit_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_credit_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"sale_id" uuid,
	"reason" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_credit_entries_type" CHECK ("store_credit_entries"."type" in ('issued', 'redeemed')),
	CONSTRAINT "store_credit_entries_source" CHECK ("store_credit_entries"."source" in ('refund', 'goodwill', 'sale')),
	CONSTRAINT "store_credit_entries_amount" CHECK ("store_credit_entries"."amount_pesewas" <> 0)
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"sale_id" uuid,
	"sold_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serials_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "serials_serial" UNIQUE("tenant_id","variant_id","serial"),
	CONSTRAINT "serials_status" CHECK ("serials"."status" in ('in_stock', 'sold'))
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_pk" PRIMARY KEY("tenant_id","branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_number" text NOT NULL,
	"expiry_date" date NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batches_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_batches_number" UNIQUE("tenant_id","branch_id","variant_id","batch_number")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"batch_id" uuid,
	"serial_id" uuid,
	"unit_cost" numeric(14, 4),
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"sale_line_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_type" CHECK ("stock_movements"."type" in ('opening_stock', 'received', 'sale')),
	CONSTRAINT "stock_movements_reference" CHECK ("stock_movements"."reference_type" in ('stock_receipt', 'sale')),
	CONSTRAINT "stock_movements_quantity" CHECK ("stock_movements"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"supplier_name" text,
	"note" text,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_receipts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_receipts_kind" CHECK ("stock_receipts"."kind" in ('received', 'opening_stock'))
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allow_negative_stock" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "tax_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "receipt_footer" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_price_list_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_fk" FOREIGN KEY ("tenant_id","cashier_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credit_entries" ADD CONSTRAINT "store_credit_entries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_serial_fk" FOREIGN KEY ("tenant_id","serial_id") REFERENCES "public"."serials"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_user_fk" FOREIGN KEY ("tenant_id","received_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_business_date" ON "sales" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_time" ON "stock_movements" USING btree ("tenant_id","variant_id","created_at");

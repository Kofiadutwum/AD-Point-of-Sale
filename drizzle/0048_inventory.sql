CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"factor" numeric(14, 3) NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"received_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"unit_cost_pesewas" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity" CHECK ("purchase_order_lines"."quantity" > 0 and "purchase_order_lines"."received_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"suggested" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_orders_number" UNIQUE("tenant_id","number"),
	CONSTRAINT "purchase_orders_status" CHECK ("purchase_orders"."status" in ('draft', 'sent', 'partly_received', 'received', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"quantity" numeric(14, 3) NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"value_pesewas" integer NOT NULL,
	"approved_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_reason" CHECK ("stock_adjustments"."reason" in ('damage', 'loss', 'theft', 'own_use', 'found', 'expiry_disposal')),
	CONSTRAINT "stock_adjustments_quantity" CHECK ("stock_adjustments"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid,
	"expected" numeric(14, 3) NOT NULL,
	"counted" numeric(14, 3),
	"counted_at" timestamp with time zone,
	"difference" numeric(14, 3)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"approved_by" uuid,
	"difference_value_pesewas" integer,
	CONSTRAINT "stock_counts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_counts_status" CHECK ("stock_counts"."status" in ('open', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_number" text,
	"expiry_date" date,
	"quantity" numeric(14, 3) NOT NULL,
	"received_quantity" numeric(14, 3),
	"unit_cost" numeric(14, 4) NOT NULL,
	"difference_reason" text,
	CONSTRAINT "stock_transfer_lines_quantity" CHECK ("stock_transfer_lines"."quantity" > 0 and ("stock_transfer_lines"."received_quantity" is null or "stock_transfer_lines"."received_quantity" >= 0))
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_branch_id" uuid NOT NULL,
	"to_branch_id" uuid NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"note" text,
	"sent_by" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	CONSTRAINT "stock_transfers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_transfers_number" UNIQUE("tenant_id","number"),
	CONSTRAINT "stock_transfers_status" CHECK ("stock_transfers"."status" in ('sent', 'received')),
	CONSTRAINT "stock_transfers_branches" CHECK ("stock_transfers"."from_branch_id" <> "stock_transfers"."to_branch_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"receipt_id" uuid,
	"reference" text,
	"amount_pesewas" integer NOT NULL,
	"paid_pesewas" integer DEFAULT 0 NOT NULL,
	"due_date" date NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_bills_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_bills_amounts" CHECK ("supplier_bills"."amount_pesewas" > 0 and "supplier_bills"."paid_pesewas" between 0 and "supplier_bills"."amount_pesewas")
);
--> statement-breakpoint
CREATE TABLE "supplier_items" (
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"pack_factor" numeric(14, 3) NOT NULL,
	"last_cost_pesewas" integer,
	"is_main" boolean DEFAULT true NOT NULL,
	CONSTRAINT "supplier_items_pk" PRIMARY KEY("tenant_id","supplier_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"bill_id" uuid,
	"amount_pesewas" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_amount" CHECK ("supplier_payments"."amount_pesewas" > 0),
	CONSTRAINT "supplier_payments_method" CHECK ("supplier_payments"."method" in ('cash', 'momo_manual', 'bank_transfer', 'cheque', 'credit'))
);
--> statement-breakpoint
CREATE TABLE "supplier_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"credit_pesewas" integer NOT NULL,
	"credit_used_pesewas" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_returns_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_returns_credit" CHECK ("supplier_returns"."credit_pesewas" >= 0 and "supplier_returns"."credit_used_pesewas" between 0 and "supplier_returns"."credit_pesewas")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "suppliers_terms" CHECK ("suppliers"."payment_terms_days" between 0 and 365 and "suppliers"."lead_time_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reference";--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "count_approval_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "adjustment_approval_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "reorder_cover_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_user_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("tenant_id","count_id") REFERENCES "public"."stock_counts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."stock_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_fk" FOREIGN KEY ("tenant_id","transfer_id") REFERENCES "public"."stock_transfers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_fk" FOREIGN KEY ("tenant_id","from_branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_fk" FOREIGN KEY ("tenant_id","to_branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_bills" ADD CONSTRAINT "supplier_bills_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."stock_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_variant_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bill_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."supplier_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_supplier_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_item" ON "stock_count_lines" USING btree ("count_id","variant_id",coalesce("batch_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "stock_count_lines_count" ON "stock_count_lines" USING btree ("tenant_id","count_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name" ON "suppliers" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type" CHECK ("stock_movements"."type" in ('opening_stock', 'received', 'sale', 'used_in_production', 'waste', 'return_restock', 'produced', 'transfer_out', 'transfer_in', 'supplier_return', 'count_adjustment', 'adjustment'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reference" CHECK ("stock_movements"."reference_type" in ('stock_receipt', 'sale', 'pot_record', 'wastage', 'return', 'production', 'transfer', 'supplier_return', 'stock_count', 'adjustment'));
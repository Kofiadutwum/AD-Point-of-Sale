CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"context_key" text NOT NULL,
	"token_hash" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_token" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_line_id" uuid,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"base_quantity" numeric(14, 3) NOT NULL,
	"condition" text NOT NULL,
	"refund_pesewas" integer NOT NULL,
	CONSTRAINT "return_lines_quantity" CHECK ("return_lines"."quantity" > 0),
	CONSTRAINT "return_lines_condition" CHECK ("return_lines"."condition" in ('saleable', 'damaged', 'expired')),
	CONSTRAINT "return_lines_refund" CHECK ("return_lines"."refund_pesewas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"refund_method" text NOT NULL,
	"refund_pesewas" integer NOT NULL,
	"reference" text,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "returns_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "returns_kind" CHECK ("returns"."kind" in ('receipt', 'no_receipt') and ("returns"."kind" = 'no_receipt' or "returns"."sale_id" is not null)),
	CONSTRAINT "returns_refund" CHECK ("returns"."refund_pesewas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "refund_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allow_no_receipt_returns" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "no_receipt_monthly_limit" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sale_line_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_unit_fk" FOREIGN KEY ("tenant_id","variant_id","unit_id") REFERENCES "public"."variant_units"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type" CHECK ("stock_movements"."type" in ('opening_stock', 'received', 'sale', 'used_in_production', 'waste', 'return_restock'));
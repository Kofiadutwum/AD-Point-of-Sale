CREATE TABLE "customer_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"balance_after_pesewas" integer NOT NULL,
	"method" text,
	"reference" text,
	"sale_id" uuid,
	"return_id" uuid,
	"shift_id" uuid,
	"reason" text,
	"user_id" uuid NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_ledger_type" CHECK ("customer_ledger"."type" in ('sale', 'payment', 'return', 'adjustment')),
	CONSTRAINT "customer_ledger_amount" CHECK ("customer_ledger"."amount_pesewas" <> 0 and "customer_ledger"."balance_after_pesewas" >= 0),
	CONSTRAINT "customer_ledger_method" CHECK ("customer_ledger"."method" is null or "customer_ledger"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer'))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_method";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_reference";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "credit_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "balance_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminder_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_sale_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_return_fk" FOREIGN KEY ("tenant_id","return_id") REFERENCES "public"."returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_ledger_customer" ON "customer_ledger" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_credit" CHECK ("customers"."credit_limit_pesewas" >= 0 and "customers"."balance_pesewas" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement', 'exchange_credit', 'credit'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference" CHECK ("payments"."method" in ('cash', 'store_credit', 'exchange_credit', 'credit') or "payments"."reference" is not null);
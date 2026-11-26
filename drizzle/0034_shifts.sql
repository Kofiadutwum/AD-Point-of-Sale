CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"reason" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expense_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_type" CHECK ("cash_movements"."type" in ('paid_in', 'paid_out')),
	CONSTRAINT "cash_movements_amount" CHECK ("cash_movements"."amount_pesewas" > 0)
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"approved_by" uuid,
	"shift_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "expenses_amount" CHECK ("expenses"."amount_pesewas" > 0),
	CONSTRAINT "expenses_method" CHECK ("expenses"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer')),
	CONSTRAINT "expenses_reference" CHECK ("expenses"."method" = 'cash' or "expenses"."reference" is not null)
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_cash_pesewas" integer NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"expected_cash_pesewas" integer,
	"counted_cash_pesewas" integer,
	"variance_pesewas" integer,
	"variance_reason" text,
	"approved_by" uuid,
	CONSTRAINT "shifts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "shifts_status" CHECK ("shifts"."status" in ('open', 'closed')),
	CONSTRAINT "shifts_opening" CHECK ("shifts"."opening_cash_pesewas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "require_shifts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cash_variance_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "expense_approval_limit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_register_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_fk" FOREIGN KEY ("tenant_id","opened_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open" ON "shifts" USING btree ("register_id") WHERE "shifts"."status" = 'open';--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;
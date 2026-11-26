CREATE TABLE "processed_events" (
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_pk" PRIMARY KEY("provider","event_type","reference")
);
--> statement-breakpoint
CREATE TABLE "signup_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_name" text NOT NULL,
	"shop_type" text NOT NULL,
	"slug" text NOT NULL,
	"owner_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"sms_code_hash" text NOT NULL,
	"email_code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"plan_id" text NOT NULL,
	"amount_pesewas" integer NOT NULL,
	"period_months" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"consent_text" text,
	"consent_by" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "subscription_checkouts_reference_unique" UNIQUE("reference"),
	CONSTRAINT "subscription_checkouts_kind" CHECK ("subscription_checkouts"."kind" in ('checkout', 'renewal')),
	CONSTRAINT "subscription_checkouts_status" CHECK ("subscription_checkouts"."status" in ('pending', 'applied', 'failed', 'mismatch')),
	CONSTRAINT "subscription_checkouts_amount" CHECK ("subscription_checkouts"."amount_pesewas" > 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "authorization_code" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "card_label" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('report', 'marketing', 'billing'));
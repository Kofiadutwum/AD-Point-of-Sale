CREATE TABLE "marketing_opt_outs" (
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_opt_outs_pk" PRIMARY KEY("tenant_id","phone")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"parts" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"send_after" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" in ('report', 'marketing')),
	CONSTRAINT "notifications_status" CHECK ("notifications"."status" in ('queued', 'sent', 'failed', 'blocked_quota'))
);
--> statement-breakpoint
CREATE TABLE "sms_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"segment" text NOT NULL,
	"message" text NOT NULL,
	"recipients" integer NOT NULL,
	"parts" integer NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_campaigns_segment" CHECK ("sms_campaigns"."segment" in ('all', 'recent', 'lapsed'))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sms_reports" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "report_time" text DEFAULT '21:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "weekly_report_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_opt_outs" ADD CONSTRAINT "marketing_opt_outs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD CONSTRAINT "sms_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_campaigns" ADD CONSTRAINT "sms_campaigns_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_queue" ON "notifications" USING btree ("status","send_after");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_weekly_report_day" CHECK ("tenants"."weekly_report_day" between 0 and 6);
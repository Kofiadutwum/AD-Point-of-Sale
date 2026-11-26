CREATE TABLE "support_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"granted_by" uuid,
	"admin_id" uuid,
	"reason" text NOT NULL,
	"emergency" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "support_sessions_who" CHECK (("support_sessions"."emergency" and "support_sessions"."admin_id" is not null) or (not "support_sessions"."emergency" and "support_sessions"."granted_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_granted_by_fk" FOREIGN KEY ("tenant_id","granted_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_sessions_tenant" ON "support_sessions" USING btree ("tenant_id","expires_at");
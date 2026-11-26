CREATE TABLE "storefront_stats" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "storefront_stats_pk" PRIMARY KEY("tenant_id","day","key")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "storefront_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "storefront_taken_down" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "storefront" jsonb DEFAULT '{"about":"","whatsapp":"","hours":"","themeColor":"#1e40af","facebook":"","instagram":"","showPrices":true,"showStock":true,"announcement":"","announcementUntil":""}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_stats" ADD CONSTRAINT "storefront_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
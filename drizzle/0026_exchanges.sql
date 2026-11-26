ALTER TABLE "payments" DROP CONSTRAINT "payments_method";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_reference";--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "exchange_sale_id" uuid;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "exchange_credit_pesewas" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_exchange_sale_fk" FOREIGN KEY ("tenant_id","exchange_sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK ("payments"."method" in ('cash', 'momo_manual', 'card_terminal', 'bank_transfer', 'store_credit', 'channel_settlement', 'exchange_credit'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference" CHECK ("payments"."method" in ('cash', 'store_credit', 'exchange_credit') or "payments"."reference" is not null);--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_exchange_credit" CHECK ("returns"."exchange_credit_pesewas" between 0 and "returns"."refund_pesewas");
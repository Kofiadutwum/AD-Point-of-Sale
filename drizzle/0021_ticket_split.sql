ALTER TABLE "ticket_lines" ADD COLUMN "paid_quantity" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD COLUMN "seat" integer;--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_paid" CHECK ("ticket_lines"."paid_quantity" >= 0 and "ticket_lines"."paid_quantity" <= "ticket_lines"."quantity");--> statement-breakpoint
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_seat" CHECK ("ticket_lines"."seat" between 1 and 50);
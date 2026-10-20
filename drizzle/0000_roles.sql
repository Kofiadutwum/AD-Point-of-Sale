DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_app') THEN CREATE ROLE pos_app NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT pos_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO pos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pos_app;

-- Supabase exposes public tables to its anon and authenticated roles through the Data API.
-- Platform tables get row-level security with no policies, so only the owner role (asPlatform) can use them.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plans_readable ON plans FOR SELECT TO pos_app USING (true);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END $$;

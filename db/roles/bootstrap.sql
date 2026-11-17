-- Run ONCE per Neon project, as the project owner, before the first migration.
-- Passwords are never written here. Pass them at run time:
--   psql "$OWNER_URL" -v platform_app_password="$PLATFORM_APP_PASSWORD" -f db/roles/bootstrap.sql
-- Store the resulting app connection string in AWS Secrets Manager, not in this repo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    CREATE ROLE platform_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE platform_app PASSWORD :'platform_app_password';

-- The app role can use the core schema and touch rows only. It cannot create objects,
-- and it cannot change the audit log.
GRANT USAGE ON SCHEMA core TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO platform_app;
REVOKE UPDATE, DELETE ON core.audit_log FROM platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;

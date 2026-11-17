-- 0001_core: the platform's core schema.
-- Runs as the owner role (migrations only). Products never run DDL.
-- Every tenant table has tenant_id and row-level security. The app sets
-- app.tenant_id per transaction (see src/db/tenant.ts); a missing setting
-- matches no rows, so an unset tenant sees nothing.

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE core.tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'INR',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Outbox: written in the same transaction as the business change, then relayed.
CREATE TABLE core.outbox (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES core.tenants (id),
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- Audit log: append-only. Updates and deletes are refused at the database.
CREATE TABLE core.audit_log (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES core.tenants (id),
  actor_id    uuid NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  changes     jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION core.refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'core.audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.refuse_change();

-- Row-level security on every tenant table.
ALTER TABLE core.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON core.audit_log
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 0002_platform_config: product entitlements, document sequences, approval matrices, sessions.
-- Tenant tables carry tenant_id and row-level security. The sessions table is the only one
-- without RLS: a request presents a token, and only its SHA-256 hash is looked up to find the
-- tenant. The app role can read and write sessions; it never lists them.

CREATE TABLE core.entitlements (
  tenant_id     uuid NOT NULL REFERENCES core.tenants (id),
  product_key   text NOT NULL CHECK (product_key IN ('platform', 'procurement', 'stores', 'sales', 'production', 'finance')),
  enabled       boolean NOT NULL,
  enabled_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_key)
);

CREATE TABLE core.sequences (
  tenant_id     uuid NOT NULL REFERENCES core.tenants (id),
  key           text NOT NULL,
  branch_id     uuid NOT NULL,
  prefix        text NOT NULL CHECK (char_length(prefix) <= 16),
  next_number   bigint NOT NULL CHECK (next_number >= 1),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key, branch_id)
);

CREATE TABLE core.approval_matrices (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES core.tenants (id),
  process       text NOT NULL,
  version       integer NOT NULL CHECK (version >= 1),
  status        text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  bands         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  UNIQUE (tenant_id, process, version)
);

-- At most one active matrix per tenant and process.
CREATE UNIQUE INDEX approval_matrices_one_active ON core.approval_matrices (tenant_id, process) WHERE status = 'active';

CREATE TABLE core.sessions (
  token_hash    text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES core.tenants (id),
  user_id       uuid NOT NULL,
  roles         text[] NOT NULL DEFAULT '{}',
  permissions   text[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE core.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.approval_matrices ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.entitlements
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON core.sequences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON core.approval_matrices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

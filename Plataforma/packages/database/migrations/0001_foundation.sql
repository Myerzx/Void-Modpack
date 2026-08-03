CREATE TABLE panel_users (
  id UUID PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE CHECK (email_normalized = lower(email_normalized)),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 96),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
  mfa_state TEXT NOT NULL DEFAULT 'disabled' CHECK (mfa_state IN ('disabled', 'pending', 'enabled')),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_token_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  ip_prefix TEXT,
  user_agent_hash CHAR(64),
  CHECK (expires_at > created_at),
  CHECK (idle_expires_at > created_at)
);

CREATE INDEX sessions_active_token_idx
  ON sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE server_instances (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'test', 'staging', 'production')),
  desired_state TEXT NOT NULL DEFAULT 'unknown' CHECK (desired_state IN ('unknown', 'offline', 'online')),
  observed_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (observed_state IN ('unavailable', 'offline', 'starting', 'online', 'stopping', 'restarting', 'degraded', 'error')),
  minecraft_version TEXT NOT NULL,
  loader TEXT NOT NULL,
  loader_version TEXT NOT NULL,
  max_players INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 100000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_provision_tokens (
  id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE agents (
  id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL UNIQUE REFERENCES server_instances(id) ON DELETE CASCADE,
  public_key_pem TEXT NOT NULL,
  certificate_fingerprint CHAR(64) NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'online', 'degraded', 'offline', 'revoked')),
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version >= 1),
  software_version TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ,
  credential_rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_nonces (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  nonce_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, nonce_hash)
);

CREATE INDEX agent_nonces_expiry_idx ON agent_nonces (expires_at);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'review-required')),
  stage TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint CHAR(64) NOT NULL,
  requested_by JSONB NOT NULL CHECK (jsonb_typeof(requested_by) = 'object'),
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner UUID,
  lease_acquired_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  cancel_requested_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  result JSONB,
  error JSONB,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (attempt <= max_attempts)
);

CREATE INDEX jobs_lease_idx
  ON jobs (priority DESC, available_at ASC, created_at ASC)
  WHERE status = 'queued';

CREATE TABLE job_events (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  stage TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'critical')),
  message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata_redacted JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_redacted) = 'object'),
  PRIMARY KEY (job_id, sequence)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  resource JSONB NOT NULL CHECK (jsonb_typeof(resource) = 'object'),
  outcome TEXT NOT NULL,
  reason TEXT,
  before_redacted JSONB,
  after_redacted JSONB,
  metadata_redacted JSONB,
  previous_hash CHAR(64),
  integrity_hash CHAR(64),
  CHECK (before_redacted IS NULL OR jsonb_typeof(before_redacted) = 'object'),
  CHECK (after_redacted IS NULL OR jsonb_typeof(after_redacted) = 'object'),
  CHECK (metadata_redacted IS NULL OR jsonb_typeof(metadata_redacted) = 'object')
);

CREATE INDEX audit_events_time_idx ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);

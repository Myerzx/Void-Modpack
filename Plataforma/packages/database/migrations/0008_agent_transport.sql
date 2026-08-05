-- Phase 9.2 makes the agent transport real.
--
-- Three things were missing. An agent credential could never be rotated or
-- revoked, so a compromised identity had no remedy. A capability was stored but
-- never granted individually, so announcing one was as good as being allowed
-- it. And a job leased by an agent that then crashed stayed `running` forever,
-- because the queue only ever leases rows that are `queued`.
--
-- The protocol stays outbound-only: nothing here lets the control plane dial an
-- agent, and no column carries a command, a path or a launch plan.

-- Credential history. Rotation supersedes rather than edits, so a superseded
-- fingerprint can never authenticate again and the history stays auditable.
CREATE TABLE agent_credentials (
  credential_id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  public_key_pem TEXT NOT NULL,
  certificate_fingerprint CHAR(64) NOT NULL CHECK (certificate_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'revoked')),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  created_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,

  CHECK ((status = 'active') = (superseded_at IS NULL)),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

-- A fingerprint identifies exactly one credential, ever.
CREATE UNIQUE INDEX agent_credentials_fingerprint_idx
  ON agent_credentials (certificate_fingerprint);
-- At most one active credential per agent.
CREATE UNIQUE INDEX agent_credentials_active_idx
  ON agent_credentials (agent_id)
  WHERE status = 'active';
CREATE INDEX agent_credentials_history_idx
  ON agent_credentials (agent_id, created_at DESC, credential_id);

-- Capabilities granted individually. Announcing a capability authorizes
-- nothing; only a grant does, and a grant can be withdrawn without touching
-- the agent's identity.
CREATE TABLE agent_capability_grants (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (
    capability IN ('heartbeat', 'configuration.apply', 'artifact.inspect',
                   'artifact.analyze', 'process.observe')
  ),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by JSONB NOT NULL CHECK (jsonb_typeof(granted_by) = 'object'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (agent_id, capability),

  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE INDEX agent_capability_grants_active_idx
  ON agent_capability_grants (agent_id)
  WHERE revoked_at IS NULL;

-- Which agent holds a leased job, and for which granted capability. The job
-- queue owns the lease itself; this records who it was handed to, so an
-- expired lease can be reclaimed and attributed.
CREATE TABLE agent_work_leases (
  lease_id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (
    capability IN ('configuration.apply', 'artifact.inspect', 'artifact.analyze')
  ),
  -- Identifies one run of the agent, so work leased by a previous run is
  -- recognisable after a restart.
  boot_id UUID NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 16),
  leased_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed')),
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'capability-refused', 'precondition-not-met', 'lease-expired',
      'operation-failed', 'unsupported-parameters'
    )
  ),

  CHECK (expires_at > leased_at),
  CHECK ((settled_at IS NULL) = (outcome IS NULL)),
  CHECK (settled_at IS NULL OR settled_at >= leased_at),
  CHECK ((outcome = 'failed') IS NOT TRUE OR failure_code IS NOT NULL),
  CHECK ((outcome = 'succeeded') IS NOT TRUE OR failure_code IS NULL)
);

-- A job may have only one unsettled lease at a time.
CREATE UNIQUE INDEX agent_work_leases_open_idx
  ON agent_work_leases (job_id)
  WHERE settled_at IS NULL;
CREATE INDEX agent_work_leases_agent_idx
  ON agent_work_leases (agent_id, leased_at DESC, lease_id);
CREATE INDEX agent_work_leases_expiry_idx
  ON agent_work_leases (expires_at)
  WHERE settled_at IS NULL;

-- Backfill: every already registered agent keeps its current identity as its
-- active credential, and keeps the capabilities it was registered with. The
-- backfill grants nothing that was not already recorded on the agent row.
INSERT INTO agent_credentials (
  credential_id, agent_id, public_key_pem, certificate_fingerprint, status,
  reason_code, created_at
)
SELECT
  gen_random_uuid(), id, public_key_pem, certificate_fingerprint, 'active',
  'registration-backfill', COALESCE(credential_rotated_at, created_at)
FROM agents;

INSERT INTO agent_capability_grants (agent_id, capability, granted_at, granted_by, reason_code)
SELECT
  a.id,
  capability.value #>> '{}',
  COALESCE(a.credential_rotated_at, a.created_at),
  '{"type":"system","id":"registration-backfill"}'::jsonb,
  'registration-backfill'
FROM agents a
CROSS JOIN LATERAL jsonb_array_elements(a.capabilities) AS capability(value)
WHERE capability.value #>> '{}' IN (
  'heartbeat', 'configuration.apply', 'artifact.inspect', 'artifact.analyze', 'process.observe'
);

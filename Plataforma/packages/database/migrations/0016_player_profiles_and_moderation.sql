-- Phase 11 persists profiles and moderation cases against the stable identity.
--
-- A punishment must survive a name change, a rebind and the revocation of the
-- claim it was recorded against. Keying either table on the Minecraft UUID
-- would tie the record to a name — in offline mode that UUID is derived from
-- one — and lose it the moment somebody renamed. So the subject is the identity
-- VoidFall issued, and the account is context.
--
-- There is no legacy nullable subject. No case has ever been persisted, and a
-- player without an authenticated identity does not get in; an authentication
-- attempt with no identity behind it belongs to the security domain, not to
-- moderation, and giving moderation a nullable subject would invite it to
-- store one.

-- Claim evidence names a revision so the Bridge can refuse anything at or below
-- an invalidated one. Without it, a ticket minted before a revocation is
-- indistinguishable from one minted after, and the revocation only takes effect
-- when the ticket expires.
ALTER TABLE player_minecraft_claims
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE TABLE player_profiles (
  identity_id UUID NOT NULL REFERENCES player_identities(identity_id) ON DELETE CASCADE,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'erasure-pending')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One profile per identity per server, which is the uniqueness the contract
  -- states and the reason this is the primary key rather than a surrogate.
  PRIMARY KEY (server_instance_id, identity_id),
  CONSTRAINT player_profiles_updated_after_created CHECK (updated_at >= created_at)
);

CREATE TABLE moderation_cases (
  case_id UUID PRIMARY KEY,
  -- Mandatory and stable. Everything below about the account is context.
  subject_identity_id UUID NOT NULL REFERENCES player_identities(identity_id) ON DELETE RESTRICT,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  -- What the incident looked like at the time. Not a key, and deliberately not
  -- a foreign key to the claim either: a case must remain readable after the
  -- claim it names has been revoked and its row is gone.
  context_claim_id UUID NOT NULL,
  context_minecraft_uuid UUID NOT NULL,
  context_minecraft_name TEXT NOT NULL CHECK (context_minecraft_name ~ '^[A-Za-z0-9_]{3,16}$'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  action TEXT NOT NULL
    CHECK (action IN ('warning', 'mute', 'kick', 'temporary-ban', 'permanent-ban')),
  status TEXT NOT NULL
    CHECK (status IN ('requested', 'applied', 'failed', 'revoked', 'expired')),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  requested_by JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  -- Evidence that the case left 'requested'. A case that says it was applied
  -- without naming who applied it and against what receipt is an assertion
  -- nobody can check, which is the opposite of what a moderation record is for.
  transition_kind TEXT CHECK (transition_kind IN ('applied', 'failed', 'revoked', 'expired')),
  transition_occurred_at TIMESTAMPTZ,
  transition_executor_id TEXT CHECK (
    transition_executor_id IS NULL OR transition_executor_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  transition_receipt_id TEXT CHECK (
    transition_receipt_id IS NULL OR char_length(transition_receipt_id) BETWEEN 1 AND 128
  ),
  transition_error_code TEXT CHECK (
    transition_error_code IS NULL OR transition_error_code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  ),
  -- A temporary action that never ends is a permanent one nobody decided on,
  -- and a permanent one with an end date is a temporary one nobody reviewed.
  CONSTRAINT moderation_cases_expiry_matches_action
    CHECK ((action IN ('mute', 'temporary-ban')) = (expires_at IS NOT NULL)),
  -- A settled case names its transition, and a requested one has none to name.
  CONSTRAINT moderation_cases_transition_matches_status
    CHECK ((status = 'requested') = (transition_kind IS NULL)),
  CONSTRAINT moderation_cases_transition_kind_matches_status
    CHECK (transition_kind IS NULL OR transition_kind = status),
  CONSTRAINT moderation_cases_transition_has_moment
    CHECK ((transition_kind IS NULL) = (transition_occurred_at IS NULL)),
  -- An executor transition names who ran it and what came back.
  CONSTRAINT moderation_cases_executor_transition_is_evidenced
    CHECK (
      transition_kind NOT IN ('applied', 'failed')
      OR (transition_executor_id IS NOT NULL AND transition_receipt_id IS NOT NULL)
    ),
  CONSTRAINT moderation_cases_expiry_after_request
    CHECK (expires_at IS NULL OR expires_at > requested_at),
  CONSTRAINT moderation_cases_updated_after_request CHECK (updated_at >= requested_at)
);

-- The two questions an operator actually asks: what is open against this
-- person, and what has this server seen lately.
CREATE INDEX moderation_cases_by_subject
  ON moderation_cases (subject_identity_id, status, requested_at DESC);
CREATE INDEX moderation_cases_by_server
  ON moderation_cases (server_instance_id, requested_at DESC);

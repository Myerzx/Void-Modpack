-- Phase 11 gives player identity somewhere durable to live.
--
-- The server runs in offline mode by product decision, so a Minecraft UUID is
-- derived from the player's name and proves nothing about who typed it. The
-- stable key is issued here; the Minecraft account is a claim on it.
--
-- What this file deliberately does not contain: no password, no verifier, no
-- IP address, no chat, no coordinates. Credentials are a separate category with
-- their own storage and their own regime, and the rest is outside the accepted
-- minimum core until a named purpose exists for it.
--
-- Groups and permission nodes are also absent, and that absence is the point:
-- LuckPerms is the source of truth for them, and a column here would be the
-- second editable source this design refuses to create.

CREATE TABLE player_identities (
  identity_id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  -- Either an identity has been seen or it has not. Half of the pair set is a
  -- write nobody thought through, so the constraint refuses it.
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_by JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT player_identities_sightings_travel_together
    CHECK ((first_seen_at IS NULL) = (last_seen_at IS NULL)),
  CONSTRAINT player_identities_last_sighting_after_first
    CHECK (last_seen_at IS NULL OR last_seen_at >= first_seen_at)
);

CREATE TABLE player_minecraft_claims (
  claim_id UUID PRIMARY KEY,
  identity_id UUID NOT NULL REFERENCES player_identities(identity_id) ON DELETE CASCADE,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  minecraft_uuid UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('legacy-unclaimed', 'active', 'revoked')),
  -- A legacy claim was never proven, so it cannot carry the moment it was. This
  -- is the distinction the whole decision rests on: the accounts carried over
  -- from the pre-authentication server record that an account existed, and
  -- grant nothing until somebody proves they hold it.
  claimed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT player_claims_unproven_has_no_moment
    CHECK ((status = 'legacy-unclaimed') = (claimed_at IS NULL)),
  CONSTRAINT player_claims_revoked_names_when
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT player_claims_revoked_after_claimed
    CHECK (revoked_at IS NULL OR claimed_at IS NULL OR revoked_at >= claimed_at)
);

-- One identity may hold at most one account per server at a time. Without this
-- a rebind that half-completed would leave two active claims and the resolver
-- would have to pick, which is exactly the guess the design removes.
CREATE UNIQUE INDEX player_claims_one_active_per_identity
  ON player_minecraft_claims (identity_id, server_instance_id)
  WHERE status = 'active';

-- And one account is held by at most one identity. Two identities actively
-- claiming the same offline UUID would mean an operation aimed at one of them
-- lands on whoever the resolver happened to find.
CREATE UNIQUE INDEX player_claims_one_active_per_account
  ON player_minecraft_claims (server_instance_id, minecraft_uuid)
  WHERE status = 'active';

CREATE INDEX player_claims_by_identity ON player_minecraft_claims (identity_id, status);

-- Alias history belongs to the identity rather than to the account, because a
-- rebind moves the account and the history is what survives it.
CREATE TABLE player_aliases (
  identity_id UUID NOT NULL REFERENCES player_identities(identity_id) ON DELETE CASCADE,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL CHECK (normalized_name ~ '^[a-z0-9_]{3,16}$'),
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_]{3,16}$'),
  source TEXT NOT NULL CHECK (source IN ('forge-bridge', 'reviewed-import', 'manual-review')),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  observation_count BIGINT NOT NULL DEFAULT 1 CHECK (observation_count >= 1),
  PRIMARY KEY (identity_id, server_instance_id, normalized_name),
  CONSTRAINT player_aliases_last_after_first CHECK (last_observed_at >= first_observed_at)
);

-- Phase 11.0 gives agent readiness somewhere durable to live.
--
-- The agent is outbound-only: it dials the control plane and never listens. So
-- "is this agent ready, and if not why not" cannot be answered by asking it —
-- there is nothing on the host to ask. It has to be something the agent
-- publishes.
--
-- `capabilities` already records what an agent announces. What it cannot record
-- is the other half an operator needs: which capabilities are *absent*, and for
-- which reason. "Backups unavailable" with no cause is indistinguishable from a
-- defect, and the operator has nothing to act on.
--
-- Announcing is still not authorizing. An agent that publishes
-- `configuration.apply` here is authorized for nothing until the control plane
-- grants it; this column describes the host, it does not grant anything.

ALTER TABLE agents
  ADD COLUMN readiness JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(readiness) = 'array');

-- When the published snapshot was taken. Distinct from `last_seen_at`, which
-- moves on every heartbeat: readiness changes only when the host does, and an
-- operator reading a stale reason should be able to tell how stale it is.
ALTER TABLE agents ADD COLUMN readiness_published_at TIMESTAMPTZ;

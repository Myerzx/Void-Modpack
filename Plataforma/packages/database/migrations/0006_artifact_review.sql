-- Phase 8.3 persists the artifact review workflow: an upload, the quarantine
-- record, the bounded inspection, the compatibility issues and the human
-- decision that closes it.
--
-- Approval here changes a review state and nothing else. No column in this
-- migration names an installation target, a filesystem path, a quarantine
-- location or artifact bytes: an artifact is identified by its SHA-256 alone,
-- and nothing in this schema can put one into a Minecraft runtime.

CREATE TABLE artifact_submissions (
  submission_id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  filename TEXT NOT NULL CHECK (
    char_length(filename) BETWEEN 1 AND 255
    AND filename !~ '[/\\]'
    AND filename !~ '^\.{1,2}$'
  ),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  state TEXT NOT NULL CHECK (
    state IN ('uploaded', 'quarantined', 'analyzing', 'blocked', 'reviewable', 'approved', 'rejected')
  ),
  submitted_by JSONB NOT NULL CHECK (jsonb_typeof(submitted_by) = 'object'),
  -- The side a human reviewed. It is never derived from presence or filename,
  -- so it stays NULL until somebody records it.
  reviewed_side TEXT CHECK (reviewed_side IS NULL OR reviewed_side IN ('client', 'server', 'both')),

  inspected BOOLEAN NOT NULL DEFAULT FALSE,
  analyzed BOOLEAN NOT NULL DEFAULT FALSE,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('compatible', 'incompatible', 'unknown')),
  loaders JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(loaders) = 'array'),
  mod_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mod_ids) = 'array'),
  declared_versions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(declared_versions) = 'array'),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count BETWEEN 0 AND 16384),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count BETWEEN 0 AND 16384),
  information_count INTEGER NOT NULL DEFAULT 0 CHECK (information_count BETWEEN 0 AND 16384),
  proven_blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (proven_blocker_count BETWEEN 0 AND 16384),

  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'not-a-zip-container', 'truncated-archive', 'unsupported-archive-feature', 'encrypted-entry',
      'content-too-large', 'metadata-unreadable', 'hash-mismatch', 'quarantine-rejected',
      'analysis-failed'
    )
  ),
  failure_stage TEXT CHECK (
    failure_stage IS NULL OR failure_stage IN ('upload', 'quarantine', 'inspection', 'compatibility')
  ),

  decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'rejected')),
  decision_actor JSONB CHECK (decision_actor IS NULL OR jsonb_typeof(decision_actor) = 'object'),
  decision_reason_code TEXT CHECK (
    decision_reason_code IS NULL OR decision_reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'
  ),
  decision_analyzed_sha256 CHAR(64) CHECK (
    decision_analyzed_sha256 IS NULL OR decision_analyzed_sha256 ~ '^[a-f0-9]{64}$'
  ),
  decided_at TIMESTAMPTZ,

  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  -- The same invariants the public contract enforces, kept in the storage so a
  -- writer that bypassed the contract still cannot record an impossible state.
  CHECK ((failure_code IS NULL) = (failure_stage IS NULL)),
  CHECK (NOT analyzed OR inspected),
  CHECK ((verdict IS NOT NULL) = analyzed),
  CHECK (proven_blocker_count <= blocker_count),
  CHECK (state NOT IN ('uploaded', 'quarantined') OR (NOT inspected AND NOT analyzed)),
  -- A proven blocker belongs in `blocked`; it may never sit in a state a person
  -- can approve from, and it may never be approved.
  CHECK (state <> 'reviewable' OR proven_blocker_count = 0),
  CHECK (state <> 'approved' OR proven_blocker_count = 0),
  CHECK (state <> 'blocked' OR proven_blocker_count > 0 OR failure_code IS NOT NULL),
  CHECK (
    (state IN ('approved', 'rejected'))
      = (decision IS NOT NULL AND decision_actor IS NOT NULL
         AND decision_reason_code IS NOT NULL AND decision_analyzed_sha256 IS NOT NULL
         AND decided_at IS NOT NULL)
  ),
  CHECK (decision IS NULL OR decision = state),
  -- A decision names the exact bytes it judged.
  CHECK (decision_analyzed_sha256 IS NULL OR decision_analyzed_sha256 = sha256)
);

CREATE INDEX artifact_submissions_server_idx
  ON artifact_submissions (server_instance_id, created_at DESC, submission_id);
CREATE INDEX artifact_submissions_state_idx
  ON artifact_submissions (server_instance_id, state);
-- The same bytes may be submitted only once per server, so a replayed upload
-- resolves to the existing submission instead of opening a second review.
CREATE UNIQUE INDEX artifact_submissions_content_idx
  ON artifact_submissions (server_instance_id, sha256);

CREATE TABLE artifact_inspection_reports (
  submission_id UUID PRIMARY KEY REFERENCES artifact_submissions(submission_id) ON DELETE CASCADE,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE artifact_compatibility_reports (
  submission_id UUID PRIMARY KEY REFERENCES artifact_submissions(submission_id) ON DELETE CASCADE,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at TIMESTAMPTZ NOT NULL
);

-- Issues are rows as well as report content, so the panel can filter by
-- severity without parsing a document.
CREATE TABLE artifact_compatibility_issues (
  submission_id UUID NOT NULL REFERENCES artifact_submissions(submission_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 16383),
  code TEXT NOT NULL CHECK (code ~ '^[a-z][a-z0-9-]{0,63}$'),
  severity TEXT NOT NULL CHECK (severity IN ('blocker', 'warning', 'information')),
  determinacy TEXT NOT NULL CHECK (determinacy IN ('proven', 'unproven')),
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z][a-z0-9-]{0,63}$'),
  context_ids JSONB NOT NULL CHECK (jsonb_typeof(context_ids) = 'array'),
  mod_ids JSONB NOT NULL CHECK (jsonb_typeof(mod_ids) = 'array'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 256),
  explanation TEXT NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 512),
  recommended_action TEXT NOT NULL CHECK (recommended_action ~ '^[a-z][a-z0-9-]{0,63}$'),
  PRIMARY KEY (submission_id, ordinal),
  -- Unknown blocks here too: a stored issue cannot be softened below a blocker.
  CHECK (determinacy = 'proven' OR severity = 'blocker')
);

CREATE INDEX artifact_compatibility_issues_severity_idx
  ON artifact_compatibility_issues (submission_id, severity, ordinal);

-- Append-only log of the human decisions. The submission carries the current
-- one; this table keeps every decision that was ever recorded.
CREATE TABLE artifact_review_decisions (
  decision_id UUID PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES artifact_submissions(submission_id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  from_state TEXT NOT NULL CHECK (
    from_state IN ('uploaded', 'quarantined', 'analyzing', 'blocked', 'reviewable', 'approved', 'rejected')
  ),
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  analyzed_sha256 CHAR(64) NOT NULL CHECK (analyzed_sha256 ~ '^[a-f0-9]{64}$'),
  decided_at TIMESTAMPTZ NOT NULL,
  UNIQUE (submission_id, decided_at, decision_id)
);

CREATE INDEX artifact_review_decisions_submission_idx
  ON artifact_review_decisions (submission_id, decided_at, decision_id);

-- Staging that survives a reload, and sandbox runs as evidence.
--
-- Staging was a file on disk and nothing else, so the panel could show a diff
-- and then forget which fields produced it. That is enough to review a change
-- and not enough to do anything with it: booting a sandbox against a change
-- needs the change itself, not a rewritten file.
--
-- One row per file per workspace, replaced when it is staged again and deleted
-- when it is discarded. Unlike an inventory this one is deliberately mutable —
-- it is an intention somebody is still editing, not a reading of what was
-- there. The evidence it produces is the sandbox run, and that is append-only.
--
-- What this file deliberately does not contain: nothing that applies anything.
-- Writing a staged change back into the workspace is the one destructive step
-- in this product and it still has no owner anywhere in this repository.

CREATE TABLE workspace_staged_changes (
  workspace_id UUID NOT NULL REFERENCES panel_workspaces (workspace_id) ON DELETE CASCADE,
  -- Relative to the workspace root, `/`-separated. Always a path the scan
  -- already found; the route refuses anything else before it gets here.
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  -- The field changes as the inferred form names them, so a sandbox run can
  -- be handed the change rather than a file somebody would have to re-read.
  changes JSONB NOT NULL,
  -- What the source hashed to when the change was computed. An apply that ever
  -- exists must refuse when this no longer matches what is on disk.
  base_sha256 CHAR(64) NOT NULL,
  staged_sha256 CHAR(64) NOT NULL,
  staged_by JSONB NOT NULL,
  staged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, path)
);

-- One row per run, never reused.
--
-- A boot spawns a real JVM against a disposable copy and takes minutes, so a
-- run is created before it starts and completed in place exactly once. The
-- lifecycle is the only thing that changes; the evidence is written once.
CREATE TABLE workspace_sandbox_runs (
  run_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES panel_workspaces (workspace_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'refused')),
  -- `booted`, `timed-out`, `exited-early`, `failed-to-start`. NULL while it
  -- runs, and never conflated with a failure: not knowing yet is its own state.
  outcome TEXT,
  -- Why the runner would not even start — a missing EULA acceptance, no Java
  -- it could find. Named, because a refusal without a cause is
  -- indistinguishable from a defect.
  refusal TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- Whether the run tested staged changes or what is already installed.
  tested_changes BOOLEAN NOT NULL DEFAULT FALSE,
  -- Progress lines, appended while it runs, so a page that reloads mid-boot
  -- sees where it got to instead of a spinner with no information.
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The evidence: generated files, the bounded log tail, whether the sandbox
  -- was disposed, and what happened to each staged change.
  evidence JSONB,
  started_by JSONB NOT NULL,
  CONSTRAINT sandbox_runs_finished_has_an_end
    CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE INDEX workspace_sandbox_runs_by_workspace
  ON workspace_sandbox_runs (workspace_id, started_at DESC);

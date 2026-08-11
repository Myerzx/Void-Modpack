-- An approved artifact becomes installable through a durable, audited
-- operation. The job only names the server; the agent resolves the immutable
-- submission from this record and never accepts a path from the wire.

ALTER TABLE server_operations DROP CONSTRAINT IF EXISTS server_operations_kind_check;
ALTER TABLE server_operations ADD CONSTRAINT server_operations_kind_check CHECK (
  kind IN ('server.start', 'server.stop', 'server.restart', 'server.command',
           'server.force-kill', 'backup.create', 'backup.restore',
           'configuration.apply', 'configuration.rollback', 'artifact.install')
);

ALTER TABLE server_operations
  ADD COLUMN artifact_submission_id UUID
  REFERENCES artifact_submissions(submission_id) ON DELETE RESTRICT;

ALTER TABLE server_operations
  ADD CONSTRAINT server_operations_artifact_submission_kind_check
  CHECK ((kind = 'artifact.install') = (artifact_submission_id IS NOT NULL));

CREATE INDEX server_operations_artifact_submission_idx
  ON server_operations (artifact_submission_id)
  WHERE artifact_submission_id IS NOT NULL;

-- A lifecycle operation makes the previous process observation obsolete.
--
-- The agent remains the only authority that can publish a fresh lifecycle
-- observation. Acceptance merely records that the old snapshot is no longer
-- current, and the dedicated topic keeps that invalidation in the same
-- transactional outbox as the operation that caused it.

ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_topic_check;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_topic_check CHECK (
    topic IN (
      'operation.accepted',
      'operation.completed',
      'process.invalidated',
      'process.observed',
      'artifact.state-changed',
      'configuration.state-changed'
    )
  );

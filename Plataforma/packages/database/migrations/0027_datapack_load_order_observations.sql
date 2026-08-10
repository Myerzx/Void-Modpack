-- Effective datapack precedence is an observation about one analysis, not part
-- of the inventory-keyed analyzer cache. Keep both immutable identities so an
-- observation can change without rewriting the semantic snapshot.
ALTER TABLE workspace_ecosystem_analyses
  ADD CONSTRAINT workspace_ecosystem_analyses_identity_unique
  UNIQUE (workspace_id, analysis_id, inventory_sha256);

CREATE TABLE workspace_datapack_load_order_observations (
  record_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  analysis_id CHAR(64) NOT NULL CHECK (analysis_id ~ '^[0-9a-f]{64}$'),
  inventory_sha256 CHAR(64) NOT NULL CHECK (inventory_sha256 ~ '^[0-9a-f]{64}$'),
  observation_id CHAR(64) NOT NULL CHECK (observation_id ~ '^[0-9a-f]{64}$'),
  source TEXT NOT NULL CHECK (
    source IN ('minecraft-world-metadata-v1', 'minecraft-runtime-report-v1')
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  observation_document JSONB NOT NULL,
  projection_document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_datapack_load_order_analysis_fk
    FOREIGN KEY (workspace_id, analysis_id, inventory_sha256)
    REFERENCES workspace_ecosystem_analyses (workspace_id, analysis_id, inventory_sha256)
    ON DELETE CASCADE,
  CONSTRAINT workspace_datapack_load_order_identity_unique
    UNIQUE (workspace_id, analysis_id, observation_id),
  CONSTRAINT workspace_datapack_load_order_observation_identity_check
    CHECK (observation_document ->> 'observationId' = observation_id),
  CONSTRAINT workspace_datapack_load_order_projection_identity_check
    CHECK (
      projection_document ->> 'analysisId' = analysis_id
      AND projection_document ->> 'inventorySha256' = inventory_sha256
      AND projection_document ->> 'observationId' = observation_id
      AND projection_document ->> 'authorizesSemanticEditing' = 'false'
    )
);

CREATE INDEX workspace_datapack_load_order_latest
  ON workspace_datapack_load_order_observations (
    workspace_id, analysis_id, observed_at DESC, record_id DESC
  );

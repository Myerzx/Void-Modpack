-- Durable semantic analysis keyed to the exact inventory that produced it.
--
-- The document is already a normalized entity/relationship/evidence graph.
-- Keeping the snapshot whole preserves that contract and makes an analyzer
-- upgrade append a new immutable observation instead of rewriting history.
CREATE TABLE workspace_ecosystem_analyses (
  record_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES panel_workspaces (workspace_id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES workspace_inventories (inventory_id) ON DELETE CASCADE,
  inventory_sha256 CHAR(64) NOT NULL,
  analysis_id CHAR(64) NOT NULL,
  analyzer_version TEXT NOT NULL CHECK (length(analyzer_version) BETWEEN 1 AND 64),
  generated_at TIMESTAMPTZ NOT NULL,
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, inventory_sha256, analyzer_version)
);

CREATE INDEX workspace_ecosystem_analyses_latest
  ON workspace_ecosystem_analyses (workspace_id, generated_at DESC);

CREATE INDEX workspace_ecosystem_analyses_inventory
  ON workspace_ecosystem_analyses (inventory_id);

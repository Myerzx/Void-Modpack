-- Phase 10.4 makes metrics, logs and alerts observable.
--
-- Every stored value carries where it came from and how good it is. That is the
-- point of the phase: this platform measures the host, the process and the JVM,
-- but cannot see inside a running Minecraft server without an approved in-game
-- provider — and tick timing is exactly what an operator most wants. A row that
-- could not say "nothing measured this" would invite a panel to draw a number
-- nobody took.
--
-- Buckets are stored, not raw samples. Keeping every sample forever is how a
-- metrics store becomes the largest table in the database and the slowest page
-- in the panel.

CREATE TABLE server_metric_buckets (
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL CHECK (metric_name IN (
    'host.disk.free.bytes', 'host.disk.total.bytes',
    'host.memory.available.bytes', 'host.memory.total.bytes', 'host.load.1m',
    'process.resident.bytes', 'process.uptime.seconds',
    'jvm.heap.used.bytes', 'jvm.heap.max.bytes', 'jvm.gc.pause.millis',
    'game.tps', 'game.mspt', 'game.players.online'
  )),
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds BETWEEN 10 AND 86400),
  minimum DOUBLE PRECISION NOT NULL,
  maximum DOUBLE PRECISION NOT NULL,
  average DOUBLE PRECISION NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 1),
  source TEXT NOT NULL CHECK (source IN ('host-agent', 'process-adapter', 'jvm', 'game-provider', 'none')),
  quality TEXT NOT NULL CHECK (quality IN ('measured', 'derived', 'stale', 'unavailable')),
  created_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (server_instance_id, metric_name, bucket_start),
  -- An average outside its own range is a bucket that was computed wrong, and
  -- storing it would put a wrong number in front of an operator.
  CONSTRAINT server_metric_buckets_average_within_range CHECK (
    minimum <= average AND average <= maximum
  ),
  -- Tick timing is only measurable by an approved in-game provider. The
  -- database refuses to hold a host-agent TPS at all, so no collector bug and
  -- no future writer can put a fabricated one on a chart.
  CONSTRAINT server_metric_buckets_game_metrics_need_provider CHECK (
    metric_name NOT IN ('game.tps', 'game.mspt', 'game.players.online')
    OR source = 'game-provider'
  ),
  -- A stored bucket was measured by something. "Unavailable" is reported, not
  -- stored: there is no bucket to keep for a number nobody took.
  CONSTRAINT server_metric_buckets_stored_values_were_measured CHECK (
    source <> 'none' AND quality <> 'unavailable'
  )
);

-- Retention scans by age, and the panel reads one metric over a window.
CREATE INDEX server_metric_buckets_retention_idx
  ON server_metric_buckets (bucket_start);
CREATE INDEX server_metric_buckets_series_idx
  ON server_metric_buckets (server_instance_id, metric_name, bucket_start DESC);

-- Alerts.
--
-- An alert names the reading that raised it, or an operator has a red badge and
-- no way to check whether it is still true.
CREATE TABLE server_alerts (
  alert_id UUID PRIMARY KEY,
  server_instance_id UUID NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('disk.low', 'memory.low', 'server.crashed', 'agent.offline', 'job.failed')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  raised_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  metric_name TEXT,
  observed_value DOUBLE PRECISION,
  threshold DOUBLE PRECISION,
  source TEXT NOT NULL CHECK (source IN ('host-agent', 'process-adapter', 'jvm', 'game-provider', 'none')),

  CONSTRAINT server_alerts_resolution_matches_status CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT server_alerts_resolution_follows_raise CHECK (
    resolved_at IS NULL OR resolved_at >= raised_at
  ),
  CONSTRAINT server_alerts_metric_carries_its_value CHECK (
    (metric_name IS NULL) = (observed_value IS NULL)
  )
);

-- One open alert of a kind per server. Without this a collector running every
-- thirty seconds would raise a new "disk is low" every thirty seconds, and the
-- one alert an operator needed to see would be buried under copies of itself.
CREATE UNIQUE INDEX server_alerts_open_kind_idx
  ON server_alerts (server_instance_id, kind)
  WHERE status = 'open';

CREATE INDEX server_alerts_server_idx
  ON server_alerts (server_instance_id, raised_at DESC);

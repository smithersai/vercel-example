-- Queue drain and public route rate-limit schema. Additive and idempotent.

ALTER TABLE run ADD COLUMN IF NOT EXISTS attempt_count int NOT NULL DEFAULT 0;
ALTER TABLE run ADD COLUMN IF NOT EXISTS lease_owner uuid;
ALTER TABLE run ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE run ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE run ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE run ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_status_check;
ALTER TABLE run ADD CONSTRAINT run_status_check
  CHECK (status IN ('pending','running','posted','skipped','failed','dead_lettered'));

CREATE INDEX IF NOT EXISTS run_queue_runnable_idx
  ON run ((COALESCE(next_attempt_at, created_at)), created_at, id)
  WHERE status IN ('pending','failed','running');

CREATE INDEX IF NOT EXISTS run_queue_lease_idx
  ON run (lease_expires_at, id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS rate_limit_counter (
  scope        text NOT NULL,
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, bucket, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_counter_window_idx
  ON rate_limit_counter (window_start);

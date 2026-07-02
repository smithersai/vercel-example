-- Core durable schema. Postgres is the only state store.

CREATE TABLE IF NOT EXISTS chat (
  id                    bigserial PRIMARY KEY,
  telegram_chat_id      bigint NOT NULL UNIQUE,
  title                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  disclosure_status     text NOT NULL DEFAULT 'pending'
                          CHECK (disclosure_status IN ('pending','sending','sent')),
  disclosure_claimed_at timestamptz,
  disclosure_message_id bigint,
  disclosure_sent_at    timestamptz
);

CREATE TABLE IF NOT EXISTS chat_config (
  chat_id             bigint NOT NULL UNIQUE REFERENCES chat(id),
  cron_expr           text,
  timezone            text,
  min_messages        int NOT NULL DEFAULT 3,
  enabled             bool NOT NULL DEFAULT true,
  enabled_at          timestamptz NOT NULL DEFAULT now(),
  sched_cursor        timestamptz,
  last_claim_scan_at  timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message (
  id                  bigserial PRIMARY KEY,
  chat_id             bigint NOT NULL REFERENCES chat(id),
  telegram_message_id bigint NOT NULL,
  from_user           text,
  text                text,
  sent_at             timestamptz NOT NULL,
  ingested_at         timestamptz NOT NULL DEFAULT now(),
  is_bot              bool NOT NULL DEFAULT false,
  assigned_run_id     bigint,
  UNIQUE (chat_id, telegram_message_id)
);

CREATE TABLE IF NOT EXISTS run (
  id                  bigserial PRIMARY KEY,
  chat_id             bigint NOT NULL REFERENCES chat(id),
  window_start        timestamptz NOT NULL,
  window_end          timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','posted','skipped','failed')),
  trigger             text NOT NULL
                        CHECK (trigger IN ('scheduled','manual')),
  smithers_run_id     text,
  summary_text        text,
  skip_reason         text,
  failure_reason      text,
  attempt_count       int NOT NULL DEFAULT 0,
  last_error          text,
  lease_owner         uuid,
  lease_expires_at    timestamptz,
  heartbeat_at        timestamptz,
  input_message_count int,
  late_message_count  int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (chat_id, window_start, window_end)
);

ALTER TABLE message DROP CONSTRAINT IF EXISTS message_assigned_run_id_fkey;
ALTER TABLE message ADD CONSTRAINT message_assigned_run_id_fkey
  FOREIGN KEY (assigned_run_id) REFERENCES run(id);

CREATE TABLE IF NOT EXISTS run_chunk (
  run_id              bigint NOT NULL REFERENCES run(id),
  chunk_index         int NOT NULL,
  chunk_text          text NOT NULL,
  state               text NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','reserving','reserved','edited','sent')),
  telegram_message_id bigint,
  reserved_at         timestamptz,
  sent_at             timestamptz,
  UNIQUE (run_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id          bigserial PRIMARY KEY,
  method      text NOT NULL,
  chat_id     bigint,
  payload     jsonb NOT NULL,
  message_id  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

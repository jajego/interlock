CREATE TABLE IF NOT EXISTS interlock_transition_history (
  id TEXT PRIMARY KEY,
  lifecycle TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  previous_version BIGINT NOT NULL CHECK (previous_version >= 1),
  next_version BIGINT NOT NULL CHECK (next_version = previous_version + 1),
  actor_type TEXT,
  actor_id TEXT,
  audit_data JSONB,
  metadata JSONB,
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  definition_version TEXT,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS interlock_history_resource_idx
  ON interlock_transition_history (lifecycle, resource_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS interlock_idempotency (
  lifecycle TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  transition_id TEXT REFERENCES interlock_transition_history(id),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (lifecycle, resource_id, idempotency_key),
  CHECK ((transition_id IS NULL AND completed_at IS NULL) OR (transition_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS interlock_outbox (
  id TEXT PRIMARY KEY,
  lifecycle TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  transition_id TEXT NOT NULL REFERENCES interlock_transition_history(id),
  topic TEXT NOT NULL CHECK (topic <> ''),
  message_key TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS interlock_outbox_pending_idx
  ON interlock_outbox (created_at, id) WHERE published_at IS NULL;

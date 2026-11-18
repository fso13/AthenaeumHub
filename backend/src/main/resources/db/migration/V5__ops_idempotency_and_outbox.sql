-- ops module: API idempotency keys and transactional outbox.

CREATE TABLE ops.idempotency_keys (
  user_id       uuid NOT NULL,
  scope         text NOT NULL,
  key           text NOT NULL,
  request_hash  bytea NOT NULL,
  -- NULL status means "request in progress" -> concurrent duplicate gets 409.
  status        smallint,
  response_body jsonb,
  resource_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);

CREATE INDEX ix_idempotency_expiry ON ops.idempotency_keys (expires_at);

-- Ops-global table: one row per domain event, written in the same transaction as the
-- aggregate change. It intentionally contains only metadata (no plaintext), and the
-- relay must read across tenants, therefore no RLS here (documented in README).
CREATE TABLE ops.outbox (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  event_version  integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  partition_key  text NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);

CREATE INDEX ix_outbox_unpublished ON ops.outbox (id) WHERE published_at IS NULL;

ALTER TABLE ops.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY p_idempotency_user ON ops.idempotency_keys
  USING (user_id = ops.current_user_id())
  WITH CHECK (user_id = ops.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.idempotency_keys TO krug_app;
GRANT SELECT, INSERT, UPDATE ON ops.outbox TO krug_app;
GRANT USAGE, SELECT ON SEQUENCE ops.outbox_id_seq TO krug_app;

-- E3 realtime: one-time WS tickets.
--
-- No RLS on purpose: the ticket is looked up during the unauthenticated HTTP upgrade,
-- before a tenant/user context exists. The table is keyed by SHA-256 of a 32-byte random
-- secret, only krug_app is granted access, and the raw ticket is never stored.
CREATE SCHEMA IF NOT EXISTS realtime;

CREATE TABLE realtime.realtime_tickets (
  id           uuid PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid NOT NULL,
  device_id    uuid NOT NULL,
  workspace_id uuid,
  issued_at    timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE INDEX ix_realtime_tickets_expires_at
  ON realtime.realtime_tickets (expires_at);
CREATE INDEX ix_realtime_tickets_user_device
  ON realtime.realtime_tickets (user_id, device_id);

GRANT USAGE ON SCHEMA realtime TO krug_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON realtime.realtime_tickets TO krug_app;

COMMENT ON TABLE realtime.realtime_tickets IS
  'E3 one-time WS tickets. token_hash is SHA-256(raw); raw is never stored.';

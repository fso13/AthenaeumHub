-- B-02 hardening: explicit worker guard for cross-tenant ops tables and retention indexes.
--
-- The outbox relay is the only cross-tenant reader of ops.outbox. Instead of leaving the
-- table without RLS, access is granted to a transaction-local worker role:
--   app.worker_role = 'outbox-relay'  -> relay may read/update every outbox row
--   app.worker_role = 'retention'     -> retention may delete expired idempotency rows
--                                        and published outbox rows
-- Tenant transactions keep the normal workspace/user guard. The setting is transaction
-- local (set_config(..., true)), so it cannot leak through the connection pool.

CREATE OR REPLACE FUNCTION ops.current_worker_role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.worker_role', true), '') $$;

GRANT EXECUTE ON FUNCTION ops.current_worker_role() TO krug_app;

-- Idempotency rows: a user sees only their own rows; the retention worker may purge all.
DROP POLICY IF EXISTS p_idempotency_user ON ops.idempotency_keys;
CREATE POLICY p_idempotency_user ON ops.idempotency_keys
  USING (user_id = ops.current_user_id() OR ops.current_worker_role() = 'retention')
  WITH CHECK (user_id = ops.current_user_id() OR ops.current_worker_role() = 'retention');

-- Stale in-progress rows (pre-B-02 crash leftovers) are cleaned by created_at.
CREATE INDEX ix_idempotency_in_progress
  ON ops.idempotency_keys (created_at)
  WHERE status IS NULL;

-- Outbox: tenant rows OR an explicit worker role. FORCE makes the policy apply to the
-- table owner as well, so a future migration/role cannot accidentally bypass it.
ALTER TABLE ops.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY p_outbox_worker ON ops.outbox
  USING (
    ops.current_worker_role() IN ('outbox-relay', 'retention')
    OR workspace_id = ops.current_workspace_id()
  )
  WITH CHECK (
    ops.current_worker_role() IN ('outbox-relay', 'retention')
    OR workspace_id = ops.current_workspace_id()
  );

-- Retention deletes published rows; the relay only needs SELECT/UPDATE.
GRANT DELETE ON ops.outbox TO krug_app;

CREATE INDEX ix_outbox_published_at
  ON ops.outbox (published_at)
  WHERE published_at IS NOT NULL;

CREATE INDEX ix_realtime_tickets_consumed_at
  ON realtime.realtime_tickets (consumed_at)
  WHERE consumed_at IS NOT NULL;

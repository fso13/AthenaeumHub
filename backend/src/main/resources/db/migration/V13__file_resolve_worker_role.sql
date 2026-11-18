-- E4-B: replace the V11 SECURITY DEFINER resolvers with an explicit worker role.
--
-- FORCE ROW LEVEL SECURITY also applies to the table owner, so a SECURITY DEFINER function
-- owned by krug_migrator would not bypass RLS on a production (non-superuser) migrator.
-- Instead the narrow `file-resolve` transaction-local worker role is allowed to read the
-- file tables; the application then immediately switches to the real tenant context and
-- re-checks ownership/membership.

ALTER POLICY p_workspace_limits_tenant ON file.workspace_limits
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

ALTER POLICY p_workspace_usage_tenant ON file.workspace_usage
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

ALTER POLICY p_uploads_tenant ON file.uploads
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

ALTER POLICY p_upload_parts_tenant ON file.upload_parts
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

ALTER POLICY p_attachments_tenant ON file.attachments
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

ALTER POLICY p_quota_reservations_tenant ON file.quota_reservations
  USING (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'))
  WITH CHECK (workspace_id = ops.current_workspace_id()
         OR ops.current_worker_role() IN ('file-scan', 'file-gc', 'file-reconcile',
                                          'file-resolve'));

DROP FUNCTION IF EXISTS file.workspace_for_upload(uuid, uuid);
DROP FUNCTION IF EXISTS file.workspace_for_attachment(uuid, uuid);

COMMENT ON SCHEMA file IS
  'E4-B managed files; cross-tenant reads only via file-scan/file-gc/file-reconcile/file-resolve';

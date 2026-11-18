-- E4-B: resolve a tenant for upload/attachment endpoints that have no workspace in the
-- path. Keycloak access tokens do not carry a workspace_id claim (only the dev token does),
-- so the file module needs a controlled way to bind an opaque resource id to its workspace.
--
-- These SECURITY DEFINER functions are deliberately narrow:
--   * upload: only the uploader may resolve the upload;
--   * attachment: the uploader, or an active workspace member for an already bound
--     attachment (the caller still runs the chat-membership check afterwards).
-- RLS remains enabled for every table; the function is the only cross-tenant lookup and it
-- never returns metadata, only workspace_id.

CREATE OR REPLACE FUNCTION file.workspace_for_upload(p_upload_id uuid, p_user_id uuid)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = file, pg_temp
  AS $$
    SELECT u.workspace_id
      FROM file.uploads u
     WHERE u.id = p_upload_id
       AND u.user_id = p_user_id
  $$;

CREATE OR REPLACE FUNCTION file.workspace_for_attachment(p_attachment_id uuid, p_user_id uuid)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = file, workspace, pg_temp
  AS $$
    SELECT a.workspace_id
      FROM file.attachments a
     WHERE a.id = p_attachment_id
       AND (
         a.user_id = p_user_id
         OR (
           a.message_id IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM workspace.memberships m
              WHERE m.workspace_id = a.workspace_id
                AND m.user_id = p_user_id
                AND m.status = 'ACTIVE'
           )
         )
       )
  $$;

GRANT EXECUTE ON FUNCTION file.workspace_for_upload(uuid, uuid) TO krug_app;
GRANT EXECUTE ON FUNCTION file.workspace_for_attachment(uuid, uuid) TO krug_app;

COMMENT ON FUNCTION file.workspace_for_upload(uuid, uuid) IS
  'E4-B: tenant binding for /uploads/{id} endpoints without a workspace path';
COMMENT ON FUNCTION file.workspace_for_attachment(uuid, uuid) IS
  'E4-B: tenant binding for /attachments/{id} endpoints; chat membership is checked after';

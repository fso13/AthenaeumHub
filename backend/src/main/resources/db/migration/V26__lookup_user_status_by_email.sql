-- Login BFF needs to distinguish a suspended account from an unverified email
-- without widening auth.users RLS. The function returns only the status string.
CREATE OR REPLACE FUNCTION ops.lookup_user_status_by_email(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, pg_catalog
AS $$
  SELECT u.status
    FROM auth.users u
   WHERE lower(u.email) = lower(btrim(p_email))
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION ops.lookup_user_status_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.lookup_user_status_by_email(text) TO krug_app;

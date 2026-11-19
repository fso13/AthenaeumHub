-- Profile slice (#72): self-service bio/phone plus explicit display-name bounds.
-- Additive only: email, password (Keycloak-owned) and E2EE key material are untouched.
ALTER TABLE auth.users
  ADD COLUMN bio   text,
  ADD COLUMN phone text;

-- Bounds are enforced at the storage boundary as well as in the domain/API so a
-- direct SQL write cannot create a profile the application can never serve.
ALTER TABLE auth.users
  ADD CONSTRAINT ck_users_display_name_length
      CHECK (length(display_name) BETWEEN 1 AND 80),
  ADD CONSTRAINT ck_users_bio_length
      CHECK (bio IS NULL OR length(bio) <= 280),
  ADD CONSTRAINT ck_users_phone_length
      CHECK (phone IS NULL OR length(phone) <= 32);

COMMENT ON COLUMN auth.users.bio IS
  'Free-form plain-text profile bio, at most 280 characters; NULL = empty.';
COMMENT ON COLUMN auth.users.phone IS
  'Free-form plain-text contact phone, at most 32 characters; NULL = empty.';

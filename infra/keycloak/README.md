# Keycloak (dev) for «Сова»

Realm export for the `keycloak` backend profile. It is imported automatically by
`docker compose up -d` from `backend/docker-compose.yml`.

**Image:** `quay.io/keycloak/keycloak:26.2` — `prompt=create` (registration button)
поддерживается с 26.2+. На 26.0 кнопка «Регистрация» открывала обычный login с ссылкой
Register, а не форму регистрации.

| Item | Value |
|---|---|
| Keycloak URL | `http://localhost:8180` |
| Admin console | `http://localhost:8180/admin` |
| Admin login | `admin` / `admin` (dev only) |
| Realm | `krug` |
| Public client | `krug-web` (standard flow, PKCE `S256`) |
| Redirect URI | `http://localhost:5173/*` |
| Web origin | `http://localhost:5173` |
| API audience | `krug-api` (added to the access token by a mapper) |
| Test user | `test@krug.local` / `Test1234!` (логин — email) |

Registration is enabled in the realm; frontend использует `prompt=create`, поэтому
нужен Keycloak 26.2+. Пароли, регистрация и сброс — только в Keycloak. Passwords, registration and password reset are owned by Keycloak; the backend does
not store passwords.

## Dev-only choices

* `sslRequired=none` and `admin/admin` are development defaults. A production realm must
  use TLS, a real admin, and no direct access grants.
* `directAccessGrantsEnabled=true` is enabled **only** to make curl/CI smoke checks
  possible. The SPA still uses authorization code + PKCE.
* The realm uses the embedded H2 dev file store. A managed PostgreSQL realm database is a
  deployment concern, not part of B-04.

## Reset the realm

```bash
cd backend
docker compose rm -sf keycloak
docker volume rm backend_krug-keycloak-data 2>/dev/null || true
docker compose up -d keycloak
```

The import only runs when the realm does not exist yet.

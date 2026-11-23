# Krug backend — managed chat, Keycloak OIDC, Auth BFF, E3 realtime, E4-B files, E5-B stickers, E6-B notifications

Spring Boot 3.4 / Java 21 / PostgreSQL 16 backend for the managed-chat vertical slice:
dev session, chat list, history, send, read receipt, sync, transactional outbox, the B-04
identity slice (Keycloak OIDC, JIT provisioning, `/me`, `/devices`, `/workspaces`), the
E3 realtime WebSocket slice (one-time ticket, `/ws` subscribe/replay, live fan-out,
receipts, typing/presence, backpressure), the B-02 hardening slice (atomic send
idempotency with a transaction-scoped advisory lock, idempotency/outbox/ticket retention,
an explicit outbox worker guard, and a fail-fast prod guard), the E5-B sticker slice
(2 built-in packs, per-user favorites, `type=STICKER` messages, realtime rendering
metadata; managed only), and the E6-B in-app notification slice (post-commit fan-out,
dedupe, unread/read, per-chat/type/channel preferences, 90-day retention and a dev email
log stub; notification body is always null, including E2EE).

The HTTP API shape is defined only by [`contracts/openapi.yaml`](../contracts/openapi.yaml);
the WS frames by [`contracts/ws-protocol.md`](../contracts/ws-protocol.md). E2EE chat,
opaque envelopes and per-device fan-out are implemented since E7-B3/B4 (the server relays
ciphertext and never decrypts); X3DH/Double Ratchet, key backup, E2EE groups/files/stickers,
managed files/keys (E4-B), custom sticker packs/upload/moderation, plugins, server-side
search/DLP over E2EE content, multi-node fan-out (Redis/Kafka), durable replay beyond 500
messages, Kafka consumers, push, edit/delete, reactions and pins are out of scope.

## Quick start

```bash
# 1. PostgreSQL 16 + Keycloak 26.2 + Mailpit (Mailpit is the dev SMTP sink for the
#    Auth BFF email TOTP; Keycloak is only needed for the `keycloak` profile)
cd backend
docker compose up -d

# 2. Run the service on 8081 (I-01 port; 8080 may be occupied by another project)
export JAVA_HOME=$(/usr/libexec/java_home -v 21)     # macOS
# export JAVA_HOME=/usr/lib/jvm/temurin-21-jdk       # Linux example
SERVER_PORT=8081 SPRING_PROFILES_ACTIVE=dev mvn spring-boot:run
# Dev-only fallback for the Auth BFF (#103): with SPRING_PROFILES_ACTIVE=keycloak
# and no KRUG_KEYCLOAK_SERVICE_CLIENT_* pair, export KC_ADMIN_USER=admin and
# KC_ADMIN_PASSWORD=admin (password grant). Prod requires the svc-krug-bff
# client-credentials service account instead.

# 3. Dev-profile smoke check
curl -s http://localhost:8081/api/v1/health
curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Дмитрий"}'
```

The default port is `8081` (`SERVER_PORT` overrides it); the contract server URL is
`http://localhost:8081/api/v1`. Flyway runs as `krug_migrator`; the application runtime
pool connects as the RLS role `krug_app` (created by migration `V1`).

## Profiles

| Profile | Identity | `POST /dev/session` | Use |
|---|---|---|---|
| `dev` (default) | HS256 dev token, `device_id` claim | present | local vertical slice |
| `test` | HS256 test token | present | integration tests |
| `keycloak` | Keycloak OIDC resource server | **404** | real OIDC login |
| `prod` | Keycloak OIDC resource server | **404** | prod-like; no dev defaults |

`keycloak` and `prod` activate the same OIDC decoder; `dev`/`test` keep the old HS256
decoder and `/dev/session` as the local fallback (AUTH-D-02). A dev token cannot be
accepted by `keycloak`/`prod` because the HMAC decoder bean does not exist there.
Both profiles run `ProdGuard` before any datasource/Flyway bean: it refuses the dev/test
content key and, for a remote database, the `krug_app`/`krug_migrator` passwords.

```bash
# Keycloak profile; OIDC defaults point at the compose service on 8180.
# B-02: the content key is mandatory and must not be the dev/test default.
SERVER_PORT=8081 SPRING_PROFILES_ACTIVE=keycloak \
  KRUG_CONTENT_KEY='local-keycloak-content-key-32-bytes' \
  mvn spring-boot:run

# Prod-like: all secrets, OIDC and DB credentials are supplied by the environment.
SPRING_PROFILES_ACTIVE=prod \
  KRUG_AUTH_JWT_SECRET='<32+ random bytes>' \
  KRUG_OIDC_ISSUER=https://id.example/realms/krug \
  KRUG_OIDC_JWKS_URI=https://id.example/realms/krug/protocol/openid-connect/certs \
  KRUG_CONTENT_KEY='<32+ random bytes>' \
  DB_URL=jdbc:postgresql://db.example:5432/krug DB_USER=krug_app DB_PASSWORD='<secret>' \
  FLYWAY_USER=krug_migrator FLYWAY_PASSWORD='<secret>' \
  java -jar target/krug-backend-0.1.0-SNAPSHOT.jar
```

## Keycloak (dev)

`infra/keycloak/realm-export.json` is imported on the first start of the compose service.

| Item | Value |
|---|---|
| Keycloak URL | `http://localhost:8180` |
| Admin console | `http://localhost:8180/admin` |
| Admin login | `admin` / `admin` (dev only) |
| Realm | `krug` |
| Client | `krug-web` — public, standard flow, PKCE `S256` |
| Redirect URI | `http://localhost:5173/*` |
| Web origin | `http://localhost:5173` |
| API audience | `krug-api` (access-token mapper) |
| Test user | `test@krug.local` / `Test1234!` (login is email) |
| BFF admin credentials | `svc-krug-bff` client-credentials service account (#103); `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD` is a dev-only password fallback |
| BFF internal URL | derived from `KRUG_OIDC_ISSUER` (compose: `http://keycloak:8080`) |

Registration is enabled in the realm. The browser talks only to `/api/v1/auth/*`: the
backend BFF creates/verifies Keycloak users through the Admin API and exchanges passwords
through the token endpoint. Keycloak passwords, registration and password reset stay in
Keycloak; the backend never stores passwords. See **Auth BFF** below. The container uses
the embedded H2 dev file store and `start-dev`; see
[`infra/keycloak/README.md`](../infra/keycloak/README.md). The compose file publishes
Keycloak only on `127.0.0.1:8180` for ops; it is not a browser dependency.

The resource server validates the JWKS signature, `iss`, `exp`/`nbf` (clock skew, default
30 s), `aud=krug-api` and `azp=krug-web`. Tokens are never logged; the Keycloak profile
keeps `org.springframework.security` at `WARN`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SERVER_PORT` | `8081` | HTTP port (I-01) |
| `DB_URL` | `jdbc:postgresql://localhost:5432/krug` (dev/test/keycloak) | app datasource; **required** in prod |
| `DB_USER` / `DB_PASSWORD` | `krug_app` / `krug_app` (dev/test/keycloak) | runtime role (RLS); **required** in prod, dev value rejected for a remote DB |
| `FLYWAY_URL` | `DB_URL` | migration datasource |
| `FLYWAY_USER` / `FLYWAY_PASSWORD` | `krug_migrator` / `krug_migrator` (dev/test/keycloak) | migration role; **required** in prod |
| `KRUG_AUTH_JWT_SECRET` | dev-only value | HS256 key, **≥32 bytes**; used only in `dev`/`test`; **required** in prod |
| `KRUG_AUTH_TTL` | `15m` | dev token TTL |
| `KRUG_OIDC_ISSUER` | blank in base; `http://localhost:8180/realms/krug` in `keycloak` | OIDC issuer |
| `KRUG_OIDC_JWKS_URI` | issuer + `/protocol/openid-connect/certs` | JWKS endpoint |
| `KRUG_OIDC_AUDIENCE` | `krug-api` | required `aud` |
| `KRUG_OIDC_AZP` | `krug-web` | required `azp` |
| `KRUG_OIDC_CLOCK_SKEW` | `30s` | `exp`/`nbf` tolerance |
| `KRUG_KEYCLOAK_SERVICE_CLIENT_ID` / `KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET` | blank / blank | #103 client-credentials service account (`svc-krug-bff`) for the Admin API; **required in `prod`**, blank enables the dev password fallback |
| `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD` | `admin` / — | dev-only password-grant fallback when the service-account pair is blank |
| `KRUG_KEYCLOAK_URL` | derived from `KRUG_OIDC_ISSUER` | internal Keycloak base URL for admin/token calls (compose: `http://keycloak:8080`) |
| `KC_ADMIN_CLIENT_ID` | `admin-cli` | client id for the dev password fallback only |
| `KRUG_AUTH_BFF_COOKIE_SECURE` | `false`; `true` in `prod` | `Secure` flag of the HttpOnly `sova_refresh` cookie (#103) |
| `KRUG_CORS_ALLOWED_ORIGINS` | `http://localhost:5173` (fallback `KRUG_WS_ALLOWED_ORIGINS`) | credentialed CORS + CSRF Origin allowlist; never `*` |
| `KRUG_AUTH_BFF_CLIENT_ID` | `krug-web` | public client used for direct grants/refresh |
| `KRUG_AUTH_BFF_REGISTRATION_ENABLED` | `true` | `false` → `403 REGISTRATION_CLOSED` |
| `KRUG_AUTH_BFF_CODE_EXPIRY` | `10m` | email confirmation lifetime |
| `KRUG_AUTH_BFF_RESEND_COOLDOWN` | `60s` | minimum interval between resends |
| `KRUG_AUTH_BFF_MAX_ATTEMPTS` | `5` | wrong codes before `429 RATE_LIMITED` |
| `KRUG_AUTH_BFF_TOTP_WINDOW` | `5` | accepted ±30-second steps (±5 min) |
| `KRUG_AUTH_BFF_EMAIL_SECRET_KEY` | `KRUG_CONTENT_KEY` | AES-256-GCM key for the TOTP secret at rest; set a dedicated ≥32-char secret in prod |
| `KRUG_AUTH_BFF_PENDING_SESSION_TTL` | `15m` | in-memory registration→verification token bridge |
| `SPRING_MAIL_HOST` / `SPRING_MAIL_PORT` | `localhost` / `1025` | SMTP relay; compose uses `mailpit`/`1025` |
| `KRUG_MAIL_FROM` | `no-reply@krug.local` | verification email sender |
| `KRUG_AUTH_BFF_RATE_LIMIT_*` | see `application.yml` | per-email/per-IP register/resend/login windows |
| `KRUG_CONTENT_KEY` | dev-only value | AES-256-GCM key material, **≥32 bytes**, **required** in `keycloak`/`prod`; dev/test defaults rejected |
| `KRUG_RATE_LIMIT_ENABLED` | `true` | message-send limiter |
| `KRUG_RATE_LIMIT_SEND_PER_USER` | `30` | per `send-user-window` |
| `KRUG_RATE_LIMIT_SEND_USER_WINDOW` | `10s` | user window |
| `KRUG_RATE_LIMIT_SEND_PER_CHAT` | `5` | per `send-chat-window` |
| `KRUG_RATE_LIMIT_SEND_CHAT_WINDOW` | `1s` | chat window |
| `KRUG_OUTBOX_RELAY_ENABLED` | `true` | log-only Kafka stub relay |
| `KRUG_OUTBOX_RELAY_POLL_INTERVAL` | `2s` | relay interval |
| `KRUG_RETENTION_ENABLED` | `true` | scheduled idempotency/outbox/ticket GC |
| `KRUG_RETENTION_POLL_INTERVAL` | `10m` | retention tick |
| `KRUG_RETENTION_BATCH_SIZE` | `500` | rows deleted per transaction |
| `KRUG_RETENTION_IN_PROGRESS_TIMEOUT` | `1h` | recover a stale in-progress reservation (pre-B-02 leftovers) |
| `KRUG_RETENTION_OUTBOX` | `7d` | published outbox retention |
| `KRUG_RETENTION_TICKETS` | `1d` | expired/consumed realtime ticket retention |
| `KRUG_NOTIFICATIONS_RETENTION_ENABLED` | `true` | 90-day notification GC scheduler |
| `KRUG_NOTIFICATIONS_RETENTION_DAYS` | `90` | notification retention window |
| `KRUG_NOTIFICATIONS_RETENTION_BATCH_SIZE` | `500` | rows deleted per transaction |
| `KRUG_NOTIFICATIONS_RETENTION_POLL_INTERVAL` | `10m` | notification GC tick |
| `KRUG_REALTIME_WS_URL` | `ws://localhost:8081/ws` | advertised in the ticket (`wss://...` behind a proxy) |
| `KRUG_WS_ALLOWED_ORIGINS` | `http://localhost:5173` | comma-separated WS Origin allowlist; never `*`; empty in prod fails closed |
| `KRUG_REALTIME_TICKET_TTL` | `30s` | one-time WS ticket TTL |
| `KRUG_REALTIME_MAX_SUBSCRIPTIONS` | `200` | chats per WS connection |
| `KRUG_REALTIME_REPLAY_LIMIT` | `500` | replay window; larger gaps → `resume.gap` |
| `KRUG_REALTIME_OUTBOUND_QUEUE_CAPACITY` | `256` | per-connection frame queue |
| `KRUG_REALTIME_HEARTBEAT_INTERVAL` | `25s` | server ping period |
| `KRUG_REALTIME_HEARTBEAT_TIMEOUT` | `60s` | close 1008 when no client activity |
| `KRUG_DEV_DISPLAY_NAME` | `Дмитрий` | default dev display name |
| `SPRING_PROFILES_ACTIVE` | `dev` | `dev`, `test`, `keycloak`, `prod` |
| `DB_POOL_SIZE` | `10` | Hikari max pool |
| `S3_STORAGE` | `s3` | object storage adapter; `memory` is test-only |
| `S3_ENDPOINT` | `http://localhost:9002` | MinIO/S3 endpoint (path-style) |
| `S3_PUBLIC_ENDPOINT` | blank | browser-visible endpoint used only for presigned GET URLs (e.g. `http://localhost:9002` in compose) |
| `S3_BUCKET` | `krug` | bucket; created lazily, compose also creates it |
| `S3_REGION` | `us-east-1` | S3 signing region |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `minioadmin` / `minioadmin` | MinIO root credentials; **prod secrets** |
| `S3_PATH_STYLE` | `true` | required by MinIO |
| `KRUG_FILES_UPLOAD_TTL` | `24h` | upload session/part reservation TTL |
| `KRUG_FILES_DOWNLOAD_TTL` | `5m` | presigned GET TTL (contract) |
| `S3_SCAN_MODE` | `noop` | `noop` (dev/test) or `clamav` |
| `S3_SCAN_FAIL_MARKER` | blank | dev/test only: filename containing it → INFECTED |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `localhost` / `3310` | clamd INSTREAM endpoint |
| `KRUG_FILES_SCAN_ENABLED` | `true` | AV scheduler |
| `KRUG_FILES_SCAN_POLL_INTERVAL` | `2s` | SCANNING poll |
| `KRUG_FILES_GC_ENABLED` | `true` | expired upload/unbound object GC |
| `KRUG_FILES_GC_POLL_INTERVAL` | `10m` | GC tick |
| `KRUG_FILES_RECONCILE_ENABLED` | `true` | daily quota reconciliation |
| `KRUG_FILES_RECONCILE_INTERVAL` | `24h` | reconcile interval |

`prod` has no dev defaults: `ProdGuard` fails startup before the datasource with one
aggregated error when `KRUG_AUTH_JWT_SECRET`, `KRUG_CONTENT_KEY`, `KRUG_OIDC_ISSUER`,
`KRUG_OIDC_JWKS_URI`, `DB_URL/DB_USER/DB_PASSWORD` or `FLYWAY_USER/FLYWAY_PASSWORD` is
missing, or when the content/JWT/DB value is a known dev/test default. `keycloak` requires
a strong `KRUG_CONTENT_KEY` and OIDC settings; its HMAC secret is not used and is optional.
`POST /api/v1/dev/session` is not mapped in `keycloak`/`prod` (404).

## B-02 hardening

### Atomic send idempotency

Before B-02 a send committed an `IDEMPOTENCY_IN_PROGRESS` row in its own transaction and
then started a second message transaction; a crash between them left the key stuck until
TTL. B-02 moved the whole send into **one transaction** (`MessageSubmissionHandler`):

```text
BEGIN
  pg_try_advisory_xact_lock(hash(user, scope, key))
    false -> 409 IDEMPOTENCY_IN_PROGRESS + Retry-After: 1   (contract §7.3)
  SELECT idempotency row
    completed + same hash  -> replay the message (same transaction)
    completed + other hash -> 409 IDEMPOTENCY_KEY_REUSED
    expired / stale        -> delete and take over (stale = older than 1h)
  rate limit -> chat authz -> domain validation -> seq -> message insert
  -> outbox insert -> UPDATE idempotency SET status=201, resource_id=...
COMMIT
```

Consequences:

* No committed in-progress row can survive a crash: it is part of the same transaction as
  the message. A concurrent duplicate fails the try-lock and gets the contract's 409 +
  `Retry-After: 1`; a retry after the winner commits returns the original message with
  `Idempotent-Replay: true`.
* A pre-B-02 committed in-progress row is recovered after
  `KRUG_RETENTION_IN_PROGRESS_TIMEOUT` (default 1h) and cleaned by the retention job, so
  there is no "eternal" in-progress state.
* A `client_message_id` unique-index race is resolved after rollback: the same body returns
  the existing message (201 + replay), a different body is `409
  CLIENT_MESSAGE_ID_CONFLICT`.
* Replays bypass the rate limiter; real sends consume quota. Nothing about the OpenAPI
  request/response shape or the `Idempotent-Replay` header changed.

### Retention / GC

Two scheduled jobs, each batch in its own transaction (default 500 rows) so a purge never
holds a long lock and never blocks request transactions:

| Job | Deletes | Default retention |
|---|---|---|
| ops retention | expired `idempotency_keys`, stale in-progress reservations | 24h TTL / 1h stale |
| ops retention | published `outbox` rows | 7 days |
| realtime retention | expired or consumed `realtime_tickets` | 1 day |

Counts are logged (`retention.deleted target=... count=... total=...`) and kept as
in-process counters (`RetentionMetrics`); a Micrometer adapter can replace the port without
touching the application services. Active rows (unexpired keys, unpublished outbox, fresh
tickets) are never touched.

### Outbox tenant guard

`ops.outbox` now has **forced RLS**. A tenant transaction sees only rows with its
`app.workspace_id`; the relay is the only cross-tenant reader and explicitly activates the
transaction-local worker role `outbox-relay`:

```sql
-- V8 policy (simplified)
ops.current_worker_role() IN ('outbox-relay', 'retention')
OR workspace_id = ops.current_workspace_id()
```

The retention worker uses the same mechanism (`retention`). The role is set with
`set_config('app.worker_role', ..., true)` and therefore cannot leak through the
connection pool. A tenant context can never read another tenant's outbox row, while
`OutboxRelayService.publishPending()` still publishes every tenant's pending rows.

### Prod guard

`ProdGuard` is a `BeanFactoryPostProcessor` (runs before datasource/Flyway) active in
`prod`/`keycloak`. It fails fast with an aggregated message when a required env var is
missing, a secret uses a dev/test default, a secret is shorter than 32 characters, or a
remote database uses the development passwords. `dev`/`test` are not guarded and keep
working with local defaults. `POST /api/v1/dev/session` remains absent in
`keycloak`/`prod`.

## API surface

Base URL: `http://localhost:8081/api/v1`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | public | liveness |
| `POST` | `/dev/session` | public | `dev`/`test` only; optional `{display_name}` |
| `POST` | `/auth/register` | public | `{email,display_name,password}` → `202 {verification_id,expires_in,resend_after}` |
| `POST` | `/auth/verify-email` | public | `{verification_id,code}` → `200 AuthSession` |
| `POST` | `/auth/resend-email-code` | public | `{verification_id}` → `202`; 60 s cooldown |
| `POST` | `/auth/login` | public | `{email,password}` → `200 AuthSession`; 401/403 |
| `POST` | `/auth/refresh` | public | cookie `sova_refresh` → `200 AuthSession` + rotated cookie; no body |
| `POST` | `/auth/logout` | public | cookie `sova_refresh` → idempotent `204` + cleared cookie |
| `GET` | `/me` | JWT | profile + active workspaces + `default_workspace_id` |
| `POST` | `/devices` | JWT + `Idempotency-Key` | WEB device; max 5; idempotent; 201 |
| `POST` | `/workspaces` | JWT + `X-Device-Id` + `Idempotency-Key` | OWNER + default «Общий чат»; 201 |
| `GET` | `/workspaces/{workspaceId}/chats` | JWT + `X-Device-Id` | active chats only |
| `GET` | `/workspaces/{workspaceId}/members?query=&cursor=&limit=` | JWT + `X-Device-Id` | active members for DIRECT; no email/keys |
| `POST` | `/workspaces/{workspaceId}/members` | JWT + `X-Device-Id` | OWNER/ADMIN adds an existing user by email; `201`; atomic member limit |
| `PATCH` | `/workspaces/{workspaceId}/members/{userId}` | JWT + `X-Device-Id` | role change with OWNER/ADMIN rules; `200` |
| `DELETE` | `/workspaces/{workspaceId}/members/{userId}` | JWT + `X-Device-Id` | soft-remove; removed user loses access on the next request; `204` |
| `GET` | `/chats/{chatId}/messages` | JWT + `X-Device-Id` | `after_seq`, `before_seq`, `limit` (1..100) |
| `POST` | `/chats/{chatId}/messages` | JWT + `X-Device-Id` + `Idempotency-Key` | 201 |
| `POST` | `/chats/{chatId}/read` | JWT + `X-Device-Id` + `Idempotency-Key` | 204 |
| `GET` | `/sync?workspace_id=` | JWT + `X-Device-Id` | reconnect snapshot |
| `POST` | `/realtime/ticket` | JWT + `X-Device-Id` | one-time WS ticket → `{ticket,expires_at,ws_url}` |
| `GET` (upgrade) | `/ws?ticket=` | ticket in query | WS protocol v1; access token is never put in the URL |
| `GET` | `/sticker-packs?chat_id=` | JWT + `X-Device-Id` | ACTIVE built-in packs + per-user `favorite` |
| `PUT` | `/stickers/{stickerId}/favorite` | JWT + `X-Device-Id` | idempotent 204 |
| `DELETE` | `/stickers/{stickerId}/favorite` | JWT + `X-Device-Id` | idempotent 204 |
| `GET` | `/notifications?cursor=&limit=` | JWT + `X-Device-Id` | own inbox, `items/page/unread_count`; newest first |
| `POST` | `/notifications/read` | JWT + `X-Device-Id` + `Idempotency-Key` | `{ids?}` or `{all:true}` → 204; only own rows |
| `GET` | `/notification-preferences` | JWT + `X-Device-Id` | stored per-user preferences |
| `PATCH` | `/notification-preferences` | JWT + `X-Device-Id` + `Idempotency-Key` | one upserted preference; 422 invalid, 403 foreign chat |

`X-Device-Id` is required only where the contract declares it: workspace/chat/sync,
`/realtime/ticket` and the sticker endpoints. `GET /me` and `POST /devices` do not require
it (a device may not exist yet). A device that belongs to another user is `403 WS_DEVICE_MISMATCH` on the ticket
endpoint; a missing/malformed device is `401 WS_TICKET_INVALID`.

Errors are always `{code,message,details,request_id}` with codes from
`docs/SYSTEM-ANALYSIS.md` §7.1. `X-Request-Id` is echoed (or generated) and logs never
contain message text, tokens or keys.

### `/me`

Returns the local profile and **only ACTIVE memberships**:

```json
{
  "user": {"id": "...", "display_name": "Тест Пользователь", "email": "test@krug.local"},
  "workspaces": [
    {"id": "...", "name": "Live Workspace", "slug": "live-workspace-65a60105",
     "role": "OWNER", "security_mode": "MANAGED"}
  ],
  "default_workspace_id": "..."
}
```

An empty `workspaces` list and `default_workspace_id: null` are valid: the frontend runs
onboarding (`POST /workspaces`). The default is the first active membership by `joined_at`.

### JIT provisioning

`auth.user_identities (provider=keycloak, subject=sub) -> auth.users` is resolved on the
first request. If absent, the local user is created with `email` (or
`preferred_username@keycloak.local` when the token has no email) and `display_name`
(`name`, then `preferred_username`). The local id is deterministic for
`(provider, subject)`, so concurrent first requests converge. A `user.provisioned` audit
event is appended in the same transaction. If the email is already owned by a different
local user, accounts are **not** linked by email: the new user gets a deterministic
`<preferred_username>.<sub-hash>@keycloak.local` address. No workspace is created
automatically.

### Device binding

| Profile | Strategy | Check |
|---|---|---|
| `dev` | `DevDeviceBinding` | `X-Device-Id` equals the signed `device_id` claim |
| `keycloak`/`prod` | `KeycloakDeviceBinding` | device belongs to the JIT user and is `ACTIVE` |

The Keycloak strategy runs JIT provisioning first, then checks `auth.devices`. A missing,
foreign, revoked or malformed device is a 401 contract envelope. Device registration is
serialised per user (`SELECT ... FOR UPDATE`) so the max-5 limit cannot race.

### Workspace onboarding

`POST /workspaces` creates, in one transaction: the workspace, the creator's `OWNER`
membership, the default group chat «Общий чат» and a `workspace.created` audit event.
Slug is transliterated from the name plus a short random suffix. Idempotency replay is
resolved by the workspace id and returns the same 201 body with `Idempotent-Replay: true`.

### Keycloak principals and chat endpoints

Keycloak access tokens do **not** contain `workspace_id` (SYSTEM-ANALYSIS §11.5). For
`/workspaces/{id}/chats` the workspace comes from the path. For chat/message/read/sync
paths the backend resolves the workspace from the chat resource through a read-only RLS
policy that only exposes chats where the caller is an ACTIVE member. The dev profile keeps
using the token claim and is unchanged.

## Auth BFF (password forms + email TOTP)

The browser never calls Keycloak. It calls only `/api/v1/auth/*`; the backend proxies the
Keycloak Admin API and token endpoint over the internal network, and confirms registration
with a 6-digit RFC 6238 TOTP from email (docs/TASKS-AUTH-BFF.md). The API is public (no
bearer token) and returns the same `{code,message,details,request_id}` envelope as the rest
of the API. `AuthSession` is
`{access_token,expires_in,token_type,user:{id,display_name,email}}`; the local
`user.id` is JIT-provisioned, so it matches `GET /me`. #103: the refresh token is **not**
in the body — it is an `HttpOnly; SameSite=Lax; Path=/api/v1/auth` cookie
(`sova_refresh`, `Secure` in prod) rotated by refresh and cleared by logout.

```text
register ──► Keycloak Admin: create user (username=email, enabled=false, emailVerified=false)
             set password; briefly enable to obtain a token pair; disable again
             generate 20-byte TOTP secret → encrypt → auth.email_verifications
             send 6-digit code via SMTP (Mailpit in dev)
verify   ──► validate TOTP (SHA-1, 6 digits, 30 s, ±5 steps)
             Keycloak Admin: enabled=true + emailVerified=true
             exchange the cached refresh token → AuthSession + JIT local user
login    ──► Keycloak token endpoint grant_type=password (client krug-web)
             refresh token goes into the HttpOnly cookie; JSON gets only access_token
refresh  ──► read sova_refresh cookie → grant_type=refresh_token (Keycloak rotates)
             → rotated cookie; no refresh token in JSON
logout   ──► read sova_refresh cookie → Keycloak logout revokes it → Max-Age=0
```

### Registration and email confirmation

* `POST /auth/register` creates the Keycloak user disabled and unverified, sets the
  password **only in Keycloak**, stores the encrypted 20-byte TOTP secret in
  `auth.email_verifications` and sends the code. No password or password hash is written to
  the application database, and neither passwords nor codes are logged. Keycloak 26's
  default user profile requires a non-empty `lastName` for a direct grant, so the BFF sends
  `firstName=lastName=display_name`; identity mapping uses `given_name` when it equals
  `family_name` (the BFF marker), so `displayName` is exactly the requested value, while
  users managed outside the BFF keep their full `name` (verified against Keycloak 26.2.5).
* The response is `202 {verification_id, expires_in: 600, resend_after: 60}`. A duplicate
  account is `409 EMAIL_TAKEN`. The code is valid for `krug.auth-bff.code.expiry` (10 min);
  the verifier accepts ±5 adjacent 30-second steps, i.e. five minutes around issuance.
* `POST /auth/verify-email` invalidates a wrong code after 5 attempts (`422 CODE_INVALID`
  for attempts 1–4, `429 RATE_LIMITED` on the fifth and afterwards), returns
  `410 CODE_EXPIRED` for an expired/used row, and on success enables + verifies the Keycloak
  user and returns an `AuthSession`.
* `POST /auth/resend-email-code` rotates the TOTP secret (the previous code stops working),
  keeps the original expiration window and enforces a 60-second cooldown; a locked or expired
  row cannot be resent.
* Expired rows and their still-disabled Keycloak users are removed by a scheduled cleanup
  job (`krug.auth-bff.cleanup.*`; counts only are logged, never emails). This makes the email
  registrable again.
* Registration failure after the Keycloak user was created rolls the user back (delete),
  revokes the temporary refresh token and removes the pending row.

### Session bridge on verification

`/auth/verify-email` must return Keycloak tokens without receiving the password again, and
the password must not be stored. Registration therefore briefly enables the user, performs a
direct grant, disables the user, and keeps the resulting refresh token in a short-lived
in-memory `PendingSessionPort` (TTL 15 min). Verification enables the user and redeems that
token. Consequences:

* registration and verification must hit the same process (single-node MVP);
* a restart between registration and verification loses the bridge. The account is still
  enabled/verified after the code is accepted, so the user can simply sign in with the
  password (`503 AUTH_UNAVAILABLE` with `details.reason=sign_in_required`);
* the bridge is not a database table and is never exposed to the browser. A production
  service-account token-exchange flow is the documented follow-up (out of this slice).

### Mailpit and SMTP

The compose stack runs `mailpit` (SMTP `1025`, web UI `http://localhost:8025`). The backend
uses `SPRING_MAIL_HOST=mailpit` / `SPRING_MAIL_PORT=1025` there; locally the defaults are
`localhost:1025`. In production set `SPRING_MAIL_*` to an external relay. The email contains
the 6-digit code and the expiration; the code is never written to logs or the database.

### Keycloak admin access

#103: the BFF obtains an Admin API token with `grant_type=client_credentials` for the
confidential `svc-krug-bff` client in realm `krug` (`KRUG_KEYCLOAK_SERVICE_CLIENT_ID` /
`KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET`), restricted to `manage-users`, `view-users` and
`query-users`. The token is cached in memory until shortly before expiry; on a `401` the
client drops it and retries once. The base URL is `KRUG_KEYCLOAK_URL`, or is derived from
`KRUG_OIDC_ISSUER` when blank — compose already sets it to `http://keycloak:8080/realms/krug`,
so the browser-facing host is never used for admin calls.

When both service-account values are blank (local dev only), the documented
password fallback (`KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`, `KC_ADMIN_CLIENT_ID`) is used.
A half-configured pair fails closed with `503`. `prod` requires the service account and a
`Secure` cookie (`ProdGuard`).

### Rate limits and error codes

In-memory fixed windows (Redis is the multi-node replacement) apply to register, resend and
login per email and per client IP; exhausted windows return `429 RATE_LIMITED` with
`Retry-After`. Set `KRUG_AUTH_BFF_TRUST_XFF=true` only behind a trusted proxy that
overwrites `X-Forwarded-For`.

| Code | HTTP | When |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | wrong password, invalid/expired refresh token |
| `EMAIL_NOT_VERIFIED` | 403 | disabled/unverified Keycloak user; `details.verification_id` when a live row exists |
| `CODE_INVALID` | 422 | wrong code (attempts 1–4) |
| `CODE_EXPIRED` | 410 | expired, consumed or unknown-state confirmation |
| `EMAIL_TAKEN` | 409 | Keycloak already has this email |
| `REGISTRATION_CLOSED` | 403 | `KRUG_AUTH_BFF_REGISTRATION_ENABLED=false` |
| `RATE_LIMITED` | 429 | per-email/IP window or the 5th wrong code attempt |
| `AUTH_UNAVAILABLE` | 503 | Keycloak/SMTP unreachable or the verification session bridge was lost |

### Security notes and known limits

* The TOTP secret is AES-256-GCM-encrypted at rest (`KRUG_AUTH_BFF_EMAIL_SECRET_KEY`,
  domain-separated from the message-content key); the 6-digit code is never persisted.
* Passwords and tokens are never logged; only generic status/reason codes appear in error
  envelopes. `GlobalExceptionHandler` never logs request data.
* Keycloak is published only on `127.0.0.1:8180` for ops; the browser dependency is removed.
* `keycloak`/`prod` still require `KRUG_CONTENT_KEY`; the pending session store and rate
  limiter are single-node. #103 provides the HttpOnly refresh cookie + Origin/Referer CSRF;
  refresh-rotation reuse detection, WebAuthn/MFA and E2EE changes remain out of scope
  (see docs/TASKS-AUTH-BFF.md).
* The realm has `registrationAllowed=true` and `directAccessGrantsEnabled=true` for the BFF;
  disable Keycloak's hosted registration UI if all sign-ups must go through the BFF.

## Realtime WebSocket (E3)

Single-node in-process hub (E3-D-01); no Redis/Kafka. The access token is **never** put in
the WS URL: the client first exchanges Bearer + `X-Device-Id` for a one-time ticket.

```text
POST /api/v1/realtime/ticket  (Bearer + X-Device-Id)
  -> 200 {ticket, expires_at, ws_url}       # opaque 32-byte token, TTL 30 s, one-time
GET  ws_url?ticket=<ticket>                 # handshake; consumed atomically
  <- hello {session_id, server_time, heartbeat_ms:25000, protocol:"krug.ws.v1"}
  -> subscribe {chats:[{chat_id,last_seq}], presence}
  <- subscribed {chats:[{chat_id,accepted,server_last_seq,reason?}]}
  <- event: message.created ...             # replay by seq ASC, then live
  <- resume.gap {chat_id,from_seq,to_seq,reason}   # only when gap > 500
  -> ping / typing / ack
  <- pong / event: typing|presence
```

Rules implemented by the slice:

* **Ticket** — TTL 30 s, one-time (`consumed_at`), only SHA-256 hash stored in
  `realtime.realtime_tickets`; reuse/expiry → HTTP 401 `WS_TICKET_INVALID` before upgrade,
  foreign device → 403 `WS_DEVICE_MISMATCH`. `ws_url` comes from
  `krug.realtime.ws-url` (`ws://localhost:8081/ws` in dev; use `wss://...` behind a proxy).
* **Authz** — every `subscribe`/`typing`/`presence` re-checks ACTIVE workspace + chat
  membership. A forbidden chat is `accepted:false, reason:"FORBIDDEN"`; existence is not
  leaked. ≤200 chats per connection → `SUBSCRIPTION_LIMIT` + close 1008.
* **Replay** — `messages WHERE seq > last_seq ORDER BY seq ASC LIMIT 500`. If
  `max_seq - last_seq > 500`, the server sends `resume.gap` and replays the last 500; the
  client catches up through `GET /messages?after_seq=...` (E3-D-03). `message.receipt`,
  `typing`, and `presence` are never replayed.
* **Live fan-out** — `MessageSubmissionHandler` publishes an in-process
  `MessageCreatedNotification`; a `@TransactionalEventListener(AFTER_COMMIT)` pushes
  `message.created` (payload = OpenAPI `Message`) to chat subscribers. `POST /read`
  publishes `message.receipt` the same way. The message id is the stable `event_id`, so
  replay/live duplicates dedupe on the client and at the replay boundary.
* **Ephemeral** — `typing` (TTL 5 s) and `presence` (TTL 60 s, ONLINE/OFFLINE) are not
  persisted. They are `type:"event"` with `event:"typing"|"presence"`, no `seq`/`event_id`;
  a client that wants presence sends `presence:true` in `subscribe`.
* **Heartbeat/backpressure** — server WS ping every 25 s, no client activity for 60 s →
  close 1008. Per-connection outbound queue 256: ephemeral frames are dropped first, then
  the connection closes 1013 `SLOW_CONSUMER last_delivered_seq=...`. One virtual-thread
  writer per connection prevents a slow client from blocking other fan-out.
* **Origin allowlist** — the handshake uses `krug.realtime.allowed-origins`
  (`KRUG_WS_ALLOWED_ORIGINS`, comma-separated) instead of `*`: dev/keycloak default
  `http://localhost:5173` (Vite proxy preserves it), prod defaults to empty and fails
  closed for browser origins until the deployed SPA origin is configured. Native clients
  without an `Origin` header still authenticate with the ticket. A foreign browser origin
  is rejected with HTTP 403 *before* the ticket is consumed, so it cannot burn a valid
  one-time ticket.
* **Close codes** — 1000 normal, 1008 bad frame/policy/heartbeat, 1013 slow consumer,
  4401 invalid/expired/used ticket, 4403 revoked device/session.

### Local smoke

```bash
# 1) ticket (set TOKEN/DEVICE/CHAT from POST /dev/session)
curl -s -X POST http://localhost:8081/api/v1/realtime/ticket \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# {"ticket":"...","expires_at":"...","ws_url":"ws://localhost:8081/ws"}

# 2) WS subscribe (Python 3.11+; pip install websockets)
python3 - <<'WS_PY'
import asyncio, json, os, websockets
async def main():
    async with websockets.connect("ws://localhost:8081/ws?ticket=" + os.environ["TICKET"]) as ws:
        print(await ws.recv())                       # hello
        await ws.send(json.dumps({"v":1,"type":"subscribe",
            "chats":[{"chat_id":os.environ["CHAT"],"last_seq":0}],"presence":True}))
        for _ in range(3):
            print(await ws.recv())                   # subscribed + replay events
asyncio.run(main())
WS_PY
```

Then send a message through `POST /chats/{chatId}/messages` in another shell: the connected
client receives `event: message.created` without reload. A reconnect must use a **new**
ticket and subscribe with the client's `last_seq`; no duplicates are expected.

## Files (E4-B, managed only)

E4-B implements the contract's file slice without changing `contracts/openapi.yaml`.
E2EE files/keys, presigned upload, DLP, retention UI, public links and CDN are out of
scope (managed uploads only).

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/v1/workspaces/{workspaceId}/limits` | tariff + effective limits + `usage` (used/reserved/limit) |
| POST | `/api/v1/uploads/preflight` | per-file `ALLOW/DENY` before any bytes; size/type/count/quota |
| POST | `/api/v1/uploads` | creates upload, `part_size=8 MiB`, `total_parts`, TTL 24 h, ACTIVE reservation, S3 multipart |
| GET | `/api/v1/uploads/{uploadId}` | status + `received_parts` (resume) |
| PUT | `/api/v1/uploads/{uploadId}/parts/{partNo}` | binary part + `Content-SHA256`; idempotent; 409/422 |
| POST | `/api/v1/uploads/{uploadId}/complete` | verifies parts/size/whole-file SHA-256, completes S3 multipart, commits quota, returns 202 `SCANNING` |
| POST | `/api/v1/uploads/{uploadId}/abort` | releases ACTIVE reservation and aborts S3 multipart (204) |
| GET | `/api/v1/attachments/{attachmentId}/download-url` | presigned GET, TTL 5 min; only `READY/BOUND` + `CLEAN` |

`Idempotency-Key` is required on preflight/init/complete/abort. Init stores the key in
`ops.idempotency_keys` and replays the same `upload_id`; complete/abort are naturally
idempotent by upload state (a replay never moves quota twice).

### Migrations and rollback

`V9` creates the `file` schema, six tables, forced RLS, worker-role policies, indexes and
backfills Team limits/usage for existing workspaces. `V10` relaxes the V4 TEXT-body check
for attachment-only messages; `V11` was the initial resolver, `V12` adds the contract's
`QUARANTINED` upload state, and `V13` replaces the V11 resolver with the `file-resolve`
worker role. All are forward-only and idempotent where practical. Rollback: disable the
file endpoints/upload feature first, keep S3 objects read-only, then (after backup) drop
`file` schema cascade for a full feature rollback; re-adding the V4 TEXT check is only safe
after confirming there are no attachment-only messages.

### Storage (S3/MinIO)

`docker compose up -d minio minio-init` starts MinIO on **9002** (API) / **9003** (console)
and creates bucket `krug`. The backend uses path-style S3 with static credentials and
`software.amazon.awssdk:s3`. `ObjectStoragePort` provides multipart create/part/complete/
abort, object stream/hash, delete and presigned GET. Parts always pass through the API
(E4-D-02), which is what makes authz/quota exact; only downloads are presigned.

If the pinned MinIO tag is unavailable in your registry (MinIO withdraws community tags),
pin any working MinIO release or an S3-compatible emulator; the S3 contract does not change.
The live E4-B check in this workspace used `adobe/s3mock` on 9002 because Docker Hub refused
the MinIO image; the 20 MiB multipart flow and presigned download were identical.

### Quota transaction

`file.workspace_usage` is the single counter row:

```
used_bytes       committed objects (complete)
reserved_bytes   ACTIVE reservations (init .. complete/abort/expiry)
invariant        used + reserved + new <= workspace_limits.storage_bytes
```

`reserve/commit/release` lock the usage row `FOR UPDATE` in the caller's transaction, and
the reservation row state-machine (`ACTIVE → COMMITTED → RELEASED`, `ACTIVE → RELEASED/
EXPIRED`) is checked before any counter move. That gives exactly one quota commit per
upload:

* **init** → `reserved += size`, reservation ACTIVE;
* **complete** → `reserved -= size`, `used += size`, reservation COMMITTED;
* **message bind** → only `attachments.message_id/status=BOUND`; **no** quota change;
* **abort** → `reserved -= size`, reservation RELEASED;
* **GC/expiry** → unbound COMMITTED object: delete S3 object, `used -= size`;
* **AV quarantine (INFECTED/FAILED)** → delete object, release COMMITTED once; download 423;
* **daily reconcile** compares `used` with `SUM(attachments.size_bytes)` and `reserved` with
  `SUM(ACTIVE reservations)`, logs drift and repairs the row;
* **80/95/100%** thresholds are logged as `file.quota.threshold` (single-node MVP).

### Chunk/resume

* 8 MiB parts, `total_parts = ceil(size / 8 MiB)`, last part may be shorter, S3 part
  numbers 1..10000.
* `PUT` is idempotent by `(upload_id, part_no)`: same hash → 200, different hash →
  `409 CHUNK_CONFLICT`, declared/received hash mismatch → `422 CHUNK_HASH_MISMATCH`,
  wrong part length → `422 CHUNK_SIZE_MISMATCH`.
* `GET /uploads/{id}` returns `received_parts`; the client retries only missing parts.
* `complete` requires all parts, exact total size, matching `parts_count`, matching
  whole-file SHA-256; it re-reads the stored object and verifies its SHA-256 before
  creating the attachment.

### AV / scan

`MalwareScanPort` with `NoopScanner` (dev/test, always CLEAN unless the dev fail marker is
configured) and an optional ClamAV INSTREAM adapter (`S3_SCAN_MODE=clamav`). Managed
complete always enters `SCANNING`; the scheduler moves it to `READY` (CLEAN) or
`QUARANTINED` (INFECTED/FAILED). AV failures are **fail-closed**: a scanner error never
makes a file downloadable. `GET download-url` returns 409 while pending and 423 for
quarantine.

### Errors (E4-B)

| HTTP | code | When |
|---|---|---|
| 413 | `FILE_TOO_LARGE` | preflight decision or init above tariff/guest limit |
| 409 | `QUOTA_EXCEEDED` | `used+reserved+size > storage_bytes` |
| 422 | `TOO_MANY_FILES` | >10 files in preflight or `attachment_ids` |
| 415 | `UNSUPPORTED_TYPE` | MIME outside the managed allowlist |
| 422 | `DANGEROUS_TYPE_BLOCKED` | exe/script/SVG/HTML policy |
| 410 | `UPLOAD_EXPIRED` | TTL 24 h elapsed |
| 409 | `CHUNK_CONFLICT` / 422 `CHUNK_HASH_MISMATCH` / `CHUNK_SIZE_MISMATCH` | part upload |
| 422 | `INCOMPLETE_UPLOAD` / `FILE_HASH_MISMATCH` | complete verification |
| 409 | `ATTACHMENT_NOT_READY` | scan pending or already bound |
| 423 | `ATTACHMENT_QUARANTINED` | INFECTED/FAILED scan; download/bind blocked |
| 422 | `MODE_NOT_SUPPORTED` | E2EE upload request in the managed slice |

### Message attachments and realtime

`MessageCreate.attachment_ids` is limited to 10, must be owned by the sender, belong to the
same chat, be `READY`/`CLEAN` and not already `BOUND`. A successful send sets
`attachments.status=BOUND, message_id=...` in the same transaction as the message, and
`Message.attachments` is returned by send/list/query. `message.created` WS payload and the
outbox payload include the same `attachments` array (OpenAPI `AttachmentRef`).

### Tests

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn test
```

E4-B added 49 tests (230 at that checkpoint); E5-B adds 19, for **249 total, all green**:
preflight oversized/quota/too-many/type/guest,
chunk idempotency/hash/size, resume, complete verification, abort release, quarantine 423,
bind/no-double-charge, message replay, RLS cross-tenant for uploads/parts/attachments/
reservations, workspace resolvers, quota race, expiry GC / unbound GC / reconciliation drift,
schema/RLS/indexes, contract schemas, realtime attachment payload and domain invariants. `ArchUnit` stays 10/10 with the `file` context in
the bounded-context isolation rule.

## Stickers (E5-B, managed only)

E5-B adds the built-in sticker catalog, server-side favorites and `type=STICKER`
messages. Scope is **managed + built-in only**: custom packs, upload, moderation, AV/DLP,
E2EE pack keys, marketplace and APNG animation are v1/out of scope. The demo art is
static PNG (SVG/HTML are forbidden by SYSTEM-ANALYSIS §12.7).

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/v1/sticker-packs?chat_id=` | ACTIVE built-in packs with their ACTIVE stickers and the caller's `favorite` flag; 404 for a foreign/unknown chat |
| PUT | `/api/v1/stickers/{stickerId}/favorite` | idempotent 204; 404 unknown/inactive sticker or disabled pack |
| DELETE | `/api/v1/stickers/{stickerId}/favorite` | idempotent 204; same 404 rules |
| POST | `/api/v1/chats/{chatId}/messages` | `{"client_message_id","type":"STICKER","sticker_id"}` → 201 `Message` with `type=STICKER`, `sticker_id` and `sticker` |

`GET /sticker-packs` is chat-scoped: the caller must be an ACTIVE member (workspace
membership + chat membership). A foreign or unknown `chat_id` is `404 NOT_FOUND` so chat
existence is not disclosed. `X-Device-Id` is required, as declared by the contract.

### Built-in seed (V14)

Two ACTIVE, `builtin=true` packs × 8 PNG stickers. IDs are deterministic UUIDv5 values;
the sticker and pack ids are stable across resets, so clients/tests can cache them.

| slug | name | cover | stickers |
|---|---|---|---|
| `krug` | «Сова» | `/stickers/krug/cover.png` | `/stickers/krug/01.png` … `/stickers/krug/08.png` |
| `cats` | «Коты» | `/stickers/cats/cover.png` | `/stickers/cats/01.png` … `/stickers/cats/08.png` |

Every row has `format=PNG`, `width=height=512`, `0 < size_bytes <= 524288`, `position`
1..8, `status=ACTIVE`. Example pack ids: `krug` = `3a7f2fdc-306b-53c8-926d-77d90bcea67e`,
`cats` = `80c42b6e-6530-5a31-b47e-eaf857ebaf0e`; the first `krug` sticker is
`a275046b-3f4d-55ca-aabe-2abb589afc93`.

The backend stores asset metadata and paths, not image bytes. The web client serves the
demo PNGs from `frontend/public/stickers/**`; `KRUG_STICKERS_ASSET_BASE_URL` can prefix the
returned paths with a CDN origin. V14 exposes `sticker.ensure_builtin_catalog()`
(SECURITY DEFINER, idempotent) and `BuiltinStickerSeedLoader` calls it on startup, so an
empty/restored catalog self-heals without giving `krug_app` INSERT on global tables.

### Sticker messages

`MessageCreate` variants are mutually exclusive:

* `type=TEXT` — text and/or up to 10 attachments (E4-B); `sticker_id` is rejected;
* `type=STICKER` — exactly one `sticker_id`, `text` empty/null, `attachment_ids` empty;
  `reply_to_id` is allowed and keeps the normal reply/reaction semantics.

The sticker and its pack must be ACTIVE. The check runs before `seq` allocation, and the
storage invariant is also enforced by the DB: `sticker_id` is non-null iff
`type='STICKER'`, and a STICKER row has no `body_ciphertext`. The response embeds
`Message.sticker` (`StickerRef`: id/pack_id/alt/url/favorite) and `sticker_id`.
`message.created` (live and replay) and the `message.created` outbox payload carry the same
`sticker_id`/`sticker` object, so history and WS render identically. Already-sent stickers
keep rendering after a pack is disabled; only new sends are rejected.

| HTTP | code | When |
|---|---|---|
| 404 | `STICKER_NOT_FOUND` | unknown sticker/pack row; also favorite of an unknown/inactive sticker |
| 410 | `STICKER_NOT_FOUND` | sticker was disabled/removed |
| 409 | `STICKER_PACK_DISABLED` | sticker is fine but its pack is not ACTIVE |
| 422 | `INVALID_STICKER_MESSAGE` | mixed payload (text/attachments on STICKER), missing `sticker_id`, or `sticker_id` on TEXT |

### Data and RLS

`V14` creates the `sticker` schema with `sticker_packs`, `stickers` and
`sticker_favorites`, then adds `message.messages.sticker_id`, the
`TEXT/STICKER/SYSTEM` type check and the STICKER↔sticker_id/body constraints.
Built-in packs and stickers are global and read-only for `krug_app` (no RLS). Favorites are
per user (`PRIMARY KEY(user_id, sticker_id)`) with `ENABLE` + `FORCE ROW LEVEL SECURITY`
and `user_id = ops.current_user_id()`, so cross-device favorites cannot leak across users.
Favoriting is an `ON CONFLICT DO NOTHING` upsert and unfavoriting is a no-op delete, hence
both directions are idempotent 204.

### Tests

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn test
```

E5-B covers the seeded catalog, per-user favorites and idempotency, foreign/unknown chats,
disabled/inactive rows, sticker send/history/replay, mixed and invalid payloads, status
errors (404/410/409/422), the realtime live + replay payload, strict OpenAPI schema
validation and the V14 schema/RLS/constraints. Custom packs/upload/moderation are v1.

## Notifications (E6-B, in-app + email stub)

`message.created` is consumed **after commit** by
`notification.infrastructure.event.NotificationMessageCreatedListener`. The listener opens
a fresh transaction (`REQUIRES_NEW`) and fans the event out to every ACTIVE chat member
except the sender. Rows are deduplicated by the unique `dedupe_key` rendered from
`(user_id, chat_id, message_id, type)`; repeated at-least-once delivery is a no-op.

Preference semantics (`notification.notification_preferences`):

* `mode=ALL` creates the row; `MUTE` and `MENTIONS` do not (E6 has no mentions parser, so
  `MENTIONS` suppresses ordinary MESSAGE notifications).
* chat-scoped row overrides the workspace-global row (`chat_id IS NULL`); IN_APP defaults to
  `ALL`, EMAIL defaults to `MUTE` (the E6 sender is opt-in).
* `channel=EMAIL` + `mode=ALL` enqueues a content-free descriptor on a small dedicated
  executor; `LoggingNotificationSender` only logs ids and never blocks the HTTP request.

Privacy: `body` is always `null` (both MANAGED and E2EE), `title` is the generic
`Новое сообщение`, and `chat_name` is resolved through chat's read port at list time.
`GET /notifications` is `(created_at DESC, id DESC)` with an opaque base64url cursor and
`unread_count`; `POST /notifications/read` updates only the caller's unread rows and is
idempotent. Retention deletes rows older than 90 days through the explicit
`notification-retention` worker role.

V15 creates the `notification` schema, forced RLS (`user_id = current_user`), indexes
`(user_id, created_at DESC, id DESC)`, a partial unread index, unique `dedupe_key`, and a
`UNIQUE NULLS NOT DISTINCT` preference key. The notification module never runs SQL against
chat tables: `ChatDirectoryPort` is implemented by an adapter over chat's published
`ChatMemberDirectoryPort`. Rollback is manual and destructive
(`DROP SCHEMA notification CASCADE`) because V15 is additive: it changes no existing table
or row.

Tests: `NotificationDomainTest`, `NotifyUseCaseTest`, `NotificationIT`
(fan-out/no-self/dedupe/MUTE/E2EE body null/unread/read/pagination/foreign/RLS/retention),
`NotificationContractIT` and the V15 assertions in `MigrationsIT`.

## E2EE device keys (E7-B1), chat and envelopes (E7-B3/B4)

E7-B1 applies the I-01 contract and the V16/V17 storage used by E2EE 1:1. **E7-B3/B4 add
E2EE DIRECT chat creation, opaque envelope send/history and per-device realtime fan-out.**
Client X3DH/Double Ratchet, key backup (E7-F/B5) and E2EE groups/files/stickers remain out
of scope: the server never decrypts, derives shared secrets, verifies private secrets or
stores private keys. Only public Ed25519 verification (device registration) and SHA-256
are used by the backend.

### I-01 contract

* `contracts/openapi.yaml` now has the I-01 schemas (`Base64Url16/32/64`,
  `SignedPrekey`, `OneTimePrekey`, `CryptoHeader`, `PrekeyBlock`, `CryptoEnvelope`,
  `DeviceList`, `SignedPrekeyUpload`, `PrekeyUploadResult`, `KeyClaimRequest`,
  `PrekeyBundle`, `UnavailableDevice`, `KeyClaimResponse`, `DeviceKeyInfo`,
  `ChatKeysResponse`, `VerificationRequest/Response`, `EnvelopeCoverage`,
  `MessageCreateResult`, `Chat`, `ChatCreateRequest`), the extended `Device`,
  `DeviceRegistration`, `Message`, `MessageCreate`, `ChatSummary` and the paths
  `GET/DELETE /devices`, `POST /devices/{id}/prekeys`, `POST /keys/claim`,
  `GET /chats/{id}/keys`, `PUT /chats/{id}/keys/verification`,
  `POST /workspaces/{id}/chats`.
* `contracts/ws-protocol.md` documents `chat.keys.changed` and `device.list.changed`;
  `chat.session.reset` is deliberately **not** a WS event.
* `frontend/src/api/schema.d.ts` is regenerated (`npm run api:types`); `npm run
  contract:check` is green. The check script counts/required-fields were extended for
  I-01 (28 paths / 33 operations / 58 schemas).

### V16 migration (`V16__e2ee_device_keys.sql`)

Forward-only, written against V1–V15:

* `auth.devices`: `identity_signing_key`, `identity_dh_key`,
  `identity_binding_signature`, `fingerprint`; `identity_key_alg` default removed;
  all-or-none CHECK; global partial unique indexes on both identity keys among
  non-`REVOKED` devices; dead `identity_public_key` dropped. A new additive RLS policy
  `p_devices_chat_peer` lets claim/keys/send read ACTIVE peer devices only through a shared
  chat in the current workspace.
* `auth.device_prekeys` (SIGNED/ONE_TIME, TTL/retire/consume) with owner + chat-peer RLS,
  explicit grants, and `auth.claim_one_time_prekey(device_id, chat_id)` (SECURITY DEFINER,
  `FOR UPDATE SKIP LOCKED`) that re-checks membership in the current workspace.
* `auth.key_verifications`: verifier-device scoped, composite ownership FK, strict
  `BEFORE INSERT` scope trigger, `vh_version=2`, tenant RLS and grants.
* `chat.chats.direct_key`: preflight `DIRECT_KEY_UNRESOLVED` for a DIRECT chat without
  exactly two distinct member rows (any status), backfill for all DIRECT (including
  deleted), `NOT VALID` → `VALIDATE`, ordered-pair format CHECK, duplicate preflight
  `DIRECT_PAIR_DUPLICATE`, partial unique `(workspace_id, direct_key)` for live DIRECT.
* `security_mode` immutability triggers on chats and workspaces; the workspace onboarding
  upsert no longer writes `security_mode`.
* `message.message_envelopes` (partitioned by `created_at`, canonical ciphertext
  272..33040 B, parent indexes only), E2EE message CHECKs (`reply_to_id`, sender required,
  no managed body/sticker/meta), and `message.ensure_partition()` now creates both the
  messages and envelopes partitions plus the sender-scoped `client_message_id` index.
  Envelopes partitions inherit exactly 4 indexes (PK + 3 parent indexes).

DDL smoke is executed by `E2eeMigrationIT` on PostgreSQL 16 Testcontainers:
V1–V15 → seed → V16 for **normal, degraded (ACTIVE+REMOVED) and deleted DIRECT**, GROUP,
new partition/index/grants/RLS/CHECK assertions, mode immutability and E2EE message
invariants; corrupt DIRECT → `DIRECT_KEY_UNRESOLVED`; duplicate pair →
`DIRECT_PAIR_DUPLICATE`.

### V17 migration (`V17__e2ee_identity_hardening.sql`) and the migration role

V17 is the security hardening required by `docs/E2EE-REVIEW-04.md`:

* **hard/global identity uniqueness (P1-06):** the V16 partial indexes
  (`WHERE status <> 'REVOKED'`) are replaced by unique indexes over **all** rows. A revoked
  key pair can never be re-registered by another account (`409 IDENTITY_KEY_CONFLICT`).
  Existing duplicates and `NULL`-combination rows accepted by V16 are quarantined in
  `auth.identity_key_quarantine` (owner-only, no `krug_app` grant) and the winner keeps the
  keys (ACTIVE first, then the oldest row). A duplicate that survives the repair fails fast
  with `IDENTITY_KEY_DUPLICATE_UNRESOLVED`.
* **NULL-safe all-or-none CHECK (P2-01):** explicit `IS NOT NULL` before `octet_length`
  (`NOT VALID` → `VALIDATE`).
* **one capability predicate (P2-02):** `auth.device_is_e2ee_capable(status, alg, sig, dh,
  binding, fingerprint)` mirrors `Device.isE2eeCapable()` and is used by claim/chat-summary/
  peer checks/device counts.
* **strict verification scope (P2-03):** the `key_verifications` trigger now requires an
  ACTIVE capable target and an ACTIVE verifier device.
* `auth.user_has_e2ee_capable_device(workspace, user)` for the E2EE DIRECT gate and
  `chat.e2ee_chat_scopes(user)` for `chat.keys.changed` fan-out (both SECURITY DEFINER).

**Migration role.** Flyway must run as the schema owner (`krug_migrator`). V16/V17
temporarily execute `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` around their backfills
because `auth.devices`, `chat.chats` and `chat.chat_members` are FORCE-RLS: without it a
non-superuser owner sees **zero** rows and the backfill is a silent no-op. `FORCE` is
restored before constraints are validated, `ENABLE` is never removed, and Flyway's
per-migration transaction rolls the `NO FORCE` change back on failure. The role does **not**
need superuser/BYPASSRLS (proven by
`E2eeMigrationIT.nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17`), but it must own the
tables; if your Flyway role is not the owner, grant it `BYPASSRLS` and document that in the
deploy runbook. Post-migration checks and the repair runbook are in
`docs/E2EE-SPEC.md` §6.5.2.

### V18/V19/V20 migrations — ciphertext floor, legacy-envelope quarantine, retention

**V18** (`V18__e2ee_ciphertext_floor.sql`) adds
`ck_envelopes_ciphertext_min CHECK (octet_length(ciphertext) BETWEEN 272 AND 33040)`
as `NOT VALID`: every new INSERT/UPDATE is checked immediately (including partitions), while
an upgraded database with pre-B3F 16..271 B rows still migrates. `NOT VALID` is a temporary
state, **not** a promise that those rows stay readable.

**V19** (`V19__e2ee_legacy_envelope_quarantine.sql`) is the permanent repair (one Flyway
transaction):

* temporarily `NO FORCE ROW LEVEL SECURITY` on `message.message_envelopes` (the V16/V17
  pattern: `ENABLE` stays, `krug_app` keeps the tenant policy);
* creates `message.message_envelopes_quarantine` — a verbatim copy of the envelope columns
  plus `reason`/`quarantined_at`, owner-only;
* copies every row outside `272..33040` (`legacy_short` / `legacy_out_of_range`) with
  `ON CONFLICT DO NOTHING`;
* deletes a live row **only** when `WHERE EXISTS` finds a quarantine row with the same PK and
  the same bytes (`workspace_id`, `chat_id`, `session_id`, `header`, `ciphertext`); a
  conflicting copy therefore fails `VALIDATE` instead of silently losing data;
* `VALIDATE CONSTRAINT` recursively covers parent + all partitions, then restores `FORCE`.

**Tolerant read.** `findForDevice`/`findByMessage` filter the same `272..33040` bytes and
`toDomainOrNull` skips any otherwise unreadable row (corrupt header/prekey, NPE/ClassCast)
logging only `message_id`, `recipient_device_id` and the reason — never ciphertext. A device
without a valid envelope gets `200` with `crypto:null` (REST) or a frame with `crypto:null`
(WS replay), not `500`; other devices keep their own envelopes. `Message.crypto` is nullable
in `contracts/openapi.yaml`, so this is wire-compatible.

**V20** (`V20__e2ee_envelope_quarantine_hardening.sql`) adds defence in depth and retention:
`ENABLE ROW LEVEL SECURITY` on the quarantine **without a policy** (the owner still bypasses
RLS; a non-owner is denied even if a future broad `GRANT` appears), explicit revocation of
`krug_app`/`PUBLIC` table privileges, an index on `quarantined_at`, and
`message.purge_envelope_quarantine(days)` (`SECURITY DEFINER`, window 1..3650 days,
`EXECUTE` to `krug_app` only). `EnvelopeQuarantineRetentionScheduler` calls it once a day
(`krug.e2ee.quarantine-retention-enabled/-days/-poll-interval`, default 90 days; disabled in
`test`). An operator can run `SELECT message.purge_envelope_quarantine(90);` directly.

**Rollout.** V19 takes `ACCESS EXCLUSIVE` on `message.message_envelopes` and scans/validates
the whole table. Run it in a maintenance window with a backup; V19/V20 are forward-only and
rollback is a restore. Deploy the tolerant code together with V19 and do not keep old strict
instances past the migration window. After the migration verify:

```sql
SELECT conrelid::regclass, convalidated FROM pg_constraint
 WHERE conname = 'ck_envelopes_ciphertext_min';            -- t for parent and partitions
SELECT count(*) FROM message.message_envelopes
 WHERE octet_length(ciphertext) NOT BETWEEN 272 AND 33040; -- 0
SELECT relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE oid = 'message.message_envelopes'::regclass;        -- t / t
SELECT count(*) FROM message.message_envelopes_quarantine; -- rows removed by V19
```

`DB_USER` (runtime) must differ from `FLYWAY_USER` (owner). Legacy-only replay semantics are
`422`/`409`, never `201` (§4.1 of the spec); see `E2eeLegacyEnvelopeIT` and
`E2eeMigrationIT`. Tests: `E2eeLegacyEnvelopeIT` (16 B / 271 B real HTTP, WS replay,
legacy-only replay), `E2eeMigrationIT` (byte-level quarantine lossless, DELETE conflict,
V20 RLS/retention, non-superuser owner), `MessageEnvelopeRepositoryAdapterTest`
(`toDomainOrNull` + log capture), and the real-HTTP wire regressions in
`E2eeMessageRealtimeIT`.

### Endpoints and semantics

| Endpoint | Behaviour |
|---|---|
| `POST /devices` | optional keys **all-or-none**: none → legacy `201` (`identity_key_alg=LEGACY`, `e2ee_capable=false`); partial → `422 INVALID_KEY_FORMAT`; full → SPK/binding Ed25519 verification, `key_generation=1`, SPK+OPK in one transaction. Same identity pair → the same device; a revoked pair → `410 DEVICE_REVOKED`; another DH owner → `409 IDENTITY_KEY_CONFLICT`. |
| `GET /devices` | own devices, ACTIVE/REVOKED, `e2ee_capable`, keys/fingerprint, active SPK id, owner-only `one_time_prekeys_available`. |
| `DELETE /devices/{id}` | terminal revoke, `key_generation++`, prekeys deleted, verifications targeting the device revoked; `device.list.changed` to the owner, `chat.keys.changed(DEVICE_REVOKED)` to every E2EE chat, and a proactive `session.revoked` + 4403 close; idempotent `204` with no duplicate events; another user's device → `404`. |
| `POST /devices/{id}/prekeys` | SPK rotation + OPK replenishment; `X-Device-Id` must match; legacy → `422 E2EE_LEGACY_DEVICE`; same key id+bytes idempotent, same id other bytes → `409 PREKEY_ID_CONFLICT`; 200 outstanding OPK cap. |
| `POST /keys/claim` | `chat_id` required; caller must be a member; target devices must be ACTIVE members; one OPK consumed atomically per device; exhaustion is `otp_exhausted=true`, no bundle at all → `409 NO_PREKEYS`; non-member/unknown → `422 UNKNOWN_DEVICE`; bounded per user/chat/device → `429 RATE_LIMITED` + `Retry-After` (a limited call consumes no OPK). |
| `GET /chats/{id}/keys` | E2EE chat only (`409 MODE_NOT_SUPPORTED` otherwise); ACTIVE e2ee-capable devices; `verified` scoped to `(X-Device-Id, target, chat)`, never inherited by another device. |
| `PUT /chats/{id}/keys/verification` | verifier device is `X-Device-Id`; `vh_version` must be `2` (`422 VH_VERSION_UNSUPPORTED`); 32-byte `safety_number_hash`; optional `expected_key_generation` mismatch → `409 KEY_CHANGED`; `Idempotency-Key` replays the same row/`verified_at`; `verified` is only valid for the verified `key_generation`. |
| `POST /workspaces/{id}/chats` | create DIRECT/GROUP; DIRECT idempotent by ordered `direct_key` (repeat → `200`, concurrent create → one chat, never `500`); GROUP is idempotent by `Idempotency-Key`; E2EE + GROUP → `409 E2EE_GROUP_NOT_SUPPORTED`; E2EE DIRECT requires capable devices on both sides (`409 E2EE_NO_ACTIVE_DEVICES`); `ChatSummary`/`Chat` expose derived `peer_id` and `peer_has_e2ee_capable_devices`. |

Legacy devices are never upgraded in place (D-17): they stay `e2ee_capable=false`, cannot
upload prekeys, never appear in chat keys and are rejected as envelope recipients. A user
who needs E2EE registers a **new** device.

### E2EE chat and messages (E7-B3/B4, flag on)

**Chat creation.** `POST /workspaces/{id}/chats` in an E2EE workspace creates a DIRECT chat
whose `security_mode=E2EE` is inherited from the workspace (the request cannot set it).
`E2EE + GROUP` → `409 E2EE_GROUP_NOT_SUPPORTED`. The mode is immutable (V16 trigger →
`MODE_CHANGE_FORBIDDEN`) and there are **no server-generated system messages**: membership
and key lifecycle are WS events (`chat.member.changed`, `chat.keys.changed`), never rows in
`message.messages`.

**Send.** `POST /chats/{id}/messages` in an E2EE chat accepts only `envelopes[1..10]`; the
server validates the public shape and the rights, never the content:

* canonical unpadded base64url, exact byte lengths (`session_id` 16, keys 32, signature 64),
  `v=1`, `scheme=PAIRWISE_X3DH_DR`, `pn/n/key_generation` ranges,
  `additionalProperties:false` for the envelope/`header`/`prekey`; ciphertext decoded
  272..33040 B (encoded 363..44054, form guard 65536 before decode);
* `chat_id` equals the path, `sender_device_id` equals `X-Device-Id` (an ACTIVE
  `e2ee_capable` device of the caller), each recipient is an ACTIVE `e2ee_capable` device of
  a participant, no self-envelope, no duplicate recipient;
* `sender_key_generation`/`recipient_key_generation` must equal the current generations
  (`409 KEY_CHANGED`); `prekey.sender_identity_*` must equal the registered identity keys
  (`422 INVALID_ENVELOPE_FORMAT`, P0-2b);
* a legacy recipient rejects the whole message with `422 E2EE_LEGACY_DEVICE` — there is no
  partial fan-out and no `seq`/row is created;
* `text`, `sticker_id`, `attachment_ids`, `reply_to_id` and `type != TEXT` →
  `422 E2EE_PLAINTEXT_FORBIDDEN` (reply metadata lives inside the encrypted payload);
* coverage counts **only** ACTIVE `e2ee_capable` devices: no peer device →
  `409 E2EE_NO_ACTIVE_DEVICES`; no envelope for the peer → `409 E2EE_NO_PEER_ENVELOPE`;
  partial coverage → `201` with `envelope_coverage.warning`
  (`PEER_DEVICE_UNCOVERED` takes priority over `SELF_DEVICE_UNCOVERED`);
* `client_message_id` is scoped `(chat, sender)`: the same bytes by the same sender replay
  the existing message (`201`, `Idempotent-Replay: true`); a different body or another
  sender → `409 CLIENT_MESSAGE_ID_CONFLICT`.

The message row is stored with `crypto_scheme=E2EE_PAIRWISE` and **no** body, sticker,
`reply_to_id` or `content_meta`; each envelope is stored as opaque bytes (session id,
header, ciphertext, prekey) with a shared `created_at` used by the partition key. `seq` is
allocated only after every envelope passed validation. The server never decrypts, never
verifies a private secret, never logs ciphertext/plaintext and never caches it by hash.

**Read.** `GET /chats/{id}/messages` returns `text:null`, no sticker/attachments/`reply_to_id`
and `crypto` **only** for the caller's `X-Device-Id`: `null` for own sent messages, other
devices of the same user and legacy devices. The envelopes of other devices and their count
are never disclosed. There is no server-side search/DLP for E2EE content. A legacy or
quarantined envelope is skipped by the tolerant read path (§V18/V19/V20 above): the page is
still `200` with `crypto:null` for that device, never `500`. Replaying a message whose only
envelope was legacy is `422` (same short bytes) or `409` (a different valid body with a new
idempotency identity); a true `Idempotency-Key` replay with the same valid 272+ B bytes
stays `201`, while replaying the original short bytes is `422`.

**Realtime.** `message.created` carries the same `Message`; `crypto` is resolved per
connection device (the sender's own device and devices without an envelope get `null`), and
the per-device map never leaves process memory. Replay resolves the envelope of the
connection device from history (`RealtimeChatHistoryAdapter`). Key lifecycle events
(`chat.keys.changed`, `device.list.changed`) remain metadata-only.

**Limits** (E2EE-SPEC §4.5): 10 envelopes per message, ciphertext decoded 272..33040 B /
encoded 363..44054, request body ≤524288 B enforced **before** JSON parsing
(`413 PAYLOAD_TOO_LARGE`), `ENVELOPE_TOO_LARGE` with `details.reason` `canonical`/`form`.

**Errors:** `E2EE_DISABLED`, `E2EE_LEGACY_DEVICE`, `E2EE_NO_ACTIVE_DEVICES`,
`E2EE_NO_PEER_ENVELOPE`, `E2EE_PLAINTEXT_FORBIDDEN`, `ENVELOPES_REQUIRED`,
`ENVELOPES_NOT_ALLOWED`, `TOO_MANY_ENVELOPES`, `DUPLICATE_ENVELOPE`,
`INVALID_ENVELOPE_FORMAT`, `UNSUPPORTED_ENVELOPE_VERSION`, `ENVELOPE_TOO_LARGE`,
`PAYLOAD_TOO_LARGE`, `KEY_CHANGED`, `CLIENT_MESSAGE_ID_CONFLICT`, `UNKNOWN_DEVICE`.

### Feature flag

`krug.e2ee.enabled` (`KRUG_E2EE_ENABLED`, default **false**). With the flag off:

* E2EE workspace/chat creation → `409 E2EE_DISABLED`;
* E2EE message send/read and any request with `envelopes` → `409 E2EE_DISABLED`
  (checked **before** envelope parsing — malformed envelopes do not change the answer; no
  plaintext fallback, no envelope storage);
* device key registration, prekeys, claim, chat keys and verification remain available
  (onboarding primitives, needed before the flag can be flipped).

### Tests

* `E2eeDeviceKeyIT` — legacy/full/partial registration, bad SPK/binding signatures,
  idempotent pair replay, revoke/`key_generation`, prekey rotation/conflict, claim and
  OTP consumption, foreign/unknown devices, RLS prekey isolation, chat keys per verifier
  device, verification `vh_version`, flag-off workspace/chat/message gates, managed message
  contract shape and DIRECT `name=null`/`peer_id`/capability.
* `E2eeMigrationIT` — real Flyway V1–V15 → V16 on normal/degraded/deleted DIRECT,
  corrupt/duplicate preflight, partitions/indexes/grants/RLS/CHECK/trigger; V18→V19
  quarantines 16/271 B byte-for-byte, the strengthened `DELETE ... WHERE EXISTS` refuses to
  drop an un-copied row, V20 enables owner-only RLS/retention, and a
  `NOSUPERUSER NOBYPASSRLS` owner can apply V16–V19.
* `E2eeLegacyEnvelopeIT` — real HTTP + PG16: 16 B and 271 B legacy rows give
  `200 crypto:null` (never `500`), WS replay gives `crypto:null`, valid replay stays `201`,
  legacy-only replay is `422`/`409`, and the real V19 file moves exactly those rows.
* `MessageEnvelopeRepositoryAdapterTest` — `toDomainOrNull` skips corrupt rows (including an
  unexpected NPE shape) and the warning log contains ids/reason but no ciphertext.
* `DeviceKeyCryptoTest` — known-answer vectors B3 (SPK signature), B5 (identity binding)
  and G1 (fingerprint), proving the server's public checks match the spec byte-for-byte.
* `E2eeMessageIT` (12) — E2EE DIRECT creation/immutability/no system messages,
  opaque envelope storage/coverage, plaintext rejection, invalid shapes/limits, legacy
  target, no peer envelope, no active peer devices, per-device `crypto`, key generation and
  prekey identity binding, idempotency/`client_message_id` conflicts, 512 KiB body limit,
  RLS isolation, managed `ENVELOPES_NOT_ALLOWED`.
* `E2eeMessageFlagOffIT` — an existing E2EE workspace/chat stays `409 E2EE_DISABLED` for
  chat creation, send (even with a malformed envelope) and read; no rows are written.
* `E2eeMessageRealtimeIT` — real WS: `message.created` has no plaintext and carries only
  the connection device's envelope, the sender's own device gets `crypto:null`, another
  device's envelope never leaks, replay resolves the device envelope; plus permanent
  real-HTTP regressions for encoded/nested paths, the 272/33040/33041 byte floor and
  chunked 524288/524289 bodies.
* `ContractValidationIT` + `OpenApiContract` validate the new response schemas.

## DDD architecture

One Spring Boot module, bounded contexts plus a small shared kernel. Each context has four
layers with a strict dependency direction:

```
api -> application -> domain
        |               ^
        v               |
infrastructure ---------+        (adapters implement domain repositories and application ports)
```

New B-02/B-04/E3 packages (in addition to the B-01 auth/workspace/chat/message contexts):

```text
ru.krug.backend
├── auth
│   ├── domain/
│   │   ├── model/             UserIdentity (new); User.provision, Device.registerWeb
│   │   └── repository/        UserIdentityRepository (new); UserRepository.findByEmail
│   ├── application/
│   │   ├── command/           RegisterDeviceCommand
│   │   ├── model/             KeycloakIdentity, AuthenticatedUser, UserProfileView,
│   │   │                      DeviceView, DeviceRegistrationResult, MeView
│   │   ├── port/              JitProvisioningPort, DeviceBindingPort, UserProfilePort
│   │   ├── service/           KeycloakIdentityFactory (deterministic local id/email)
│   │   └── usecase/           JitProvisioningService, JitProvisioningTx,
│   │                          DeviceBindingService, DeviceRegistrationService,
│   │                          DeviceQueryService, RegisterDeviceUseCase, MeQueryService
│   ├── infrastructure/persistence/
│   │                          UserIdentityEntity + adapter; Device/User adapters extended
│   └── api/                   MeController, DeviceController, dto/, mapper/
├── workspace
│   ├── domain/model/          WorkspaceMembership (read model)
│   ├── domain/repository/     WorkspaceRepository: findBy/ listActiveMemberships
│   ├── application/
│   │   ├── model/             WorkspaceMembershipView, WorkspaceSummaryView,
│   │   │                      CreateWorkspaceResult
│   │   ├── command/           CreateWorkspaceCommand
│   │   ├── port/              WorkspaceDirectoryPort
│   │   ├── service/           WorkspaceSlugFactory
│   │   └── usecase/           WorkspaceDirectoryService, WorkspaceOnboardingService,
│   │                          WorkspaceQueryService, CreateWorkspaceUseCase
│   └── api/                   WorkspaceController, dto/, mapper/
├── chat
│   ├── domain/model/          Chat.createGroup(securityMode)
│   ├── domain/repository/     ChatRepository.saveChat, findWorkspaceIdForActiveMember
│   ├── application/
│   │   ├── command/           DefaultChatCommand
│   │   ├── port/              ChatProvisioningPort.createDefaultGroupChat,
│   │   │                      ChatWorkspacePort
│   │   └── usecase/           ChatProvisioningService, ChatWorkspaceResolver
│   └── infrastructure/persistence/  adapter queries extended
├── ops                        (B-02 hardening: idempotency, outbox, retention)
│   ├── domain/model/          IdempotencyKey (24h TTL, completed factory),
│   │                          OutboxMessage, OutboxRecord
│   ├── domain/repository/     IdempotencyKeyRepository (advisory lock, upsert,
│   │                          stale/expired batch GC), OutboxRepository
│   │                          (publish + published-before batch GC)
│   ├── application/
│   │   ├── model/             IdempotencyReservation, OutboxEvent, RetentionReport
│   │   ├── port/              IdempotencyPort, OutboxPort, OutboxRelaySettings,
│   │   │                      RateLimitPort, EventPublisher
│   │   └── usecase/           IdempotencyReservationService (try-lock/recovery),
│   │                          OutboxRelayService (worker role),
│   │                          IdempotencyOutboxRetentionBatch, RetentionService
│   └── infrastructure/
│       ├── persistence/       IdempotencyKeyRepositoryAdapter (native SQL:
│       │                      pg_try_advisory_xact_lock + upsert + ctid batch GC),
│       │                      OutboxRepositoryAdapter
│       └── scheduling/        OutboxRelayScheduler, RetentionScheduler
├── audit                      (new bounded context, no public HTTP API in B-04)
│   ├── domain/model/          AuditEvent, AuditChainHead
│   ├── domain/repository/     AuditRepository
│   ├── domain/service/        AuditHashChain (pure SHA-256 chain)
│   ├── application/           AuditPort, AuditRecord, AuditAppenderService
│   └── infrastructure/persistence/ AuditEventEntity, AuditRepositoryAdapter
├── realtime                   (new E3 bounded context: WS transport + fan-out)
│   ├── domain/model/          RealtimeTicket, TicketId, TicketToken, TicketTokenHash
│   ├── domain/repository/     RealtimeTicketRepository
│   ├── domain/exception/      ticket invalid (401/4401), forbidden (403/4403),
│   │                          subscription limit (1008), session revoked
│   ├── application/
│   │   ├── model/             IssuedRealtimeTicket, RealtimeSession, ChatSubscription,
│   │   │                      SubscribedChat, SubscriptionPlan, ReplayBatch, RealtimeGap,
│   │   │                      RealtimeEvent, EphemeralEvent, MessageSnapshot
│   │   ├── port/              RealtimePublisherPort, RealtimeSubscriptionPort,
│   │   │                      RealtimeChatAccessPort, RealtimeChatHistoryPort,
│   │   │                      RealtimeDevicePort, RealtimeSettingsPort
│   │   ├── service/           RealtimeEventFactory (OpenAPI/WS payloads)
│   │   └── usecase/           IssueTicketUseCase, OpenSessionUseCase, SubscriptionService,
│   │                          RealtimeTicketRetentionBatch, RealtimeTicketRetentionService
│   ├── infrastructure/
│   │   ├── persistence/       RealtimeTicketEntity + JPA repository + adapter
│   │   ├── adapter/           chat-access/history/device/settings bridges
│   │   ├── event/             AFTER_COMMIT message.created and message.receipt listeners
│   │   ├── config/            krug.realtime properties + settings adapter
│   │   ├── scheduling/        RealtimeTicketRetentionScheduler (1 day GC)
│   │   └── ws/                config, /ws handshake interceptor, handler, frame codec,
│   │                          in-memory hub, bounded queue, virtual-thread writer,
│   │                          heartbeat scheduler
│   └── api/                   RealtimeTicketController, dto/, mapper/
├── sticker                     (new E5-B bounded context: built-in catalog + favorites)
│   ├── domain/model/           StickerPack, Sticker, StickerId, StickerAsset,
│   │                          PackStatus, StickerStatus, StickerRecord (read projection)
│   ├── domain/exception/       StickerNotFound (404), StickerGone (410),
│   │                          StickerPackDisabled (409)
│   ├── domain/repository/      StickerPackRepository, StickerFavoriteRepository
│   ├── application/model/      StickerPackView, StickerRefView (published to message)
│   ├── application/port/       StickerAccessPort (chat gate), StickerCatalogPort
│   │                          (published catalog for message), StickerAssetUrlResolver
│   ├── application/service/    StickerViewMapper (URL + favorite expansion)
│   ├── application/usecase/    ListPacksUseCase, FavoriteStickerUseCase
│   ├── infrastructure/
│   │   ├── persistence/        JPA entities/repos/adapters for packs, stickers, favorites
│   │   ├── adapter/            StickerChatAccessAdapter, StickerCatalogAdapter (implements
│   │   │                       the message-owned catalog port), asset URL resolver
│   │   ├── config/             krug.stickers properties
│   │   └── seed/               BuiltinStickerSeedLoader (idempotent catalog repair)
│   └── api/                    StickerController, dto/, mapper/
├── notification                 (new E6-B bounded context)
│   ├── domain/model/            Notification, NotificationType, Channel, Mode,
│   │                            NotificationPreference
│   ├── domain/service/          NotificationPreferencePolicy (chat > global > default)
│   ├── domain/exception/        invalid preference (422), access denied (403),
│   │                            invalid cursor (400)
│   ├── domain/repository/       NotificationRepository, NotificationPreferenceRepository
│   ├── application/
│   │   ├── model/               NotificationView/Page, PreferenceView, EmailNotification,
│   │   │                        MessageCreatedSignal, NotificationPageCursor
│   │   ├── port/                NotificationSenderPort, ChatDirectoryPort,
│   │   │                        WorkspaceLookupPort, NotificationRetentionSettings
│   │   └── usecase/             ListNotificationsUseCase, MarkReadUseCase,
│   │                            GetPreferencesUseCase, UpdatePreferenceUseCase,
│   │                            NotifyUseCase, NotificationRetentionBatch/Service
│   ├── infrastructure/
│   │   ├── persistence/         JPA entities/repos/adapters + cursor queries
│   │   ├── adapter/             chat-directory bridge, workspace lookup,
│   │   │                        LoggingNotificationSender (async email stub)
│   │   ├── event/               AFTER_COMMIT message.created listener (REQUIRES_NEW)
│   │   ├── config/              krug.notifications properties + email executor
│   │   └── scheduling/          NotificationRetentionScheduler (90 days)
│   └── api/                     NotificationController, dto/, mapper/
├── message/application/event/  MessageCreatedNotification (AFTER_COMMIT fan-out)
├── chat/application/event/     ReadReceiptNotification (AFTER_COMMIT fan-out)
└── shared
    ├── application/model/     AuthenticatedActor, Principal.withWorkspace
    ├── application/port/      WorkerContext (outbox-relay/retention roles),
    │                          RetentionSettings, RetentionMetrics
    └── infrastructure/
        ├── security/          KeycloakJwtDecoderConfig, KeycloakJwtValidators,
        │                      KeycloakClaims, DeviceBindingStrategy,
        │                      DevDeviceBinding, KeycloakDeviceBinding,
        │                      DeviceBindingFilter (profile strategy), DevJwtDecoderConfig
        ├── persistence/       JpaTenantContext, JpaWorkerContext
        ├── config/            RetentionProperties, RetentionSettingsAdapter, ProdGuard
        └── metrics/           InMemoryRetentionMetrics
```

### Layer rules

Enforced by `ArchitectureTest` (ArchUnit, 10 rules):

1. `domain` depends only on Java + `shared.error`; no Spring, JPA, Jackson, DTO or HTTP.
2. `application` never depends on `infrastructure` or `api`.
3. `application` never uses JPA/Hibernate.
4. `api` never depends on `domain` or `infrastructure` — only on `application` and
   `shared`.
5. JPA `@Entity` classes live only in `infrastructure.persistence`.
6. `@RestController` classes live only in `api`; `*Request`/`*Response` DTOs live in
   `api.dto`.
7. A context's `domain` never imports another context's `domain`.
8. Bounded contexts are `auth`, `workspace`, `chat`, `message`, `ops`, `audit`,
   `realtime`, `file`, `sticker`, `notification`.
9. WS handlers/interceptors live only in `realtime.infrastructure.ws`.
10. `domain`/`application`/`api` never depend on `org.springframework.web.socket`.

Cross-context links use IDs, published application ports or events. New examples:
`auth.me -> workspace.application.port.WorkspaceDirectoryPort`,
`workspace.onboarding -> chat.application.port.ChatProvisioningPort`,
`message -> chat.application.port.ChatWorkspacePort`,
`auth/workspace -> audit.application.port.AuditPort`,
`realtime -> chat.application.port.ChatAccessPort/ChatWorkspacePort`,
`realtime -> auth.application.port.DeviceBindingPort`,
`realtime -> message.domain.repository.MessageRepository` (via its own history adapter),
`message -> sticker.application.port.StickerCatalogPort` (implemented by the sticker
adapter; message owns only its own `MessageStickerView` projection),
`sticker -> chat.application.port.ChatAccessPort/ChatWorkspacePort` (chat-scoped picker
access),
`notification -> chat.application.port.ChatMemberDirectoryPort` (fan-out members/name/mode;
the notification-owned `ChatDirectoryPort` adapts it). The realtime and notification
contexts listen to message/chat *application events* after commit; no cross-context SQL
joins.
No cross-context SQL joins; each repository adapter touches only its own schema.

### DTO ↔ application ↔ domain ↔ JPA adapter

```
HTTP request DTO (api.dto)
  -> application command/query
     -> domain aggregate / value object / domain service
     -> domain repository interface  (implemented by JPA adapter)
  <- application result/read model (application.model)
<- HTTP response DTO via api.mapper
```

* Controllers accept and return only `api.dto` records; they never accept/return domain
  entities.
* JPA entities are separate classes in `infrastructure.persistence` and are mapped
  explicitly.
* Encryption is a persistence concern: the domain `Message` holds plaintext, the JPA
  adapter stores AES-GCM ciphertext.

### Transaction boundaries

`@Transactional` lives only in application handlers. Every tenant handler starts with
`TenantContext.activate(...)`, which issues transaction-local
`set_config('app.user_id'/'app.workspace_id'/'app.request_id', …)` for RLS.

* `JitProvisioningTx.ensure` — one transaction: activate the deterministic user id, create
  `auth.users` + `auth.user_identities`, append `user.provisioned` audit.
* `WorkspaceOnboardingService.create` — one transaction: workspace, OWNER membership,
  default chat, `workspace.created` audit.
* `CreateWorkspaceUseCase` / `RegisterDeviceUseCase` — idempotency reserve (committed,
  protected by the advisory try-lock), domain transaction, idempotency complete. A crash
  after the reservation is recovered by the 1h stale reservation takeover and the GC.
* `MessageSubmissionHandler.submit` — **one transaction**: advisory try-lock →
  idempotency reserve/replay → rate limit → chat authz → domain validation → sticker
  resolution (`StickerCatalogPort`, E5-B) → `seq` allocation (`ChatSeqAllocator`, row lock
  on `chat_counters`) → message insert → `message.created` outbox insert → idempotency
  completion. A rollback removes every reservation artefact.
* `OutboxRelayService.publishPending` — one transaction with the `outbox-relay` worker
  role; rows are `FOR UPDATE SKIP LOCKED` and marked published.
* `IdempotencyOutboxRetentionBatch` / `RealtimeTicketRetentionBatch` — each batch is one
  short transaction (`REQUIRES` a fresh transaction from the job orchestrator); no request
  transaction is held.
* Controllers are HTTP/authz-header parsing only, no DB access.

## Data and invariants

* Flyway migrations `V1`..`V15`: schemas `auth/workspace/chat/message/ops/audit/realtime/
  file/sticker/notification`, roles `krug_migrator`/`krug_app`, RLS policies (`ENABLE` +
  `FORCE`), monthly message partitions.
* `V15` (E6-B) adds `notification.notifications` (`dedupe_key` UNIQUE, no body content,
  user RLS + retention worker bypass) and `notification.notification_preferences`
  (`UNIQUE NULLS NOT DISTINCT` scope, prefs RLS by user). Indexes cover the inbox page,
  unread badge and 90-day GC.
* `V8` (B-02) adds forced RLS on `ops.outbox` with an explicit worker role, a retention
  bypass on `ops.idempotency_keys`, and indexes for stale in-progress, published outbox
  and consumed tickets. Tenant transactions see only their own outbox rows.
* `V7` adds `realtime.realtime_tickets` (`token_hash` UNIQUE, TTL/consumed timestamps).
  It intentionally has **no RLS**: the ticket is looked up during the unauthenticated HTTP
  upgrade, before a tenant context exists; only `krug_app` has grants, and the raw token is
  never stored (SHA-256 only).
* `V6` adds `auth.user_identities` (`UNIQUE(provider,subject)`,
  `UNIQUE(user_id,provider)`; RLS self), the append-only hash-chained
  `audit.audit_events` / `audit.audit_chain`, and three read-only RLS policies:
  workspace-by-active-membership (for `/me`), own chat membership and chats visible to an
  active member (for Keycloak workspace resolution).
* `messages` is `RANGE(created_at)` partitioned; current + two future partitions are
  created by `message.ensure_partition(date)`.
* `seq` is per chat from `chat_counters` under `SELECT … FOR UPDATE`; gaps are allowed,
  duplicates are impossible.
* `Idempotency-Key`: same body → original result + `Idempotent-Replay: true`; different
  body → `409 IDEMPOTENCY_KEY_REUSED`; concurrent duplicate → `409 IDEMPOTENCY_IN_PROGRESS`
  + `Retry-After: 1`. For sends the reservation, message and outbox share one transaction,
  so no committed in-progress row can be orphaned; stale pre-B-02 rows are recovered after
  1h and GC'd.
* Retention: expired keys; published outbox older than 7 days; expired/consumed tickets
  older than 1 day. Active rows are preserved. Counts are logged as
  `retention.deleted` and exposed through the `RetentionMetrics` port.
* Device registration: `(user_id, name, platform, app_version)` natural key returns the
  existing ACTIVE device; otherwise max 5 ACTIVE devices →
  `409 DEVICE_LIMIT_REACHED`.
* Audit hash: `SHA-256(prev_hash || canonical_json(event))`, one chain per
  `user:<id>` / `workspace:<id>`, head locked `FOR UPDATE`. `krug_app` has no
  UPDATE/DELETE on events.
* Managed bodies use local AES-256-GCM. KMS envelope encryption and key rotation are a
  later slice; prod **must** provide `KRUG_CONTENT_KEY`.
* Logs contain `request_id`, ids, event metadata, latency/status — never message text,
  tokens or keys.

## Tests

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn test
```

Current full suite (**453 tests, all green** on JDK 21; E12-B adds 6 integration tests):

* **Unit** — domain invariants (`MessageBody` 1..8000, seq > 0, reply-in-chat), counter
  allocation, idempotency key expiry/hash, cursor, canonical JSON, AES-GCM, JWT,
  in-memory limiter, dev ids, application authz, outbox relay (worker-role activation),
  **Keycloak aud/azp validators, deterministic JIT identity/email fallback, JIT
  transaction/audit, device max-5/natural-key idempotency, workspace
  onboarding/OWNER/default-chat/audit, audit hash chain, ticket TTL/one-time/token hash,
  subscribe authz/limit, replay order/dedupe/gap, outbound queue
  drop-ephemeral/overflow, WS frame contract, B-02 retention batching, B-02 prod-guard
  missing/dev-secret/remote-DB cases and context fail-fast, E6-B notification domain
  (body null, dedupe key, mode semantics, cursor round-trip) and fan-out use case
  (no self, MUTE/MENTIONS, email stub, dedupe skip)**.
* **Integration (Testcontainers PostgreSQL 16)** — Flyway schema/partitions/roles/RLS,
  RLS cross-tenant reads/writes with `krug_app`, dev session, send/list/reply/read/sync,
  `after_seq`, seq gap, idempotency replay/reuse/in-progress, **atomic concurrent
  duplicate + retry-after-failure + stale in-progress recovery**, `client_message_id`
  conflict/concurrency, outbox rows + relay, outbox tenant isolation under forced RLS,
  **retention counts and active-row preservation across users**, 401/403/404/409/422/429,
  prod-profile 404 (ProdGuard fail-fast is covered by unit/context tests), **keycloak-profile JIT `/me` → `/devices` →
  `/workspaces` → default chat flow, device limit, workspace/device idempotency, foreign
  workspace 403, revoked device 401, audit/identity assertions, `/dev/session` 404,
  ticket endpoint 200/401/403 + OpenAPI schema, WS handshake/hello, subscribe/replay, live
  message from a second user, read receipt, reconnect without duplicates, foreign chat
  `accepted:false`, expired/used ticket 401, foreign WS Origin 403, allowed Vite Origin
  200**.
* **Auth BFF** — RFC 6238 vectors and the ±5-step window; AES-256-GCM secret-at-rest
  round-trip/AAD/tamper; attempt cap (4×`422`, 5th→`429`, correct code locked); expiry
  `410`; resend cooldown + secret rotation; duplicate `409`; unverified login `403` +
  `verification_id`; wrong password `401`; register/resend/login per-email/per-IP `429`;
  Keycloak rollback on SMTP/password failure; cleanup of expired rows/users; encrypted
  secret and no password column in V21; WireMock Keycloak admin/token/userinfo/JWKS +
  captured SMTP; full register→verify→`/me`→refresh→logout flow with real RS256 tokens;
  contract validation of all new schemas; log assertion (no password/code/token).
* **Real JWT decoding** — `KeycloakJwtIT` serves a JWKS from WireMock and signs RS256
  tokens: valid token, expired token, wrong `aud`/`azp`/`iss`, wrong signature; device
  binding and onboarding run through the production decoder.
* **Contract** — real responses validated against `contracts/openapi.yaml` schemas
  (`MeResponse`, `Device`, `WorkspaceSummary`, `ChatList`, `Session`, `Message`,
  `MessagePage`, `SyncResponse`, `Error`, plus E4-B `WorkspaceLimits`, `PreflightResponse`,
  `UploadSession`, `UploadPart`, `DownloadUrl`, `Message.attachments` and E5-B
  `StickerPackList`/`Message.sticker`/STICKER `Message.type`).
* **E4-B files** — preflight/limits, chunk idempotency/hash/size, resume, complete/abort,
  quota commit/release/race, AV quarantine + 423, message binding + replay, RLS
  cross-tenant for all six file tables, workspace resolvers, schema/indexes, contract and
  realtime attachment payload.
* **E5-B stickers** — domain asset/pack invariants, seeded 2×8 catalog, picker list with
  per-user `favorite`, idempotent PUT/DELETE favorites, foreign/unknown chat 404,
  inactive/disabled rows, sticker send/history/replay, mixed/invalid payload 422,
  404/410/409/422 status matrix, strict OpenAPI schemas, V14 schema/RLS/constraints,
  realtime live + replay `sticker_id`/`sticker` payload.
* **E6-B notifications** — fan-out to an ACTIVE member and never the sender, repeated
  event dedupe, MUTE suppression, E2EE `body=null` + generic title, unread count,
  read one/all idempotency, cursor pagination without duplicates, foreign notification
  untouched, foreign-chat preference 403, forced-RLS proof, 90-day retention, OpenAPI
  `Notification`/`NotificationPage`/`NotificationPreferences`/`NotificationPreference`
  validation and V15 schema/index/RLS assertions.
* **E7-B1 device keys** — KAT B3/B5/G1, legacy/full/partial registration, SPK/binding
  rejection, identity-pair replay and revoked 410, prekey rotation/idempotency/conflict/
  limit/legacy 422, claim + atomic OPK consume + NO_PREKEYS, foreign/unknown device and
  prekey RLS, per-verifier chat keys, vh=1 422, flag-off E2EE workspace/chat/message,
  managed message shape, DIRECT `name=null`/`peer_id`/capability; V1–V15→V16 on
  normal/degraded/deleted DIRECT + corrupt/duplicate preflight, partitions/indexes/grants/
  RLS/CHECK/trigger.
* **E12-B workspace members** — add an existing user by email (`201`, duplicate `409`,
  unknown/inactive `404`), role changes under the OWNER/ADMIN matrix, last-owner/self
  protections, soft removal with access loss on the next request, an atomic concurrent
  last-slot add (exactly one `201`), audit metadata without email/display name, direct SQL
  bypass rejection, RLS isolation and no-`PUBLIC`-execute on V27 functions.
* **ArchUnit** — 10 layer/bounded-context rules; all green.

## Live checks

### Dev profile

```bash
SERVER_PORT=8081 SPRING_PROFILES_ACTIVE=dev mvn spring-boot:run

curl -i -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"I-01 Live"}'
# with TOKEN/DEVICE/WS from the response:
curl -i "http://localhost:8081/api/v1/me" -H "Authorization: Bearer $TOKEN"
curl -i "http://localhost:8081/api/v1/workspaces/$WS/chats" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"

# E3 realtime: one-time ticket, then the WS snippet from "Realtime WebSocket (E3)"
curl -s -X POST http://localhost:8081/api/v1/realtime/ticket \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# 200 {ticket,expires_at,ws_url}; repeat the same ticket on /ws -> HTTP 401

# B-02 atomic idempotency: send once, replay, then reuse the key with another body.
KEY=$(uuidgen); CID=$(uuidgen)
curl -i -X POST "http://localhost:8081/api/v1/chats/$CHAT/messages" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"client_message_id\":\"$CID\",\"type\":\"TEXT\",\"text\":\"B-02 live\"}"
# replay with the same key/body -> 201 + Idempotent-Replay: true and the same id
# same key + another text -> 409 IDEMPOTENCY_KEY_REUSED

# B-02 GC/outbox guard (the compose container is krug-postgres)
docker exec krug-postgres psql -U krug_migrator -d krug -c \
  "select relrowsecurity, relforcerowsecurity from pg_class where oid='ops.outbox'::regclass;"
docker exec krug-postgres psql -U krug_migrator -d krug -c \
  "select count(*) from ops.outbox where published_at is not null and published_at < now() - interval '7 days';"
```

### Files (E4-B)

```bash
# MinIO (API 9002, console 9003, bucket krug). If the pinned tag is unavailable, use any
# S3-compatible endpoint and set S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY accordingly.
docker compose up -d minio minio-init
SERVER_PORT=8081 SPRING_PROFILES_ACTIVE=dev \
  S3_ENDPOINT=http://localhost:9002 S3_BUCKET=krug \
  S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin mvn spring-boot:run

# The E4-B live run in this workspace used adobe/s3mock on 9002 (MinIO images were not
# available from the registry) and completed a 20 MiB file as 3 parts:
#   GET  /workspaces/{id}/limits       used=0 reserved=0
#   POST /uploads/preflight            ALLOW, part_size=8388608
#   POST /uploads                      201, total_parts=3
#   PUT  /uploads/{id}/parts/1..3      200, etags
#   GET  /uploads/{id}                 received_parts=[1,2,3]
#   POST /uploads/{id}/complete        202 SCANNING -> download 200 after scan
#   GET  /attachments/{id}/download-url presigned TTL 300s; downloaded 20 MiB SHA-256 equal
#   POST /chats/{id}/messages         201, attachments[0].scan_status=CLEAN
#   GET  /workspaces/{id}/limits       used=20971520 reserved=0
#   POST /uploads + abort              reserved=5242880 -> 0
```

### Stickers (E5-B)

```bash
# Reuse TOKEN/DEVICE/CHAT from the dev-profile session above.
curl -s "http://localhost:8081/api/v1/sticker-packs?chat_id=$CHAT" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# -> 2 ACTIVE built-in packs x 8 PNG stickers; favorite=false for a fresh user

STICKER=a275046b-3f4d-55ca-aabe-2abb589afc93   # krug/01
curl -i -X PUT "http://localhost:8081/api/v1/stickers/$STICKER/favorite" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"     # 204
curl -i -X DELETE "http://localhost:8081/api/v1/stickers/$STICKER/favorite" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"     # 204

KEY=$(uuidgen); CID=$(uuidgen)
curl -i -X POST "http://localhost:8081/api/v1/chats/$CHAT/messages" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"client_message_id\":\"$CID\",\"type\":\"STICKER\",\"sticker_id\":\"$STICKER\"}"
# 201, type=STICKER, sticker_id + sticker{id,pack_id,alt,url,favorite}, text=null
curl -s "http://localhost:8081/api/v1/chats/$CHAT/messages" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# history item keeps type=STICKER and Message.sticker

# Managed-only / disabled pack fixture: new send -> 409 STICKER_PACK_DISABLED,
# existing history still renders the sticker.
docker exec krug-postgres psql -U krug_migrator -d krug -c \
  "update sticker.sticker_packs set status='DISABLED' where slug='krug';"
KEY=$(uuidgen); CID=$(uuidgen)
curl -i -X POST "http://localhost:8081/api/v1/chats/$CHAT/messages" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"client_message_id\":\"$CID\",\"type\":\"STICKER\",\"sticker_id\":\"$STICKER\"}"
docker exec krug-postgres psql -U krug_migrator -d krug -c \
  "update sticker.sticker_packs set status='ACTIVE' where slug='krug';"

# Negative contract checks
# foreign/unknown chat_id -> 404; missing chat_id -> 400
# STICKER + text/attachments or no sticker_id -> 422 INVALID_STICKER_MESSAGE
# unknown sticker -> 404 STICKER_NOT_FOUND; disabled sticker -> 410 STICKER_NOT_FOUND
# no X-Device-Id -> 401
```

### Notifications (E6-B)

```bash
# Reuse TOKEN/DEVICE/CHAT from the dev-profile session and add a second dev user to the chat:
BOB=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"E6-B Bob"}')
BOB_TOKEN=$(echo "$BOB" | jq -r .access_token)
BOB_DEVICE=$(echo "$BOB" | jq -r .device.id)
docker exec -i krug-postgres psql -U krug_migrator -d krug -c \
  "insert into chat.chat_members (chat_id,workspace_id,user_id,role,status)
   values ('$CHAT','$WS','$(echo "$BOB" | jq -r .user.id)','MEMBER','ACTIVE');"

# Alice sends; Bob (not Alice) sees one generic notification.
curl -s -X POST "http://localhost:8081/api/v1/chats/$CHAT/messages" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d "{\"client_message_id\":\"$(uuidgen)\",\"type\":\"TEXT\",\"text\":\"E6-B live\"}"
curl -s http://localhost:8081/api/v1/notifications \
  -H "Authorization: Bearer $BOB_TOKEN" -H "X-Device-Id: $BOB_DEVICE"
# -> items[0] {type:MESSAGE, title:"Новое сообщение", body:null, read:false}, unread_count:1
# Alice's own inbox -> items:[], unread_count:0

# Read one/all is idempotent 204.
curl -i -X POST http://localhost:8081/api/v1/notifications/read \
  -H "Authorization: Bearer $BOB_TOKEN" -H "X-Device-Id: $BOB_DEVICE" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"all":true}'

# MUTE stops creation for that chat.
curl -s -X PATCH http://localhost:8081/api/v1/notification-preferences \
  -H "Authorization: Bearer $BOB_TOKEN" -H "X-Device-Id: $BOB_DEVICE" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d "{\"chat_id\":\"$CHAT\",\"type\":\"MESSAGE\",\"channel\":\"IN_APP\",\"mode\":\"MUTE\"}"

# E2EE fixture: create an E2EE chat with both users, send as Alice, list as Bob.
# The notification keeps body=null and the generic title; the DB body column is NULL too:
docker exec krug-postgres psql -U krug_migrator -d krug -c \
  "select count(*), count(body) from notification.notifications where chat_id='<e2ee-chat>';"
# -> 1 | 0
```

The live E6-B run in this workspace exercised exactly this path: fan-out created 1 row for
Bob and 0 for Alice, read-all returned 204, chat-scoped `MUTE` suppressed the next message,
and the E2EE fixture returned `title="Новое сообщение"`, `body=null`.

### Keycloak profile

```bash
docker compose up -d                       # PostgreSQL + Keycloak on 8180
# B-02: keycloak requires a strong content key (the dev default is rejected).
SERVER_PORT=8081 SPRING_PROFILES_ACTIVE=keycloak \
  KRUG_CONTENT_KEY='local-keycloak-content-key-32-bytes' mvn spring-boot:run

TOKEN=$(curl -s -X POST \
  http://localhost:8180/realms/krug/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=password -d client_id=krug-web \
  -d username=test@krug.local -d password='Test1234!' |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

curl -i http://localhost:8081/api/v1/me -H "Authorization: Bearer $TOKEN"
# 200, workspaces [] on the first login (JIT provisioning)

DEVICE_ID=$(curl -s -X POST http://localhost:8081/api/v1/devices \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Live Chrome","platform":"WEB","app_version":"1.0.0"}' |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

WORKSPACE_ID=$(curl -s -X POST http://localhost:8081/api/v1/workspaces \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE_ID" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"name":"Live Workspace","security_mode":"MANAGED"}' |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

curl -s http://localhost:8081/api/v1/me -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:8081/api/v1/workspaces/$WORKSPACE_ID/chats" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE_ID"

# E3 realtime in the keycloak profile (same ticket/WS flow, Bearer from Keycloak)
curl -s -X POST http://localhost:8081/api/v1/realtime/ticket \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE_ID"

# Contract checks
curl -i http://localhost:8081/api/v1/me                    # 401 UNAUTHENTICATED envelope
curl -i -X POST http://localhost:8081/api/v1/dev/session   # 404 NOT_FOUND in keycloak
```

The live flow above was verified against Keycloak 26.2: first `/me` 200 with empty
workspaces, `POST /devices` 201, `POST /workspaces` 201, `/me` with the workspace and
`default_workspace_id`, `GET /workspaces/{id}/chats` 200 with «Общий чат», idempotent
workspace replay 201 with `Idempotent-Replay: true`, 401 envelope, `/dev/session` 404.
A message sent with the same Keycloak token (no `workspace_id` claim) received `seq=1`,
confirming the chat→workspace resolution.

### Prod fail-fast

```bash
# No env: ProdGuard must reject the context before the datasource is created.
SPRING_PROFILES_ACTIVE=prod java -jar target/krug-backend-0.1.0-SNAPSHOT.jar
# exit != 0, message includes:
#   Insecure [prod] configuration: KRUG_AUTH_JWT_SECRET is required ...
# The same run with all env vars from "Profiles" starts normally.
```

## E8-B — first-run setup, platform admin, runtime settings and chat limits

E8-B adds the v1.1 admin slice (R-01…R-04) without changing the managed-chat/E2EE
semantics. Migration **V22** adds `auth.users.is_platform_admin` and the singleton
`ops.system_settings` row (SMTP ciphertext, business limits, `registration_open` and
`setup_completed_at`).

### Roles, setup and limits

* The first local user becomes `platform_admin` atomically. The claim is serialized by
  `auth.claim_platform_admin()` (transaction-scoped advisory lock); the partial unique
  index `ux_users_single_platform_admin` guarantees at most one admin. On an upgrade the
  earliest existing user is promoted, so a running installation never loses admin access.
  Multiple admins are out of scope for v1.1.
* `GET /setup/status` is public and secret-free:
  `{setup_required, registration_open}`. `setup_required=true` while
  `setup_completed_at IS NULL`; the wizard is a frontend concern.
* Setup completion uses `PATCH /admin/settings`; there is no separate setup-completion
  POST. Send `{"complete_setup": true}` to finish first-run setup. Completion and the
  settings write are one transaction (`SELECT … FOR UPDATE`); a repeated completion is
  `409 SETUP_ALREADY_COMPLETED`. Regular PATCHes after completion remain allowed.
* Every `/admin/*` operation is guarded server-side by `PlatformAdminGuard`, which reads
  `auth.users.is_platform_admin` under RLS. A non-admin gets `403 FORBIDDEN`; the UI guard
  is UX only.
* `GET /admin/overview` returns only aggregate `users/workspaces/chats` counts via the
  `ops.platform_overview()` SECURITY DEFINER function (admin sessions are RLS-scoped to
  themselves and cannot count other tenants directly). No message content or E2EE data is
  exposed.
* `GET /workspaces/{id}/limits` keeps the E4 file limits and now also returns
  `max_chats_per_user` and `chats_used` (the caller's ACTIVE chat memberships in that
  workspace).
* `POST /workspaces/{id}/chats` checks `max_chats_per_user` and
  `max_chats_per_workspace` **inside the creating transaction**, after a workspace-scoped
  advisory lock. DIR/GROUP replay/duplicate paths do not consume a slot. On overflow:
  `409 CHAT_LIMIT_REACHED` with `details.scope` (`USER`|`WORKSPACE`),
  `details.limit` and `details.used`. Defaults: 100 per user, 1000 per workspace.
  Existing chats are never deleted when a limit is lowered.

### SMTP runtime settings

* `PATCH /admin/settings` accepts `smtp_host`, `smtp_port`, `smtp_username`,
  `smtp_password` (write-only), `smtp_from`, `smtp_starttls`, the business limits and
  `registration_open`. `GET /admin/settings` never returns the password; it exposes only
  `smtp_configured` (host + from are set). An omitted/empty password means “keep the
  existing ciphertext”.
* The SMTP password is encrypted with AES-256-GCM derived from the existing
  `KRUG_CONTENT_KEY` (domain-separated; `[version][nonce][ciphertext+tag]`, AAD
  `ops.system_settings|smtp_password`). It is never written to logs, audit metadata or
  API responses.
* `SmtpMailAdapter` prefers the DB settings and builds a `JavaMailSenderImpl` per send;
  when the install has no SMTP host/from yet it falls back to the environment
  (`SPRING_MAIL_*` / `KRUG_MAIL_FROM`). `POST /admin/settings/test-email` is synchronous:
  `202 {sent:true,to}` on success, `503 SMTP_UNAVAILABLE` when the relay rejects it.
  Provider-level DKIM/SPF setup is out of scope.
* `AuthBffSettingsAdapter.registrationEnabled()` is
  `KRUG_AUTH_BFF_REGISTRATION_ENABLED AND ops.system_settings.registration_open`, so
  either switch can return `403 REGISTRATION_CLOSED` from `POST /auth/register`.
  `GET /setup/status` reports the persisted `registration_open` value.

### Manual smoke (dev profile)

```bash
# Public status
curl -s http://localhost:8081/api/v1/setup/status
# -> {"setup_required":true,"registration_open":true}

# The first dev/JIT user is platform admin; GET /me reports is_platform_admin.
SESSION=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Админ"}')
TOKEN=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
DEVICE=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["device"]["id"])')
WS=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')

curl -s http://localhost:8081/api/v1/me -H "Authorization: Bearer $TOKEN" \
  -H "X-Device-Id: $DEVICE"
# user.is_platform_admin=true

curl -s -X PATCH http://localhost:8081/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H 'Content-Type: application/json' -d '{
    "smtp_host":"localhost","smtp_port":1025,"smtp_from":"no-reply@krug.local",
    "smtp_starttls":false,"max_chats_per_user":100,"max_chats_per_workspace":1000,
    "max_workspace_members":100,"registration_open":true,"complete_setup":true}'

curl -s -X POST http://localhost:8081/api/v1/admin/settings/test-email \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H 'Content-Type: application/json' -d '{"to":"admin@krug.local"}'
# 202; Mailpit UI :8025 shows the message

curl -s http://localhost:8081/api/v1/admin/overview \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
curl -s "http://localhost:8081/api/v1/workspaces/$WS/limits" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# max_chats_per_user=100, chats_used=1

# Limit probe: lower the workspace limit below the current count, then create -> 409.
curl -s -X PATCH http://localhost:8081/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"max_chats_per_workspace":1}'
curl -i -X POST "http://localhost:8081/api/v1/workspaces/$WS/chats" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"type":"GROUP","name":"Ещё чат"}'
# 409 {"code":"CHAT_LIMIT_REACHED","details":{"scope":"WORKSPACE","limit":1,"used":1,...}}
```

Caveats:

* `setup_required` is advisory for the frontend; only `registration_open` gates an API
  (`/auth/register`). Chat creation is intentionally not blocked before setup, so the
  first admin can prepare the installation.
* `max_workspace_members` is enforced atomically by the E12-B add-member path
  (`workspace.add_member` under a per-workspace advisory lock); exceeding it is `409
  WORKSPACE_MEMBER_LIMIT_REACHED` with `details.limit/used`.
* SMTP passwords are write-only and cannot be cleared through the API; changing the
  provider means writing a new password (or rotating `KRUG_CONTENT_KEY` with a re-encrypt
  migration, which is out of scope).
* One platform admin only; `GET /admin/settings`/`PATCH`/`test-email` and
  `/admin/overview` are audited (`settings.updated`, `setup.completed`,
  `settings.test_email`).

## E9-B — admin directory: users, chats and storage dashboard

E9-B adds the read-only R-05 admin views (`docs/SYSTEM-ANALYSIS.md` §18.1,
`docs/TASKS-ADMIN-V2.md`): user list, cross-workspace chat list and a storage dashboard.
Every operation is `platform_admin`-only, cursor-paginated where it lists rows, and
audited. Admin responses contain metadata and aggregates only — never message text,
E2EE envelopes, filenames, object keys or file bytes.

### Endpoints

| Operation | Query | Response |
|---|---|---|
| `GET /admin/users` | `query`, `cursor`, `limit` (1..100, default 30) | `AdminUserPage` |
| `GET /admin/chats` | `workspace_id`, `query`, `type` (`DIRECT`/`GROUP`), `cursor`, `limit` | `AdminChatPage` |
| `GET /admin/storage` | `workspace_id` (optional) | `AdminStorage` |

Page shape is `{items, next_cursor, has_more}`. The cursor is an opaque base64url value
bound to the endpoint (`users`/`chats`): passing a users cursor to `/admin/chats` returns
`400 VALIDATION_FAILED` instead of silently paginating a different keyset. Ordering is
stable `created_at DESC, id DESC` and uses keyset comparison, so rows created in the same
microsecond never duplicate or skip. `limit` outside `1..100`, an oversized `query`, an
unknown `type` or a malformed cursor is `400`. Non-admins get `403 FORBIDDEN` before any
data is read.

* `AdminUser`: `id`, `email`, `display_name`, `is_platform_admin`, `status`,
  `workspaces_count`, `chats_count`, `storage_used_bytes`, `created_at`. Search is a
  literal (non-wildcard) substring over email and display name. `DELETED` users and
  deleted workspaces/chats are not listed. `workspaces_count`/`chats_count` are ACTIVE
  memberships; `storage_used_bytes` is the sum of the user's non-deleted attachments whose
  object is still retained (`READY`/`BOUND`).
* `AdminChat`: `id`, `name`, `type`, `security_mode`, `workspace_id`, `workspace_name`,
  `members_count` (ACTIVE chat members), `messages_count`, `created_at`,
  `last_activity_at`. `messages_count` is `chat_counters.next_seq - 1` — the number of
  allocated message sequences (includes messages later deleted). It is O(1) per chat, so a
  page does not scan the partitioned `message.messages` timeline. Search matches the chat
  name only (`DIRECT` chats have no name and therefore do not match a name search).
  `last_activity_at` is `chats.last_message_at` (null until the first message).
* `AdminStorage`: `{totals, workspaces[]}`. `totals` is the sum of the returned rows, so
  `?workspace_id=…` returns that workspace's totals. Each row has `workspace_id`,
  `workspace_name`, `security_mode`, `used_bytes`/`reserved_bytes` from
  `file.workspace_usage`, `storage_limit_bytes` from `file.workspace_limits`, `objects`
  (attachments whose object is still retained: `READY`/`BOUND`) and `attachments` (all
  non-deleted attachment records, including quarantined ones). There is no top-users
  block: per-user storage is already available in `AdminUser.storage_used_bytes`, and the
  dashboard deliberately avoids a second cross-tenant scan.

### Data access and security

`backend/src/main/resources/db/migration/V23__admin_directory_aggregates.sql` adds three
narrow `SECURITY DEFINER`, `STABLE`, read-only functions:
`ops.admin_users_page`, `ops.admin_chats_page`, `ops.admin_storage_workspaces`. They are
the only cross-tenant reads; EXECUTE is granted to `krug_app` only. RLS is not weakened:
admin HTTP calls still activate the tenant context and pass `PlatformAdminGuard` before
the function is invoked. As with `ops.platform_overview()`, the migration role that owns
the functions must be able to see all tenants (superuser/BYPASSRLS in dev/test; the
production DBA provisions the same split). The functions return no content columns by
construction.

Reads are audited with counts only: `admin.users.viewed`, `admin.chats.viewed`,
`admin.storage.viewed` (storage also records the aggregate byte/object counts). The search
string, emails, display names, message text and filenames are never written to audit
metadata. Audit events are appended with a native INSERT (the runtime role has
SELECT/INSERT only); this also fixes a latent Hibernate JSON dirty-check that could emit a
forbidden `UPDATE audit.audit_events` when metadata contained numeric values.

### Manual smoke (dev profile)

```bash
# Admin session (the first dev/JIT user is platform admin; see E8-B).
SESSION=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Админ"}')
TOKEN=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
DEVICE=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["device"]["id"])')
WS=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')

# Users: literal search + first page.
curl -s "http://localhost:8081/api/v1/admin/users?query=example&limit=2" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# -> {"items":[...],"next_cursor":"...","has_more":true}

# Next page (opaque cursor).
CURSOR=$(curl -s "http://localhost:8081/api/v1/admin/users?limit=2" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["next_cursor"])')
curl -s "http://localhost:8081/api/v1/admin/users?limit=2&cursor=$CURSOR" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"

# Chats of one workspace, GROUP only, name search.
curl -s "http://localhost:8081/api/v1/admin/chats?workspace_id=$WS&type=GROUP&query=тест" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"

# Storage dashboard (all workspaces or one).
curl -s "http://localhost:8081/api/v1/admin/storage" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
curl -s "http://localhost:8081/api/v1/admin/storage?workspace_id=$WS" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# -> {"totals":{"used_bytes":0,"reserved_bytes":0,"objects":0,"attachments":0},
#     "workspaces":[{"workspace_id":"...","storage_limit_bytes":1099511627776,...}]}
```

Caveats:

* Only `platform_admin` can read these endpoints; the flag is checked server-side from
  `auth.users`, not from the token/UI.
* `messages_count` counts allocated sequences and includes deleted messages; it is not a
  live-message count. Counting live rows would require fan-out over every monthly message
  partition on each page.
* The storage dashboard has no pagination: one row per non-deleted workspace. If the
  installation grows to thousands of workspaces, add a cursor page and keep totals computed
  in SQL rather than by the application.
* `top users` is intentionally not part of the dashboard; use `GET /admin/users` with
  `storage_used_bytes` instead.
* Contract additions are additive: 3 paths / 3 operations / 7 schemas
  (`AdminUser`, `AdminUserPage`, `AdminChat`, `AdminChatPage`, `AdminStorage`,
  `AdminStorageTotals`, `AdminStorageWorkspace`). The generated
  `frontend/src/api/schema.d.ts` was refreshed with `npm run api:types`.

## E10-B — member directory for DIRECT chats

`GET /workspaces/{workspaceId}/members` (`WorkspaceMemberPage`) is the server-side member
picker for DIRECT chat creation (`docs/SYSTEM-ANALYSIS.md` §17.1/§17.5,
`docs/TASKS-ADMIN-V2.md` E10). The contract addition is additive: 1 path / 1 operation /
2 schemas (`WorkspaceMember`, `WorkspaceMemberPage`). `frontend/src/api/schema.d.ts` was
regenerated with `npm run api:types`.

| Operation | Query | Response |
|---|---|---|
| `GET /workspaces/{workspaceId}/members` | `query`, `cursor`, `limit` (1..100, default 50) | `WorkspaceMemberPage` |

* `WorkspaceMember` has exactly `user_id`, `display_name`, `role` (`OWNER`/`ADMIN`/
  `MEMBER`/`GUEST`) and `joined_at`. Email, credentials, devices and keys are never
  selected; the SQL function projects only those four columns.
* Only `ACTIVE` memberships in an `ACTIVE` workspace and `ACTIVE` users are returned.
  `INVITED`/`REMOVED` memberships, suspended/deleted users and deleted workspaces are
  excluded. The caller is included when active; the DIRECT endpoint still rejects
  `peer_id == caller` with `400 VALIDATION_FAILED`.
* A non-member (including a member of another workspace) gets `403 FORBIDDEN`. An unknown
  workspace id also returns `403` rather than disclosing existence.
* `query` is a case-insensitive literal substring of `display_name` (`position()`, never
  `LIKE`), so `%` and `_` are ordinary characters. Blank means no filter; over 80
  characters is `400`.
* Ordering is stable `display_name ASC, user_id ASC`; `cursor` is opaque base64url,
  workspace-bound and keyset-based (`display_name`, `user_id`), so rows with equal names
  never duplicate or skip. A cursor from another workspace/endpoint is
  `400 VALIDATION_FAILED`. `limit` outside `1..100` is `400`. `has_more` is derived from
  `limit + 1` rows in the same query (no N+1).
* `POST /workspaces/{id}/chats` DIRECT already required an ACTIVE peer membership and
  `peer_id != caller`; E10-B adds an end-to-end test that resolves the peer through this
  directory, creates the DIRECT chat, repeats it (`200`, same chat id), and rejects self,
  removed and foreign peers.

### Data access and security

`backend/src/main/resources/db/migration/V24__workspace_member_directory.sql` adds
`workspace.member_directory(p_workspace_id, p_query, p_limit, p_cursor_display_name,
p_cursor_user_id)`: `STABLE`, `SECURITY DEFINER`, read-only. `auth.users` has FORCE RLS
with a self-only policy, so a member cannot join another member's display name directly.
The function checks `caller.user_id = ops.current_user_id()` and
`caller.status = 'ACTIVE'` for the requested workspace; a caller who bypasses the HTTP
guard still gets zero rows. RLS/policies are unchanged, `EXECUTE` is granted to `krug_app`
only and `PUBLIC` is revoked. The function owner must read `auth.users` (superuser/BYPASSRLS
migration role in dev/test; the production DBA provisions the same split, as for
`ops.platform_overview()` and the V23 admin functions). A partial index
`ix_users_active_display_name_id (display_name, id) WHERE status = 'ACTIVE'` supports the
keyset order.

### Manual smoke (dev profile)

```bash
SESSION=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Дмитрий"}')
TOKEN=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
DEVICE=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["device"]["id"])')
WS=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')

curl -s "http://localhost:8081/api/v1/workspaces/$WS/members?limit=2" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# -> {"items":[{"user_id":"...","display_name":"Дмитрий","role":"OWNER",
#               "joined_at":"..."}],"next_cursor":null,"has_more":false}

curl -s "http://localhost:8081/api/v1/workspaces/$WS/members?query=Дмитр" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"

# DIRECT using the directory's user_id (repeat -> 200 with the same chat).
curl -s -X POST "http://localhost:8081/api/v1/workspaces/$WS/chats" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H "Idempotency-Key: $(uuidgen | tr 'A-Z' 'a-z')" \
  -H 'Content-Type: application/json' \
  -d '{"type":"DIRECT","peer_id":"<user_id from /members>"}'
```

Contract note for the frontend task (E10-B state; after E11-B see the section below):
`frontend/scripts/check-contract.mjs` still pins `41 paths / 47 operations / 81 schemas`;
the additive E10-B endpoint made the real contract `42 / 48 / 83`. The generated
`schema.d.ts` is in sync, but the counter assertions and the required-operation map in that
script must be updated by E10-F (outside the `backend/**` + `schema.d.ts` zone).

## E11-B — admin actions and audit view

`docs/TASKS-ADMIN-V2.md` E11 / `docs/SYSTEM-ANALYSIS.md` §18.5 (R-08,
FR-ADM-15…FR-ADM-18). Four platform-admin operations, additive to the contract:
**4 paths / 4 operations / 2 schemas** (`AdminAuditEvent`, `AdminAuditPage`).

| Method | Path | Response | Notes |
|---|---|---|---|
| `POST` | `/admin/users/{userId}/suspend` | `204` | local `SUSPENDED`; Keycloak disabled; all Keycloak sessions logged out |
| `POST` | `/admin/users/{userId}/activate` | `204` | local `ACTIVE`; Keycloak enabled |
| `DELETE` | `/admin/chats/{chatId}` | `204` | soft-delete: sets `chat.chats.deleted_at` |
| `GET` | `/admin/audit?action=&cursor=&limit=` | `200 AdminAuditPage` | cross-tenant audit log, exact action filter |

All four run behind `PlatformAdminGuard` (server-side `auth.users.is_platform_admin`,
never a token claim); a non-admin gets `403 FORBIDDEN` before any read or write.

### Suspend / activate (FR-ADM-15)

* `V25__admin_actions_and_audit_view.sql` adds `ops.admin_user_detail(uuid)` and
  `ops.admin_set_user_status(uuid, text)`. Both are `SECURITY DEFINER` because `auth.users`
  is FORCE RLS with a self-only policy, so the admin cannot read or update another user's
  row through the runtime connection.
* `ops.admin_set_user_status` takes the same advisory lock as
  `auth.claim_platform_admin()`, re-checks the admin count and returns an outcome instead of
  raising: `NOT_FOUND`, `ALREADY`, `LAST_ADMIN`, `OK`. Reading the outcome avoids parsing
  SQLSTATE and keeps the 404/409 mapping in the application.
* Refusals: suspending yourself → `409 SELF_ACTION_FORBIDDEN`; suspending the last
  platform admin → `409 LAST_PLATFORM_ADMIN` (also enforced by the DB for a direct SQL
  caller); already suspended/active → `409 USER_ALREADY_SUSPENDED` /
  `409 USER_ALREADY_ACTIVE`; unknown or `DELETED` user → `404 NOT_FOUND`; bad path UUID →
  `400 VALIDATION_FAILED`.
* Keycloak: `findByEmail` → `PUT /admin/realms/{realm}/users/{id}` with
  `{"enabled": false|true}` (only `enabled`, so `emailVerified` is untouched) and, on
  suspend, `POST /admin/realms/{realm}/users/{id}/logout`, which invalidates the user's
  Keycloak sessions/refresh tokens. A user without a Keycloak account (dev/test fixtures)
  skips the IdP step; an unreachable IdP is `503 AUTH_UNAVAILABLE` and rolls the local
  transaction back.
* WS: after commit, a user-scoped application event closes every live session with
  `session.revoked` reason `USER_SUSPENDED` and close code `4403` (device E2EE keys are
  **not** revoked — suspension is reversible). In the `keycloak`/`prod` profile the next
  request also fails because JIT provisioning rejects a non-`ACTIVE` local user; the access
  token itself is stateless and expires at its normal TTL.
* Audit: `admin.user.suspended` / `admin.user.activated`, target `user/{id}`, metadata
  `{previous_status, status}` only — no email or display name.

### Chat soft-delete (FR-ADM-16)

* `ops.admin_soft_delete_chat(uuid)` sets `chat.chats.deleted_at` (the column already
  existed since V3) and returns `OK` / `NOT_FOUND` / `ALREADY_DELETED` plus
  `workspace_id` and the active member count for the audit. No row is physically deleted:
  `chat.chat_members`, `message.messages`, files and E2EE envelopes are untouched.
* Every existing read path already filters `deleted_at IS NULL`: participant chat lists,
  message reads/sends, `findActiveMemberIds` and `ops.admin_chats_page`. The chat therefore
  disappears for participants and from the admin directory without any additional RLS
  change.
* A repeated `DELETE` returns the documented `409 CHAT_ALREADY_DELETED` (chosen over a
  silent `204` so the UI can distinguish a retry from a successful action); an unknown id
  is `404`.
* Audit: `admin.chat.deleted`, target `chat/{id}`, metadata
  `{workspace_id, members}` — no chat name, message text or file metadata.

### Audit view (FR-ADM-17)

* `ops.admin_audit_page(action, limit, cursor_created_at, cursor_id)` is `STABLE`,
  `SECURITY DEFINER` and returns only the contract columns:
  `id, action, actor_id, actor_email, target_type, target_id, created_at`. The `metadata`
  JSONB, `prev_hash`/`hash`, `request_id` and `scope_key` never leave the database, so a
  future richer audit event cannot leak content through this endpoint. `actor_email` is the
  single PII field and is explicitly allowed by the admin contract.
* Ordering is keyset `(created_at DESC, id DESC)` with the same opaque
  `AdminPageCursor` used by the other admin lists (scope `audit`; a users/chats cursor on
  `/admin/audit` is `400`). `limit` is 1..100 (default 30); `action` is an exact-match
  filter (max 120 chars, blank = no filter, over-long = `400`).
* Each read appends `admin.audit.viewed` with counts only (`returned`, `has_more`) in the
  admin's own hash-chain scope; the table stays append-only (`krug_app` has no
  `UPDATE`/`DELETE` grant) and the chain itself is never rewritten.
* Platform-admin actions are appended with `workspace_id = null` (scope
  `user:<admin>`), because suspending a user or deleting a chat is an installation-level
  action, not tenant data. The target workspace is carried as metadata (`workspace_id`) for
  chat deletion.

### Errors

| Status | Codes |
|---|---|
| `400` | `VALIDATION_FAILED` (bad UUID/limit/cursor/action) |
| `403` | `FORBIDDEN` (non-admin) |
| `404` | `NOT_FOUND` (unknown user/chat) |
| `409` | `SELF_ACTION_FORBIDDEN`, `LAST_PLATFORM_ADMIN`, `USER_ALREADY_SUSPENDED`, `USER_ALREADY_ACTIVE`, `CHAT_ALREADY_DELETED` |
| `503` | `AUTH_UNAVAILABLE` (Keycloak unreachable) |

### Tests

`AdminActionsIT` (7 integration tests) covers: the full suspend → Keycloak disabled →
`/logout` called → refresh token rejected → login rejected → activate → login again flow;
self-suspend and the atomic `LAST_ADMIN` DB backstop; cross-tenant chat soft-delete hidden
from participant/admin lists while messages remain; audit filter/pagination/ordering and
the absence of metadata/content; non-admin `403` before any state change; `404`s and
local-only users; `SECURITY DEFINER`/no-`PUBLIC`-execute/append-only invariants.
`AdminPageCursorTest` adds the audit cursor scope; `ChangeUserStatusServiceTest` (5 unit
tests) covers the suspend/activate decision table and the 503 rollback path. The full suite
result is in `backend/E11-B-REPORT.md`.

### Manual smoke (dev profile)

The first `dev/session` user is the platform admin. Dev users have no Keycloak account, so
the IdP step is a no-op locally; the local state and audit are the observable parts.

```bash
SESSION=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Admin"}')
TOKEN=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
DEVICE=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["device"]["id"])')

# suspend / activate a target user id
curl -i -X POST "http://localhost:8081/api/v1/admin/users/<user_id>/suspend" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"        # 204
curl -i -X POST "http://localhost:8081/api/v1/admin/users/<user_id>/activate" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"        # 204

# soft-delete a chat, then inspect the audit log
curl -i -X DELETE "http://localhost:8081/api/v1/admin/chats/<chat_id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"        # 204
curl -s "http://localhost:8081/api/v1/admin/audit?action=admin.chat.deleted&limit=10" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
```

Contract note for the frontend task: `frontend/scripts/check-contract.mjs` still pins
`42 paths / 48 operations / 83 schemas`; the additive E11-B endpoints make the real
contract `46 / 52 / 85`. `frontend/src/api/schema.d.ts` is regenerated and in sync, but the
counter/operation assertions in that script must be updated by E11-F (outside the
`backend/**` + `schema.d.ts` zone).

## E12-B — workspace member management (add / role / remove)

`docs/TASKS-ADMIN-V2.md` E12 / `docs/SYSTEM-ANALYSIS.md` §18.6 (R-09, FR-WS-4…FR-WS-7).
Three additive operations reuse the existing `WorkspaceMember` schema; the contract grows
by **1 path / 3 operations / 2 schemas** (`AddWorkspaceMemberRequest`,
`ChangeWorkspaceMemberRoleRequest`): 46/52/85 → **47/55/87**.

| Method | Path | Response | Notes |
|---|---|---|---|
| `POST` | `/workspaces/{workspaceId}/members` | `201 WorkspaceMember` | `{email, role}`; only an existing ACTIVE account |
| `PATCH` | `/workspaces/{workspaceId}/members/{userId}` | `200 WorkspaceMember` | `{role}`; no-op is idempotent |
| `DELETE` | `/workspaces/{workspaceId}/members/{userId}` | `204` | soft: `status = 'REMOVED'` |

### Rules

| Actor | Add | Change role | Remove |
|---|---|---|---|
| `OWNER` | `ADMIN`/`MEMBER`/`GUEST` | any of `ADMIN`/`MEMBER`/`GUEST` except self | `ADMIN`/`MEMBER`/`GUEST` except self |
| `ADMIN` | `MEMBER`/`GUEST` | `MEMBER`/`GUEST` → `MEMBER`/`GUEST`; not self, not `OWNER`/another `ADMIN` | `MEMBER`/`GUEST`; not self, not `OWNER`/another `ADMIN` |
| `MEMBER`/`GUEST`/outsider | `403 FORBIDDEN` | `403 FORBIDDEN` | `403 FORBIDDEN` |

* `OWNER` is never assignable (the workspace has exactly one owner); the last owner cannot
  be demoted or removed, and nobody can change/remove themselves (`409 LAST_OWNER` /
  `SELF_ACTION_FORBIDDEN`).
* Only an existing ACTIVE user can be added: unknown/inactive email → `404 USER_NOT_FOUND`.
  Invitations to unregistered emails and SCIM are v1.1 (out of scope).
* Duplicate (including a previously removed membership row) → `409 MEMBER_ALREADY_EXISTS`.
* `max_workspace_members` is read from `ops.system_settings` in the same transaction and
  checked under a per-workspace advisory lock; exceeding it → `409
  WORKSPACE_MEMBER_LIMIT_REACHED` with `details.scope/limit/used`.
* Audit: `workspace.member.added`, `workspace.member.role_changed`,
  `workspace.member.removed` in the workspace hash-chain scope. Metadata carries user ids
  and roles (`role`, `previous_role`); email and display name are never written.
* Removal is soft, so `joined_at` and the row survive. Access is re-evaluated on every
  request (`ACTIVE` membership), therefore the removed user loses the workspace and its
  chats on the next call. Existing access tokens are not revoked (stateless JWT); `/me`
  keeps working but no longer lists the workspace.

### Data access and security

`backend/src/main/resources/db/migration/V27__workspace_member_management.sql` adds three
`SECURITY DEFINER` functions (`workspace.add_member`, `workspace.change_member_role`,
`workspace.remove_member`). `auth.users` is FORCE RLS with a self-only policy, so the email
lookup (and the display-name projection) must run as the function owner; the application
never reads another user's row. Every function re-checks `p_actor_id =
ops.current_user_id()` and an ACTIVE OWNER/ADMIN membership, so a direct SQL call that
bypasses the HTTP guard still gets `FORBIDDEN`. Each call takes the same
`workspace.members|<workspace-id>` transaction advisory lock before the duplicate/limit
checks, which also makes two concurrent adds for the last slot deterministic (one `201`,
one `409`). `EXECUTE` is granted to `krug_app` only and `PUBLIC` is revoked; the migration
does not weaken any RLS policy or grant.

### Errors

| Status | Codes |
|---|---|
| `400` | `VALIDATION_FAILED` (bad email/role/path UUID) |
| `403` | `FORBIDDEN` (not an OWNER/ADMIN), `ROLE_CHANGE_FORBIDDEN` (ADMIN/OWNER/self rule) |
| `404` | `USER_NOT_FOUND` (add), `MEMBER_NOT_FOUND` (patch/delete) |
| `409` | `MEMBER_ALREADY_EXISTS`, `WORKSPACE_MEMBER_LIMIT_REACHED`, `SELF_ACTION_FORBIDDEN`, `LAST_OWNER` |

### Tests

`WorkspaceMemberManagementIT` (6 integration tests) covers add/role/remove, contract
validation of `WorkspaceMember`, no-email audit/response assertions, unknown/duplicate
emails, a concurrent last-slot add (exactly one winner), owner/admin/self/last-owner
protection matrix, non-admin and outsider `403`, soft removal with access loss on the next
request and a still-valid token, re-add-after-removal `409`, direct SQL bypass rejection,
RLS isolation and the no-`PUBLIC`-execute invariant. The full suite result is in
`backend/E12-B-REPORT.md`.

### Manual smoke (dev profile)

```bash
SESSION=$(curl -s -X POST http://localhost:8081/api/v1/dev/session \
  -H 'Content-Type: application/json' -d '{"display_name":"Owner"}')
TOKEN=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
DEVICE=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["device"]["id"])')
WS=$(echo "$SESSION" | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')

# Add an existing user (get their email from auth.users in a dev DB; API never returns it).
curl -s -X POST "http://localhost:8081/api/v1/workspaces/$WS/members" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H 'Content-Type: application/json' \
  -d '{"email":"dev+...@krug.local","role":"MEMBER"}'
# -> 201 {"user_id":"...","display_name":"...","role":"MEMBER","joined_at":"..."}

curl -s -X PATCH "http://localhost:8081/api/v1/workspaces/$WS/members/<user_id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE" \
  -H 'Content-Type: application/json' -d '{"role":"ADMIN"}'

curl -i -X DELETE "http://localhost:8081/api/v1/workspaces/$WS/members/<user_id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $DEVICE"
# -> 204 (soft removal; the member is 403 on the next workspace request)
```

## Contract deviations / open questions


The contract file is unchanged. Deliberate interpretations:

1. `POST /chats/{id}/messages` returns **201** for a `client_message_id` replay; the
   contract defines only 201. `Idempotent-Replay: true` is set.
2. Invalid `reply_to_id` → `422 VALIDATION_FAILED` (details `field=reply_to_id`).
3. `POST /chats/{id}/read` requires `Idempotency-Key` but does not store replay rows; the
   operation is naturally idempotent.
4. `X-Device-Id` missing/mismatched → `401`, not 403 (token binding failure). It is
   enforced only on endpoints that declare the header.
5. `POST /devices` and `POST /workspaces` return `Idempotent-Replay: true` on a replay;
   the contract does not define this header for them (additive, harmless).
6. `GET /me` chooses the first ACTIVE membership by `joined_at` as
   `default_workspace_id`; an empty list is valid.
7. `POST /workspaces` creates the default group chat «Общий чат» for both MANAGED and
   E2EE security modes; E2EE key distribution is out of scope.
8. `audit.audit_events` is append-only with a hash chain but is not yet monthly
   partitioned; partitions/anchors/export are E8 scope.
9. `dev/session` is registered for `dev`/`test` only; absent in `keycloak`/`prod`.
10. Managed body encryption uses a local key instead of KMS; rate limiting is in-memory.
11. WS ephemeral frames use `type:"event"` + `event:"typing"|"presence"` (WS protocol §2/§3);
    `workspace_id` is an additive field on `event` frames. A device that is not owned by the
    caller is `403 WS_DEVICE_MISMATCH`; an unknown/expired/used ticket is `401` before
    upgrade. For a replay gap the server sends `resume.gap` and then the last 500 messages,
    so a client that catches up via REST never loses the tail.
12. B-02 did not change the OpenAPI/WS contract. A concurrent duplicate still gets the
    contract's `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1` (now from the advisory
    try-lock); a retry after the winner commits returns the original resource with
    `Idempotent-Replay: true`. A stale pre-B-02 reservation is recovered transparently.
13. E4-B: preflight returns 200 with per-file `decision`/`error` (`FILE_TOO_LARGE`,
    `QUOTA_EXCEEDED`, ...) rather than failing the whole request; init enforces the same
    limits with the contract statuses 413/415/422/409. `Idempotency-Key` is required on
    preflight/complete/abort; preflight is read-only (no replay row), complete/abort are
    state-idempotent and never move quota twice.
14. E4-B: managed complete returns **202** `SCANNING`; a replay after the AV scan returns
    **200** `READY` (the contract documents 200 for ready, 202 for scanning).
15. E4-B: `GET /attachments/{id}/download-url` returns **409 ATTACHMENT_NOT_READY** while
    the scan is pending and **423 ATTACHMENT_QUARANTINED** for INFECTED/FAILED. The contract
    defines 423 explicitly; 409 follows the §12.2 `SCAN_PENDING`/quarantine split.
16. E4-B: upload/attachment endpoints have no workspace in the path. Dev tokens carry
    `workspace_id`; Keycloak tokens do not, so a narrow transaction-local `file-resolve`
    worker role reads the resource id once, verifies the caller (uploader; or owner/active
    workspace member for a bound attachment), and immediately switches to normal tenant RLS
    before any metadata is returned. The worker role is read-only in the application and
    the chat-membership check still runs afterwards.
17. E5-B: `Message.sticker` is **omitted** when the message is not a sticker. The contract
    declares the field optional and models it as `type: [object, "null"]` + `allOf:
    StickerRef`; JSON Schema 2020-12 applies `allOf` even to an explicit null, so emitting
    `"sticker": null` fails schema validation. Omitting an optional field is
    contract-compatible; `sticker_id` is still emitted as explicit null for text messages.
18. E5-B: `GET /sticker-packs` hides a foreign/unknown chat as **404 NOT_FOUND** (the
    acceptance allows 403/404, and 404 does not disclose chat existence). Missing
    `chat_id`/malformed UUID is 400 `VALIDATION_FAILED`.
19. E5-B: favorites are server-side and per user. PUT/DELETE are idempotent 204; an
    unknown, inactive (DISABLED/REMOVED) sticker or a non-ACTIVE pack is 404
    `STICKER_NOT_FOUND`. Already-sent sticker messages keep rendering after a pack is
    disabled; only new sends get 409 `STICKER_PACK_DISABLED`.
20. E5-B: built-in packs/stickers are global (`builtin=true`, no `workspace_id`, no RLS,
    read-only for `krug_app`) and seeded by V14. `sticker_favorites` is per user with
    forced RLS. The backend stores asset metadata/paths; the demo PNG files are served by
    the web client (`frontend/public/stickers/**`), and `KRUG_STICKERS_ASSET_BASE_URL` can
    prepend a CDN origin.

## Known risks

* Keycloak dev uses H2 (`start-dev`), `admin/admin`, `sslRequired=none` and a test user.
  Production must use TLS, a real admin and a managed realm database.
* Direct access grants are enabled in the dev realm only to make curl/CI smoke checks
  possible. The SPA uses authorization code + PKCE.
* `KeycloakDeviceBinding` runs JIT provisioning on every authenticated request (one
  indexed lookup after the first). A request-scoped cache is a later optimisation.
* `V1` creates `krug_app` with a dev password. Production must pre-create roles/passwords;
  `ProdGuard` rejects dev DB passwords for a remote database and requires DB env vars in
  `prod`, but it cannot rotate an already-created role.
* The outbox relay is the only cross-tenant reader; `ops.outbox` is protected by forced RLS
  and an explicit `outbox-relay` worker role, and carries metadata only.
* Retention jobs exist for idempotency/outbox/tickets. Audit partition/anchors/export are
  E8 scope.
* Realtime is **single-node**: the hub is in-process, so WS connections on another node do
  not see live events. Redis/Kafka pub/sub is the next slice (E3-D-01). There is no durable
  replay beyond 500 messages (client uses REST), no E2EE WS payload, no push, and no typing
  privacy settings.
* `realtime.realtime_tickets` is GC'd after 1 day, but ticket issuance relies on edge rate
  limiting (no dedicated 429 limiter in E3).
* No Kafka consumer, E2EE, search, or edit/delete — intentionally out of scope.
* Redis rate limiting and KMS envelope encryption are B-03, not B-02; the in-memory limiter
  and local AES key remain development-grade.
* Testcontainers requires Docker; `mvn test` starts PostgreSQL 16 via Testcontainers.
* E4-B known debt: no E2EE files/keys; no presigned upload (parts go through the API);
  no DLP/retention UI/public links/CDN; AV dev adapter is Noop (ClamAV is optional and
  production must switch `S3_SCAN_MODE=clamav`); 10 GiB desktop upload is v1; MinIO is a
  single-node compose service with no HA/replication; GC/reconcile are in-process
  single-node jobs and the 80/95/100% thresholds are logged, not yet emitted as
  `EVT-15` outbox events with billing-period dedup.
* E5-B known debt: built-in packs only (custom packs/upload/moderation/quotas are v1); no
  AV/DLP pipeline for stickers, no E2EE `K_pack`/epoch keys, no marketplace, no APNG
  animation checks; demo art is generated PNG placeholders, not final design; there is no
  admin API to add/disable packs (fixtures are SQL/seed only) and no `sticker.pack.changed`
  outbox/WS event yet. The startup catalog loader relies on the V14 SECURITY DEFINER
  function; if a deployment strips it, the catalog must be repaired by a migration.
* Auth BFF known debt: the registration→verification refresh token lives in a single-node
  in-memory bridge (15 min); a restart/multi-node deployment requires the user to sign in
  after verification (the account is still verified). Keycloak admin access uses the
  `svc-krug-bff` client-credentials service account (#103); the password fallback is dev-only.
  The rate limiter is in-memory (Redis is the multi-node replacement). The verification
  email has no branding/i18n beyond plain text. Refresh reuse detection, WebAuthn and
  stronger MFA remain out of scope; #103 implements HttpOnly refresh cookies + CSRF
  (`SameSite=Lax` + Origin/Referer). The access token still lives in sessionStorage with a
  short TTL — moving it to memory-only is the remaining frontend follow-up.
  two constants (the regenerated `src/api/schema.d.ts` is already committed).

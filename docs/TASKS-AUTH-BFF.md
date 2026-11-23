# Auth BFF: own forms + email TOTP

**Status:** DONE (backend 391 tests, frontend 625 tests; live Keycloak+Mailpit smoke passed).

> **Цель:** браузер больше не общается с Keycloak. Пользователь видит собственные формы входа/регистрации; backend проксирует Keycloak Admin API и token endpoint. Регистрация подтверждается 6-значным TOTP из письма.

## 0. Границы

- Браузер → только `backend /api/v1/auth/*`; Keycloak снаружи не публикуется (только `127.0.0.1:8180` для ops).
- Keycloak остаётся IdP и хранит пароли/пользователей; backend — BFF.
- Пароли не логируются и не хранятся в БД приложения.
- Email — SMTP; dev: Mailpit (`http://localhost:8025`), prod: внешний SMTP.
- E2EE flag остаётся false; auth-изменения не включают E2EE.

## 1. API (contracts/openapi.yaml)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/auth/register` | `{email, display_name, password}` | `202 {verification_id, expires_in, resend_after}` |
| POST | `/auth/verify-email` | `{verification_id, code}` | `200 AuthSession` |
| POST | `/auth/resend-email-code` | `{verification_id}` | `202 {expires_in, resend_after}` |
| POST | `/auth/login` | `{email, password}` | `200 AuthSession` |
| POST | `/auth/refresh` | — (HttpOnly cookie #103) | `200 AuthSession` + rotated cookie |
| POST | `/auth/logout` | — (HttpOnly cookie #103) | `204` + cleared cookie |

`AuthSession`: `{access_token, expires_in, token_type, user:{id,display_name,email}}`.
#103: the refresh token is **not** in the JSON body; it is an `HttpOnly;
SameSite=Lax; Path=/api/v1/auth` cookie (`sova_refresh`, `Secure` in prod).

Коды: `INVALID_CREDENTIALS` 401, `EMAIL_NOT_VERIFIED` 403 (+ `verification_id`), `CODE_INVALID` 422, `CODE_EXPIRED` 410, `EMAIL_TAKEN` 409, `RATE_LIMITED` 429, `REGISTRATION_CLOSED` 403.

## 2. Backend

- DDD auth: `AuthBffController`, use cases Register/Verify/Login/Refresh/Logout; ports `KeycloakAdminPort`, `TokenExchangePort`, `MailPort`, `EmailCodePort`.
- Keycloak Admin API: create user (`username=email`, `email`, `firstName=display_name`, `enabled=false`, `emailVerified=false`), set password; enable + emailVerified after TOTP; delete/resend on failure.
- Login: Keycloak token endpoint `grant_type=password`, client `krug-web`; map errors.
- Register: generic response; duplicate email → 409 `EMAIL_TAKEN` (documented).
- Email TOTP: 20-byte secret, RFC 6238 SHA-1 6 digits/30s, window ±5 (5 min), expiry 10 min, max 5 attempts, resend 60s; secret encrypted at rest; code never logged.
- Table `auth.email_verifications`; no password; cleanup job.
- Rate limits: register/resend/login per email/IP.
- SMTP `spring-boot-starter-mail`; Mailpit in compose.
- Tests: WireMock Keycloak admin/token, MockMailSender, TOTP clock, duplicate/expired/wrong code, rate limit, no password logs; full suite.

## 3. Frontend

- Remove `RealOidcProvider` path from app; `AuthMode = dev | password` (mock only in tests).
- Login form: email/password; register form: display name/email/password/confirm; verify form: 6 digits, resend timer.
- Store only the access token via existing auth storage; refresh on 401 calls `/auth/refresh`
  with `credentials: 'include'` (cookie), logout calls the backend and never sends a token.
- No redirect/callback/Keycloak URLs; update E2E/auth tests; a11y.
- `VITE_AUTH_MODE=password`; OIDC env removed from deploy.

## 4. Compose

- Keycloak internal only; nginx no `/realms`, `/admin`, `/resources`.
- `mailpit` on `8025`/`1025`; backend `SPRING_MAIL_HOST=mailpit`.
- Keycloak `KC_HOSTNAME=http://keycloak:8080`; backend issuer/JWKS internal.
- Keycloak admin credentials env for BFF; production use a service account (follow-up).

## 5. Acceptance

1. Register → email in Mailpit with 6-digit code.
2. Wrong code → 422; expired → 410; 5 attempts → 429.
3. Correct code → user enabled, tokens returned, `/me` 200.
4. Login with wrong password → 401; unverified → 403.
5. Refresh rotates access token; logout revokes.
6. Browser network has no requests to `:8180`/`/realms`.
7. No passwords/codes in logs.

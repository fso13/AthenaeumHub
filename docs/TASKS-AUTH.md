# Auth slice — B-04 / F-04 (Keycloak OIDC)

> **Цель:** заменить dev-only вход на реальный OIDC-вход через Keycloak: регистрация, логин, логаут, провижининг пользователя, устройство и первый воркспейс.  
> **Контракт:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>) — добавлены `/me`, `/devices`, `/workspaces`.  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §7, §10, §11.5, ADR-17; [`docs/TASKS.md`](<TASKS.md>) SL-01.

## 0. Правила параллельной работы

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**`, `infra/**` | Backend-сессия B-04 | всё внутри | `frontend/**`, `docs/**`, `contracts/**` |
| `frontend/**` | Frontend-сессия F-04 | всё внутри | `backend/**`, `infra/**`, `docs/**`, `contracts/**` |
| `contracts/openapi.yaml` | PM | только через эту задачу | — |

- Контракт уже расширен; если чего-то не хватает — `[BLOCKED]`, не выдумывать.
- `dev`-профиль и `POST /dev/session` **сохраняются** как fallback для локальной разработки. Новый профиль — `keycloak` (и `prod` использует его).
- CORS не включаем: frontend ходит через Vite proxy; Keycloak — через redirect/token endpoint.
- Пароли/регистрацию/сброс — только Keycloak; backend не хранит пароли.

## 1. B-04 — Backend: Keycloak OIDC + провижининг

**Владелец:** backend-сессия  
**Директория:** `backend/**`, `infra/**`  
**Приоритет:** P0  
**Оценка:** 2–3 сессии  
**Статус:** **DONE** — Keycloak 26.2, 122 backend-теста, ArchUnit 8/8, live 8081

### Scope

1. **Keycloak в compose**
   - `infra/keycloak/realm-export.json`: realm `krug`, client `krug-web` (public, standard flow, PKCE S256), redirect `http://localhost:5173/*`, web origins `http://localhost:5173`, registration enabled, dev test user.
   - `backend/docker-compose.yml` (или `infra/docker-compose.yml`): Keycloak 26 на `8180`, PostgreSQL Keycloak или dev H2; healthcheck.
   - README: как поднять, URL admin, тестовый пользователь.

2. **Профиль `keycloak`**
   - `spring.security.oauth2.resourceserver.jwt.issuer-uri=http://localhost:8180/realms/krug`; JWKS.
   - Валидация `iss`, `aud` (`krug-api`), `azp` (`krug-web`); часы/clock skew.
   - `dev`-профиль не меняется; `keycloak`/`prod` не содержат `POST /dev/session` (404).
   - JWT не логируется; ошибки 401 — контрактный envelope.

3. **JIT-провижининг**
   - `auth.user_identities` (`provider=keycloak`, `subject=sub`) → локальный `users`.
   - При первом запросе: создать пользователя (email, display_name), запись identity, аудит `user.provisioned`.
   - Если email пуст — использовать `preferred_username`.
   - Не создавать воркспейс автоматически: `GET /me` вернёт пустой список, frontend проведёт onboarding.

4. **API**
   - `GET /me` → `{user, workspaces[], default_workspace_id}`; только active membership.
   - `POST /devices` → зарегистрировать устройство (`name`, `platform=WEB`, `app_version`), max 5, idempotent; вернуть `{id, platform, created_at}`.
   - `POST /workspaces` → создать воркспейс (`name`, `security_mode`), пользователь `OWNER`, создать дефолтный групповой чат «Общий чат»; аудит; idempotent.
   - `GET /workspaces/{id}/chats` — использовать principal из Keycloak, не dev-claim.
   - `X-Device-Id` для защищённых API: в `keycloak`-профиле проверить, что устройство принадлежит пользователю и `ACTIVE`; в `dev` — текущая проверка claim `device_id`.
   - `DeviceBindingFilter` вынести в профильную стратегию (`DevDeviceBinding` / `KeycloakDeviceBinding`), не ломать dev.

5. **Тесты**
   - Unit: JWT decoder/validator, JIT provisioning, device limit, workspace onboarding.
   - Integration: `spring-security-test` `jwt()` для `/me`, `/devices`, `/workspaces`; 401/403/404; RLS.
   - Contract: ответы по `contracts/openapi.yaml`.
   - Keycloak E2E — если контейнер поднимается; иначе WireMock JWKS + подписанные тестовые токены.
   - Проверить: `keycloak`-профиль не отдаёт `/dev/session`; `dev`-профиль продолжает работать.

### Вне scope

Инвайты, роли UI, 2FA/WebAuthn, сброс пароля в приложении, SCIM, BFF/HttpOnly refresh, E2EE-ключи, аудит-UI. Пароли и регистрация — только Keycloak.

### B-04: результат

- Keycloak 26.2 (`prompt=create` работает), realm `krug`, client `krug-web`, test user.
- Профиль `keycloak`: OIDC resource server, `iss/aud/azp`, JIT-провижининг.
- `GET /me` 200, `POST /devices` 201, `POST /workspaces` 201, `GET /workspaces/{id}/chats` 200.
- `POST /dev/session` в keycloak-профиле → 404; no-auth `/me` → 401 контрактный envelope.
- 122 backend-теста (unit + Testcontainers + contract + negative), ArchUnit 8/8.
- Регистрация: Keycloak 26.2 отдаёт форму First/Last/Email по `prompt=create`; полный E2E регистрации не автоматизирован (только страница + логин).

## 2. F-04 — Frontend: OIDC login/register/logout

**Владелец:** frontend-сессия  
**Директория:** `frontend/**`  
**Приоритет:** P0  
**Оценка:** 2 сессии  
**Статус:** **DONE** — mock/auth e2e + real Keycloak smoke 1/1 (после Keycloak 26.2)

### Scope

1. **OIDC PKCE**
   - `oidc-client-ts` (или эквивалент) + `react-oidc-context`; Keycloak realm `krug`, client `krug-web`.
   - `VITE_AUTH_MODE=dev|keycloak`; dev — текущий `/dev/session`; keycloak — OIDC.
   - Redirect URI `http://localhost:5173/auth/callback`; silent renew или re-login при истечении.
   - Logout через Keycloak end-session; очистка токенов/состояния.
   - Токен не в `localStorage`; используй `sessionStorage`/in-memory и зафиксируй ограничение в README. Не логировать токены.

2. **Экраны**
   - `/login`: «Войти» и «Регистрация» (Keycloak registration URL), объяснение режима.
   - `/auth/callback`: обработка кода, загрузка `/me`.
   - Auth guard: без сессии → `/login`; с сессией → приложение.
   - Onboarding: если `workspaces=[]` — форма создания воркспейса (`POST /workspaces`), затем чат.
   - Если нет устройства — `POST /devices`, сохранить `device_id` (не секрет) и передавать `X-Device-Id`.
   - Logout в шапке/меню; ошибки 401/403 — понятные экраны.

3. **Интеграция**
   - После OIDC: `/me` → выбрать default workspace → `GET /workspaces/{id}/chats`.
   - Все API-вызовы — с access token; 401 → refresh/re-login, не бесконечный retry.
   - Dev-режим сохранить: `VITE_AUTH_MODE=dev` + `VITE_DEV_SESSION=true` работает как раньше.
   - CORS: Vite proxy `/api` → 8081; Keycloak redirect напрямую.

4. **Тесты**
   - Unit/RTL: auth guard, login screen, callback, no-workspace onboarding, 401/403, logout.
   - MSW `/me`, `/devices`, `/workspaces`; mock OIDC adapter.
   - Playwright: mock auth flow; real Keycloak smoke — если realm поднят и есть тестовый пользователь.
   - `npm run check` зелёный; axe без блокеров.

### Вне scope

Кастомные формы пароля/регистрации (Keycloak hosted), 2FA UI, инвайты, управление ролями, BFF.

### F-04: результат real smoke

- Keycloak 26.2, realm `krug`, test user `test@krug.local` / `Test1234!` (login is email).
- `npm run test:e2e:keycloak` → **1 passed** (hosted login → `/auth/callback` → `/me` → чат).
- `prompt=create` проверен: Keycloak 26.2 отдаёт форму First/Last/Email; на 26.0 был обычный login.
- Регистрация проходит через hosted Keycloak; backend паролей не хранит.

## 3. Acceptance (AUTH-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| AUTH-AC-01 | Открыть приложение без сессии | `/login`; кнопки «Войти»/«Регистрация» ведут в Keycloak |
| AUTH-AC-02 | Регистрация нового пользователя | Keycloak создаёт пользователя; возврат в приложение; `GET /me` 200 |
| AUTH-AC-03 | Первый вход без воркспейса | Onboarding; `POST /workspaces` 201; появляется чат |
| AUTH-AC-04 | Устройство | `POST /devices` 201; защищённые API с `X-Device-Id` 200 |
| AUTH-AC-05 | Logout | Keycloak end-session; токены очищены; API 401 |
| AUTH-AC-06 | Истёкший access | refresh/re-login; нет цикла 401 |
| AUTH-AC-07 | Dev fallback | `VITE_AUTH_MODE=dev` работает как F-01 |
| AUTH-AC-08 | Keycloak-профиль | `POST /dev/session` → 404; ошибки в контрактном envelope |

## 4. Решения

| ID | Решение | Причина |
|---|---|---|
| AUTH-D-01 | Keycloak hosted login/registration | Не хранить пароли в приложении; ADR-17 |
| AUTH-D-02 | `keycloak` профиль рядом с `dev` | Не ломать текущий вертикальный срез |
| AUTH-D-03 | JIT provisioning по `sub` | Нет отдельного user-service; первый вход создаёт пользователя |
| AUTH-D-04 | Воркспейс создаёт пользователь при онбординге | Нет приглашений в этом срезе; пустой `/me` — валидное состояние |
| AUTH-D-05 | Device binding: claim в dev, БД-проверка в keycloak | Keycloak-токен не содержит `device_id` |
| AUTH-D-06 | Токены в sessionStorage (MVP) | OIDC SPA без BFF; зафиксировать как долг, не localStorage |

## 5. Известный долг

- Нет invite/membership flow — только личный воркспейс.
- Нет 2FA/WebAuthn/step-up.
- Нет BFF/HttpOnly refresh; sessionStorage — компромисс.
- Keycloak hosted pages не брендированы под «Сова».
- CORS/reverse proxy для production — отдельная задача.
- `audit.audit_events` в B-04 не партиционирован и без anchors — E8/B-02.
- JIT-провижининг выполняется на каждом аутентифицированном запросе (после первого — indexed lookup); request-scoped cache — оптимизация.
- Keycloak dev realm на H2; при смене тега 26.0→26.2 volume пересоздаётся, старые тестовые пользователи/воркспейсы могут разъехаться.
- Два JIT-identity для `testuser` после пересоздания realm — это ожидаемо (email collision не линкует аккаунты).

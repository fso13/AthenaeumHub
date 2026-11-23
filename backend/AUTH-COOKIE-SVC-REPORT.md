# #103 — HttpOnly refresh cookie + Keycloak client-credentials service account

**Статус: DONE.** Backend, контракт, минимальный frontend, deploy/prod-конфигурация,
runbook и тесты обновлены. Полный backend suite и полный frontend suite зелёные.

## 1. Что было и что стало

До #103 BFF возвращал `access_token` и `refresh_token` в JSON, SPA хранил оба токена
в `sessionStorage`. Runtime Keycloak Admin API ходил password-grant'ом технического
пользователя (`KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`, потенциально master/admin-cli).

После #103:

- refresh-токен живёт **только** в `HttpOnly` cookie `sova_refresh`;
- JSON-ответы `/auth/*` больше не содержат refresh-токен;
- refresh/logout не принимают токен в теле — только cookie;
- mutating auth-запросы защищены `SameSite=Lax` + проверкой `Origin`/`Referer`,
  CORS включает credentials;
- Keycloak Admin API использует `grant_type=client_credentials` confidential-клиента
  `svc-krug-bff` в realm `krug` с ролями `manage-users` / `view-users` /
  `query-users`; токен кэшируется и перевыпускается после `401`;
- в `prod` `ProdGuard` требует service account, `Secure` cookie и непустой
  CORS/CSRF allowlist; dev password-grant fallback сохранён и задокументирован.

## 2. Backend

### 2.1. Cookie transport

`backend/src/main/java/ru/krug/backend/auth/api/RefreshCookieFactory.java`

- `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`, `Max-Age` из
  `krug.auth-bff.refresh-cookie.max-age` (30m по умолчанию), `Secure` из конфигурации
  (`false` в dev, `true` в prod), без `Domain` (host-only).
- Значение cookie проверяется по безопасному ASCII-шаблону; `CR/LF`, `;`, пробелы
  отклоняются, поэтому скомпрометированный IdP не может внедрить второй `Set-Cookie`.
- Отдельный `clear()` отдаёт `sova_refresh=; Max-Age=0` с теми же атрибутами.

`AuthBffController`:

| Endpoint | Cookie |
|---|---|
| `POST /auth/login` (200) | ставит новую cookie |
| `POST /auth/verify-email` (200) | ставит новую cookie |
| `POST /auth/2fa/verify` | ставит новую cookie |
| `POST /auth/2fa/enroll/verify` | ставит новую cookie |
| `POST /auth/refresh` | читает только cookie, ротирует и ставит новую |
| `POST /auth/logout` | отзывает токен из cookie и всегда очищает cookie |

`AuthSessionResponse` и `AuthBffApiMapper` больше не содержат `refreshToken`.
Access token остаётся в теле и в памяти SPA.

Ошибки refresh (401/403/503) возвращаются обычным контрактным `Error`; токен и cookie
никогда не попадают в тело ошибки.

### 2.2. Конфигурация

`krug.auth-bff.refresh-cookie` (`AuthBffProperties.RefreshCookie`):

| Свойство | Env | Default |
|---|---|---|
| `name` | `KRUG_AUTH_BFF_REFRESH_COOKIE_NAME` | `sova_refresh` |
| `path` | `KRUG_AUTH_BFF_REFRESH_COOKIE_PATH` | `/api/v1/auth` |
| `secure` | `KRUG_AUTH_BFF_COOKIE_SECURE` | `false`; в `prod` — `true` |
| `same-site` | `KRUG_AUTH_BFF_COOKIE_SAME_SITE` | `Lax` |
| `max-age` | `KRUG_AUTH_BFF_REFRESH_COOKIE_MAX_AGE` | `30m` |

`SameSite=None` без `Secure` отклоняется на старте. `application-prod.yml` задаёт
`secure=true`; `ProdGuard` дополнительно падает, если в prod выставлено `false`.

Миграция БД не требуется: BFF не хранит refresh-токены, авторитетом остаётся
Keycloak; cookie содержит непрозрачный refresh-токен и заменяется при каждой ротации.

### 2.3. CSRF и CORS

`backend/src/main/java/ru/krug/backend/auth/infrastructure/security/AuthCsrfFilter.java`:

- применяется ко всем mutating (`POST/PUT/PATCH/DELETE`) `/api/v1/auth/**`;
- `GET/HEAD/OPTIONS` и preflight не блокируются;
- `Origin` (или `Referer`, если `Origin` нет) должен входить в
  `krug.cors.allowed-origins`; чужой/`null` origin и `Sec-Fetch-Site: cross-site`
  дают `403 CSRF_REJECTED` с контрактным JSON и `X-Request-Id`;
- запрос без `Origin`/`Referer` (curl/нативный клиент) не является браузерным CSRF и
  пропускается; cookie при этом всё равно защищена `SameSite=Lax`.

`CorsConfig` (`krug.cors.allowed-origins`, fallback на `KRUG_WS_ALLOWED_ORIGINS`):

- `Access-Control-Allow-Credentials: true`;
- конкретные origin-паттерны, `*` запрещён;
- методы `GET/POST/PUT/PATCH/DELETE/OPTIONS`, заголовки `Authorization`,
  `Content-Type`, `Idempotency-Key`, `X-Device-Id`, `X-Request-Id` и т.д.;
- CORS включён в user security chain; bot-chain по-прежнему без CORS.

CSRF-фильтр стоит перед Spring `CorsFilter`, поэтому чужой Origin получает
контрактный `CSRF_REJECTED`, а не plain-text `Invalid CORS request`.

### 2.4. Keycloak service account

`AuthBffProperties.Keycloak`:

- `service-client-id` ← `KRUG_KEYCLOAK_SERVICE_CLIENT_ID`;
- `service-client-secret` ← `KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET`.

`KeycloakHttp`:

- если заданы оба значения — `POST /realms/krug/protocol/openid-connect/token` с
  `grant_type=client_credentials`, `client_id`, `client_secret`;
- если оба пусты — документированный dev fallback (password grant в admin realm);
- если задано только одно — fail closed (`ProviderUnavailableException` → 503), без
  тихого отката на пароль;
- токен кэшируется в памяти до `expires_in - admin-token-skew` (минимум 30 s);
- отдельный `adminRestClient` с `BufferingClientHttpRequestFactory` и interceptor'ом:
  на `401` инвалидирует именно отвергнутый токен, получает новый и **один раз**
  повторяет запрос; тело запроса буферизуется для replay;
- секреты, токены, тела Admin API и email-адреса не логируются.

`KeycloakAdminAdapter` переведён на `adminRestClient()`, ручные
`Authorization`-заголовки удалены.

`ProdGuard` (профиль `prod`) требует:

- `KRUG_KEYCLOAK_SERVICE_CLIENT_ID`;
- `KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET` (≥ 32 символов);
- `KRUG_AUTH_BFF_COOKIE_SECURE != false`;
- непустой `KRUG_CORS_ALLOWED_ORIGINS`.

Профиль `keycloak` (локальный compose) по-прежнему допускает dev fallback.

## 3. Контракт

`contracts/openapi.yaml`:

- `AuthSession.required` больше не содержит `refresh_token`; само поле оставлено
  `deprecated` для обратной совместимости;
- `AuthRefreshRequest` / `AuthLogoutRequest` помечены `deprecated`, `refresh_token`
  в них необязателен: тело игнорируется;
- у `200 /auth/refresh`, `204 /auth/logout`, `200 /auth/login` документирован
  заголовок `Set-Cookie`;
- у refresh/logout документирован `403 CSRF_REJECTED`;
- `CSRF_REJECTED` добавлен в описание кодов ошибок.

`frontend/src/api/schema.d.ts` перегенерирован (`npm run api:types`); проверка
`contract:check` обновлена под новую (ослабленную) обязательность полей.

Совместимость: браузерный SPA обновлён в этом же изменении. Не-браузерные клиенты,
которые читали `refresh_token` из JSON или присылали его в теле refresh/logout,
должны перейти на cookie-jar с `credentials: include`; тело запросов теперь
игнорируется. Для старых клиентов refresh без cookie вернёт `401
INVALID_CREDENTIALS`, logout всё равно идемпотентно очистит cookie.

## 4. Frontend

- `ApiClient` отправляет `credentials: 'include'` для JSON, blob и fetch-multipart
  запросов; XHR-ветка выставляет `withCredentials = true`. Presigned S3 GET
  сознательно остаётся `credentials: 'omit'`.
- `AuthApi.refresh()` и `AuthApi.logout()` больше не принимают аргумент и не шлют
  тело; refresh на 401 идёт через cookie.
- `StoredAuthSession` больше не содержит `refreshToken`; `auth/storage.ts` при чтении
  старой сессии с `refreshToken` немедленно удаляет её (одноразовый re-login), чтобы
  старый refresh-токен не остался читаемым из JS.
- `PasswordAuthProvider`: refresh не требует наличия `sessionStorage`-сессии (cookie
  может быть валидна после перезагрузки), logout всегда вызывает backend и очищает
  локальное состояние.
- MSW-моки эмулируют HttpOnly cookie на стороне mock-DB, отдают `Set-Cookie` и не
  возвращают `refresh_token` в JSON.
- Тесты: cookie-ротация, отсутствие refresh-токена в теле/хранилище, refresh после
  401, logout, `credentials: 'include'`, очистка legacy-сессии.

## 5. Deploy / production

- `deploy/production/.env.prod.example`: `KRUG_KEYCLOAK_SERVICE_CLIENT_ID/SECRET`,
  `KRUG_AUTH_BFF_COOKIE_SECURE=true`, `KRUG_CORS_ALLOWED_ORIGINS`; удалены
  `KC_ADMIN_USER/PASSWORD` как runtime-креды.
- `deploy/production/docker-compose.prod.yml`: backend получает service-account и
  CORS/cookie переменные; убран master/admin-cli; `keycloak-realm-init` подставляет
  `__BFF_SERVICE_CLIENT_SECRET__` в импортируемый realm.
- `deploy/production/realm-export.prod.json`: добавлен confidential client
  `svc-krug-bff` (`serviceAccountsEnabled=true`, `standardFlowEnabled=false`,
  `directAccessGrantsEnabled=false`, `publicClient=false`, `fullScopeAllowed=false`).
- `deploy/scripts/preflight.sh`: требует service-account секрет (≥ 32), запрещает
  `admin-cli`, `*` в CORS, `Secure=false`; предупреждает о legacy `KC_ADMIN_*`.
- `docs/PRODUCTION-RUNBOOK.md`: переписаны §3.3 (provisioning service account и
  выдача ролей), §4 (режим доступа + dev fallback), §9 (ротация секрета клиента),
  §10 (реализованная cookie-схема, проверки, остаточный риск), §12/§13/§14.
- `docs/TASKS-AUTH-BFF.md` обновлён под cookie-транспорт.

`docker compose config --quiet` для prod проверен на тестовом env; подстановка
секрета в realm проверена отдельно; `preflight.sh` на тестовом env проходит
(0 errors, ожидаемый warning про `S3_SCAN_MODE=noop`).

## 6. Тесты

### Backend

Новые/обновлённые:

- `unit/RefreshCookieFactoryTest` — флаги dev/prod, `SameSite=None`+`Secure`,
  очистка, отказ небезопасным значениям без эха токена.
- `unit/KeycloakServiceAccountTokenTest` (WireMock) — `client_credentials`,
  кэш (один token-запрос на несколько Admin API вызовов), `401 → reacquire → replay`,
  password fallback только при обоих пустых значениях, fail-closed при половине пары.
- `integration/AuthBffIT` — `Set-Cookie` на login/verify, отсутствие refresh в JSON,
  ротация/старение cookie, logout/идемпотентность, refresh без cookie → 401,
  чужой Origin/Referer → `403 CSRF_REJECTED`, CORS preflight с credentials,
  service-account используется и password grant не вызывается,
  `401` Admin API → ровно одно переполучение токена, логи без пароля/кода/токена/
  cookie/секрета.
- `integration/TwoFactorIT`, `TwoFactorPolicyIT` — 2FA/enroll выдают cookie,
  refresh работает только через cookie, `TWO_FACTOR_REQUIRED` не отдаёт токены.
- `integration/AdminActionsIT` — после suspend refresh по cookie даёт 401.
- `unit/ProdGuardTest`, `integration/ProdProfileIT` — prod требует service account,
  `Secure` cookie и CORS allowlist.
- `ArchitectureTest` — новое правило: `application` не зависит от
  `jakarta.servlet` / `org.springframework.http` / `org.springframework.web`
  (cookie/CSRF остаются transport-слоем).

Команда:

```bash
cd backend
mvn -o -Dmaven.repo.local=.m2repo test
```

Результат полного прогона: **1091 tests, 0 failures, 0 errors, 0 skipped**;
`BUILD SUCCESS`, ArchUnit 11/11. Прогон выполнялся на Java 21: в этом окружении
Maven по умолчанию стартует на Java 26, где inline-mock Mockito падает на нескольких
pre-existing unit-тестах (не связано с #103).

### Frontend

```bash
cd frontend
npx vitest run          # 142 files / 1392 tests — passed
npm run contract:check  # passed
npm run security:check  # passed
npm run session-writers:check
npx tsc -p tsconfig.json --noEmit
```

## 7. Безопасность: что закрыто и что осталось

Закрыто:

- refresh-токен недоступен JavaScript (HttpOnly) и не уходит в JSON;
- refresh cookie не отправляется на обычные API-запросы (`Path=/api/v1/auth`);
- CSRF: `SameSite=Lax` + Origin/Referer allowlist; cross-site POST не может
  ротировать/отозвать cookie;
- CORS не использует `*` и включает credentials только для явных origin;
- runtime Keycloak Admin API не использует master/admin-cli и пароль человека;
  service account имеет минимальные роли; токен кэшируется и обновляется на 401;
- prod fail-fast: без service account, `Secure` cookie и CORS allowlist приложение
  не стартует.

Остаточный риск / follow-up:

- access token по-прежнему хранится в `sessionStorage` (короткий TTL, device
  binding). Переход на memory-only + bootstrap-refresh при загрузке SPA — отдельная
  frontend-задача; refresh-токен уже защищён.
- CSRF-запрос без `Origin`/`Referer` (не-браузерный клиент) пропускается: это не
  браузерный CSRF-вектор, но для максимальной строгости можно требовать заголовок
  для refresh/logout (риск сломать CLI/интеграции).
- Ключ `KRUG_KEYCLOAK_SERVICE_CLIENT_SECRET` хранится в `.env.prod`/secret manager;
  ротация — runbook §9.

## 8. Build-unblocking note (shared worktree)

В общем рабочем дереве параллельно шли изменения #104 (translation provider). Из-за
второго convenience-конструктора `TranslationProperties` Spring перестал выбирать
constructor binding, и любой контекст падал с `No default constructor found`. Чтобы
прогнать suite, добавлен `@ConstructorBinding` на канонический конструктор. Также
одна строка в `TranslationSettingsView.providerWire()` заменена на `provider.name()`
(вызов domain-метода из application-модели, которую использует api-mapper, нарушал
ArchUnit `apiDependsOnlyOnApplicationAndShared`). Семантика #104 не менялась; #104-
агенту нужно сохранить аннотацию/не возвращать domain-вызов.

## 9. Файлы #103 (основные)

Backend:

- `auth/api/AuthBffController.java`, `auth/api/RefreshCookieFactory.java`,
  `auth/api/dto/AuthSessionResponse.java`, `auth/api/mapper/AuthBffApiMapper.java`
- `auth/application/port/AuthBffSettings.java`,
  `auth/infrastructure/config/AuthBffProperties.java`,
  `auth/infrastructure/config/AuthBffSettingsAdapter.java`
- `auth/infrastructure/security/AuthCsrfFilter.java`
- `auth/infrastructure/keycloak/KeycloakHttp.java`,
  `auth/infrastructure/keycloak/KeycloakAdminAdapter.java`
- `shared/infrastructure/config/CorsProperties.java`,
  `shared/infrastructure/config/CorsConfig.java`,
  `shared/infrastructure/config/ProdGuard.java`,
  `shared/infrastructure/security/SecurityConfig.java`,
  `shared/error/ErrorCode.java`
- `resources/application.yml`, `application-prod.yml`

Контракт/фронтенд:

- `contracts/openapi.yaml`, `frontend/src/api/schema.d.ts`
- `frontend/src/api/http.ts`, `authApi.ts`
- `frontend/src/auth/{types,storage,runtime,PasswordAuthProvider}.ts(x)`
- `frontend/src/mocks/{db,handlers}.ts`
- `frontend/scripts/check-contract.mjs`

Deploy/docs:

- `deploy/production/{.env.prod.example,docker-compose.prod.yml,realm-export.prod.json}`
- `deploy/scripts/preflight.sh`, `deploy/docker-compose.yml`
- `docs/PRODUCTION-RUNBOOK.md`, `docs/TASKS-AUTH-BFF.md`

## 10. Definition of done

- [x] login/verify/2FA/enroll/refresh ставят HttpOnly cookie с `Secure` в prod,
      `SameSite=Lax`, `Path=/api/v1/auth`, `Max-Age`.
- [x] refresh читает только cookie, ротирует её, JSON без refresh-токена.
- [x] logout отзывает токен и очищает cookie; идемпотентен.
- [x] CSRF Origin/Referer + SameSite; CORS с credentials.
- [x] dev http localhost без `Secure`; prod `Secure` обязателен (`ProdGuard`).
- [x] Keycloak client-credentials `svc-krug-bff` с минимальными ролями; кэш токена и
      refresh на 401; секреты не логируются; dev fallback задокументирован, prod
      требует service account.
- [x] Контракт, frontend (credentials/refresh/logout/no refresh storage), mocks/tests.
- [x] Deploy/prod env/realm/preflight/runbook.
- [x] Полный backend suite + ArchUnit; полный frontend suite.
- [x] Отчёт.

**DONE.**

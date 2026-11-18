# Auth BFF — собственные формы + email TOTP

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, auth-часть
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` и `infra/**` не менялись.
> Git-репозитория в workspace нет, поэтому diff/one-PR подтвердить нельзя.

## Статус

**DONE по backend + contract:** все 6 endpoint'ов, DDD use cases/ports, Keycloak Admin
API/token endpoint, email TOTP, V21, rate limits, cleanup, тесты и README.
**PARTIAL по двум follow-up вне зоны/скоупа:**

1. `frontend/scripts/check-contract.mjs` жёстко проверяет «ровно 28 paths / 58 schemas».
   Контракт аддитивно вырос до **34 paths / 68 schemas**, поэтому `npm run contract:check`
   падает на этих двух константах. Скрипт — не наша зона; `schema.d.ts` регенерирован, и
   кроме счётчиков drift не обнаружен.
2. Production-доступ к Keycloak остаётся через master-realm `admin-cli` +
   `KC_ADMIN_USER/KC_ADMIN_PASSWORD`; выделенный realm service account с `manage-users`
   — документированный follow-up (в задаче явно вне scope).

## Сделано

### 1. Contract (additive)

Добавлены `POST /auth/register`, `/auth/verify-email`, `/auth/resend-email-code`,
`/auth/login`, `/auth/refresh`, `/auth/logout` (все `security: []`) и схемы
`AuthRegisterRequest/Response`, `AuthVerifyEmailRequest`, `AuthResendEmailCodeRequest/
Response`, `AuthLoginRequest`, `AuthRefreshRequest`, `AuthLogoutRequest`, `AuthSession`,
`AuthSessionUser`. Добавлен общий ответ `503 ServiceUnavailable` (`AUTH_UNAVAILABLE`),
коды auth перечислены в описании `Error`. `AuthSession` — ровно
`{access_token,refresh_token,expires_in,token_type,user:{id,display_name,email}}`;
`user.id` — локальный JIT-id, совпадающий с `GET /me`.

### 2. Backend DDD auth BFF

* `AuthBffController` + `api/dto` + `AuthBffApiMapper`; публичные пути добавлены в
  `SecurityConfig` и `DeviceBindingFilter.shouldNotFilter`.
* Use cases: `RegisterUserService`, `VerifyEmailService` (+ `VerifyEmailTx`),
  `ResendEmailCodeService` (+ `ResendEmailCodeTx`), `LoginService`,
  `RefreshSessionService`, `LogoutService`, `EmailVerificationCleanupService`,
  `AuthSessionService` (JIT-провижининг).
* Порты: `KeycloakAdminPort`, `TokenExchangePort`, `MailPort`, `EmailCodePort`,
  плюс `AuthRateLimitPort`, `PendingSessionPort`, `AuthBffSettings`.
* Keycloak Admin API: admin-cli token (кэш до истечения), create user
  (`username=email`, `email`, `firstName=display_name`, `enabled=false`,
  `emailVerified=false`), set password, enable+emailVerified после TOTP, delete/rollback
  при SMTP/password/provider failure. Внутренний URL берётся из `KRUG_KEYCLOAK_URL` или
  выводится из `KRUG_OIDC_ISSUER` (compose: `http://keycloak:8080`); браузерный `:8180`
  не используется. Проверено на реальном Keycloak 26.2.5.
* Login: `grant_type=password`, `client_id=krug-web`; `invalid_grant` + disabled/unverified
  → `403 EMAIL_NOT_VERIFIED` с `details.verification_id`, иначе `401 INVALID_CREDENTIALS`.
  Refresh/logout — через token/logout endpoint; Keycloak ротирует refresh.
* Важная совместимость Keycloak 26: default user profile требует непустой `lastName`,
  иначе direct grant отдаёт `invalid_grant` «Account is not fully set up». BFF отправляет
  `firstName=lastName=display_name`, а identity mapping использует `given_name`, когда он
  равен `family_name` (маркер BFF-пользователя), поэтому `display_name` остаётся ровно тем,
  что ввёл пользователь; пользователи, заведённые вне BFF, сохраняют полный `name`.

### 3. Email TOTP

* V21 `auth.email_verifications`: `id, email citext, display_name, keycloak_user_id,
  secret (bytea, AES-256-GCM), expires_at, attempts, consumed_at, last_sent_at, created_at`;
  индексы `(email, created_at desc)`, частичный `expires_at`, частичный `consumed_at`;
  GRANT только `krug_app`; **колонки password нет**.
* 20-байтный секрет, RFC 6238 SHA-1 / 6 цифр / 30 с, окно ±5 шагов, TTL 10 мин, максимум
  5 попыток, cooldown 60 с. Секрет шифруется AES-256-GCM с AAD
  `verification_id|email`; ключ `KRUG_AUTH_BFF_EMAIL_SECRET_KEY` (fallback —
  `KRUG_CONTENT_KEY`), доменно отделён от ключа сообщений. Код не хранится и не логируется.
* `spring-boot-starter-mail`, dev — Mailpit (`mailpit:1025`, UI `:8025`); SMTP-настройки
  через `SPRING_MAIL_*`.
* Cleanup job удаляет истёкшие строки и disabled/unverified Keycloak-пользователей
  (если Keycloak недоступен — строка остаётся на следующий тик). Логи — только счётчики.
* Регистрация не хранит пароль: он сразу уходит в Keycloak. Для возврата сессии из
  `/auth/verify-email` без повторного пароля registration кратко включает пользователя,
  получает refresh token, снова выключает его и держит refresh в ограниченном по TTL
  in-memory `PendingSessionPort`; verify включает+верифицирует пользователя и обменивает
  этот refresh на сессию. Пароль/код/токены не логируются.

### 4. Rate limits

In-memory fixed-window limiter на register/resend/login **per email и per IP**;
`429 RATE_LIMITED` + `Retry-After` + `details.scope/limit/window_seconds`. Значения
конфигурируются `krug.auth-bff.rate-limit.*`. `X-Forwarded-For` учитывается только при
`KRUG_AUTH_BFF_TRUST_XFF=true`.

### 5. Тесты

Добавлено 51 тест (baseline 340 → **391**):

* unit — RFC 6238 векторы и окно ±5; AES-GCM round-trip/AAD/tamper; домен
  `EmailVerification`; attempts (4×422, 5-я →429, затем корректный код тоже 429);
  expired/consumed →410; resend cooldown + ротация секрета; register duplicate/rollback;
  login unverified/wrong password; rate limiter; cleanup; Keycloak errors.
* integration — WireMock Keycloak (admin users/token/userinfo/logout/JWKS), реальные RS256
  access tokens проходят production `KeycloakJwtDecoder`, MockMailSender с перехватом кода:
  register→Mailpit-письмо→verify→`AuthSession`→`/me` 200; duplicate 409; wrong 422; five
  attempts 429; expired 410; resend cooldown/ротация; unverified login 403 + verification_id;
  wrong password 401; refresh rotation; logout revoke; register/login rate-limit 429;
  contract validation всех новых схем; V21 columns/indexes/grants/no-password;
  лог-ассерт «нет password/code/token».
* ArchUnit — 10/10.
* Дополнительно вручную проверен реальный Keycloak 26.2.5 (кэшированный образ): admin-cli
  token, create user с payload BFF, reset-password, enable (emailVerified=false), password
  grant 200, userinfo `given_name/email_verified`, disable → refresh 400 `invalid_grant`,
  enable+emailVerified → refresh 200, logout; контейнер удалён.

## Файлы

Новые (backend):

* `auth/api/AuthBffController.java`, `auth/api/dto/Auth*`, `auth/api/mapper/AuthBffApiMapper.java`
* `auth/application/command/*`, `auth/application/model/Auth*/TokenSet/KeycloakUserView/
  RegistrationView/Resend*`, `auth/application/port/*`, `auth/application/usecase/*`
* `auth/domain/model/EmailVerification.java`, `auth/domain/repository/EmailVerificationRepository.java`,
  `auth/domain/service/TotpCode.java`
* `auth/infrastructure/config/AuthBff*`, `keycloak/*`, `mail/SmtpMailAdapter.java`,
  `code/TotpEmailCodeAdapter.java`, `persistence/EmailCodeCipher|EmailVerification*`,
  `ratelimit/AuthRateLimiter.java`, `session/InMemoryPendingSessionStore.java`,
  `scheduling/AuthEmailVerificationCleanupScheduler.java`
* `db/migration/V21__auth_email_verifications.sql`

Изменены:

* `pom.xml` — `spring-boot-starter-mail`; `docker-compose.yml` — dev Mailpit (8025/1025)
* `application.yml`, `application-keycloak.yml`, `application-test.yml` — auth-bff/mail
* `shared/error/{ErrorCode,ErrorCategory,DomainException}.java`,
  `shared/api/GlobalExceptionHandler.java` — коды/`SERVICE_UNAVAILABLE`
* `shared/infrastructure/security/{SecurityConfig,DeviceBindingFilter,KeycloakClaims}.java`
* `contracts/openapi.yaml`; `frontend/src/api/schema.d.ts` (регенерация)
* `backend/README.md`; этот отчёт

Тесты: `AuthBffIT`, `AuthBffRateLimitIT`, `AuthBffSchemaIT`, 9 unit-классов,
support (`KeycloakWireMock`, `MockMailSender`, `TestMailConfig`,
`InMemoryEmailVerificationRepository`, `MutableClock`, `AuthBffTestData`).

## Проверки

| Команда | Результат |
|---|---|
| `mvn -Dmaven.repo.local=.m2repo test` | **391 tests, 0 failures, 0 errors; BUILD SUCCESS** |
| `ArchitectureTest` | **10/10** |
| `npm run api:types` | `schema.d.ts` регенерирован (новая auth-часть) |
| `npm run contract:check` | **PARTIAL:** падает только на hard-coded `28 paths / 58 schemas`; фактически 34/68, drift схем нет (скрипт вне зоны) |
| Keycloak 26.2.5 smoke | admin-cli token, create user (firstName=lastName), reset password, enable unverified → password grant 200, userinfo, disable → refresh `invalid_grant`, verify → refresh 200, logout — OK |
| `openapi.yaml` parse | 34 paths / 68 schemas, YAML валиден |

## Contract

Изменения только аддитивные; существующие paths/schemas/поля не менялись.
Отклонений от `docs/TASKS-AUTH-BFF.md` нет:

* 6 endpoint'ов и `AuthSession` — как в §1; коды `INVALID_CREDENTIALS` 401,
  `EMAIL_NOT_VERIFIED` 403 (+`verification_id`), `CODE_INVALID` 422, `CODE_EXPIRED` 410,
  `EMAIL_TAKEN` 409, `RATE_LIMITED` 429, `REGISTRATION_CLOSED` 403.
* Добавлен аддитивный `503 AUTH_UNAVAILABLE` для недоступных Keycloak/SMTP и
  потерянного pending-session; добавлен `422` для отклонённого Keycloak пароля.
* `AuthSession.user.id` — локальный JIT-id (совпадает с `/me`), не Keycloak `sub`;
  `token_type=Bearer`; `expires_in` — из Keycloak; refresh/logout принимают токен в теле,
  не в URL.
* `frontend/src/api/schema.d.ts` регенерирован; `frontend/scripts/check-contract.mjs`
  требует обновления двух констант владельцем frontend (вне зоны).

## Security

* Пароли не пишутся в БД приложения и не логируются; в `auth.email_verifications`
  нет password/hash. Пароль только передаётся в Keycloak Admin API и token endpoint.
* 6-значный код не хранится; TOTP-секрет шифруется AES-256-GCM (AAD привязан к
  verification_id/email), ключ — отдельный env (`KRUG_AUTH_BFF_EMAIL_SECRET_KEY`) либо
  `KRUG_CONTENT_KEY` с доменным разделением.
* Код/пароль/токены не попадают в логи (integration-тест на CapturedOutput); ошибки
  внешних вызовов маппятся в generic `AUTH_UNAVAILABLE` без URL/тела/email.
* 5 попыток, TTL 10 мин, cooldown 60 с, одноразовый `consumed_at`, атомарный
  `markConsumed` (row lock), ротация секрета на resend; cleanup ограничивает PII.
* Rate limits per email/IP на register/resend/login; `Retry-After`; fail-closed. XFF
  учитывается только за доверенным прокси.
* Keycloak наружу не публикуется; BFF использует внутренний URL. `AUTH`-эндпоинты
  публичные только в `SecurityConfig`; CSRF отключён, потому что это stateless BFF без
  cookie-сессий (cookie-сессии — вне scope).
* Остаточные риски: in-memory pending session (single-node/restart → пользователь
  входит паролем после verify), in-memory rate limiter, master-realm `admin-cli`
  (production follow-up — service account), cleanup не переживает ротацию ключа
  шифрования, брендирование письма/i18n.

## DDD

```text
auth/
  api/            AuthBffController, dto/Auth*, mapper/AuthBffApiMapper
  application/    command/*, model/*, port/*, usecase/* (Register/Verify/Resend/Login/
                  Refresh/Logout/Cleanup/AuthSession), service (existing JIT)
  domain/         model/EmailVerification, repository/EmailVerificationRepository,
                  service/TotpCode
  infrastructure/ config/AuthBff*, keycloak/*, mail/*, code/*, persistence/*,
                  ratelimit/*, session/*, scheduling/*
```

Направление зависимостей: api → application/shared; application → domain/application/
shared; infrastructure → application/domain/shared. Контроллер не видит domain/
infrastructure; application не видит JPA/Spring Web. ArchUnit 10/10.

## Риски и вопросы

* **Pending session** живёт в памяти процесса. Это осознанный компромисс: пароль нельзя
  хранить, а `/verify-email` обязан вернуть токены. При restart/multi-node аккаунт всё
  равно verified — пользователь входит паролем (`503 AUTH_UNAVAILABLE`,
  `details.reason=sign_in_required`). Production follow-up — service-account token
  exchange.
* **Keycloak admin**: master-realm `admin-cli` + `KC_ADMIN_PASSWORD`; нужен выделенный
  service account с `manage-users` в realm `krug` (вне scope).
* **Rate limiter** in-memory; Redis — multi-node follow-up.
* **Frontend contract check** требует обновить `28/58` → `34/68`; скрипт вне зоны.
* **Live Mailpit/браузерный E2E** в этой сессии не запускались: compose-стек не поднимался,
  SMTP проверен MockMailSender; Keycloak проверен отдельным контейнером 26.2.5.
* **Keycloak lastName**: default user profile требует непустой lastName; BFF использует
  `firstName=lastName=display_name` и `given_name` для display name. Это проверено на
  реальном Keycloak; при кастомном user profile с другим требованием нужна настройка realm.

## Что дальше

1. Frontend-владельцу: обновить две константы в `frontend/scripts/check-contract.mjs`
   (34/68) и использовать новые `paths`/`AuthSession` в формах.
2. Production: realm service account с `manage-users` вместо master admin-cli;
   вынести pending session/rate limit в Redis; dedicated SMTP relay + брендированный шаблон.
3. Live E2E с compose (Mailpit + Keycloak internal) и браузерный сценарий
   register → Mailpit → verify → `/me`.
4. Добавить audit-события `user.registered`, `user.email_verified`, `auth.login_failed`
   (сейчас audit есть только у JIT `user.provisioned`).

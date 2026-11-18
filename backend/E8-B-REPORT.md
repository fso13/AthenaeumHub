# E8-B — first-run setup, platform admin, runtime settings, chat limits

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` не менялись. Git-репозитория в
> рабочем дереве нет, поэтому «одним PR» проверить нельзя; изменения согласованы в
> рабочем дереве.

## Статус

**DONE в границах E8-B.** Реализованы R-01…R-04 серверной части: V22, атомарный первый
platform admin, публичный `GET /setup/status`, защищённые `/admin/*`, runtime SMTP с
AES-GCM-шифрованием пароля, `registration_open` для `/auth/register` и серверные лимиты
создания чатов с `409 CHAT_LIMIT_REACHED`. Полный backend suite — **407/407**,
`ArchitectureTest` — **10/10**. Frontend-гард `frontend/scripts/check-contract.mjs`
остался с прежними точными константами (34 paths / 68 schemas / 39 операций в его
собственном списке); его нужно обновить в E8-F до 38 / 74 / 44 — это единственный
ожидаемый красный чек вне зоны E8-B.

## Сделано

### 1. V22 и модель

`backend/src/main/resources/db/migration/V22__platform_admin_and_system_settings.sql`:

* `auth.users.is_platform_admin boolean NOT NULL DEFAULT false` + частичный уникальный
  индекс `ux_users_single_platform_admin` (не более одного админа; multiple admins вне
  scope v1.1).
* `auth.claim_platform_admin()` — SECURITY DEFINER, транзакционный advisory lock,
  возвращает `true` только первому конкурирующему provision. RLS (`FORCE`) не позволяет
  вызывающему увидеть чужие строки, поэтому проверка «есть ли уже админ» вынесена в
  definer-функцию.
* Апгрейд существующей базы: самый ранний пользователь повышается до админа, чтобы
  установка не осталась без администратора.
* `ops.system_settings` — singleton (`id=1`) с `setup_completed_at`, SMTP
  (`host/port/username/password_ciphertext/from/starttls`), бизнес-параметрами
  (`max_chats_per_user=100`, `max_chats_per_workspace=1000`,
  `max_workspace_members=100`), `registration_open=true`, `updated_at/updated_by`.
  Таблица глобальная (не tenant), пароль — только `bytea`-шифртекст.
* `ops.platform_overview()` — SECURITY DEFINER, только агрегаты users/workspaces/chats
  для админского overview (админ под RLS видит только себя).

Первый JIT-пользователь становится админом в той же транзакции, что создаёт
`auth.users`; dev-пользователи (`/dev/session`) используют тот же claim, поэтому
локальный/test-сценарий ведёт себя так же. Доменные `User`, `UserEntity`,
`UserPersistenceMapper`, `UserRepository` расширены флагом; старые конструкторы
`User.createDev/provision/reconstitute` сохранены как back-compat overloads.

### 2. Auth / BFF

* `GET /me` → `user.is_platform_admin`; `AuthSession.user.is_platform_admin` (JIT,
  verify-email, login, refresh).
* `MeView`, `UserProfileView`, `AuthUserView`, `AuthenticatedUser` получили флаг с
  back-compat конструкторами; `UserProfilePort.isPlatformAdmin` читает persisted-флаг.
* `PlatformAdminGuard` (auth application) активирует tenant context и проверяет
  `auth.users.is_platform_admin`; любая admin-операция без флага → `403 FORBIDDEN`.
* `AuthBffSettingsAdapter.registrationEnabled()` = env
  `KRUG_AUTH_BFF_REGISTRATION_ENABLED` **AND** `ops.system_settings.registration_open`.
  Закрытая регистрация → `403 REGISTRATION_CLOSED` до вызова Keycloak.
* SMTP: `SmtpMailAdapter` теперь строит `JavaMailSenderImpl` из runtime-настроек БД
  (fallback — `spring.mail.*`/`KRUG_MAIL_FROM`), реализует `TestEmailPort`;
  тестовое письмо синхронное. Пароль расшифровывается только в памяти.

### 3. Ops settings context

DDD-контекст `ops`:

```
ops/domain/model           SystemSettings, SmtpSettings, PlatformOverview
ops/domain/repository      SystemSettingsRepository, PlatformOverviewRepository
ops/application/model      SystemSettingsView, SmtpSettingsView, RuntimeSmtpSettings,
                           SetupStatusView, AdminOverviewView, SystemSettingsUpdateCommand
ops/application/port       SystemSettingsPort, SmtpPasswordCipherPort, TestEmailPort
ops/application/service    SystemSettingsMapper
ops/application/usecase    SystemSettingsService, GetSetupStatusService,
                           GetAdminSettingsService, UpdateAdminSettingsService,
                           GetAdminOverviewService, SendTestEmailService
ops/infrastructure/...     native singleton repository, overview adapter,
                           SmtpPasswordCipher (AES-256-GCM)
ops/api                    SetupController, AdminSettingsController,
                           AdminOverviewController + dto/mapper
```

`UpdateAdminSettingsService` блокирует singleton `FOR UPDATE`, применяет partial patch,
шифрует пароль, пишет `settings.updated` и (при завершении) `setup.completed` в audit,
не включая пароль ни в metadata, ни в ответ. `complete_setup=true` (алиас
`setup_completed=true`) завершает setup; повтор → `409 SETUP_ALREADY_COMPLETED`.
`SendTestEmailService` пишет audit `settings.test_email` без адреса получателя; ошибка
SMTP → `503 SMTP_UNAVAILABLE`.

### 4. Chat limits (R-01)

* `ChatRepository.lockChatCreation(workspaceId)` — `pg_advisory_xact_lock` на workspace,
  чтобы проверка счётчиков и INSERT были в одной транзакции и конкурирующие запросы на
  границе не проходили оба.
* `countActiveChatsForUser` = ACTIVE membership пользователя в не удалённых чатах
  воркспейса; `countActiveChatsInWorkspace` = все не удалённые чаты воркспейса.
* `ChatLimitPolicy` (pure domain) → `409 CHAT_LIMIT_REACHED`,
  `details.scope=USER|WORKSPACE`, `details.limit`, `details.used`.
* `ChatCreateService`: DIRECT duplicate/replay и GROUP idempotent replay не расходуют
  слот; лимит проверяется после advisory lock и до INSERT. E2EE/групповые правила
  (name 1..120, creator OWNER, E2EE DIRECT-only) не изменены.
* `GET /workspaces/{id}/limits` расширен полями `max_chats_per_user`, `chats_used`
  (file-лимиты E4 сохранены).
* `max_workspace_members` хранится и отдаётся, но не применяется: в v1.1 нет API
  добавления участников.

### 5. Контракт и frontend types

`contracts/openapi.yaml` — additive:

* paths: `GET /setup/status`, `GET/PATCH /admin/settings`,
  `POST /admin/settings/test-email`, `GET /admin/overview`;
* schemas: `SetupStatus`, `AdminSettings`, `AdminSettingsPatch`, `AdminOverview`,
  `TestEmailRequest`, `TestEmailResponse`;
* `MeResponse.user.is_platform_admin`, `AuthSessionUser.is_platform_admin`,
  `WorkspaceLimits.max_chats_per_user/chats_used`, описание
  `CHAT_LIMIT_REACHED/SETUP_ALREADY_COMPLETED/SMTP_UNAVAILABLE`;
* `frontend/src/api/schema.d.ts` регенерирован через `npm run api:types` (только этот
  файл в `frontend/**`).

**Фактические счётчики:** 38 paths, **44 operations**, **74 schemas** (было 34/39/68).
Оценка «44/78» в задаче не подтвердилась по schemas: settings-response плоский, поэтому
nested-схемы (`AdminSmtpSettings`/`AdminLimits` и т.п.) не заводились. Генератор
`openapi-typescript` синхронен; `check-contract` падает только на захардкоженных
`34` и `68` — их и список операций должен обновить E8-F.

### 6. README

`backend/README.md` дополнен разделом «E8-B — first-run setup, platform admin, runtime
settings and chat limits»: endpoints, setup-flow, guard, SMTP/шифрование/fallback,
`registration_open`, лимиты и scope, curl-smoke, caveats (один админ, advisory
`setup_required`, не применяемый `max_workspace_members`, невозможность очистить
SMTP-пароль через API, DKIM вне scope).

## 5. Приёмка (TASKS §5)

| Пункт | Статус |
|---|---|
| V22: `is_platform_admin`, `ops.system_settings`, SMTP ciphertext | ✅ |
| Первый local/JIT пользователь — admin атомарно, только один | ✅ `claim_platform_admin` + partial unique index |
| `GET /setup/status` public | ✅ |
| `GET/PATCH /admin/settings`, `test-email`, `overview` | ✅ |
| `GET /me` + `is_platform_admin`; `AuthSessionUser` | ✅ |
| `GET /workspaces/{id}/limits` + chat counters | ✅ |
| `POST /workspaces/{id}/chats` `409 CHAT_LIMIT_REACHED` | ✅ details scope/limit/used |
| Setup completion + повторный `409 SETUP_ALREADY_COMPLETED` | ✅ `complete_setup`/`setup_completed` |
| Non-admin → 403 на всех `/admin/*` | ✅ серверный guard |
| SMTP AES-GCM at rest, без секрета в ответах/логах | ✅ |
| `registration_open` → `403 REGISTRATION_CLOSED` | ✅ |
| Лимиты user/workspace и concurrent boundary | ✅ `AdminSettingsIT` |
| Full suite + ArchUnit | ✅ 407/407 + 10/10 |
| README admin/setup/env/limits/SMTP caveats | ✅ |
| `schema.d.ts` регенерирован | ✅; `check-contract` ждёт обновления констант E8-F |

## Contract

| Операция | Auth | Ответ |
|---|---|---|
| `GET /setup/status` | public | `{setup_required, registration_open}` |
| `GET /admin/settings` | platform admin | `AdminSettings` (без пароля) |
| `PATCH /admin/settings` | platform admin | `AdminSettings`; `complete_setup=true`; `409 SETUP_ALREADY_COMPLETED` |
| `POST /admin/settings/test-email` | platform admin | `202 {sent,to}`; `503 SMTP_UNAVAILABLE` |
| `GET /admin/overview` | platform admin | `{users,workspaces,chats}` |
| `GET /me` | user | `user.is_platform_admin` |
| `GET /workspaces/{id}/limits` | member | + `max_chats_per_user`, `chats_used` |
| `POST /workspaces/{id}/chats` | member | `409 CHAT_LIMIT_REACHED` c `scope/limit/used` |

Контракт не переизобретался: `/setup/status` и детали ошибки совпадают с
`docs/SYSTEM-ANALYSIS.md` §17.5; остальные формы — минимально необходимые additive
поля. Новые схемы проходят `OpenApiContract.assertValid` в `AdminSettingsIT`.

## Security

* Пароль SMTP: AES-256-GCM, ключ доменно отделён от message-content и email-code
  (`SHA-256("ops-system-settings-smtp|" + KRUG_CONTENT_KEY)`), формат
  `[version=1][12B nonce][ciphertext+tag]`, AAD `ops.system_settings|smtp_password`.
  В БД только ciphertext; ни ответы, ни audit metadata, ни логи не содержат пароль.
  `RuntimeSmtpSettings.toString()` редактирует secret; `AdminSettings` вообще не имеет
  поля пароля, только `smtp_configured`.
* Admin guard серверный (`PlatformAdminGuard`), читает persisted-флаг под RLS. Клиентский
  `is_platform_admin` — только UX; прямой вызов `/admin/*` без флага → 403.
* `/admin/overview` не раскрывает строки/контент: SECURITY DEFINER возвращает только
  count-агрегаты.
* SMTP test-email не логирует получателя; audit пишет только факт доставки.
* `registration_open` проверяется до Keycloak; `setup_required` намеренно не блокирует
  API (иначе первый админ не смог бы пройти setup) — это frontend-gate.
* RLS не ослаблен: admin-операции активируют tenant context; глобальные чтения идут
  только через узкие SECURITY DEFINER функции (`claim_platform_admin`,
  `platform_overview`).

## Тесты

* Полный backend suite: **407/407**, failures/errors 0 (`mvn -o test`, JDK 21).
* `ArchitectureTest`: **10/10**.
* Новое:
  * `AdminSettingsIT` (9): публичный setup-status; завершение setup + повторный 409 +
    audit; первый/единственный админ; 403 на всех `/admin/*`; шифрование SMTP и
    отсутствие секрета в response/log; test-email; `registration_open` → 403
    `REGISTRATION_CLOSED`; overview; лимит user; лимит workspace; конкурентная граница
    (201+409, ровно 2 чата); `WorkspaceLimits` с новыми полями.
  * `SmtpPasswordCipherTest` (4): round-trip, nonce, tamper/version, короткий ключ.
  * `ChatLimitPolicyTest` (2): граница и `scope/limit/used`.
  * `JitProvisioningTxTest` (+1): claim флага в JIT-транзакции.
* `AdminSettingsIT` проверяет контрактные схемы `SetupStatus`, `AdminSettings`,
  `AdminOverview`, `TestEmailResponse`, `WorkspaceLimits`, `MeResponse`.
* `frontend/src/api/schema.d.ts` синхронен с контрактом (`api:types`); `contract:check`
  падает только на устаревших точных константах frontend-гарда (вне зоны).

## Риски и вопросы

1. **Frontend contract guard** (`frontend/scripts/check-contract.mjs`) захардкодил
   34 paths / 68 schemas / 39 операций в собственном списке. E8-F должен поднять
   константы до 38/74, добавить 5 операций setup/admin в `operations` и их обязательные
   поля; иначе `npm run check` красный, хотя типы синхронны.
2. **Один platform admin.** Так задумано в v1.1 (partial unique index); назначение
   второго требует отдельной модели/аудита.
3. **`setup_required` — advisory.** Бэкенд не блокирует чаты до завершения setup; это
   осознанно, иначе первый администратор не смог бы подготовить установку. Регистрация
   управляется только `registration_open`.
4. **`max_workspace_members` не применяется.** Нет API добавления участников; параметр
   сохранён и отдаётся для будущего enforcement.
5. **SMTP-пароль нельзя очистить через API**: пустое поле = «не менять». Смена
   провайдера — новый пароль; ротация `KRUG_CONTENT_KEY` требует re-encrypt-миграции
   (вне scope).
6. **test-email синхронный и выполняется в транзакции**, удерживая соединение на время
   SMTP-таймаутов (5 с). Для админского редкого действия приемлемо; при необходимости
   вынести в отдельный executor.
7. **Провайдерный DKIM/SPF, несколько SMTP-профилей, биллинг, E2EE-админка** — вне
   scope E8-B.

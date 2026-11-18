# E11-B — admin actions (suspend/activate, chat soft-delete) + audit view

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` не менялись; порт `8080` не
> трогался. Git-репозитория в рабочем дереве нет, поэтому «одним PR» проверить нельзя —
> изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E11-B.** Реализованы R-08 / FR-ADM-15…18:
`POST /admin/users/{userId}/suspend|activate`, `DELETE /admin/chats/{chatId}` и
`GET /admin/audit`. Пользователь приостанавливается в локальной БД и в Keycloak
(disable + отзыв сессий), чат удаляется программно (`chats.deleted_at`, сообщения
остаются), audit-лог читается cross-tenant через узкую `SECURITY DEFINER` функцию.
Полный backend suite — **447/447**, `ArchitectureTest` — **10/10** (JDK 21).
`frontend/src/api/schema.d.ts` регенерирован; `frontend/scripts/check-contract.mjs`
остаётся красным только на захардкоженных счётчиках `42/48/83` — его обновляет E11-F
(вне зоны E11-B).

## Сделано

### 1. Contract (additive)

`contracts/openapi.yaml`:

* paths: `POST /admin/users/{userId}/suspend`, `POST /admin/users/{userId}/activate`,
  `DELETE /admin/chats/{chatId}`, `GET /admin/audit`;
* schemas: `AdminAuditEvent`, `AdminAuditPage`;
* 204-ответы без тела для трёх мутаций; `409`/`404`/`403`/`503` описаны явно;
* `AdminAuditPage` = `{items, next_cursor, has_more}`; item содержит **только**
  `id`, `action`, `actor_id`, `actor_email`, `target_type`, `target_id`, `created_at`;
  поля `metadata`, `prev_hash`/`hash`, `request_id`, `scope_key` отсутствуют by
  construction;
* в описание `Error.code` добавлены E11-коды (`SELF_ACTION_FORBIDDEN`,
  `USER_ALREADY_SUSPENDED`, `USER_ALREADY_ACTIVE`, `LAST_PLATFORM_ADMIN`,
  `CHAT_ALREADY_DELETED`).

**Фактические счётчики контракта:** было **42 paths / 48 operations / 83 schemas**,
стало **46 / 52 / 85** (+4 paths, +4 operations, +2 schemas). `openapi-typescript`
синхронен; `frontend/src/api/schema.d.ts` обновлён через `npm run api:types`.
Существующие 42/48/83 не менялись — только additive.

### 2. V25 — действия и cross-tenant audit без ослабления RLS

`backend/src/main/resources/db/migration/V25__admin_actions_and_audit_view.sql`:

* `ops.admin_user_detail(p_user_id)` — `STABLE`, `SECURITY DEFINER`, метаданные
  не-DELETED пользователя (id/email/display_name/status/is_platform_admin) для
  pre-check 404/409 до обращения к Keycloak.
* `ops.admin_set_user_status(p_user_id, p_status)` — `plpgsql`, `SECURITY DEFINER`,
  берёт **тот же advisory lock**, что `auth.claim_platform_admin()`; проверяет
  last-admin и делает UPDATE одной атомарной операцией. Возвращает outcome
  `OK | NOT_FOUND | ALREADY | LAST_ADMIN`, поэтому приложение маппит 404/409 без
  парсинга SQLSTATE. Разрешены только `ACTIVE`/`SUSPENDED`; `DELETED` недостижим.
* `ops.admin_soft_delete_chat(p_chat_id)` — `SECURITY DEFINER`, ставит
  `chat.chats.deleted_at = now()` и возвращает
  `OK | NOT_FOUND | ALREADY_DELETED` + `workspace_id` + число ACTIVE участников.
  Никакого физического DELETE: сообщения, вложения, E2EE-конверты и членства остаются.
* `ops.admin_audit_page(p_action, p_limit, p_cursor_created_at, p_cursor_id)` —
  `STABLE`, `SECURITY DEFINER`, keyset `(created_at DESC, id DESC)`, точный фильтр
  `action`, `LIMIT LEAST(GREATEST(p_limit,1),101)`. Проекция — только 7 колонок
  контракта; `metadata::jsonb`, хэши и `request_id` не возвращаются. `actor_email` —
  единственное PII-поле, разрешённое контрактом администратора.
* Новый индекс `ix_audit_events_created_at_id (created_at DESC, id DESC)` для
  глобального keyset-порядка (V6-индексы workspace/actor-scoped).
* `EXECUTE` только `krug_app`, `PUBLIC` отозван; RLS-политики и гранты на таблицы не
  менялись. Owner функций — доверенная migration/BYPASSRLS роль (та же предпосылка,
  что у `ops.platform_overview()`, V23 и V24).

Причина SECURITY DEFINER: платформенный админ аутентифицируется как обычный
пользователь, а `auth.users`/`chat.chats`/`audit.audit_events` — FORCE RLS с
tenant/self политиками. Обычный runtime-запрос увидел бы только свои строки.

### 3. Backend `ops/admin`

```
ops/domain/model           AdminUserDetailRow, AdminUserStatusChange,
                           AdminChatDeleteResult, AdminAuditRow
ops/domain/repository      AdminActionRepository
ops/application/model      AdminAuditView, AdminAuditPageView, AdminAuditViewMapper
ops/application/usecase    ChangeUserStatusService, SoftDeleteChatService,
                           ListAdminAuditService
ops/infrastructure/...     AdminActionRepositoryAdapter (native SQL, 1 вызов на операцию)
ops/api                    AdminUserActionsController, AdminAuditController,
                           AdminChatsController#delete + dto/mapper
```

* `PlatformAdminGuard` вызывается **первым** в каждом use case; non-admin → `403
  FORBIDDEN` до любого чтения/записи.
* `ChangeUserStatusService`:
  self-suspend → `409 SELF_ACTION_FORBIDDEN`; unknown/DELETED → `404`; уже
  SUSPENDED/ACTIVE → `409`; last admin → `409 LAST_PLATFORM_ADMIN` (и в приложении, и
  атомарно в БД).
* Порядок suspend: guard → self/pre-check → локальный статус (SQL) → Keycloak
  disable → `/logout` → audit. Keycloak-вызов выполняется внутри транзакции
  осознанно: недоступный IdP → `503 AUTH_UNAVAILABLE` и rollback локального статуса,
  поэтому API не заявляет приостановку, которую IdP не применил.
* `SoftDeleteChatService`: cross-tenant soft-delete, повторный DELETE →
  `409 CHAT_ALREADY_DELETED` (осознанно вместо тихого 204 — UI отличает retry от
  успеха); unknown → `404`.
* `ListAdminAuditService`: cursor scope `audit`, `limit` 1..100 (default 30), exact
  `action` ≤ 120 символов; страница сама аудируется (`admin.audit.viewed`, только
  `returned`/`has_more`).

### 4. Keycloak Admin API

`KeycloakAdminPort` + `KeycloakAdminAdapter`:

* `setEnabled(userId, enabled)` — partial `PUT /admin/realms/{realm}/users/{id}` с
  `{"enabled": ...}`; `emailVerified`/`requiredActions` не перезаписываются.
* `logoutAllSessions(userId)` — `POST /admin/realms/{realm}/users/{id}/logout`;
  идемпотентно (404 = пользователя уже нет), инвалидирует refresh-токены/сессии.
* Пользователь без Keycloak-аккаунта (dev/test fixtures) — no-op; недоступный
  Keycloak — `503`, транзакция откатывается.
* Креденшелы/тела/токены не логируются (существующее свойство адаптера сохранено).

### 5. Realtime: WS-сессии

Добавлен user-scoped путь отзыва, переиспользующий существующий hook:

* `auth/application/event/UserSessionsRevokedEvent` +
  `DeviceKeyEvents.userSessionsRevoked(userId, reason)`;
* `RealtimePublisherPort.publishUserSessionsRevoked(userId, reason)` и реализация в
  `InMemoryRealtimeHub`: каждому live-соединению пользователя уходит
  `session.revoked` (`reason=USER_SUSPENDED`) и close `4403`;
* `RealtimeDeviceKeyListener` доставляет событие только `AFTER_COMMIT`, поэтому
  rollback не закрывает сессии.
* E2EE device keys не отзываются: suspend обратим, в отличие от device revoke.

### 6. Audit

* `admin.user.suspended` / `admin.user.activated` — target `user/{id}`, metadata
  `{previous_status, status}`; email/display name в metadata не попадают.
* `admin.chat.deleted` — target `chat/{id}`, metadata `{workspace_id, members}`;
  имени чата, текста сообщений и файловых метаданных там нет.
* `admin.audit.viewed` — metadata только `{returned, has_more}`; строка фильтра
  `action` не сохраняется.
* Платформенные действия пишутся с `workspace_id = null` (scope `user:<admin>`), т.к.
  это installation-level действия, а не tenant-данные; целевой workspace для удаления
  чата передаётся в metadata.
* Hash-chain не менялся: append идёт через `AuditPort`/нативный INSERT, у `krug_app`
  нет `UPDATE`/`DELETE` на `audit.audit_events` (проверено тестом).

### 7. Tests

Добавлено **13** тестов (434 → **447**):

* `AdminActionsIT` (7 integration, WireMock Keycloak):
  * suspend: `204`, локальный `SUSPENDED`, Keycloak `enabled=false`,
    `POST .../users/{id}/logout` вызван, старый refresh-токен → `401`, повторный
    login → `403 EMAIL_NOT_VERIFIED`; audit-событие без email;
  * activate: `204`, локальный `ACTIVE`, Keycloak `enabled=true`, login снова `200`
    с тем же локальным user id; audit-событие;
  * self-suspend → `409 SELF_ACTION_FORBIDDEN`; прямой SQL-вызов
    `ops.admin_set_user_status` → `LAST_ADMIN`, статус не меняется;
  * cross-tenant soft-delete чужого чата → `204`, `deleted_at` заполнен, сообщения
    сохранены, чат исчез из списка участника и `GET /admin/chats`, сообщения → `404`,
    повтор → `409 CHAT_ALREADY_DELETED`, unknown → `404`;
  * audit: валидация контракта, limit/action/cursor (включая чужой cursor), фильтр по
    action, stable keyset-пагинация без дублей/пропусков, `actor_email` — только PII,
    ответ не содержит `metadata`/`request_id`/имени чата/текста, чтение аудита само
    аудируется;
  * non-admin → `403` на всех четырёх endpoints **до** изменения состояния
    (статус/`deleted_at` не меняются);
  * `404` на unknown id; локальный пользователь без Keycloak-аккаунта
    приостанавливается/активируется, повторные действия → `409`;
  * `SECURITY DEFINER`, `PUBLIC` execute revoked, `audit_events` append-only для
    `krug_app` (нет UPDATE/DELETE).
* `AdminPageCursorTest` (+1): audit scope round-trip и привязка к endpoint.
* `ChangeUserStatusServiceTest` (5 unit): self-suspend, `LAST_ADMIN` → `409`, уже
  SUSPENDED → `409`, happy path (Keycloak disable → `/logout` → audit → WS event),
  `ProviderUnavailableException` → `503` без audit/WS.

`ContractValidationIT`/`OpenApiContract` не менялись; `AdminAuditPage` валидируется в
`AdminActionsIT`.

Полный suite: **447/447**, failures/errors 0, skipped 0 (`mvn -o test`, JDK 21.0.10,
1:20 min). `ArchitectureTest`: **10/10**. JDK 26 в этом окружении ломает существующие
Mockito inline-тесты (известное ограничение, не E11-B); эталон — JDK 21. Один
промежуточный полный прогон упал на известном timing-флаки
`FileMessageIT.rejectsQuarantinedAttachmentWith423` (quarantine scan не успел за 8 s);
изолированный и повторный полный прогон — зелёные, к E11-B не относится.

### 8. README

`backend/README.md`: раздел «E11-B — admin actions and audit view» — endpoint-таблица,
семантика suspend/activate, Keycloak disable/logout, WS 4403, soft-delete, audit
проекция/keyset, коды ошибок, тесты, curl-smoke и contract-count caveat для E11-F.

## Приёмка (TASKS-ADMIN-V2 E11 / FR-ADM-15…18)

| Пункт | Статус |
|---|---|
| `POST /admin/users/{userId}/suspend` → 204 | ✅ |
| `POST /admin/users/{userId}/activate` → 204 | ✅ |
| `DELETE /admin/chats/{chatId}` → 204 (soft-delete) | ✅ |
| `GET /admin/audit?cursor=&limit=&action=` → `AdminAuditPage` | ✅ |
| items: id/action/actor_id/actor_email/target_type/target_id/created_at | ✅ |
| Нет metadata/тел/секретов в audit-ответе | ✅ SQL-проекция + тест |
| 403 non-admin на всех действиях/чтении | ✅ guard первым |
| 404 unknown user/chat | ✅ |
| 409 self-suspend / last admin / already suspended/active / already deleted | ✅ |
| Keycloak disable/enable | ✅ WireMock PUT |
| Отзыв активных Keycloak-сессий (`/logout`) | ✅ WireMock POST + refresh 401 |
| Локальный статус + audit в одной транзакции, rollback при 503 | ✅ |
| WS session revocation (existing hooks) | ✅ user-scoped `session.revoked`/4403 |
| `chats.deleted_at` (V3) + скрытие из списков, сообщения сохранены | ✅ без V25-ALTER (колонка уже была) |
| Audit cross-tenant через SECURITY DEFINER, hash-chain не тронут | ✅ V25 + append-only тест |
| Фильтр action, cursor, limit | ✅ |
| Contract additive, schema.d.ts regenerated | ✅ 46/52/85 |
| Full suite + ArchUnit | ✅ 447/447 + 10/10 (JDK 21) |
| README | ✅ |

## Contract

| Операция | Auth | Ответ |
|---|---|---|
| `POST /admin/users/{userId}/suspend` | JWT + platform admin | `204`, body пуст |
| `POST /admin/users/{userId}/activate` | JWT + platform admin | `204`, body пуст |
| `DELETE /admin/chats/{chatId}` | JWT + platform admin | `204`, body пуст |
| `GET /admin/audit?action=&cursor=&limit=` | JWT + platform admin | `AdminAuditPage` |

Новые схемы:

* `AdminAuditEvent` — required `id`, `action`, `actor_id`, `actor_email`,
  `target_type`, `target_id`, `created_at`; nullable-поля допускают системные события;
* `AdminAuditPage` — required `items`, `has_more`; `next_cursor` nullable.

Существующие 42 path / 48 operations / 83 schema не менялись; правки только additive.
Ошибочные ответы — существующий `Error`; новые коды добавлены в описание.

## Security

* **Authorization.** HTTP: `PlatformAdminGuard` читает `auth.users.is_platform_admin` из
  БД после активации tenant context; claim/`GET /me` не доверяются. Guard стоит первым,
  поэтому non-admin не получает даже 404-oracle. SQL: write-функции дополнительно
  защищены тем, что `EXECUTE` есть только у `krug_app`, а приложение вызывает их после
  guard; last-admin проверяется атомарно под advisory lock.
* **RLS.** Политики не менялись. `auth.users` остаётся FORCE RLS/self-only; admin
  действия идут через узкие `SECURITY DEFINER` функции, owner — доверенная
  migration/BYPASSRLS роль (как V23/V24). Функции не расширяют видимость ни одной
  таблицы: audit-функция возвращает 7 колонок, user-detail — 5, write-функции —
  outcome.
* **No destructive deletes.** `chat.chats.deleted_at` — единственное изменение; ни один
  message/file/attachment/membership не удаляется физически. `audit.audit_events`
  остаётся append-only, hash-chain продолжается без изменения алгоритма.
* **No content/secrets.** В audit-ответе нет `metadata`, `scope_key`, `prev_hash`,
  `hash`, `request_id`; metadata новых событий содержит только статусы/IDs/counts.
  В логах нет email, тел, токенов и Keycloak credentials.
* **IdP consistency.** Suspend: Keycloak disable + `logout`; недоступный IdP → `503` с
  rollback локального статуса. Activate: Keycloak enable. Suspend закрывает WS-сессии
  (`4403`), E2EE keys не уничтожаются.
* **Injection.** Все параметры биндятся через `?`; native SQL не конкатенирует
  пользовательский ввод; `action`/`query`/`cursor` валидируются по длине/формату.
* **PII.** `actor_email` — единственное PII-поле audit-контракта, доступно только
  platform admin. `AdminUserDetailRow.email` используется только для вызова Keycloak и
  не попадает ни в audit metadata, ни в 204-ответ.
* **Resource limits.** `limit ≤ 100`, keyset без offset, SQL-функция ограничивает
  `p_limit` 101; `action ≤ 120`; битый/чужой cursor → `400`, не `500`.

## Риски и вопросы

1. **Frontend contract guard.** `frontend/scripts/check-contract.mjs` пинит
   `Object.keys(spec.paths).length === 42`, `operations === 48`, `schemas === 83` и
   фиксированный список операций. Реальный контракт теперь `46 / 52 / 85`.
   `schema.d.ts` синхронен (типы проходят), но E11-F должен поднять счётчики и добавить
   4 новых операции в `operations`, иначе их никто не проверяет. Скрипт вне зоны E11-B
   (нельзя `frontend/**`, кроме `schema.d.ts`) и намеренно не менялся.
2. **Access token TTL.** Keycloak `/logout` инвалидирует сессии/refresh-токены, но
   stateless access token живёт до истечения (≤ TTL). В `keycloak`/`prod` профиле
   следующий HTTP-запрос всё равно отклоняется: `KeycloakDeviceBinding` → JIT видит
   локальный `SUSPENDED` и отдаёт `403`. В `dev`/`test` профиле dev-token не сверяется
   с локальным статусом — это свойство dev-аутентификации, не production-пути.
3. **Один platform admin в v1.** Частичный unique-index допускает максимум одного
   админа, поэтому «приостановить другого админа, оставив last admin» через API
   недостижимо: self-suspend отсекается раньше, а `LAST_ADMIN` проверен прямым вызовом
   SQL-функции и unit-тестом. При появлении нескольких админов проверка `count <= 1`
   уже готова. Отдельного endpoint удаления пользователя в E11 нет, поэтому
   «delete last platform admin» неприменим: soft-delete касается только чатов.
4. **`409` на повторный DELETE** выбран вместо idempotent `204` (TASKS допускает оба).
   Это осознанно: UI получает явный сигнал «уже удалён», в audit не появляется второй
   no-op. Если продукту нужен именно idempotent `204`, это точечное изменение
   `SoftDeleteChatService` + контракта.
5. **Audit read аудируется.** `GET /admin/audit` добавляет `admin.audit.viewed`, поэтому
   лог пополняется при каждом просмотре. Это согласуется с остальными admin-read
   (`admin.users.viewed` и т.д.), но при очень частом polling страница «сдвигается».
   Фильтр `action=admin.audit.viewed` позволяет увидеть эти события отдельно.
6. **`actor_email` nullable.** Для системных/старых событий `actor_id` может быть NULL;
   контракт допускает nullable и валидатор это принимает.
7. **503-путь покрыт unit-тестом, не integration-тестом.** Маппинг
   `ProviderUnavailableException` → `503 AUTH_UNAVAILABLE` и отсутствие audit/WS
   проверены в `ChangeUserStatusServiceTest`; отдельный WireMock-сценарий «Keycloak
   отвечает 500» не добавлен, чтобы не усложнять общий fake IdP. Локальный rollback
   гарантирован `@Transactional`; при желании следующая сессия может добавить
   end-to-end failure-тест.
8. **Cursor не подписан HMAC** — как и все существующие admin/notification-курсоры.
   Он не является границей безопасности (данные фильтруются SQL/guard) и привязан к
   endpoint; унификация с HMAC — общее изменение для всех cursor-страниц.

## Файлы E11-B

* `backend/src/main/resources/db/migration/V25__admin_actions_and_audit_view.sql`
* `backend/src/main/java/ru/krug/backend/ops/{domain,application,infrastructure,api}/**`
  (новые классы admin actions/audit + `AdminChatsController#delete`)
* `backend/src/main/java/ru/krug/backend/auth/application/port/KeycloakAdminPort.java`
* `backend/src/main/java/ru/krug/backend/auth/infrastructure/keycloak/{KeycloakAdminAdapter,KeycloakEndpoints}.java`
* `backend/src/main/java/ru/krug/backend/auth/application/{event/UserSessionsRevokedEvent,service/DeviceKeyEvents}.java`
* `backend/src/main/java/ru/krug/backend/realtime/{application/port/RealtimePublisherPort,infrastructure/ws/InMemoryRealtimeHub,infrastructure/event/RealtimeDeviceKeyListener}.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
* `backend/src/test/java/ru/krug/backend/integration/AdminActionsIT.java`
* `backend/src/test/java/ru/krug/backend/unit/ChangeUserStatusServiceTest.java`
* `backend/src/test/java/ru/krug/backend/unit/AdminPageCursorTest.java`
* `backend/src/test/java/ru/krug/backend/support/KeycloakWireMock.java` (admin `/logout`)
* `backend/src/test/java/ru/krug/backend/unit/SubscriptionServiceTest.java` (fake port)
* `contracts/openapi.yaml` (additive)
* `frontend/src/api/schema.d.ts` (регенерация)
* `backend/README.md` (раздел E11-B)
* `backend/E11-B-REPORT.md` (этот файл)

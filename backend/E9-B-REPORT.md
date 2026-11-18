# E9-B — admin directory: users/chats + storage dashboard

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/openapi.yaml`, регенерация `frontend/src/api/schema.d.ts`. Остальной
> `frontend/**`, `docs/**`, `design/**`, `deploy/**` не менялись; `8080` не трогался.
> Git-репозитория в рабочем дереве нет, поэтому «одним PR» проверить нельзя —
> изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E9-B.** Реализованы R-05 admin-списки: `GET /admin/users`,
`GET /admin/chats`, `GET /admin/storage` с cursor-пагинацией, поиском/фильтрами,
платформенным guard, аудитом чтений и cross-tenant агрегатами через узкие
`SECURITY DEFINER` функции (V23). Полный backend suite — **416/416**, `ArchitectureTest` —
**10/10**. `frontend/src/api/schema.d.ts` регенерирован; frontend-гард
`scripts/check-contract.mjs` остаётся красным только на захардкоженных
`38 paths / 44 operations / 74 schemas` — его должен обновить E9-F (вне зоны E9-B).

## Сделано

### 1. Contract (additive)

`contracts/openapi.yaml`:

* paths: `GET /admin/users`, `GET /admin/chats`, `GET /admin/storage`;
* schemas: `AdminUser`, `AdminUserPage`, `AdminChat`, `AdminChatPage`,
  `AdminStorageWorkspace`, `AdminStorageTotals`, `AdminStorage`;
* page shape `{items, next_cursor, has_more}`; `limit` 1..100 (default 30); `query`,
  `cursor`, `workspace_id`, `type` (`DIRECT|GROUP`) — параметры;
* response DTO не содержат ни одного контентного поля: только метаданные, счётчики и
  агрегаты.

**Фактические счётчики контракта:** было **38 paths / 44 operations / 74 schemas**,
стало **41 / 47 / 81** (+3 paths, +3 operations, +7 schemas). `openapi-typescript`
синхронен; `frontend/src/api/schema.d.ts` обновлён через `npm run api:types`.

### 2. V23 — cross-tenant aggregates без ослабления RLS

`backend/src/main/resources/db/migration/V23__admin_directory_aggregates.sql`:

* `ops.admin_users_page(p_query, p_limit, p_cursor_created_at, p_cursor_id)` —
  keyset `(created_at DESC, id DESC)`, literal-поиск `position(lower(q) IN lower(...))`
  по email/display_name, `DELETED` пользователи исключены;
  `workspaces_count`/`chats_count` — ACTIVE membership в неудалённых
  workspace/chat; `storage_used_bytes` — сумма байт вложений пользователя со
  статусом `READY/BOUND` (объект ещё хранится).
* `ops.admin_chats_page(p_workspace_id, p_query, p_type, p_limit, p_cursor_created_at,
  p_cursor_id)` — неудалённые чаты/workspace, фильтры workspace/name/type,
  `members_count` — ACTIVE участники, `messages_count` =
  `chat_counters.next_seq - 1` (O(1), без сканирования партиций `message.messages`),
  `last_activity_at` = `chats.last_message_at`.
* `ops.admin_storage_workspaces(p_workspace_id)` — строка на неудалённый workspace:
  `used_bytes`/`reserved_bytes` из `file.workspace_usage`, `storage_limit_bytes` из
  `file.workspace_limits`, `objects` — вложения с сохранённым объектом (`READY/BOUND`),
  `attachments` — все неудалённые записи вложений (включая карантин). Итоги считаются
  приложением как сумма строк, поэтому `?workspace_id=` даёт итоги этого workspace.

Все три функции — `STABLE`, `SECURITY DEFINER`, read-only; `EXECUTE` выдан только
`krug_app`, `PUBLIC` отозван. Owner функций должен видеть все тенанты (та же
предпосылка, что у `ops.platform_overview()` и `auth.claim_platform_admin()`:
superuser/BYPASSRLS migration-роль в dev/test; прод-DBA настраивает такое же
разделение). RLS и политики не менялись; admin HTTP-путь по-прежнему активирует tenant
context и проходит `PlatformAdminGuard`.

Добавлены keyset-индексы `auth.users(created_at DESC, id DESC)` и
`chat.chats(created_at DESC, id DESC)`.

### 3. Backend `ops/admin`

```
ops/domain/model           AdminUserRow, AdminChatRow, AdminStorageWorkspaceRow
ops/domain/repository      AdminDirectoryRepository
ops/domain/exception       InvalidAdminCursorException (400)
ops/application/model      AdminPageCursor, AdminUser(View/Page), AdminChat(View/Page),
                           AdminStorageTotals/Workspace/View
ops/application/service    AdminDirectoryViewMapper, AdminPageRequests
ops/application/usecase    ListAdminUsersService, ListAdminChatsService, GetAdminStorageService
ops/infrastructure/...     AdminDirectoryRepositoryAdapter (native SQL, 1 запрос на страницу)
ops/api                    AdminUsersController, AdminChatsController, AdminStorageController
                           + dto/mapper
```

* `PlatformAdminGuard` вызывается первым в каждом use case; non-admin → `403 FORBIDDEN`
  до любого чтения.
* Непрозрачный cursor: base64url `{"s":"users|chats","t":micros,"id":uuid}`; привязан к
  эндпоинту (cursor users на `/admin/chats` → `400`), микропрецизия сохраняется.
  `limit` вне 1..100, слишком длинный `query` (254 для users, 120 для chats), неизвестный
  `type`, битый cursor → `400 VALIDATION_FAILED`.
* Каждая страница — один SQL-вызов функции; коррелированные агрегаты считает БД, N+1 в
  приложении нет.
* `storage` без курсора: одна строка на неудалённый workspace (осознанно, см. риски).

### 4. Audit

* `admin.users.viewed`, `admin.chats.viewed`, `admin.storage.viewed` пишутся в той же
  транзакции, metadata — только счётчики (`returned`, `has_more`; для storage —
  `workspaces`, `used_bytes`, `reserved_bytes`, `objects`, `attachments`). Поисковая
  строка, email/display name, текст сообщений и имена файлов в audit не попадают.
* Попутно исправлен латентный дефект аудита: append теперь выполняется нативным INSERT,
  а не JPA `persist`. Hibernate при JSON-`metadata` с числовыми значениями мог на
  следующем flush увидеть `metadata` «грязной» и выпустить `UPDATE audit.audit_events`,
  на который у `krug_app` нет права (append-only таблица). Симптом воспроизводился на
  storage-аудите (числовые `used_bytes` и т.п.). Native INSERT сохраняет append-only
  семантику и hash-chain.

### 5. Tests

Добавлено 9 тестов (407 → **416**):

* `AdminPageCursorTest` (3): microsecond round-trip, привязка к endpoint, мусор/пустой
  cursor.
* `AdminDirectoryIT` (6):
  * users: literal-поиск по display name и email, пагинация без дублей/пропусков,
    `has_more`/`next_cursor`, `limit` 0/101, слишком длинный query, битый cursor;
  * chats: workspace/type/name-фильтры, стабильная пагинация, `members_count`/
    `messages_count`/`last_activity_at`, неверный type и limit, чужой cursor;
  * storage: точные totals (`used/reserved/objects/attachments`), `storage_limit_bytes`,
    строка по workspace, инвариант «totals = сумма строк», отсутствие filename/object key;
  * non-admin → `403 FORBIDDEN` на всех трёх endpoints;
  * audit: три действия, metadata только со счётчиками, без search/email/текста;
  * V23: `prosecdef`, `provolatile='s'`, отсутствие `EXECUTE` для `PUBLIC`.
* Проверка отсутствия контента: ответы chats/storage не содержат отправленный текст
  сообщения и имя файла; схемы `Admin*` не имеют контентных полей by construction.
* `AdminDirectoryIT` валидирует ответы через `OpenApiContract.assertValid`.

### 6. README

`backend/README.md` — раздел «E9-B — admin directory: users, chats and storage
dashboard»: endpoints, cursor/filters, семантика полей, RLS/SECURITY DEFINER, audit,
curl-smoke, caveats (messages_count, отсутствие pagination у storage, top users, owner
функций).

## 5. Приёмка (TASKS §5)

| Пункт | Статус |
|---|---|
| `GET /admin/users` → `AdminUserPage`, cursor/search/limit | ✅ |
| `GET /admin/chats` → `AdminChatPage`, workspace/type/search/cursor | ✅ |
| `GET /admin/storage` → totals + per-workspace rows | ✅ |
| Contract additive, регенерация `schema.d.ts` | ✅ 41/47/81; `api:types` |
| Platform-admin guard, non-admin 403 | ✅ до чтения |
| Audit `admin.users.viewed` / `chats.viewed` / `storage.viewed`, только счётчики | ✅ |
| Cross-tenant агрегаты через SECURITY DEFINER, RLS не ослаблен | ✅ V23 + тест grants |
| Stable order `(created_at DESC, id DESC)`, cursor opaque | ✅ keyset, endpoint-bound |
| No N+1 на страницах | ✅ один SQL-вызов на страницу |
| Storage used/reserved/objects/attachments, per workspace | ✅ |
| Нет текста сообщений / E2EE / file bytes / object keys | ✅ по построению + тесты |
| Ошибки: битый cursor/limit/type/query | ✅ 400 `VALIDATION_FAILED` |
| README admin API | ✅ |
| Full suite + ArchUnit | ✅ 416/416 + 10/10 (JDK 21) |

## Contract

| Операция | Auth | Ответ |
|---|---|---|
| `GET /admin/users?query=&cursor=&limit=` | platform admin | `AdminUserPage` — `items[]` (`id`, `email`, `display_name`, `is_platform_admin`, `status`, `workspaces_count`, `chats_count`, `storage_used_bytes`, `created_at`), `next_cursor`, `has_more` |
| `GET /admin/chats?workspace_id=&query=&type=&cursor=&limit=` | platform admin | `AdminChatPage` — `items[]` (`id`, `name`, `type`, `security_mode`, `workspace_id`, `workspace_name`, `members_count`, `messages_count`, `created_at`, `last_activity_at`), `next_cursor`, `has_more` |
| `GET /admin/storage?workspace_id=` | platform admin | `AdminStorage` — `totals` (`used_bytes`, `reserved_bytes`, `objects`, `attachments`) + `workspaces[]` (`workspace_id`, `workspace_name`, `security_mode`, `used_bytes`, `reserved_bytes`, `storage_limit_bytes`, `objects`, `attachments`) |

Контракт additive: существующие 38 paths / 44 operations / 74 schemas не менялись;
`MeResponse`, `AdminSettings`, `AdminOverview` и остальные схемы не затронуты. Новые
схемы проходят `OpenApiContract.assertValid` в `AdminDirectoryIT`.

## Security

* Доступ только `platform_admin`; проверка — серверная (`PlatformAdminGuard` читает
  persisted-флаг под RLS). Клиентский флаг `/me` не используется для авторизации.
* SECURITY DEFINER функции узкие: read-only, только агрегаты/метаданные, без колонок
  контента; `EXECUTE` только `krug_app`, `PUBLIC` отозван. RLS-политики не менялись.
* `admin.storage` не отдаёт `filename`, `object_key`, `sha256`, размеры отдельных файлов
  или байты; `admin.chats` не читает `message.messages` вообще (только
  `chat_counters.next_seq`), поэтому E2EE-конверты и plaintext недостижимы.
* Поиск — literal substring (`position`), не LIKE: `%`/`_` не являются wildcard, SQL
  инъекция исключена параметризацией.
* Audit append-only: native INSERT в `audit.audit_events` (роль имеет только
  SELECT/INSERT), hash-chain и `FOR UPDATE` на `audit_chain` сохранены. В audit не
  попадают поисковые строки, email/display name, тексты и имена файлов.
* Лимиты/курсоры не дают неограниченных выборок: `limit ≤ 100`, keyset, функции
  дополнительно ограничивают `p_limit` 101 (limit+1 для `has_more`).

## Тесты

* Полный backend suite: **416/416**, failures/errors 0 (`mvn -o test`, JDK 21).
  Запуск на JDK 26 даёт падения существующих Mockito-тестов (inline mock maker), это
  ограничение окружения, не E9-B; JDK 21 — эталон проекта.
* `ArchitectureTest`: **10/10**.
* Новое: `AdminPageCursorTest` (3), `AdminDirectoryIT` (6).
* Попутно стабилизирован тестовый профиль сканирования файлов
  (`application-test.yml`): `scan-poll-interval: 100ms`, `scan-batch-size: 1000`.
  Полный suite накопил SCANNING-upload'ы (часть тестов довольствуется download URL и не
  ждёт сканер), и пре-существующий `FileContractIT` с 8-секундным ожиданием карантина
  периодически не успевал. Прод-конфиг (`application.yml`, дефолт 2s/50) не менялся;
  после настройки полный прогон стабилен.

## Риски и вопросы

1. **Frontend contract guard.** `frontend/scripts/check-contract.mjs` содержит точные
   константы `38 paths / 44 operations / 74 schemas` и собственный список операций.
   E9-F должен поднять их до `41 / 47 / 81`, добавить три admin-операции и обязательные
   поля новых схем; иначе `npm run check` красный, хотя `schema.d.ts` синхронен (первая
   проверка скрипта проходит).
2. **Storage без пагинации.** Одна строка на неудалённый workspace; при тысячах
   workspace нужен cursor-страничный режим, а totals считать в SQL, а не суммой строк.
   Для v1.2 (пилот ~20 workspace) осознанно оставлено просто.
3. **`messages_count` — выделенные последовательности.** Включает сообщения, удалённые
   позже; это O(1) и не требует сканирования партиций. Если нужен точный live-count,
   это отдельный запрос по `message.messages` (дорого на каждой странице).
4. **`top users` не включён.** Per-user storage уже есть в
   `AdminUser.storage_used_bytes`; отдельный top-N требует второго cross-tenant
   агрегата. Задача помечала его как optional.
5. **Owner функций.** Как и у `ops.platform_overview()`, SECURITY DEFINER-функции должны
   принадлежать роли, видящей все тенанты. В dev/test это superuser миграций; на managed
   PostgreSQL DBA должен обеспечить BYPASSRLS/эквивалент. Это записано в README и в
   комментарии V23.
6. **Список users/chats скрывает удалённое.** `DELETED` users, deleted chats/workspaces
   не показываются; фильтра по статусу в контракте нет. Это согласовано с
   `ops.platform_overview()`.
7. **Поиск по подстроке не индексируется btree.** `position(lower(...))` — seq scan по
   users/chats. Для админского поиска и пилотных объёмов приемлемо; при росте — pg_trgm
   GIN-индекс или отдельный поисковый индекс (вне scope).
8. **Один platform admin** (E8-B, partial unique index) не менялся: назначение второго
   админа по-прежнему требует отдельной модели/аудита.
9. **Каждое чтение пишет audit** и берёт `FOR UPDATE` на chain head — админские чтения
   сериализуются по scope `user:<admin>`; для редких admin-действий приемлемо.

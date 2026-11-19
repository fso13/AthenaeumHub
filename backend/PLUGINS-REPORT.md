# D1.1 (#69) — каталог плагинов и состояние в чате

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/**`, регенерация `frontend/src/api/schema.d.ts`. Остальной `frontend/**`,
> `docs/**`, `design/**`, `deploy/**` не менялись. Git-репозитория в рабочем дереве нет,
> поэтому проверка «одним PR» невозможна; изменения согласованы в рабочем дереве.

## Статус

**DONE в границах #69.** Реализованы:

* `GET /plugins` — встроенный каталог (5 first-party плагинов), без marketplace/install;
* `GET /chats/{chatId}/plugins` — per-chat состояние
  `{plugin_id, enabled, available, reason?}`;
* `PATCH /chats/{chatId}/plugins/{pluginId}` `{enabled}` — chat `OWNER`/`ADMIN`,
  идемпотентно; E2EE не включает серверные плагины (`422 PLUGIN_NOT_AVAILABLE`);
* audit `chat.plugin.changed` — только `plugin_id` и `enabled`;
* миграция **V34** (V33 уже занята параллельной sticker brand-rename миграцией):
  `plugin.catalog` + `chat.chat_plugins`, RLS/grants, seed 5 built-in;
* backend suite **544/544**, ArchUnit **10/10**;
* `frontend/src/api/schema.d.ts` регенерирован.

Плагины **не исполняются**: в этом срезе нет runtime, sandbox, capability-токенов,
манифестов, подписей, установки, версий, consent и внешних вызовов. Нет и marketplace:
каталог — закрытый список first-party строк, заполняемый миграцией.

## 1. Contract (additive)

`contracts/openapi.yaml`:

* новый tag `plugins`;
* `GET /plugins` (`operationId: listPlugins`) — `200 PluginList`, `401`;
* `GET /chats/{chatId}/plugins` (`operationId: listChatPlugins`) — `200
  ChatPluginStateList`, `401/403/404`; параметры `ChatId` + `X-Device-Id`;
* `PATCH /chats/{chatId}/plugins/{pluginId}` (`operationId: updateChatPlugin`) —
  тело `ChatPluginUpdateRequest`, `200 ChatPluginState`, `400/401/403/404/422`;
  параметры `ChatId` + новый `PluginId` + `X-Device-Id`;
* новые schemas: `Plugin`, `PluginList`, `ChatPluginState`, `ChatPluginStateList`,
  `ChatPluginUpdateRequest` (5);
* новый reusable parameter `PluginId` (slug `^[a-z][a-z0-9-]{0,63}$`);
* в описание `Error.code` добавлены `PLUGIN_NOT_FOUND` (404),
  `PLUGIN_NOT_AVAILABLE` (422), `PLUGIN_DISABLED` (422).

Форма `Plugin`: `id`, `name`, `description`, `icon?`, `permissions[]`, `modes[]`,
`state?`. `permissions` — закрытый словарь `MESSAGES | MEMBERS | FILES | WEBHOOKS`
(описательные имена, не выданные capability-гранты). `modes` — `MANAGED | E2EE`;
у всех засеянных built-in только `MANAGED`, потому что это серверные плагины.
`state` — `ACTIVE | DISABLED` (kill switch); поле оставлено необязательным для
additive-совместимости, сервер всегда его отдаёт.

Форма `ChatPluginState`: `plugin_id`, `enabled`, `available`, `reason?`.
`reason` отсутствует при `available=true`; при `available=false` — стабильный код
`PLUGIN_NOT_AVAILABLE` или `PLUGIN_DISABLED` (не локализованная строка).

**Фактические счётчики контракта:**

| | paths | operations | schemas |
|---|---:|---:|---:|
| до #69 | 51 | 60 | 91 |
| после #69 | **54** | **63** | **96** |
| delta | +3 | +3 | +5 |

`frontend/src/api/schema.d.ts` обновлён через `npm run api:types`
(`listPlugins`, `listChatPlugins`, `updateChatPlugin`, `Plugin`, `ChatPluginState…`
присутствуют; drift по сгенерированным типам отсутствует).

`npm run contract:check` красный **только** на захардкоженных счётчиках
`51 paths / 91 schemas` в `frontend/scripts/check-contract.mjs` (реально `54 / 96`;
operations-карта скрипта по-прежнему содержит 60 записей и новые операции не
покрывает). Скрипт — вне зоны #69 (`frontend/**`, кроме `schema.d.ts`), поэтому
намеренно не менялся. Нужен frontend-гард-апдейт: `51→54`, `91→96`, добавить три
операции в `operations`.

## 2. V34 — схема, RLS, grants, seed

`backend/src/main/resources/db/migration/V34__plugin_catalog_and_chat_plugins.sql`.

**Почему V34, а не V33.** В дереве уже присутствует
`V33__rename_builtin_sticker_pack.sql` (параллельная задача брендинга «Сова»).
Переиспользовать номер нельзя: Flyway упал бы на duplicate version. Поэтому
additive-миграция #69 — следующая свободная, V34; порядок V1…V34 последователен.

### 2.1 `plugin.catalog` (глобальный каталог)

| Колонка | Тип / ограничение |
|---|---|
| `id` | `text PK`, slug `^[a-z][a-z0-9-]{0,63}$` |
| `name` | `text NOT NULL`, 1..120 |
| `description` | `text NOT NULL`, 1..500 |
| `icon` | `text NULL`, 1..64, закрытый клиентский токен |
| `permissions` | `text[] NOT NULL`, подмножество `MESSAGES/MEMBERS/FILES/WEBHOOKS` |
| `modes` | `text[] NOT NULL`, 1..2, подмножество `MANAGED/E2EE` |
| `state` | `text NOT NULL`, `ACTIVE/DISABLED` |
| `sort_order` | `integer NOT NULL`, ≥ 0 |
| `created_at/updated_at` | `timestamptz NOT NULL DEFAULT now()` |

* глобальная таблица **без RLS** (как `sticker.sticker_packs`): это не пользовательский
  контент и не секрет;
* `krug_app` имеет только `SELECT`; `INSERT/UPDATE/DELETE` — только migrator;
* индекс `ix_plugin_catalog_state_order (state, sort_order, id)`.

Seed — 5 built-in из макета (без клиентского `stickers`, который в #69 не входит):

| id | name | permissions | modes |
|---|---|---|---|
| `polls` | Опросы | MESSAGES, MEMBERS | MANAGED |
| `tasks` | Задачи | MESSAGES | MANAGED |
| `translate` | Перевод | MESSAGES | MANAGED |
| `telegram` | Мост в Telegram | MESSAGES, MEMBERS, WEBHOOKS | MANAGED |
| `dlp` | DLP-подсказки | MESSAGES, FILES | MANAGED |

`icon`: `poll`, `task`, `translate`, `plug`, `shield`.

### 2.2 `chat.chat_plugins` (per-chat state)

| Колонка | Тип / ограничение |
|---|---|
| `workspace_id` | `uuid NOT NULL` (денормализация для RLS) |
| `chat_id` | `uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE` |
| `plugin_id` | `text NOT NULL REFERENCES plugin.catalog(id) ON DELETE RESTRICT` |
| `enabled` | `boolean NOT NULL DEFAULT false` |
| `updated_by` | `uuid NOT NULL` (audit-like actor; без FK, чтобы удаление пользователя не стирало конфигурацию чата) |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| PK | `(chat_id, plugin_id)` |

* индексы `ix_chat_plugins_workspace_chat (workspace_id, chat_id)` и
  `ix_chat_plugins_plugin (plugin_id)` (последний — для FK);
* `ENABLE + FORCE ROW LEVEL SECURITY`, политика
  `p_chat_plugins_tenant USING/WITH CHECK (workspace_id = ops.current_workspace_id())`;
* `GRANT SELECT, INSERT, UPDATE, DELETE … TO krug_app`;
* отсутствие строки = `enabled=false`; строка создаётся только явным действием.

### 2.3 Rollback (forward-only)

```sql
DROP TABLE chat.chat_plugins;
DROP TABLE plugin.catalog;
DROP SCHEMA plugin;
```

Теряется только per-chat состояние плагинов; чаты, сообщения, файлы и стикеры не
затрагиваются.

## 3. Backend

Новый bounded context `ru.krug.backend.plugin` (добавлен в `ArchitectureTest.CONTEXTS`):

```
plugin/domain/model          Plugin, ChatPlugin, PluginMode, PluginPermission,
                             PluginState, PluginUnavailableReason, PluginAvailability,
                             PluginAvailabilityPolicy
plugin/domain/repository     PluginCatalogRepository, ChatPluginRepository
plugin/application/port      PluginChatAccessPort
plugin/application/model     PluginChatContext, PluginView, ChatPluginStateView
plugin/application/usecase   ListPluginsService, ListChatPluginsService,
                             UpdateChatPluginService
plugin/infrastructure        PluginCatalogAdapter (native SELECT),
                             ChatPluginRepositoryAdapter (conditional upsert),
                             PluginChatAccessAdapter (chat access + tenant GUCs)
plugin/api                   PluginController, DTOs, PluginApiMapper
```

Слоистость соблюдена: domain — чистый Java; application не видит infrastructure/api;
api видит только application/shared; JPA/EntityManager — только в infrastructure;
cross-context — через `PluginChatAccessPort` и опубликованные chat-порты.

### 3.1 Порядок и права

`UpdateChatPluginService.update`:

1. `PluginChatAccessPort.requireActiveChat` — резолвит workspace (для Keycloak),
   активирует tenant GUCs, проверяет ACTIVE workspace membership и ACTIVE chat
   membership. Unknown/deleted/foreign chat или не-член чата → `404`; не-член
   воркспейса → `403`.
2. Проверка роли **чата**: `OWNER`/`ADMIN`; `MODERATOR`/`MEMBER`/`GUEST` → `403`.
   Это осознанно chat-scoped: состояние плагина — свойство чата, а не воркспейса.
   `ChatAccessPort` уже отдаёт `memberRole`, поэтому отдельный SECURITY DEFINER не
   нужен.
3. `plugin.catalog.findById` → unknown `404 PLUGIN_NOT_FOUND`.
4. `PluginAvailabilityPolicy`: `state=DISABLED` → `422 PLUGIN_DISABLED`; режим чата не
   входит в `modes` → `422 PLUGIN_NOT_AVAILABLE` (для E2EE + MANAGED-only это и есть
   запрет серверных плагинов). Доступность проверяется до записи — частичного
   применения нет.
5. Conditional upsert (`INSERT … ON CONFLICT DO UPDATE … WHERE enabled IS DISTINCT
   FROM EXCLUDED.enabled RETURNING plugin_id`). Если значение не изменилось — `200`,
   `updated_by`/`updated_at` не трогаются, audit не пишется.
6. При реальном изменении — audit в той же транзакции.

`ListChatPluginsService` возвращает по записи на каждый каталог-плагин, `enabled` из
строки (или `false`), `available/reason` из политики. `ListPluginsService` не требует
workspace/chat: каталог глобальный, но эндпоинт аутентифицирован.

### 3.2 Коды ошибок

| Код | HTTP | Когда |
|---|---|---|
| `PLUGIN_NOT_FOUND` | 404 | `pluginId` отсутствует в каталоге |
| `PLUGIN_NOT_AVAILABLE` | 422 | `modes` не содержит режим чата (серверный плагин в E2EE) |
| `PLUGIN_DISABLED` | 422 | `plugin.catalog.state = DISABLED` |
| `NOT_FOUND` | 404 | чат неизвестен/удалён/чужой/пользователь не член чата |
| `FORBIDDEN` | 403 | роль чата ниже `OWNER`/`ADMIN`; не-член воркспейса |
| `VALIDATION_FAILED` | 400 | отсутствует/невалиден `enabled`, пустое тело |

### 3.3 Audit

* action `chat.plugin.changed`, target `chat/{chatId}`;
* metadata `{"plugin_id": "<id>", "enabled": <bool>}` — **только id и boolean**;
* нет имени/описания/прав плагина, имени чата, сообщений, файлов, ключей, E2EE;
* запись в workspace hash-chain scope, в транзакции изменения; ошибка audit
  откатывает изменение;
* no-op PATCH не пишет событие (идемпотентность).

### 3.4 E2EE и отсутствие execution

* все засеянные built-in — `MANAGED`-only, поэтому в E2EE:
  `GET /chats/{chatId}/plugins` отдаёт `available=false`,
  `reason=PLUGIN_NOT_AVAILABLE`, `enabled=false`; любой PATCH (включая `false`) →
  `422 PLUGIN_NOT_AVAILABLE`;
* `security_mode` не читается из тела и не меняется; E2EE plaintext/ключи не
  затрагиваются;
* нет runtime, sandbox, RPC, capability-JWT, webhook-вызовов, сетевых запросов;
* в схеме `plugin` нет ни одной функции (проверено тестом);
* `krug_app` не может писать в каталог, только читать.

## 4. Tests

Добавлено **17 тестов** (527 → **544**):

| Класс | + | Что покрыто |
|---|---:|---|
| `unit/PluginDomainTest` | 6 | availability MANAGED/E2EE, E2EE-клиентский плагин, приоритет kill switch, инварианты `Plugin`, immutable-коллекции |
| `integration/PluginCatalogIT` | 4 | `GET /plugins` (5 built-in, поля, modes, permissions, state, contract), per-chat defaults, membership/404/401, auth без workspace |
| `integration/ChatPluginsIT` | 6 | owner enable/disable + persist + contract; идемпотентность (нет второго audit/updated_at); chat ADMIN 200, MODERATOR/MEMBER 403, non-chat-member/outsider 404, removed membership 404; unknown plugin 404; 400 на тело; audit только `plugin_id/enabled`; kill switch 422; RLS/grants/PK/FK/indexes/seed/no-functions/DB-check/tenant isolation |
| `integration/E2eePluginsIT` | 1 | E2EE: все 5 `available=false`/`PLUGIN_NOT_AVAILABLE`, enable и disable → 422, нет строки/audit, unknown → 404, MEMBER → 403, каталог остаётся MANAGED-only |

Ключевые проверки:

* `GET /plugins` → 5 items в стабильном порядке `polls, tasks, translate, telegram, dlp`;
  `permissions` у `telegram = [MESSAGES, MEMBERS, WEBHOOKS]`, у `dlp = [MESSAGES, FILES]`;
* GET состояния по умолчанию: все `enabled=false`, `available=true`, `reason`
  отсутствует; GET не создаёт строк;
* чужой/неизвестный/soft-deleted чат и workspace-member без chat membership → 404;
* PATCH `{"enabled":true}` → `200 ChatPluginState`, строка с правильными
  `workspace_id/chat_id/plugin_id/enabled/updated_by/updated_at`;
* повтор того же значения → 200, audit/updated_at не меняются; disable → второе
  событие; другой плагин — независимая строка;
* audit: ровно два ключа metadata, значения `polls`/`telegram`, нет «Опросы»,
  «Голосования», «Telegram», «WEBHOOKS», `text`;
* E2EE: `PLUGIN_NOT_AVAILABLE` и для enable, и для disable; строка и audit не
  появляются;
* прямой SQL: `chat.chat_plugins` RLS forced, `plugin.catalog` без RLS; у `krug_app`
  только SELECT на каталог и CRUD на состоянии; PK/FK/индексы; `INSERT` с
  `modes=['BOGUS']` падает; строка одного тенанта не видна другому; вставка с чужим
  `workspace_id` под текущим GUC падает на WITH CHECK; в схеме `plugin` нет функций.

`ArchitectureTest` — **10/10** (в `CONTEXTS` добавлен `plugin`; domain/application/api
и JPA-правила проходят).

Команды:

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 544, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0

cd ../frontend
npm run api:types
npm run contract:check
# FAIL: "Contract must expose exactly 51 paths" / "exactly 91 schemas"
# реально 54 / 96; schema.d.ts синхронен; счётчики — в frontend/scripts (вне зоны)
```

## 5. Security

* **AuthN.** Все три операции требуют bearer JWT; `GET /plugins` не требует
  `X-Device-Id` (контракт его не объявляет), chat-операции — требуют, как все
  `/chats/**`.
* **AuthZ.** GET — ACTIVE chat membership; PATCH — chat `OWNER`/`ADMIN`. Роль берётся из
  БД (`chat.chat_members`), не из тела/JWT.
* **Existence hiding.** Unknown/deleted/foreign chat и отсутствие chat membership
  неотличимы от несуществующего (`404`); известный чат с недостаточной ролью — `403`.
* **E2EE fail-closed.** Серверный плагин в E2EE недоступен для чтения и записи;
  `security_mode` неизменяем; plaintext/ключи не читаются.
* **Input.** `pluginId` — bind-параметр, без SQL-конкатенации; неизвестный id → 404;
  `enabled` — strict boolean (`@NotNull`, Jackson); пустое/битое тело → 400.
* **RLS/grants.** `chat.chat_plugins` — forced RLS по `workspace_id`; каталог —
  глобальный read-only; `updated_by` без FK осознанно.
* **Audit.** Только `plugin_id` + `enabled`; hash-chain и append-only не менялись.
* **No secrets / no external calls / no execution.**
* **Rate limit.** Отдельного лимита нет; операция доступна только chat
  OWNER/ADMIN. При необходимости — edge/Redis limiter (follow-up, как и для
  `PATCH /chats/{chatId}`).

## 6. Риски / follow-up

1. **`frontend/scripts/check-contract.mjs` пинит `51 paths / 91 schemas`.** Реально
   `54 / 96`; script вне зоны #69 и намеренно не менялся. Нужно добавить три операции
   в `operations` и поднять счётчики — иначе `contract:check` остаётся красным, хотя
   `schema.d.ts` синхронен. Это единственный «красный» пункт приёмки, и он относится к
   frontend-гарду, а не к backend.
2. **Роль PATCH — chat-level `OWNER/ADMIN`.** Если продукт хочет, чтобы плагинами
   управлял workspace `OWNER/ADMIN` без членства в чате (как D1-BE3 для настроек
   чата), это небольшое изменение: резолв через `chat.settings_scope` и проверка
   workspace-роли. Сейчас выбран chat-scoped вариант, потому что состояние —
   per-chat, а формулировка #69 — «active chat membership for GET; OWNER/ADMIN for
   PATCH».
3. **Нет WS-события `chat.plugin.changed`.** Другие участники увидят новое состояние
   после refetch. Realtime не входил в #69; при необходимости — outbox/WS event с теми
   же metadata-only полями.
4. **Kill switch только через миграцию/ops-SQL.** Отдельного admin-эндпоинта
   `state=DISABLED` нет (вне scope). Тест временно выключает `translate` и
   восстанавливает `ACTIVE` в `finally`.
5. **E2EE-клиентские плагины не засеяны.** `modes` уже поддерживает `E2EE`, политика
   и unit-тест это покрывают, но в каталоге только серверные built-in. Клиентский
   `stickers` из макета — отдельный срез.
6. **V34 вместо V33.** V33 занята sticker brand-rename; это ожидаемое следствие
   параллельной задачи, а не пропуск версии.
7. **Last-write-wins.** Два chat ADMIN могут переключать один плагин конкурентно;
   conditional upsert атомарен, но optimistic-lock/version не требуется по ТЗ.
8. **`enabled` для недоступного плагина.** GET отдаёт сохранённое значение, а не
   принудительный `false`; `available=false` — источник истины. В текущих данных
   недоступный+включённый невозможен (режим чата неизменяем, E2EE-включение
   запрещено), но при будущем kill switch уже включённого плагина UI должен
   ориентироваться на `available`.

## 7. Изменённые файлы

Backend main:

* `backend/src/main/resources/db/migration/V34__plugin_catalog_and_chat_plugins.sql`
* `backend/src/main/java/ru/krug/backend/plugin/domain/model/{Plugin,ChatPlugin,PluginMode,PluginPermission,PluginState,PluginUnavailableReason,PluginAvailability,PluginAvailabilityPolicy}.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/repository/{PluginCatalogRepository,ChatPluginRepository}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/port/PluginChatAccessPort.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/model/{PluginChatContext,PluginView,ChatPluginStateView}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/usecase/{ListPluginsService,ListChatPluginsService,UpdateChatPluginService}.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/persistence/{PluginCatalogAdapter,ChatPluginRepositoryAdapter}.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/adapter/PluginChatAccessAdapter.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/PluginController.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/dto/{PluginResponse,PluginListResponse,ChatPluginStateResponse,ChatPluginStateListResponse,ChatPluginUpdateRequest}.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/mapper/PluginApiMapper.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`

Backend tests:

* `backend/src/test/java/ru/krug/backend/unit/PluginDomainTest.java`
* `backend/src/test/java/ru/krug/backend/integration/{PluginCatalogIT,ChatPluginsIT,E2eePluginsIT}.java`
* `backend/src/test/java/ru/krug/backend/ArchitectureTest.java` (CONTEXTS + `plugin`)

Contracts / generated:

* `contracts/openapi.yaml`
* `frontend/src/api/schema.d.ts` (регенерация)
* `backend/PLUGINS-REPORT.md` (этот файл)

## 8. Приёмка #69

| Пункт | Статус |
|---|---|
| `GET /plugins`: built-in id/name/description/icon/permissions/modes/state; без marketplace | ✅ |
| `GET /chats/{chatId}/plugins`: `{plugin_id, enabled, available, reason?}` | ✅ |
| `PATCH /chats/{chatId}/plugins/{pluginId}` `{enabled}`, OWNER/ADMIN, audit | ✅ |
| V34 `plugin.catalog` + `chat.chat_plugins`, seed 5, RLS/grants | ✅ |
| active chat membership для GET; OWNER/ADMIN для PATCH | ✅ |
| plugin exists/available in mode; E2EE server plugin → `PLUGIN_NOT_AVAILABLE` | ✅ |
| идемпотентность; no external calls; no secrets | ✅ |
| tests: catalog, state, permissions, E2EE, audit, unknown plugin | ✅ 17 |
| full backend 527+ | ✅ **544/544** |
| ArchUnit | ✅ **10/10** |
| additive, chat/details не сломаны | ✅ (544/544, chat/message/thread/file tests зелёные) |
| contract counts в отчёте | ✅ 54/63/96; guard-счётчики — см. риск 1 |

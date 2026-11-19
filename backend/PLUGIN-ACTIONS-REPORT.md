# D1.1 (#76) — polls / tasks / translate execution APIs

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Rest of `frontend/**`, `docs/**`, `design/**`, `deploy/**` were not edited by this task.
> The workspace is not a Git checkout, so the change set is verified in the working tree
> and by the test suite.

## Статус

**DONE в границах #76.** Плагины остаются только данными/политиками: код плагинов не
исполняется, установки/marketplace нет, внешний переводчик по умолчанию не вызывается.

Реализовано:

* `GET/POST /chats/{chatId}/polls`;
* `POST /chats/{chatId}/polls/{pollId}/votes` `{option_id}` → `Poll`;
* `PATCH /chats/{chatId}/polls/{pollId}` `{closed}` → `Poll` (закрытие создателем);
* `GET/POST /chats/{chatId}/tasks`;
* `PATCH /chats/{chatId}/tasks/{taskId}` `{done}` → `Task`;
* `POST /chats/{chatId}/messages/{messageId}/translate` `{target}` → `Translation`;
* миграция **V37**: `plugin.polls`, `plugin.poll_options`, `plugin.poll_votes`,
  `plugin.tasks`, RLS/grants/индексы/CHECK-и;
* общий gate действий поверх `plugin.catalog` + `chat.chat_plugins`: active chat
  membership и включённый плагин (`polls`/`tasks`/`translate`), иначе
  `422 PLUGIN_NOT_ENABLED`; E2EE fail-closed (`422 PLUGIN_NOT_AVAILABLE`);
* audit только `action` + id (без question/title/option text/translation text);
* translation: provider не настроен по умолчанию → `503 TRANSLATION_UNAVAILABLE` +
  `Retry-After: 30`; при заданном `krug.plugins.translate.url` — bounded HTTP-вызов;
* backend suite **586/586**, `ArchitectureTest` **10/10** (JDK 21);
* `frontend/src/api/schema.d.ts` регенерирован; `npm run contract:check` зелёный.

## 1. Contract (additive)

`contracts/openapi.yaml`:

| Operation | Path | Request | Response |
|---|---|---|---|
| `listPolls` | `GET /chats/{chatId}/polls` | — | `200 PollList`; 401/403/404/422 |
| `createPoll` | `POST /chats/{chatId}/polls` | `PollCreate {question, options[2..10]}` | `201 Poll`; 400/401/403/404/422 |
| `votePoll` | `POST /chats/{chatId}/polls/{pollId}/votes` | `PollVoteRequest {option_id}` | `200 Poll`; 400/401/403/404/422 |
| `closePoll` | `PATCH /chats/{chatId}/polls/{pollId}` | `PollCloseRequest {closed=true}` | `200 Poll`; 400/401/403/404/422 |
| `listTasks` | `GET /chats/{chatId}/tasks` | — | `200 TaskList`; 401/403/404/422 |
| `createTask` | `POST /chats/{chatId}/tasks` | `TaskCreate {title, assignee_id?, due_at?}` | `201 Task`; 400/401/403/404/422 |
| `updateTask` | `PATCH /chats/{chatId}/tasks/{taskId}` | `TaskUpdate {done}` | `200 Task`; 400/401/403/404/422 |
| `translateMessage` | `POST /chats/{chatId}/messages/{messageId}/translate` | `TranslationRequest {target}` | `200 Translation`; 400/401/403/404/422/503 |

Новые schemas (12): `PollOption`, `Poll`, `PollList`, `PollCreate`, `PollVoteRequest`,
`PollCloseRequest`, `Task`, `TaskList`, `TaskCreate`, `TaskUpdate`, `TranslationRequest`,
`Translation`.

Новые parameters: `PollId`, `TaskId` (UUID). Новый reusable response
`TranslationUnavailable` (503 + `Retry-After`).

`Error.code` дополнен кодами:

| Код | HTTP | Когда |
|---|---|---|
| `PLUGIN_NOT_ENABLED` | 422 | per-chat toggle `false` (нет строки = false) |
| `POLL_CLOSED` | 422 | голосование в закрытом опросе |
| `POLL_OPTION_INVALID` | 422 | option не принадлежит этому poll |
| `POLL_STATE_INVALID` | 422 | `closed=false` (переоткрытие не поддерживается) |
| `TASK_ASSIGNEE_INVALID` | 422 | assignee не ACTIVE-участник этого чата |
| `MESSAGE_NOT_TRANSLATABLE` | 422 | не managed `TEXT` (sticker/system/удалённое/скрытое — 404) |
| `TRANSLATION_UNAVAILABLE` | 503 | provider не настроен/ошибка/таймаут/невалидный ответ |

**Фактические счётчики контракта** (измерено в рабочем дереве):

| | paths | operations | schemas |
|---|---:|---:|---:|
| до #76 (рабочее дерево, после параллельных срезов) | 57 | 67 | 103 |
| после #76 | **63** | **75** | **115** |
| delta | +6 | +8 | +12 |

`frontend/src/api/schema.d.ts` обновлён через `npm run api:types`.
`npm run contract:check` в текущем дереве проходит: **75 operations / 115 schemas**,
generated types in sync. Сам guard (`frontend/scripts/check-contract.mjs`) в этой задаче
не менялся — он уже был обновлён параллельным срезом; в отчёте фиксируется фактический
результат, а не «красный» счётчик из #69.

## 2. V37 — схема, RLS, grants, indexes

`backend/src/main/resources/db/migration/V37__plugin_actions_polls_tasks.sql`.
V36 в дереве отсутствует; V37 — следующая свободная версия после V35.

### 2.1 `plugin.polls`

| Колонка | Тип / ограничение |
|---|---|
| `id` | `uuid PK` |
| `workspace_id` | `uuid NOT NULL` (RLS) |
| `chat_id` | `uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE` |
| `creator_id` | `uuid NOT NULL`, только он закрывает опрос |
| `question` | `text`, 1..500, без control/`<`/`>` |
| `closed_at` | `timestamptz NULL` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| UNIQUE | `(workspace_id, chat_id, id)` — родительский ключ composite FK |

Индекс `ix_plugin_polls_ws_chat_created (workspace_id, chat_id, created_at DESC, id DESC)`.

### 2.2 `plugin.poll_options`

| Колонка | Тип / ограничение |
|---|---|
| `id` | `uuid PK` |
| `workspace_id` / `chat_id` / `poll_id` | `uuid NOT NULL` |
| `position` | `integer`, 0..9 |
| `text` | `text`, 1..200, без control/`<`/`>` |
| UNIQUE | `(poll_id, position)`, `(workspace_id, chat_id, poll_id, id)` |
| FK | `(workspace_id, chat_id, poll_id) → plugin.polls(workspace_id, chat_id, id)` CASCADE |

Индекс `ix_plugin_poll_options_ws_chat_poll (workspace_id, chat_id, poll_id, position)`.

### 2.3 `plugin.poll_votes`

| Колонка | Тип / ограничение |
|---|---|
| `poll_id` + `user_id` | **PK** — один голос на пользователя |
| `option_id` | `uuid NOT NULL` |
| `workspace_id` / `chat_id` | `uuid NOT NULL` |
| `created_at` / `updated_at` | `timestamptz NOT NULL` |
| FK | `(workspace_id, chat_id, poll_id, option_id) → plugin.poll_options(workspace_id, chat_id, poll_id, id)` CASCADE |

Composite FK включает workspace/chat/poll: option чужого poll/тенанта не может получить
голос даже прямым SQL (FK проверяется в обход RLS). Индекс
`ix_plugin_poll_votes_ws_chat_poll_option (workspace_id, chat_id, poll_id, option_id)`.

### 2.4 `plugin.tasks`

| Колонка | Тип / ограничение |
|---|---|
| `id` | `uuid PK` |
| `workspace_id` / `chat_id` | `uuid NOT NULL`, `chat_id` FK на `chat.chats` CASCADE |
| `creator_id` | `uuid NOT NULL` |
| `assignee_id` | `uuid NULL` (валидируется приложением как ACTIVE chat member) |
| `title` | `text`, 1..500, без control/`<`/`>` |
| `due_at` | `timestamptz NULL` |
| `done` | `boolean NOT NULL DEFAULT false` |
| `completed_by` / `completed_at` | `NULL`; CHECK: `done=true` ⇔ оба заполнены, `done=false` ⇔ оба NULL |
| `created_at` / `updated_at` | `timestamptz NOT NULL` |

Индексы `ix_plugin_tasks_ws_chat_done_created`, `ix_plugin_tasks_ws_chat_assignee`.

### 2.5 RLS / grants

* Все четыре таблицы: `ENABLE + FORCE ROW LEVEL SECURITY`, политика
  `workspace_id = ops.current_workspace_id()` с `USING` и `WITH CHECK`.
* `krug_app`: `SELECT/INSERT/UPDATE` на `polls`, `poll_votes`, `tasks`;
  `SELECT/INSERT` на `poll_options` (варианты неизменяемы). `DELETE` не выдан нигде —
  delete-эндпоинтов в этом срезе нет.
* Rollback (forward-only, destructive): drop votes → options → polls → tasks. Каталог,
  chat_plugins и chat/message/file данные не затрагиваются.

## 3. Backend

```
plugin/domain/model        Poll, PollOption, ChatTask
plugin/domain/service      PluginTextPolicy
plugin/domain/repository   PollRepository, ChatTaskRepository
                           ChatPluginRepository (+isEnabled)
plugin/application/port    PluginChatAccessPort (+isActiveChatMember),
                           TranslationProviderPort, TranslationUnavailableException
plugin/application/model   PollView, PollOptionView, TaskView, TranslationView
plugin/application/usecase PluginActionGate, PollService, TaskService,
                           TranslateMessageService
plugin/infrastructure      PollRepositoryAdapter, ChatTaskRepositoryAdapter,
                           ChatPluginRepositoryAdapter, PluginChatAccessAdapter (+member check),
                           TranslationProperties, HttpTranslationProvider
plugin/api                 PluginActionsController, 12 DTOs, PluginActionsApiMapper
```

Слоистость сохранена: domain — чистый Java; application не видит infrastructure/api;
api видит только application/shared; JPA — только в infrastructure. `ArchitectureTest`
10/10, `plugin` уже в `CONTEXTS` с #69.

### 3.1 Порядок авторизации

`PluginActionGate.requireEnabled`:

1. `PluginChatAccessPort.requireActiveChat` — workspace для Keycloak, tenant GUCs,
   ACTIVE workspace + ACTIVE chat membership. Unknown/deleted/foreign/removed → `404`
   (existence hidden); не-член воркспейса → `403`.
2. `plugin.catalog.findById` — unknown id → `404 PLUGIN_NOT_FOUND`.
3. `PluginAvailabilityPolicy` — kill switch → `422 PLUGIN_DISABLED`; режим не входит в
   `modes` (MANAGED-only в E2EE) → `422 PLUGIN_NOT_AVAILABLE`.
4. `chat.chat_plugins` enabled? Иначе → `422 PLUGIN_NOT_ENABLED`.

Все действия (GET и write) проходят этот gate. Плагин не исполняется.

### 3.2 Polls

* Создавать и голосовать может любой ACTIVE-участник чата; создатель фиксируется
  сервером.
* Вопрос 1..500, 2..10 уникальных вариантов по 1..200; trim, plain text, без
  control/HTML; duplicate → `422`.
* `total_votes` — число уникальных пользователей; `my_option_id` — выбор вызывающего.
* Голос: PK `(poll_id, user_id)`; повтор того же варианта — `200` без audit и без
  изменения `updated_at`; смена варианта — UPDATE строки, не второй голос.
* Чужой option → `422 POLL_OPTION_INVALID` до записи; DB composite FK — backstop.
* Закрыть может только создатель (`403` иначе); `closed=false` → `422 POLL_STATE_INVALID`;
  повтор закрытия идемпотентен; голос после закрытия → `422 POLL_CLOSED`.
* Listing: новые первыми, не более 100; без N+1 (один grouped query на страницу).

### 3.3 Tasks

* Создавать может любой ACTIVE-участник; `title` 1..500 plain text; `assignee_id`
  необязателен и обязан быть ACTIVE-участником **этого** чата, иначе
  `422 TASK_ASSIGNEE_INVALID`; `due_at` необязателен.
* `done` меняют создатель, assignee или chat `OWNER`/`ADMIN`; остальные → `403`.
* `completed_by`/`completed_at` выставляет сервер; повтор того же `done` — `200` без
  audit; `false` переоткрывает и очищает completion-поля.
* Listing: открытые первыми, затем выполненные; новые первыми; не более 100.

### 3.4 Translation

* Только ACTIVE-участник, включённый `translate`, managed-сообщение `TEXT`, не удалённое
  и не скрытое вызывающим. E2EE-чат/сообщение → `422 E2EE_METADATA_FORBIDDEN`
  (фактически в E2EE gate отвечает `PLUGIN_NOT_AVAILABLE`); не-TEXT → `422
  MESSAGE_NOT_TRANSLATABLE`; чужой/неизвестный message → `404`.
* **По умолчанию провайдера нет**: `krug.plugins.translate.url` пуст, сетевой вызов не
  выполняется, ответ — `503 TRANSLATION_UNAVAILABLE` + `Retry-After: 30`. Фальшивый
  «успешный» перевод не возвращается.
* Если URL задан: `POST {url}` `{"text","target"}` → `200 {"text"}`; connect/read timeout
  (`2s`/`5s` по умолчанию), max response bytes (`65536`), HTTP status/JSON/`text`
  проверяются; любое отклонение → `503`. Текст, URL и тело провайдера не логируются;
  секретов/API-key в этом срезе нет.
* Ответ провайдера — untrusted plain text: trim, CRLF→LF, 1..8000, запрещены `<>` и
  control (кроме `\n`/`\t`). HTML не возвращается.
* Cache не реализован (опционален по ТЗ); повторный запрос идёт к провайдеру.

### 3.5 Audit

| Action | Target | Metadata |
|---|---|---|
| `chat.poll.created` | `poll/{pollId}` | `{}` |
| `chat.poll.voted` | `poll/{pollId}` | `{"option_id": "<uuid>"}` |
| `chat.poll.closed` | `poll/{pollId}` | `{}` |
| `chat.task.created` | `task/{taskId}` | `{}` |
| `chat.task.completed` / `chat.task.reopened` | `task/{taskId}` | `{}` |
| `chat.message.translated` | `message/{messageId}` | `{}` |

Только id/action. Вопрос, варианты, title, message text, переведённый текст, assignee
display name и секреты не пишутся. Audit и изменение — в одной транзакции; no-op
(повторный голос/close/done) второй audit не пишет. Ошибка audit откатывает изменение.

## 4. Tests

Добавлено **15 тестов** (571 → **586**):

| Класс | + | Что покрыто |
|---|---:|---|
| `unit/PluginActionsDomainTest` | 4 | poll options/trim/duplicates/HTML, task completion roles, translation output/target policy |
| `unit/HttpTranslationProviderTest` | 4 | configured success + JSON contract, non-200/invalid JSON/no text, oversize response, empty URL = no network call |
| `integration/PluginActionsIT` | 6 | plugin disabled, membership/removed/outsider, vote idempotency/change, option-of-other-poll, close creator/idempotency/closed vote, task assignee/complete/reopen/manager, translation 503/managed/TEXT/sticker/404, DB RLS/grants/FK/CHECK/indexes |
| `integration/E2eePluginActionsIT` | 1 | injected enabled toggle in E2EE still `422 PLUGIN_NOT_AVAILABLE`, no rows/audit |

Ключевые проверки:

* до enable: `GET/POST /polls`, `GET/POST /tasks`, translate → `422 PLUGIN_NOT_ENABLED`;
  строки и audit не появляются;
* `POST /polls` 201 → `Poll`; member видит `my_option_id=null`, после голоса — свой
  option, `total_votes=1`; смена голоса не удваивает; чужой option → 422; закрытый
  опрос → 422; не-создатель → 403;
* `POST /tasks` 201 → `Task`; assignee не-член чата/случайный UUID → 422; чужой member
  не может complete → 403; assignee/creator/ADMIN могут; повтор — без второго audit;
  reopen очищает completion; title/HTML/аудит без текста;
* translation: default provider → 503, `Retry-After: 30`, code
  `TRANSLATION_UNAVAILABLE`, ноль audit; bad target → 400; unknown/foreign message → 404;
  sticker → 422 `MESSAGE_NOT_TRANSLATABLE`;
* RLS: forced на всех 4 таблицах; grants точные; 5 индексов; прямой чужой
  `workspace_id` падает WITH CHECK; composite FK не даёт голосовать option другого poll;
  DB CHECK не даёт HTML; в схеме `plugin` нет функций;
* E2EE: даже вставленный напрямую `enabled=true` не открывает actions; ciphertext не
  читается, poll/task/audit строк нет.

Команды:

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 586, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchitectureTest: Tests run: 10, Failures: 0, Errors: 0

cd ../frontend
npm run api:types
npm run contract:check
# Contract check passed: 75 operations, 115 contract schemas; generated types in sync
```

## 5. Security

* **AuthN/AuthZ.** Все действия требуют bearer JWT + `X-Device-Id` (как `/chats/**`).
  ACTIVE workspace + chat membership; роль берётся из БД (`chat.chat_members`), не из
  JWT/тела. Plugin toggle — отдельный обязательный bar.
* **Existence hiding.** Unknown/deleted/foreign chat/poll/task/message → `404`; известный
  чат с недостаточной ролью → `403`. `assignee_id` не раскрывает существование
  пользователя: не-член → `422`, без списка пользователей.
* **Actor из аутентификации.** `user_id`/`creator_id`/`completed_by` не принимаются из
  тела; assignee — только проверенный id.
* **E2EE fail-closed.** MANAGED-only плагины недоступны в E2EE; ciphertext/keys не
  читаются; translation не пытается расшифровывать.
* **Input.** Bind-параметры/SQL без конкатенации; UUID path params; plain-text rules +
  DB CHECK; bounded lists (100).
* **External calls.** Только при явно заданном `krug.plugins.translate.url`; по
  умолчанию — ноль сетевых вызовов. Timeout/размер ответа ограничены; текст не
  логируется; секретов нет.
* **Audit.** Только action + ids; hash-chain/append-only не менялись.
* **No plugin execution.** Нет runtime/sandbox/RPC/capability-JWT/установки.

## 6. Риски / follow-up

1. **Нет WS-событий** `poll.*` / `task.*`: другие участники увидят изменения после
   refetch. Realtime/outbox не входил в #76.
2. **Нет cursor-пагинации**: списки ограничены 100 последними; для больших чатов нужен
   cursor (аналогично остальным list-эндпоинтам).
3. **Нет кэша переводов** (опционален по ТЗ); каждый успешный запрос идёт к провайдеру.
4. **Контракт провайдера — внутренний**: `POST {url}` `{"text","target"}` →
   `{"text"}`. Внешние API (DeepL/Google) требуют отдельного адаптера/секрета; в этом
   срезе секретов нет.
5. **Нет отдельного rate limit** на actions; защита — membership + plugin toggle.
   При необходимости — edge/Redis limiter (как follow-up #69).
6. **`due_at` не ограничен будущим**: принимается любой валидный timestamp (deadline в
   прошлом не запрещён продуктово).
7. **`closed=false` / переоткрытие опроса** намеренно не поддержано — только закрытие
   создателем; код `POLL_STATE_INVALID`.
8. **V36 отсутствует** в дереве; V37 — следующая свободная версия после V35, без
   пропуска занятых номеров.

## 7. Изменённые файлы

Backend main:

* `backend/src/main/resources/db/migration/V37__plugin_actions_polls_tasks.sql`
* `backend/src/main/resources/application.yml` (секция `krug.plugins.translate`)
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/model/{Poll,PollOption,ChatTask}.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/service/PluginTextPolicy.java`
* `backend/src/main/java/ru/krug/backend/plugin/domain/repository/{PollRepository,ChatTaskRepository,ChatPluginRepository}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/port/{PluginChatAccessPort,TranslationProviderPort,TranslationUnavailableException}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/model/{PollView,PollOptionView,TaskView,TranslationView}.java`
* `backend/src/main/java/ru/krug/backend/plugin/application/usecase/{PluginActionGate,PollService,TaskService,TranslateMessageService}.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/persistence/{PollRepositoryAdapter,ChatTaskRepositoryAdapter,ChatPluginRepositoryAdapter}.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/adapter/PluginChatAccessAdapter.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/config/TranslationProperties.java`
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/translation/HttpTranslationProvider.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/PluginActionsController.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/dto/{PollOptionResponse,PollResponse,PollListResponse,PollCreateRequest,PollVoteRequest,PollCloseRequest,TaskResponse,TaskListResponse,TaskCreateRequest,TaskUpdateRequest,TranslationRequest,TranslationResponse}.java`
* `backend/src/main/java/ru/krug/backend/plugin/api/mapper/PluginActionsApiMapper.java`

Backend tests:

* `backend/src/test/java/ru/krug/backend/unit/PluginActionsDomainTest.java`
* `backend/src/test/java/ru/krug/backend/unit/HttpTranslationProviderTest.java`
* `backend/src/test/java/ru/krug/backend/integration/PluginActionsIT.java`
* `backend/src/test/java/ru/krug/backend/integration/E2eePluginActionsIT.java`

Contracts / generated:

* `contracts/openapi.yaml`
* `frontend/src/api/schema.d.ts` (регенерация)
* `backend/PLUGIN-ACTIONS-REPORT.md` (этот файл)

## 8. Приёмка #76

| Пункт | Статус |
|---|---|
| Contract: polls GET/POST/votes/close, tasks GET/POST/PATCH, translate | ✅ |
| V37 `plugin.polls/options/votes/tasks`, RLS/grants/indexes/CHECK | ✅ |
| active membership; plugin enabled gate → `422 PLUGIN_NOT_ENABLED` | ✅ |
| poll creator close; one vote/user; idempotent change; option belongs to poll | ✅ |
| tasks create by member; complete by creator/assignee/OWNER/ADMIN; no arbitrary ids | ✅ |
| translate managed TEXT only; E2EE fail-closed; sanitize/no HTML | ✅ |
| no provider by default → `503 TRANSLATION_UNAVAILABLE` + Retry-After; no fake success | ✅ |
| optional configured provider: timeout/size; no content logs; no secrets | ✅ |
| audit only ids/action, never question/title/text | ✅ |
| tests: membership, disabled, votes, tasks, E2EE, 503, RLS | ✅ 15 new |
| full backend 571+ | ✅ **586/586** |
| ArchUnit | ✅ **10/10** |
| additive; no E2EE content; no plugin execution | ✅ |
| contract counts в отчёте | ✅ 63/75/115; guard зелёный |

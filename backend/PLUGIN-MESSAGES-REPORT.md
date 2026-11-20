# #95 — опрос/задача как тип сообщения в ленте

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Остальной `frontend/**` не редактировался. Рабочее дерево общее с параллельными
> срезами, поэтому счётчики контракта/тестов ниже — фактические на момент сдачи.

## Статус

**DONE в границах #95.**

* `Message.type` расширен значениями `POLL` и `TASK`; такие строки создаются **только
  сервером** в одной транзакции с `plugin.polls` / `plugin.tasks`.
* `POST /chats/{chatId}/polls` и `POST /chats/{chatId}/tasks` возвращают `message_id`,
  идемпотентный replay не создаёт второе сообщение/второй опрос/задачу.
* История, WS `message.created` (live и replay) и ответы чтения содержат `poll_id`/`poll`
  или `task_id`/`task`; `poll.my_option_id` считается для зрителя.
* Изменение голоса/закрытие опроса/выполнение задачи не переписывает сообщение и не
  тратит новый `seq`: встроенная проекция читается заново при следующем history/replay.
* `delete-for-all` работает как обычный message-tombstone; отдельного удаления
  опроса/задачи нет.
* E2EE fail-closed: серверный плагин в E2EE-чате недоступен, `POLL/TASK` не могут быть
  E2EE, тело (`body_ciphertext`) для них запрещено CHECK-констрейнтом.

### Нумерация миграции

Задача просила V49, но в общем дереве на момент сдачи уже существовали
`V49__overview_admin_exports_sessions_translation.sql` и
`V50__global_files_and_mentions.sql` от параллельных срезов; Flyway не допускает две
миграции с одной версией. Использована следующая свободная версия:
**`V51__plugin_messages_polls_tasks.sql`**. Содержимое соответствует требуемым
ограничениям V49.

## 1. Contract (additive)

`contracts/openapi.yaml`:

| Элемент | Изменение |
|---|---|
| `Message.type` | enum дополнен `POLL`, `TASK` (было `TEXT, STICKER, SYSTEM`) |
| `Message.poll_id` | `uuid \| null`, только для `type=POLL` |
| `Message.poll` | `Poll \| null`, встроенная viewer-relative проекция |
| `Message.task_id` | `uuid \| null`, только для `type=TASK` |
| `Message.task` | `Task \| null`, актуальное состояние задачи |
| `Poll.message_id` | optional uuid; присутствует в ответе create |
| `Task.message_id` | optional uuid; присутствует в ответе create |
| `OptionalIdempotencyKey` | новый reusable header parameter (`required: false`) для create poll/task |
| `createPoll` / `createTask` 201 | описание: сообщение создаётся в той же транзакции; replay → `Idempotent-Replay: true` |

`MessageCreate.type` **не** расширялся: `POLL`/`TASK` нельзя создать клиентским
`POST /chats/{id}/messages` (запрос отклоняется 400). Новых путей/операций/схем нет —
только аддитивные поля и enum-значения.

`contracts/ws-protocol.md`: `message.created` payload для `POLL/TASK` документирован как
flat `Message` с `poll_id`/`poll`/`task_id`/`task`; tombstone не несёт `poll`/`task`.

Проверка: `npm run contract:check` — **144 operations / 191 schema**, generated types in
sync. (Рост относительно #76 — вклад параллельных срезов; #95 добавил 0 операций и 0 схем.)

`frontend/src/api/schema.d.ts` регенерирован через `npm run api:types`.

## 2. Миграция V51

`backend/src/main/resources/db/migration/V51__plugin_messages_polls_tasks.sql`.

### Колонки

`message.messages` (partitioned parent; ALTER клонируется на все существующие и будущие
партиции):

| Колонка | Тип | Ограничение |
|---|---|---|
| `poll_id` | `uuid NULL` | FK → `plugin.polls(id) ON DELETE CASCADE` |
| `task_id` | `uuid NULL` | FK → `plugin.tasks(id) ON DELETE CASCADE` |

### CHECK-констрейнты

| Имя | Смысл |
|---|---|
| `ck_messages_type` | `TEXT, STICKER, SYSTEM, POLL, TASK` (старое значение заменено) |
| `ck_messages_poll_exactly_one` | `POLL` ⇒ `poll_id NOT NULL AND task_id NULL` |
| `ck_messages_task_exactly_one` | `TASK` ⇒ `task_id NOT NULL AND poll_id NULL` |
| `ck_messages_plugin_refs_only` | не-`POLL/TASK` ⇒ оба id `NULL` |
| `ck_messages_poll_no_body` / `ck_messages_task_no_body` | `body_ciphertext IS NULL` |
| `ck_messages_plugin_managed_only` | `POLL/TASK` ⇒ `crypto_scheme='MANAGED'` |

### Same-tenant/chat backstop

Простой FK по `poll_id`/`task_id` не может включить `workspace_id/chat_id` (partitioned
parent не имеет глобального composite unique). Поэтому добавлен
`BEFORE INSERT` trigger `message.enforce_plugin_message_target()` (SECURITY DEFINER):
он достаёт `workspace_id/chat_id` опроса/задачи и падает `POLL_OTHER_CHAT` /
`TASK_OTHER_CHAT`, если ссылка из другого тенанта/чата. FK остаётся backstop-ом
существования, trigger — backstop-ом принадлежности.

Индексы: `ix_messages_poll (poll_id) WHERE poll_id IS NOT NULL`,
`ix_messages_task (task_id) WHERE task_id IS NOT NULL`.

RLS/grants не менялись: это те же партиции `message.messages`; `plugin.polls/tasks`
уже FORCE RLS из V37. Rollback-план (forward-only, destructive) — в конце файла.

## 3. Создание: poll/task + сообщение атомарно

```
PluginActionsController
  └─ PollService.create / TaskService.create        (@Transactional)
       ├─ PluginActionGate (membership, plugin, E2EE fail-closed)
       ├─ permission/assignee validation
       ├─ IdempotencyPort.reserve(scope, key, requestHash)
       ├─ repository.create(entity)
       ├─ PluginMessagePort.createPollMessage/createTaskMessage
       │    └─ PluginMessageService (message application, @Transactional)
       │         ├─ seqAllocator.nextSeq(chat)
       │         ├─ Message.createPoll/createTask (no body, no client_message_id)
       │         ├─ messageRepository.save
       │         ├─ MessageView + embedded projection
       │         ├─ outbox "message.created"
       │         └─ MessageCreatedNotification (AFTER_COMMIT → WS)
       ├─ audit (ids only)
       └─ IdempotencyPort.complete(resourceId = messageId)
```

* `message_id` — idempotency-ресурс. Replay читает сообщение по `resourceId`, берёт
  `poll_id`/`task_id` и возвращает исходный `Poll`/`Task` + `message_id` с заголовком
  `Idempotent-Replay: true`. Новые строки не создаются.
* `Idempotency-Key` для create poll/task **опционален** (обратная совместимость с уже
  существующим фронтендом); без заголовка сервер генерирует свежий ключ. С заголовком
  retry с тем же телом — replay; другое тело с тем же ключом — `409
  IDEMPOTENCY_KEY_REUSED`.
* Библиотека/слой: `PluginMessagePort` (plugin.application.port) реализован
  `PluginMessageAdapter` (plugin.infrastructure) поверх
  `PluginMessageService` (message.application). Домен и application не импортируют
  чужие контексты напрямую; ArchUnit проходит.
* E2EE: `PluginMessageService` повторно проверяет `securityMode` и отвечает
  `422 PLUGIN_NOT_AVAILABLE`, даже если будущий вызывающий забудет gate. Тело не
  пишется ни в каком виде.

## 4. Чтение и встроенная проекция

`MessageView` получил `MessagePluginContent(pollId, EmbeddedPollView, taskId,
EmbeddedTaskView)`; `MessageResponse` — поля `poll_id`, `poll`, `task_id`, `task`
(`@JsonInclude(NON_NULL)`, поэтому TEXT/STICKER/SYSTEM не меняются).

* `MessageQueryHandler.enrich` одним batch-запросом на каждый вид подтягивает poll/task
  для страницы (без N+1) и передаёт `viewerId`; `poll.my_option_id` — выбор вызывающего.
* `RealtimeChatHistoryAdapter.after` делает то же для replay-окна; live-событие
  получает встроенную проекцию из `MessageCreatedNotification` (создаётся в той же
  транзакции, когда poll/task уже вставлены).
* `RealtimeEventFactory` пишет `poll_id/poll/task_id/task` в flat payload.
* `/sync` остаётся seq/unread-моделью: создание poll/task увеличивает `last_seq`
  чата, но объектов сообщений sync не возвращает by design. Встроенная проекция
  доступна в `GET /chats/{id}/messages` и WS replay.
* Завершение задачи/голос/закрытие опроса не порождают `message.updated`: следующее
  чтение/replay отдаёт актуальные `task.done/completed_*` и `poll.closed/total_votes`.

### Tombstone и удаление

Отдельного DELETE опроса/задачи нет. `DELETE /messages/{id}?scope=all` работает как
обычный tombstone: `deleted_at` заполнен, `text`, `poll`/`task` и вложенные метаданные
не возвращаются, строка и `seq` остаются для места в ленте. FK `ON DELETE CASCADE`
страхует будущие maintenance-удаления сущностей от «висячей» ссылки.

## 5. Тесты

Добавлено 6 тестовых методов (+1 усиление существующего E2EE-теста):

| Класс | + | Покрытие |
|---|---:|---|
| `PluginMessagesIT` | 5 | create → message в history; idempotent replay без дублей; vote/close без нового seq; viewer-relative `my_option_id`; task completion/reopen в embedded task; tombstone; permission/disabled plugin; client POST `type=POLL/TASK` → 400; DB CHECK/FK/trigger; RLS другого тенанта |
| `RealtimeWebSocketIT` | 1 | live `message.created` для POLL и TASK; replay после vote/completion с актуальной проекцией; vote не порождает второе сообщение |
| `E2eePluginActionsIT` | +assert | E2EE отклоняет poll/task до записи, `messageCount=0` |

Ключевые проверки #95:

* `message.messages`: `type`, `poll_id/task_id`, `body_ciphertext IS NULL`, `seq`,
  sender, `client_message_id IS NULL`; `chat_counters.next_seq` увеличивается ровно на 1
  на create и не меняется от vote/close/task update.
* replay: тот же `poll.id`/`message_id`, `pollCount=1`, `messageCount=1`, audit=1;
  другой body с тем же ключом → 409.
* RLS: `inTenant` другого workspace не видит POLL-сообщение; свой — видит.
* Прямой SQL: чужой poll/chat → `POLL_OTHER_CHAT`; `TASK` с `poll_id` → CHECK;
  `POLL` с `body_ciphertext` → CHECK.

### Результаты прогонов (JDK 21, PostgreSQL 16 Testcontainers)

* Целевой прогон #95 в общем дереве:
  `PluginMessagesIT` **5/5**, `RealtimeWebSocketIT#pollAndTask...` **1/1**,
  `ArchitectureTest` **10/10**.
* Регрессия: `PluginActionsIT`, `E2eePluginActionsIT`, `MessageApiIT`, `ThreadsIT`,
  `StickerMessageIT`, `MigrationsIT`, `IdempotencyIT`, `ArchitectureTest` — **56/56**.
* Полный backend suite в изолированной копии (чтобы не пересекаться с параллельными
  агентами по `target/`): **900 тестов, 895 passed**, 5 failures в чужих in-flight
  срезах (`MessageSearchIT`, `WorkspaceFilesIT`, `MentionsIT`, `MentionsE2eeIT`).
  Все тесты #95, `PluginMessagesIT`, `RealtimeWebSocketIT` (11/11) и ArchUnit 10/10 —
  зелёные. Финальный client-API тест добавлен после этого прогона и проверен отдельно
  (`PluginMessagesIT` 5/5); эффективный размер suite — 901. Предыдущий полный прогон
  дал 873 теста и 2 падения в `AdminSessionsIT`, которые после правок параллельного
  среза проходят (проверено отдельно: 3/3).

## 6. Совместимость

* `TEXT`/`STICKER`/`SYSTEM`/threads/E2EE-pipeline не менялись; новые поля ответа
  отсутствуют у старых типов благодаря `NON_NULL`.
* `MessageCreate` по-прежнему принимает только `TEXT`/`STICKER`; сообщения `POLL/TASK`
  нельзя подделать клиентским POST.
* Плагины остаются данными/политиками: код плагинов не исполняется.
* Audit для create по-прежнему содержит только id/action; вопрос, варианты, title,
  assignee и текст в audit не попадают.
* Ограничение: `/sync` не содержит объектов сообщений (исторически seq/unread);
  встроенный poll/task доступен в history и WS replay, а seq синхронизации учитывает
  созданное сообщение.
* Frontend follow-up (вне зоны #95, разрешён только `schema.d.ts`): текущий
  `frontend/src/store/chatStore.ts::readApiMessage` принимает только
  `TEXT/STICKER/SYSTEM` и отбросит `POLL/TASK`, а `MessageList`/`MessageRow` пока не
  рендерят встроенные карточки. Контракт и сгенерированные типы готовы; для отображения
  нужен отдельный frontend-срез, который расширит этот guard и добавит карточки
  `poll`/`task` (поля `poll_id/poll/task_id/task` уже приходят в REST и WS).

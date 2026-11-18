# D1-BE1 — flat threads (contract C1 + backend BE1)

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/**`, регенерация `frontend/src/api/schema.d.ts`. Остальной `frontend/**`,
> `docs/**`, `design/**`, `deploy/**` не менялись; порт `8080` не трогался. Git-репозитория
> в рабочем дереве нет, поэтому «одним PR» проверить нельзя — изменения согласованы в
> рабочем дереве.

## Статус

**DONE в границах D1-C1 + D1-BE1.** Реализованы треды как плоское дерево глубины 1
(`docs/TASKS-DASHBOARD-V1.md` §3.2, §5):

* `Message.thread_root_id`, `Message.thread_summary`;
* `MessageCreate.thread_root_id`;
* `GET /chats/{chatId}/messages?thread_root_id=<uuid>` — ответы одного треда;
  без параметра — только основная лента (`thread_root_id = null`);
* `message.created` в WS несёт `thread_root_id` (live и replay);
* миграция V28: колонка, CHECK-инварианты, композитный индекс
  `(chat_id, thread_root_id, seq)`, DB-backstop на same-chat/depth-1;
* managed-only и E2EE-reject (`THREADS_E2EE_UNSUPPORTED`), без E2EE-превью;
* summary одним window-запросом на страницу, без N+1.

Полный backend suite — **467/467**, `ArchitectureTest` — **10/10** (JDK 21).
`frontend/src/api/schema.d.ts` регенерирован; `npm run contract:check` зелёный.

## 1. Contract (additive)

`contracts/openapi.yaml`:

* `Message`:
  * `thread_root_id: uuid|null` — корень треда; `null` для сообщения основной ленты;
  * `thread_summary: object|null` — только для корня, managed; поля `reply_count`
    (`integer`, `minimum: 0`), `last_reply_at`, `last_reply_author_id`,
    `last_reply_excerpt` (`maxLength: 160`). Для корня без ответов отдаётся объект с
    `reply_count = 0`; для ответа/E2EE — `null`;
* `MessageCreate.thread_root_id: uuid|null` — ответ в тред; описание фиксирует
  same-chat/depth-1/E2EE-запрет;
* `GET /chats/{chatId}/messages`:
  * новый query-параметр `thread_root_id: uuid`;
  * уточнено: без параметра — только `thread_root_id = null`, с параметром — ответы
    одного треда с той же `after_seq`/`before_seq`/`limit` семантикой;
  * добавлен ответ `422` (невалидный/удалённый/вложенный корень, E2EE);
* `POST /chats/{chatId}/messages` — описание валидации корня и кодов
  `THREAD_*`/`THREADS_E2EE_UNSUPPORTED`;
* `Error.code` — в описание добавлены D1-коды: `THREAD_ROOT_NOT_FOUND`,
  `THREAD_ROOT_DELETED`, `THREAD_NESTING_UNSUPPORTED`, `THREADS_E2EE_UNSUPPORTED`.

`contracts/ws-protocol.md`:

* `message.created` payload — `Message` из OpenAPI, `thread_root_id` присутствует всегда
  (nullable); `thread_summary` в WS не входит (сервер считает его только в REST, клиент
  инкрементирует счётчик локально);
* replay/live содержит **все** сообщения чата, включая ответы тредов; REST-лента без
  `thread_root_id` отдаёт только корни;
* пример плоского payload обновлён.

**Фактические счётчики контракта:** было **47 paths / 55 operations / 87 schemas**,
стало **47 / 55 / 87** — новых path/operation/schema нет, изменения только additive
в существующих схемах. `openapi-typescript` синхронен; `frontend/src/api/schema.d.ts`
обновлён через `npm run api:types`.

## 2. V28 — схема, индекс и DB-backstop

`backend/src/main/resources/db/migration/V28__message_threads.sql`:

* `message.messages.thread_root_id uuid` (nullable). Колонка на партиционированной
  родительской таблице, автоматически появляется во всех партициях;
* `ck_messages_thread_no_self`: `thread_root_id IS NULL OR thread_root_id <> id` —
  сообщение не может быть корнем само себе;
* `ck_messages_e2ee_no_thread_root`: E2EE-строка не может нести `thread_root_id`
  (DB-страховка поверх API-валидации);
* `ix_messages_chat_thread_seq (chat_id, thread_root_id, seq)` — thread-страницы
  (`WHERE chat_id = ? AND thread_root_id = ? AND seq ...`) и summary; при создании на
  partitioned parent индекс клонируется на все существующие и будущие партиции
  (`CREATE TABLE ... PARTITION OF` наследует индексы и триггеры — проверено на PG16);
* `message.enforce_thread_root()` + `trg_messages_thread_root` (BEFORE INSERT):
  * корень существует в том же `workspace_id`;
  * корень в том же чате;
  * корень сам не является ответом (depth 1);
  * корень не soft-deleted;
  * корень не E2EE.
  Нарушения дают SQLSTATE `23514` и тексты `THREAD_ROOT_NOT_FOUND`,
  `THREAD_ROOT_OTHER_CHAT`, `THREAD_NESTING_UNSUPPORTED`, `THREAD_ROOT_DELETED`,
  `THREADS_E2EE_UNSUPPORTED`. Функция `SECURITY DEFINER` с фиксированным `search_path`,
  `EXECUTE` только `krug_app`, `PUBLIC` отозван; workspace-предикат явный, поэтому
  cross-tenant корень не находится;
* **Почему не FK:** `message.messages` — RANGE-partitioned по `created_at`; глобального
  уникального ключа по `id` нет, а self-FK потребовал бы `(id, created_at)`, которого
  клиент не знает. Это та же предпосылка, что задокументирована в V4. Поэтому integrity
  держат application-валидация (типизированные 422) + trigger/CHECK backstop;
* rollback (forward-only): удалить trigger, функцию, индекс, два CHECK и колонку;
  данные о тредах при этом теряются, поэтому rollback — только вместе с откатом
  frontend-фичи.

## 3. Backend

```
message/domain/model          Message (+threadRootId), ThreadSummary, ThreadSummary.empty
message/domain/service        MessageThreadPolicy (same chat, depth 1, deleted, E2EE)
message/domain/repository     MessageRepository (+main/thread page, summaries)
message/infrastructure/...    MessageEntity/MessagePersistenceMapper (+thread_root_id)
                              MessageJpaRepository (+8 scoped page queries)
                              MessageRepositoryAdapter (+window summary query)
message/application/...       MessageView/MessageCreateInput/ListMessagesQuery
                              MessageQueryHandler (root validation + summaries)
                              MessageSubmissionHandler (send validation, E2EE reject)
message/api                   MessageController (+query param), DTO (+thread fields)
realtime/...                  MessageSnapshot/RealtimeEventFactory (+thread_root_id)
```

* **Send.** `thread_root_id` проходит `MessageThreadPolicy` до аллокации seq:
  unknown/foreign → `422 THREAD_ROOT_NOT_FOUND`; корень-ответ →
  `422 THREAD_NESTING_UNSUPPORTED`; удалённый корень → `422 THREAD_ROOT_DELETED`;
  E2EE → `422 THREADS_E2EE_UNSUPPORTED`. Право записи — существующий
  `ChatAccessPort.requireActiveChat` (активное членство; отдельного read-only ACL в
  текущем срезе нет). Ошибка откатывает транзакцию: seq/идемпотентность/лимиты не
  оставляют мусора.
* **Idempotency.** `requestHash` добавляет `thread_root_id` только когда он non-null:
  старые managed-запросы без треда сохраняют прежний hash и реплеятся; новый
  `thread_root_id` меняет hash. `sameContent` сравнивает `threadRootId`, поэтому тот же
  `client_message_id` с другим корнем — `409 CLIENT_MESSAGE_ID_CONFLICT`.
* **List.** Без `thread_root_id` — `findMainPage` (`thread_root_id IS NULL`), с
  параметром — `findThreadPage` по корню. Обе выборки используют те же
  `after_seq`/`before_seq`/`limit` и `MessagePageCursor`; порядок — seq. Root
  валидируется тем же `MessageThreadPolicy`; E2EE-чат с параметром → 422.
* **Summary.** После `enrich` один native window-запрос на страницу:
  `count(*) OVER (PARTITION BY thread_root_id)` + `row_number() OVER (... ORDER BY seq
  DESC)`; берётся последний живой ответ (deleted_at IS NULL). Summary получает каждый
  managed-корень (`reply_count = 0`, если ответов нет), ответы — `null`; E2EE-ветка
  summary не вызывает вовсе. Excerpt расшифровывается только для `MANAGED`, новые
  строки и табы схлопываются, обрезка — по Unicode code points до 160 (не рвёт
  surrogate pair); ошибка расшифровки одной строки не валит всю ленту.
* **WS.** `message.created` получает `thread_root_id` и в live (`MessageSnapshot` из
  `MessageView`), и в replay (`RealtimeChatHistoryAdapter`). Replay по-прежнему отдаёт
  все сообщения, включая ответы; outbox-payload также содержит поле.
* **E2EE.** Треды не поддерживаются: send/list отвечают `THREADS_E2EE_UNSUPPORTED`
  (422; при выключенном E2EE-флаге — существующий `409 E2EE_DISABLED`), summary не
  считается, plaintext-excerpt не покидает сервер, DB CHECK запрещает строку.
* **Audit/limits.** Не менялись: audit для сообщений в этом срезе не пишется,
  `RateLimitPort.checkMessageSend` и seq-аллокатор работают как раньше.

## 4. Tests

Добавлено **14 тестов** (453 → 467):

| Класс | + | Что покрыто |
|---|---:|---|
| `ThreadsIT` | 6 | send/list main↔thread, cursor/limit/after/before, summary+excerpt+truncate+deleted last reply, typed validation, idempotency/client_message_id, schema/index/trigger backstop, RLS |
| `ThreadDomainTest` | 4 | thread root в domain, self/nesting, E2EE-инвариант, excerpt/negative count |
| `E2eeMessageIT` | 1 | send и list с `thread_root_id` → 422 `THREADS_E2EE_UNSUPPORTED`, seq/row не созданы |
| `RealtimeWebSocketIT` | 1 | live и replay `message.created` несут `thread_root_id` (root → null, reply → uuid) |
| `MigrationsIT` | 1 | V28 column/2 CHECK/trigger/partitioned index на всех партициях |
| `ContractValidationIT` | 1 | `Message`/`MessagePage` с непустым `thread_summary` валидны по OpenAPI |

Ключевые проверки:

* main feed после двух ответов содержит только корень; thread-страница — ровно ответы
  (DESC по умолчанию, ASC с `after_seq`, `before_seq`/`limit`/`next_cursor`);
* summary: `reply_count`, `last_reply_at`, `last_reply_author_id`, excerpt 160 code
  points, перенос строки схлопнут; после soft-delete последнего ответа превью
  переключается на предыдущий живой;
* невалидные корни: unknown, другой чат, другое workspace, корень-ответ, удалённый
  корень, E2EE; во всех случаях сообщение не создано;
* DB backstop прямым SQL: `THREAD_ROOT_NOT_FOUND`, `THREAD_NESTING_UNSUPPORTED`,
  `THREAD_ROOT_OTHER_CHAT`, `THREAD_ROOT_DELETED`, `ck_messages_e2ee_no_thread_root`;
* RLS: под tenant A видны только ответы A, ответ на корень B прямым SQL отклоняется;
* `ArchitectureTest` 10/10; domain не зависит от infrastructure/api, application не
  использует JPA, API не видит domain.

Команды:

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 467, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS

cd ../frontend
npm run api:types
npm run contract:check
# Contract check passed: 55 operations, 87 contract schemas
```

## 5. Security

* **Authorization.** Корень ищется только после `requireActiveChat` (активное членство в
  workspace и чате); чужой/несуществующий корень неотличимы (`THREAD_ROOT_NOT_FOUND`),
  существование чужих сообщений не раскрывается.
* **RLS.** Политики не ослаблены: `thread_root_id` живёт в той же партиционированной
  таблице с tenant-политикой; summary-запрос выполняется под tenant GUC. Trigger —
  `SECURITY DEFINER` с явным `workspace_id` и фиксированным `search_path`.
* **E2EE.** Сервер не строит plaintext-превью: `thread_summary` для E2EE не
  считается/не отдаётся, replies запрещены на API (422/409) и на DB CHECK. E2EE-флаг
  в этом срезе `false`; managed-треды от него не зависят.
* **Input.** `thread_root_id` парсится каноническим UUID-десериализатором; глубина 1,
  self-reference, deleted root и cross-chat проверяются и в приложении, и в БД.
* **Excerpt.** Только managed; нормализация whitespace + обрезка 160 code points; сервер
  не вставляет текст в SQL/HTML/пути; отсутствие excerpt у sticker/E2EE — честный null.
* **Идемпотентность.** Хеш включает корень только при его наличии; повтор с другим
  корнем не становится replay. Старые ключи без треда сохраняют прежний hash.
* **Audit/limits.** Не расширялись и не ослаблялись; тред-ответ — обычное сообщение в
  том же seq/rate-limit/attachment pipeline.

## 6. Риски / follow-up

1. **FK нет by design.** Из-за партиционирования по `created_at` self-FK невозможен без
   `created_at` в ключе; same-chat/depth-1 держат application-валидация и trigger.
   Trigger — last line of defence, а не замена типизированным 422.
2. **Миграция на большой БД.** `CREATE INDEX` (не CONCURRENTLY) и `ADD CHECK` берут
   блокировки на parent/партиции. На проде — окно обслуживания или `NOT VALID` +
   `VALIDATE CONSTRAINT` / `CREATE INDEX CONCURRENTLY` отдельной ops-миграцией.
3. **Unread/last_seq включают ответы**, а main feed их не показывает: бейдж может быть
   больше числа видимых корней. Это осознанно (unread не меняли); продуктовое решение
   по «непрочитанным в тредах» — D1.1.
4. **Soft-deleted сообщения.** Thread list, как и существующий list, отдаёт строки с
   `deleted_at`; summary считает только живые ответы. UI должен фильтровать deleted.
   Удалённый корень: thread API → 422 `THREAD_ROOT_DELETED`, но корень может остаться в
   main feed (текущая лента не фильтрует deleted) — FE должен показать состояние.
5. **Summary — дополнительный запрос на страницу** (один window-запрос + decrypt до
   `limit` превью). Индекс покрывает; при росте — кэш счётчика/превью в D1.1.
6. **WS replay отдаёт ответы** в общем seq-потоке. Клиенты, ещё не знающие
   `thread_root_id`, должны игнорировать/складывать их; это зона D1-FE3.
7. **Нет отдельного kill-switch тредов** в этом срезе: E2EE отсекается always-on,
   managed-треды включены. Если нужен серверный feature flag — отдельная конфигурация
   `krug.threads.enabled` + тесты (D1-FE/ops).
8. **Sticker как последний ответ** даёт `last_reply_excerpt = null` при
   `reply_count > 0`; FE использует fallback («стикер»/иконку). Контракт это допускает.
9. **Курсор не привязан к треду:** `next_cursor` — seq, его можно передать в другой
   thread-запрос того же чата; авторизация пересчитывается, утечки нет, но клиенту
   следует хранить курсор вместе с `thread_root_id`.
10. **Триггер требует PG13+** (BEFORE ROW на partitioned parent); проект на PG16,
    зафиксировано в тестах.

## 7. Изменённые файлы

Backend:

* `backend/src/main/resources/db/migration/V28__message_threads.sql`
* `backend/src/main/java/ru/krug/backend/message/domain/model/{Message,ThreadSummary}.java`
* `backend/src/main/java/ru/krug/backend/message/domain/service/MessageThreadPolicy.java`
* `backend/src/main/java/ru/krug/backend/message/domain/repository/MessageRepository.java`
* `backend/src/main/java/ru/krug/backend/message/infrastructure/persistence/{MessageEntity,MessageJpaRepository,MessagePersistenceMapper,MessageRepositoryAdapter}.java`
* `backend/src/main/java/ru/krug/backend/message/application/model/{MessageView,MessageCreateInput,ThreadSummaryView}.java`
* `backend/src/main/java/ru/krug/backend/message/application/command/ListMessagesQuery.java`
* `backend/src/main/java/ru/krug/backend/message/application/usecase/{MessageQueryHandler,MessageSubmissionHandler,SendMessageUseCase}.java`
* `backend/src/main/java/ru/krug/backend/message/api/MessageController.java`
* `backend/src/main/java/ru/krug/backend/message/api/dto/{MessageCreateRequest,MessageResponse,ThreadSummaryResponse}.java`
* `backend/src/main/java/ru/krug/backend/message/api/mapper/MessageApiMapper.java`
* `backend/src/main/java/ru/krug/backend/realtime/application/model/MessageSnapshot.java`
* `backend/src/main/java/ru/krug/backend/realtime/application/service/RealtimeEventFactory.java`
* `backend/src/main/java/ru/krug/backend/realtime/infrastructure/{event/RealtimeMessageCreatedListener,adapter/RealtimeChatHistoryAdapter}.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`
* tests: `ThreadsIT`, `ThreadDomainTest`, `E2eeMessageIT`, `RealtimeWebSocketIT`,
  `MigrationsIT`, `ContractValidationIT`, `WebSocketIntegrationTestBase`.

Contracts / generated:

* `contracts/openapi.yaml`
* `contracts/ws-protocol.md`
* `frontend/src/api/schema.d.ts` (regenerated only)

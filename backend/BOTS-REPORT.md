# #96 — боты как в Slack (MVP backend)

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Дополнительно обновлён `frontend/scripts/check-contract.mjs` — это contract-guard, который
> жёстко фиксирует число paths/operations/schemas; без него любой новый endpoint валит CI.
> Остальной `frontend/**` не редактировался. Рабочее дерево общее с параллельными срезами,
> поэтому счётчики ниже — фактические на момент сдачи.

## Статус

**DONE в границах #96 (MVP backend).**

* `POST /workspaces/{id}/bots` создаёт бота и **один раз** возвращает bearer-токен;
  в БД лежит только `SHA-256` hash (`bot.bots.token_hash bytea`), открытый токен не
  сохраняется, не логируется и не попадает в audit.
* Полный lifecycle: список, `PATCH` (имя/scopes/статус/аватар), `DELETE` = disable,
  отдельная ротация токена (`POST .../token`).
* Установка в чат (`POST /chats/{chatId}/bots`, `DELETE`) — только chat OWNER/ADMIN;
  список установленных ботов доступен любому ACTIVE-участнику чата.
* `POST /bots/{botId}/messages` — единственный bot-token endpoint. Сообщение создаётся
  как `sender_type=BOT` с `bot_id` и именем бота, **без** `sender_id`/device (impersonation
  невозможна), с idempotency и отдельным rate limit.
* Бот не может читать сообщения, звонить, работать с файлами/загрузками или вызывать
  пользовательские/админские API: его токен принимает только отдельная security-цепочка
  `/api/v1/bots/**`.
* `bot.bots` и `bot.chat_bots` — FORCE RLS; сообщения остаются в партиционированной
  `message.messages` с новыми колонками `sender_type`/`bot_id`.
* E2EE отсутствует: бот не устанавливается в E2EE-чат и не может туда писать
  (`422 BOT_E2EE_UNSUPPORTED`), а `BOT`-строка в БД обязана быть `MANAGED`.
* Полный backend suite: **963 tests, 0 failures/errors**; ArchUnit **10/10**;
  contract-guard: **155 operations / 126 paths / 204 schemas**, generated types in sync.

## 1. Миграция

Задача просила V53; на момент сдачи `V52__music_room_plugin.sql` уже занят, поэтому
использована следующая свободная версия — **`V53__bots.sql`**.

### `bot.bots`

| Колонка | Тип / ограничение |
|---|---|
| `id` | `uuid PK` |
| `workspace_id` | `uuid NOT NULL REFERENCES workspace.workspaces ON DELETE CASCADE` |
| `name` | `text NOT NULL CHECK (1..80)` |
| `avatar_file_id` | `uuid REFERENCES file.attachments(id) ON DELETE SET NULL` |
| `token_hash` | `bytea NOT NULL CHECK (octet_length = 32)` — только SHA-256 |
| `scopes` | `text[] NOT NULL`, `cardinality >= 1`, `scopes <@ ARRAY['chat.write']` |
| `created_by` | `uuid NOT NULL`, без FK (удаление пользователя не стирает бота) |
| `status` | `ACTIVE / DISABLED` |
| `created_at`, `updated_at`, `token_rotated_at` | `timestamptz` |

`UNIQUE (workspace_id, id)`, индекс `(workspace_id, status, created_at DESC)`,
`ENABLE/FORCE ROW LEVEL SECURITY` + tenant policy, `GRANT SELECT/INSERT/UPDATE/DELETE
TO krug_app`. Колонок `token`, `raw_token`, `token_plain`, `secret` нет — это проверяется
в `MigrationsIT`.

### `bot.chat_bots`

`(chat_id, bot_id) PK`, `workspace_id` для RLS, `enabled boolean NOT NULL DEFAULT true`,
`installed_by`, `installed_at`, `updated_at`; composite FK
`(workspace_id, bot_id) → bot.bots(workspace_id, id) ON DELETE CASCADE`; trigger
`bot.enforce_chat_bot_workspace` не даёт установить бота в чат другого воркспейса.
RLS + grant как у `bot.bots`.

### `message.messages`

* `sender_type text NOT NULL DEFAULT 'USER'` (`USER`/`BOT`);
* `bot_id uuid NULL`;
* `ck_messages_bot_shape`: у `BOT` обязателен `bot_id`, а `sender_id`/`sender_device_id`
  обязаны быть `NULL`; у `USER` `bot_id` всегда `NULL`;
* `ck_messages_bot_managed`: `BOT` только `MANAGED` (никакого E2EE);
* `ck_messages_bot_text`: `BOT` — только `TEXT` с body, без reply/thread/sticker/poll/task;
* partial index `ix_messages_bot (bot_id) WHERE bot_id IS NOT NULL`;
* trigger `message.enforce_bot_message_sender` проверяет, что `bot_id` существует и
  принадлежит workspace сообщения (backstop для партиционированной таблицы).

## 2. API (additive)

| Метод | Путь | Права |
|---|---|---|
| `POST` | `/workspaces/{workspaceId}/bots` | workspace OWNER/ADMIN → `201 BotToken` (bot + one-time token) |
| `GET` | `/workspaces/{workspaceId}/bots` | любой ACTIVE-участник → `BotList`, без токенов |
| `PATCH` | `/workspaces/{workspaceId}/bots/{botId}` | OWNER/ADMIN: `name`, `scopes`, `status`, `avatar_file_id`/`clear_avatar` |
| `DELETE` | `/workspaces/{workspaceId}/bots/{botId}` | OWNER/ADMIN, идемпотентный disable → `204` |
| `POST` | `/workspaces/{workspaceId}/bots/{botId}/token` | OWNER/ADMIN → `200 BotToken`, старый токен сразу невалиден |
| `GET` | `/chats/{chatId}/bots` | ACTIVE-участник чата → `ChatBotList` |
| `POST` | `/chats/{chatId}/bots` | chat OWNER/ADMIN, `{bot_id}`, идемпотентно → `201 ChatBot` |
| `DELETE` | `/chats/{chatId}/bots/{botId}` | chat OWNER/ADMIN, идемпотентно → `204` |
| `POST` | `/bots/{botId}/messages` | **bot token**, `{chat_id,text}` + `Idempotency-Key` → `201 Message` |

`BotToken.token` имеет формат
`sova_bot_<workspace_id>_<bot_id>_<32 random bytes base64url>`. Workspace/bot id не
секретны: они позволяют фильтру активировать tenant RLS до чтения строки. Секрет — только
последняя часть (256 бит). Сравнение — `MessageDigest.isEqual` над SHA-256, т.е.
constant-time; неизвестный/битый/чужой/отключённый токен дают одинаковый `401`.

### Сообщение бота

* `type=TEXT`, `crypto_scheme=MANAGED`, `sender_type=BOT`, `bot_id=<id>`,
  `sender_id=null`, `sender_device_id=null`;
* `sender_display_name` — имя бота на момент отправки (snapshot, переименование бота не
  переписывает историю);
* `client_message_id=null` (idempotency живёт в `ops.idempotency_keys` под scope
  `bot.message` и `user_id=bot_id`);
* `Idempotent-Replay: true` при повторе с тем же телом, `409 IDEMPOTENCY_KEY_REUSED` при
  другом теле;
* сообщение проходит обычный managed-пайплайн: per-chat `seq`, шифрование body,
  `ops.outbox`, post-commit realtime/notification fan-out.

### Ошибки (коды)

`BOT_NOT_FOUND`, `BOT_DISABLED`, `BOT_NOT_INSTALLED`, `BOT_SCOPE_FORBIDDEN`,
`BOT_E2EE_UNSUPPORTED`, `BOT_AVATAR_INVALID`; credential-ошибки — `401 UNAUTHENTICATED`
(без раскрытия причины), rate limit — `429 RATE_LIMITED` + `Retry-After`.

## 3. Безопасность

* **Хранение**: только SHA-256 hash. `BotToken`/`IssuedBotToken` — единственные объекты с
  raw token; они не логируются, `BotTokens.Parsed.toString()` редактирует секрет.
* **Ротация**: новый hash и `token_rotated_at` пишутся в одной транзакции; старый токен
  сразу получает `401`.
* **Disable**: `DELETE` ставит `status=DISABLED`; токен немедленно перестаёт
  аутентифицироваться, но hash сохраняется. `PATCH status=ACTIVE` возвращает бота в строй
  с прежним токеном (осознанная семантика «disable», а не «revoke»; для гарантированного
  отзыва нужна ротация).
* **Rate limit**: отдельные окна `bot-send-per-bot` (60/60s) и `bot-send-per-chat`
  (10/1s), независимые от пользовательских. Replay не потребляет квоту.
* **Audit**: `bot.created`, `bot.updated`, `bot.disabled`, `bot.token.rotated`,
  `chat.bot.installed`, `chat.bot.uninstalled`; metadata содержит только id
  (`bot_id`, для установки — `bot_id`), без токена, hash и содержимого сообщений.
* **Нет surface для calls/files**: токен валиден только на `/api/v1/bots/**`, а там
  единственный контроллер — send. Пользовательская цепочка JWT отвечает `401` на bot token
  (проверено на `GET /chats/{id}/messages`, `POST /chats/{id}/messages`, `GET /files`,
  `GET /workspaces/{id}/bots`).
* **Impersonation**: `BOT`-строка не может иметь `sender_id`/device (DB CHECK + domain
  invariant); UI обязан рисовать бейдж по `sender_type`, а не по имени.
* **E2EE**: установка и отправка в E2EE-чат запрещены; `BOT`-строка обязана быть
  `MANAGED` (DB backstop).
* **RLS**: обе bot-таблицы FORCE RLS; cross-tenant insert в `bot.chat_bots` отклоняется
  RLS/trigger; без tenant GUC строки не видны.

## 4. Contract / UI

`contracts/openapi.yaml` (additive):

* tag `bots`; 6 новых paths и 9 операций (create/list/update/disable/rotate,
  install/listChat/uninstall, send);
* schemas: `Bot`, `BotCreateRequest`, `BotUpdateRequest`, `BotToken`, `BotList`,
  `ChatBotInstallRequest`, `ChatBot`, `ChatBotList`, `BotMessageCreate`;
* `Message.sender_type` (`USER|BOT`, default `USER`) и `Message.bot_id` (`uuid|null`) —
  UI-бейдж;
* `securitySchemes.botTokenAuth`; у `POST /bots/{botId}/messages` — только он;
* параметр `BotId`.

`contracts/ws-protocol.md`: `message.created` для бота — `sender_type=BOT`,
`sender_id=null`, `bot_id`, `sender_display_name`; E2EE bot-сообщений нет.

`frontend/src/api/schema.d.ts` регенерирован через `npm run api:types`;
`npm run contract:check` — **155 operations / 126 paths / 204 schemas**, in sync.

## 5. Тесты

Новые:

| Файл | Покрытие |
|---|---|
| `unit/BotDomainTest` (5) | формат/парсинг/хеш токена, redacted toString, нормализация scopes, name/scopes ошибки, disable/enable/rotate |
| `unit/BotMessageDomainTest` (3) | BOT-сообщение без user/device, `bot_id`, запрет BOT+E2EE/без bot_id |
| `unit/InMemoryRateLimiterTest` (+1) | отдельное per-bot окно и `429` scope=`bot` |
| `unit/RealtimeFrameContractTest` (+1) | WS payload `sender_type`/`bot_id`/`sender_id=null` |
| `integration/BotsIT` (9) | create + токен один раз, список без секретов, hash-only в БД, audit ids-only, OWNER/ADMIN, rotate/revoked, install идемпотентно + chat-права + E2EE + disabled, send/бейдж/idempotency/replay/conflict, no read/files, disable/enable, RLS + cross-tenant trigger |
| `integration/BotRateLimitIT` (1) | третий send → `429`, replay работает |
| `integration/MigrationsIT` (+1) | bot schema/tables/RLS/колонки/constraints/triggers |

Регрессия: `MessageApiIT`, `ContractValidationIT`, `ThreadsIT`, `MentionsIT`,
`PluginMessagesIT`, `RealtimeFrameContractTest`, `SubscriptionServiceTest`,
`MessageDomainTest`, `ThreadDomainTest` — зелёные.

Итог на момент сдачи: **963 tests, 0 failures, 0 errors**; **ArchUnit 10/10**
(контекст `bot` добавлен в `CONTEXTS`).

## 6. Ограничения MVP / следующие шаги

Не входит в #96 и явно не реализовано:

1. **Event subscriptions / webhooks / slash commands / interactive components** — только
   `chat.write`; бот не получает события и не читает историю.
2. **Bot read API** (`GET /bots/{id}/...`) и scopes `chat.read`/`files.*` — нужен новый
   scope, миграция и отдельная проверка.
3. **DLP для bot-сообщений**: `DlpGuardPort` пишет `actor_id` с FK на `auth.users`, а бот
   не пользователь; в MVP DLP-правила к bot-сообщениям не применяются (нужен отдельный
   bot-actor тип/аудит).
4. **Audit самих bot-сообщений**: `AuditAppenderService` жёстко пишет `actor_type=USER`;
   для audit отправок нужен `actor_type=BOT` (или content-free событие с null actor).
5. **Avatar serving** и загрузка аватара бота: есть `avatar_file_id` и валидация
   существующего изображения, но нет `GET /bots/{id}/avatar`/upload.
6. **`enabled=false` через API**: колонка есть, установка всегда `true`; отдельный
   enable/disable install — следующий шаг.
7. **Multi-node**: rate limiter и realtime fan-out in-memory (как и остальной MVP);
   Redis/Kafka — вне среза.
8. **Bot identity в `auth.users`**: намеренно нет; бот не участник чата, не звонящий и не
   владелец файлов.
9. **Редактирование/удаление bot-сообщений ботом**, вложения/стикеры/треды от бота — нет.

## 7. Rollback

Forward-only план — в шапке `V53__bots.sql`: удалить bot-сообщения, снять
constraints/колонки `sender_type`/`bot_id`, drop trigger/function, drop
`bot.chat_bots`/`bot.bots`/schema `bot`. Bot-строки и установки теряются; пользовательские
сообщения, чаты и файлы не затрагиваются. Application rollback — до миграции (эндпоинты
`/bots/**` и поля `sender_type`/`bot_id` исчезнут из контракта).

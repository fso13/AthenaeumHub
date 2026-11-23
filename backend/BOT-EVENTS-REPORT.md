# #98 — Slack-like боты, phase 2: события и slash-команды

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Дополнительно обновлён `frontend/scripts/check-contract.mjs` — contract-guard фиксирует
> точное число paths/schemas и список операций; без него любой новый endpoint/path валит
> `npm run contract:check`. Остальной `frontend/**` не редактировался.
> Рабочее дерево общее с параллельными срезами; счётчики ниже — фактические на момент сдачи.

## Статус

**DONE в границах #98 (backend).** Полный backend suite — см. §9 (фактический прогон).
ArchUnit **10/10**, contract-guard: **160 operations / 131 path / 212 schemas**, generated
types in sync.

Реализовано:

* подписки бота на `message.created` / `app_mention`, https-only `events_url`,
  `events_enabled` (алиас `enabled`), одноразовый показ и ротация signing secret;
* подписанные HMAC-SHA256 webhook-доставки (`X-Sova-Signature`, `X-Sova-Timestamp`) через
  durable outbox с retry/backoff, таймаутом 5 с, no-redirect и SSRF-защитой;
* content-free статусы доставок и `POST .../test-event` ping;
* slash-команды бота: регистрация в PATCH, вызов участником чата без сообщения в чат,
  одноразовый `response_url` (5 минут) и ответ ровно одним bot-сообщением;
* БД V54: конфигурация событий в `bot.bots`, `bot.event_deliveries`, `bot.command_tokens`,
  RLS/grants, encrypted secret/payload;
* тесты на подпись, retry/backoff, SSRF, redirect, app_mention, дедупликацию, slash-команды,
  one-time/expiry, permissions, RLS, ArchUnit.

## 1. Миграция V54

`V54__bot_events_commands.sql` (V53 занят ботами #96; V54 — следующая свободная версия).

### `bot.bots` (additive)

| Колонка | Тип / ограничение |
|---|---|
| `events_url` | `text NULL`, CHECK: `https://`, 9..2048, без userinfo/query/fragment |
| `event_types` | `text[] NOT NULL DEFAULT '{}'`, CHECK `<@ ARRAY['message.created','app_mention']` |
| `events_enabled` | `boolean NOT NULL DEFAULT false` |
| `signing_secret_encrypted` | `bytea NULL`, CHECK 29..4096 — **только AES-256-GCM ciphertext** |
| `signing_secret_created_at` | `timestamptz NULL` |
| `commands` | `jsonb NOT NULL DEFAULT '[]'`, CHECK `jsonb_typeof = 'array'` |

Добавлена `p_bots_worker` (`FOR SELECT USING current_setting('app.worker_role', true) =
'bot-event-relay'`). Tenant-политика `p_bots_tenant` остаётся FORCE RLS. Колонок
`signing_secret`, `secret`, `secret_plain` нет.

### `bot.event_deliveries` — durable outbox

`id uuid PK`, `workspace_id`, `bot_id`, `chat_id NULL`, `event_type` (`message.created`,
`app_mention`, `slash_command`, `test`), `event_id uuid`, `payload_encrypted bytea`,
`status` (`PENDING`/`DELIVERED`/`FAILED`), `attempt_count`, `next_attempt_at`,
`last_status_code`, `last_error` (<=120, только content-free причина), `created_at`,
`updated_at`, `delivered_at`.

* composite FK `(workspace_id, bot_id) → bot.bots(workspace_id, id) ON DELETE CASCADE`;
* `UNIQUE (bot_id, event_type, event_id)` — replay-safe: повторный replay сообщения или
  повторная постановка события не создаёт дубль;
* индексы `(status, next_attempt_at, id)` и `(workspace_id, bot_id, created_at DESC, id)`;
* FORCE RLS + tenant policy + `p_bot_event_deliveries_worker` (роль `bot-event-relay`);
* GRANT SELECT/INSERT/UPDATE/DELETE `krug_app`.

### `bot.command_tokens` — одноразовый response_url

`id uuid PK`, `workspace_id`, `chat_id`, `bot_id`, `invoked_by`, `command`,
`token_hash bytea NOT NULL CHECK (octet_length = 32)`, `expires_at`, `consumed_at`,
`response_message_id`, `created_at`.

* хранится только SHA-256 hash capability-токена, не raw;
* `UNIQUE (token_hash)` и `(expires_at)` index;
* FORCE RLS + tenant policy; GRANT как выше.

Payload доставки и signing secret шифруются AES-256-GCM (`BotSecretCipher`) с
domain-separation от ключа контента сообщений и AAD, привязанным к `bot_id`/`delivery_id`.

## 2. API (additive)

| Метод | Путь | Права / результат |
|---|---|---|
| `PATCH` | `/workspaces/{workspaceId}/bots/{botId}` | OWNER/ADMIN; расширен полями `events_url`, `events`, `events_enabled` (алиас `enabled`), `commands`; при первой активации генерирует secret и отдаёт его **один раз** в `Bot.signing_secret` |
| `POST` | `/workspaces/{workspaceId}/bots/{botId}/secret` | OWNER/ADMIN → `200 BotSigningSecret`; ротация, raw secret один раз |
| `GET` | `/workspaces/{workspaceId}/bots/{botId}/deliveries?limit=50` | OWNER/ADMIN → `BotDeliveryList` (1..100, новые первыми); без payload/URL/секрета |
| `POST` | `/workspaces/{workspaceId}/bots/{botId}/test-event` | OWNER/ADMIN → `202 {delivery_id}`; signed `test` ping |
| `POST` | `/chats/{chatId}/commands` | ACTIVE-участник чата, `{command,args}` → `202 {delivery_id}`; сообщение в чат не создаётся |
| `POST` | `/bot-responses/{token}` | **токен сам авторизует** ровно одно сообщение; `{text}` → `201 Message`; JWT/bot bearer не нужны |

`Bot`/`BotUpdateRequest` расширены `events_url`, `events`, `events_enabled`,
`has_signing_secret`, `signing_secret_created_at`, `commands[]`; `Bot.signing_secret`
присутствует только в ответе, который сгенерировал/ротировал секрет. `GET`/list никогда
не содержат секрет, payload или hash.

### Ошибки #98

`BOT_EVENTS_URL_INVALID`, `BOT_EVENTS_NOT_CONFIGURED`, `BOT_COMMAND_NOT_FOUND`,
`BOT_COMMAND_AMBIGUOUS`, `BOT_RESPONSE_INVALID` (401), `BOT_RESPONSE_EXPIRED` (410),
`BOT_RESPONSE_USED` (409); credential/SSRF-ошибки не раскрывают URL/секрет.

## 3. События

### Подписка

* `message.created` — обычное сообщение в чате (managed);
* `app_mention` — **определение**: текст сообщения содержит `@<имя бота>` без учёта
  регистра **или** сообщение отправлено с server-validated флагом `mention_all` (`@all`).
  Боты не являются участниками чата, поэтому per-user `mentions[]` их не адресует; это
  документированное Slack-like приближение. Для `@all` событие получают все боты чата с
  подпиской `app_mention`.
* Доставка только для ACTIVE бота, установленного и `enabled` в чате; чат — MANAGED.
  E2EE-чат не может содержать бота (#96 backstop).
* Сообщения, отправленные ботом, события не порождают (защита от циклов). Плагинные
  сообщения (poll/task) в этом срезе события не порождают — см. §8.

### Envelope

```json
{
  "type": "message.created | app_mention",
  "id": "<message_id>",
  "created_at": "2026-…Z",
  "workspace_id": "…",
  "chat_id": "…",
  "message": {
    "id": "…", "chat_id": "…", "seq": 42, "type": "TEXT",
    "sender_type": "USER", "sender_id": "…", "bot_id": null,
    "sender_display_name": "…", "text": "…",
    "reply_to_id": null, "thread_root_id": null, "created_at": "…"
  }
}
```

`slash_command`: `{type,id,created_at,workspace_id,chat_id,command,args,user_id,response_url}`.
`test`: `{type,id,created_at,workspace_id,chat_id,bot_id}`.

Envelope строится в той же транзакции, что и сообщение/команда, и шифруется в outbox.
HTTP-вызов выполняется только после commit (worker).

### Подпись

```
canonical = "v1:" + timestamp + ":" + rawBody
X-Sova-Signature: v1=<hex HMAC-SHA256(secret, canonical)>
X-Sova-Timestamp: <epoch seconds>
X-Sova-Event-Type / X-Sova-Event-Id / X-Sova-Delivery-Id
```

Получатель обязан проверить подпись и свежесть timestamp (окно задаёт получатель).
Raw secret — `sova_whsec_<32 random bytes base64url>`, показывается один раз.

## 4. Outbox / worker

`BotEventDeliveryService`:

* активирует узкую роль `bot-event-relay` (`app.worker_role`) и забирает пачку
  `FOR UPDATE SKIP LOCKED` (`batch-size=25`, poll `1s`);
* расшифровывает secret/payload, проверяет URL через SSRF-guard, подписывает и отправляет;
* таймауты connect/read — **5 с**, redirect — **NEVER** (3xx не следует и помечается
  permanent failure), response body дренится bounded-чтением и игнорируется;
* тело ограничено **64 KiB** (UTF-8); больше — permanent `payload_too_large`;
* retry: max **6** попыток, backoff `1s → 2s → 4s → 8s → 16s` с cap `1h`; retryable —
  timeout/network/408/429/5xx, permanent — 3xx и прочие 4xx, private/unresolved target,
  oversized/unreadable payload;
* `last_error` — только короткая причина (`timeout`, `http_500`, `private_address`,
  `redirect_not_allowed`, …), без URL/body/секрета;
* статусы `PENDING`/`DELIVERED`/`FAILED` доступны в `GET .../deliveries`.

При replay сообщения (`Idempotency-Key`) message pipeline возвращается до вставки, поэтому
новых событий нет; `UNIQUE (bot_id, event_type, event_id)` — второй backstop.

## 5. SSRF / сеть

`BotWebhookUrlGuard` выполняется **при каждой отправке**, а не только при PATCH:

* только absolute `https`, без userinfo/query/fragment, dot-segments, control chars;
* host резолвится заново; отклоняются loopback, private (10/8, 172.16/12, 192.168/16),
  link-local (169.254/16, fe80::/10), CGNAT (100.64/10), benchmark/doc ranges
  (198.18/15, 192.0.2/24, 198.51.100/24, 203.0.113/24), unspecified, multicast,
  IPv4-mapped private, IPv6 unique-local `fc00::/7`, NAT64 well-known prefix;
* один приватный ответ среди нескольких A/AAAA отклоняет весь host;
* `localhost`/`.localhost` отклоняются до DNS;
* redirect не follows, поэтому публичный endpoint не может «перепрыгнуть» на internal;
* DNS rebinding TOCTOU остаётся теоретическим остатком (резолв и connect раздельны) — §8.

## 6. Slash-команды и ответ

* регистрация: `commands: [{command, description}]` в PATCH; command lowercase 1..32,
  `[a-z0-9][a-z0-9_-]{0,31}`, уникален внутри бота, максимум 50; description 1..256;
* вызов: любой ACTIVE-участник MANAGED-чата; команда ищется среди installed+enabled ботов;
  0 совпадений — `404 BOT_COMMAND_NOT_FOUND`, >1 — `409 BOT_COMMAND_AMBIGUOUS`;
  E2EE — `422 BOT_E2EE_UNSUPPORTED`, нет events_url/secret — `422 BOT_EVENTS_NOT_CONFIGURED`; пустой список `events` допустим
  для slash-command-only бота (webhook обслуживает только команды);
* вызов создаёт `bot.command_tokens` (TTL 5 минут) и signed `slash_command` delivery;
  сообщение в чат не пишется;
* `response_url = {krug.bots.events.response-url-base}/bot-responses/{token}`; в БД только
  SHA-256 hash, token одноразовый и атомарно `consumed_at` в одной транзакции с сообщением;
* ответ создаёт обычное BOT-сообщение через `BotMessageService` (scope/install/MANAGED/
  rate-limit/idempotency проверки действуют), поэтому impersonation и E2EE исключены;
* повторное использование — `409 BOT_RESPONSE_USED`, истёкший — `410 BOT_RESPONSE_EXPIRED`,
  битый/чужой — `401 BOT_RESPONSE_INVALID`; токен не логируется;
* отдельные rate-limit окна: `bot-command` per user/chat, `bot-response` per token/bot.

## 7. Безопасность

* **Секреты**: signing secret и event payload — AES-256-GCM, ключ derived из content key с
  domain separation; AAD привязан к bot/delivery id. Raw secret существует только в
  PATCH/rotate response; в audit/логах/БД в открытом виде отсутствует.
* **One-time token**: response capability — 256-bit random, SHA-256 hash at rest, TTL 5 мин,
  атомарное consumption, unique index.
* **RLS**: все три таблицы FORCE RLS; worker — только `bot-event-relay` с отдельной
  политикой; tenant-запросы без GUC ничего не видят.
* **E2EE**: bots/events/commands доступны только в MANAGED; бот не ставится и не пишет в
  E2EE (#96), команда/ответ в E2EE — 422.
* **Нет content-логов**: delivery/worker логируют максимум id/тип/статус; envelope, URL,
  args, text и secret не попадают в `last_error`/audit/лог. `last_error` — whitelisted
  короткая причина.
* **Audit**: `bot.updated` (ids only), `bot.secret.rotated` (ids only),
  `bot.command.invoked` (bot_id + command name, без args/текста).
* **Impersonation**: `slash_command` response создаёт BOT-строку с `bot_id`, без
  `sender_id`/device; DB CHECK #96 остаётся backstop.
* **Rate limits**: slash command и response имеют отдельные окна, не расходующие
  пользовательский/ботский send quota.

## 8. Ограничения среза

1. Нет событий для bot-authored и plugin-сообщений (poll/task): сознательная защита от
   циклов и граница среза; при необходимости — отдельный `sender_type` фильтр.
2. Нет retention/cleanup для `bot.event_deliveries`/`bot.command_tokens`; строки накапливаются
   (истёкшие токены не удаляются). Следующий шаг — retention job.
3. Worker держит row locks на пачку во время HTTP-вызовов; при большом batch/медленных
   получателях возможна задержка. Production-вариант — claim → send → update в отдельных
   транзакциях.
4. Rate limiter in-memory (single-node), как и остальной MVP; Redis — вне среза.
5. DNS rebinding TOCTOU: host резолвится guard'ом, затем HttpClient резолвит повторно.
   Для полного закрытия нужен connect-to-IP с Host/SNI или egress-proxy.
6. `response-url-base` по умолчанию `http://localhost:8081/api/v1`; в production должен быть
   публичным https-origin. Значение не содержит секрета.
7. Нет interactive components/attachments/файлов в событиях (у бота нет file scope).
8. Локальный content key (KMS envelope — вне среза), как и для managed-сообщений.
9. UI для событий/команд не входит в backend-срез.

## 9. Тесты

Новые:

| Файл | Покрытие |
|---|---|
| `unit/BotWebhookUrlGuardTest` (5) | https-only, loopback/private/link-local/CGNAT/doc/IPv6 unique-local/IPv4-mapped, localhost, unresolved, один приватный среди публичных |
| `unit/BotSignaturesTest` (1) | независимый HMAC-SHA256 over `v1:timestamp:body`, чувствительность к secret/body/timestamp |
| `unit/BotCommandEventDomainTest` (3) | нормализация/уникальность/лимиты команд, subscriptions, формат/redaction response token |
| `unit/BotSecretCipherTest` (1) | AES-GCM round-trip, ciphertext без plaintext, AAD binding |
| `unit/JdkBotEventTransportTest` (3) | 2xx, redirect не follows, 5xx retryable, timeout |
| `unit/InMemoryRateLimiterTest` (+1) | отдельные bot-command/bot-response окна и 429 scope |
| `integration/BotEventsIT` (6) | подпись/получатель, encrypted secret at rest, replay без дубля, app_mention по тексту и `@all`, retry/backoff, SSRF private → FAILED, redirect permanent, permissions, test-event |
| `integration/BotCommandsIT` (5) | slash command без сообщения, signed envelope/response_url, one-time ответ, 409/410/401, permissions, unknown/ambiguous, E2EE, no events config |
| `integration/MigrationsIT` (+1) | V54 таблицы/колонки/CHECK/RLS/worker policy/grants/unique indexes, отсутствие raw secret/token колонок |
| `ArchitectureTest` | контекст `bot` (10/10), application не зависит от infrastructure |

Регрессия: `BotsIT` (9), `BotRateLimitIT`, `MessageApiIT`, `ContractValidationIT`,
`MentionsIT`, `RlsIsolationIT`, `OutboxIT`, `RealtimeWebSocketIT`, `MigrationsIT` — зелёные.

Фактический полный прогон: **`989` tests, 0 failures, 0 errors**;
ArchUnit **10/10**; contract-guard **160 operations / 131 path / 212 schemas**, in sync.

## 10. Contract

`contracts/openapi.yaml` (additive):

* tag `bots`; новые paths: `POST .../secret`, `GET .../deliveries`, `POST .../test-event`,
  `POST /chats/{chatId}/commands`, `POST /bot-responses/{token}`;
* обновлены `PATCH .../bots/{botId}` request/response, `Bot` (`events_url`, `events`,
  `events_enabled`, `has_signing_secret`, `signing_secret_created_at`, `commands`,
  one-time `signing_secret`);
* новые schemas: `BotCommand`, `BotSigningSecret`, `BotDelivery`, `BotDeliveryList`,
  `BotDeliveryAccepted`, `BotCommandInvoke`, `BotCommandAccepted`, `BotResponseCreate`;
* `/bot-responses/{token}` — `security: []` (capability в path); все остальные — JWT.

`frontend/src/api/schema.d.ts` перегенерирован `npm run api:types`;
`npm run contract:check` — 160 operations / 212 schemas, generated types in sync.

## 11. Rollback

Forward-only план — в шапке `V54__bot_events_commands.sql`: drop `bot.command_tokens`,
`bot.event_deliveries`, worker/tenant policies, затем drop новых колонок/CHECK на
`bot.bots`. События, доставки и response-токены теряются; сообщения, чаты, пользователи и
файлы не затрагиваются. Application rollback — до миграции: endpoints/поля #98 исчезают из
контракта, #96 bots продолжают работать.

## 12. Definition of done

**DONE.** Все пункты #98 реализованы в backend-зоне, контракт additive, generated types в
sync, полный suite/ArchUnit/contract-guard зелёные.

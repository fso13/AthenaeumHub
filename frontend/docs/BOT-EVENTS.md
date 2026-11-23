# #98 — события ботов и slash-команды (UI + интеграция)

Дополняет [`BOTS.md`](./BOTS.md): бот умеет не только отправлять сообщения, но и
получать подписанные webhook-события, регистрировать slash-команды и отвечать на
их вызов одним сообщением.

## Где это в UI

| Экран                          | Что можно сделать                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Настройки → Боты → Настроить` | Задать `events_url` (только https), включить `message.created` / `app_mention`, включить доставку, добавить/удалить команды (имя + описание), сохранить одним PATCH.                                                  |
| Там же, «Signing secret»       | Создать или ротировать HMAC-секрет. Значение показывается **один раз**, копируется по явной кнопке и очищается из памяти при закрытии окна; повторно его не увидеть — только ротация.                                 |
| Там же, «Доставки»             | Content-free статусы outbox (`PENDING`/`DELIVERED`/`FAILED`), тип события, время, число попыток, HTTP-код и безопасная причина. Кнопка «Отправить тестовое событие» ставит подписанный `test` ping в очередь (`202`). |
| Композер канала (MANAGED)      | Ввод `/` открывает палитру команд установленных и включённых ботов чата. Enter подставляет команду, отправка вызывает `POST /chats/{id}/commands`; сообщение в ленту при этом **не** создаётся.                       |

Палитра появляется только для команд, зарегистрированных установленным,
включённым и `ACTIVE` ботом. Неизвестный `/текст` уходит обычным сообщением (как в
Slack), а серверные `404 BOT_COMMAND_NOT_FOUND` / `409 BOT_COMMAND_AMBIGUOUS`
показываются честной ошибкой без фальшивого сообщения.

## Безопасность

- `signing_secret` — HMAC-SHA256 ключ; в БД хранится только AES-256-GCM
  ciphertext. UI держит raw-значение в памяти, не пишет его в
  `localStorage`/`sessionStorage`, не логирует и очищает при закрытии окна.
- Токен ответа (`response_url`) — **backend-only**. Фронтенд не читает, не
  хранит и не передаёт его: ответ бота создаётся его сервером через
  `POST /bot-responses/{token}`, а в ленту приходит обычное BOT-сообщение.
- События/команды доступны только в MANAGED-чатах. E2EE-чат получает
  `422 BOT_E2EE_UNSUPPORTED`.
- `events_url` проверяется при каждой доставке (SSRF-guard), redirect не
  выполняется; UI дополнительно не даёт сохранить не-https URL.

## curl: настройка, тест и доставки

Переменные: `SOVA_API` (например `https://sova.example/api/v1`),
`ACCESS_TOKEN`/`DEVICE_ID` — пользовательская сессия OWNER/ADMIN,
`WORKSPACE_ID`, `BOT_ID`.

```bash
# 1. Настроить webhook и команды. Ответ может один раз содержать
#    signing_secret (если секрета ещё не было).
curl -X PATCH "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "events_url": "https://example.com/sova/events",
    "events": ["message.created", "app_mention"],
    "events_enabled": true,
    "commands": [
      {"command": "echo", "description": "Повторить текст"},
      {"command": "status", "description": "Показать статус"}
    ]
  }'

# 2. Ротация секрета (старый сразу перестаёт проверять подписи).
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID/secret" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID"

# 3. Подписанный test ping: 202 {"delivery_id":"..."}.
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID/test-event" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID"

# 4. Content-free статусы доставок.
curl "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID/deliveries?limit=20" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID"
```

Заголовки доставки: `X-Sova-Signature`, `X-Sova-Timestamp`,
`X-Sova-Event-Type`, `X-Sova-Event-Id`, `X-Sova-Delivery-Id`.

## Проверка подписи на приёмнике

Каноническая строка: `v1:<timestamp>:<rawBody>` (сырое тело до JSON-парсинга),
подпись: `v1=<hex HMAC-SHA256(secret, canonical)>`.

```js
// Node.js, без зависимостей. SECRET — значение из одноразового окна.
import crypto from 'node:crypto';

function verifySovaWebhook({ rawBody, headers, secret, toleranceSeconds = 300 }) {
  const timestamp = headers['x-sova-timestamp'];
  const signature = headers['x-sova-signature'];
  if (!timestamp || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;
  const expected = `v1=${crypto
    .createHmac('sha256', secret)
    .update(`v1:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  const left = Buffer.from(signature, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
```

`openssl`-эквивалент для отладки:

```bash
printf 'v1:%s:%s' "$TIMESTAMP" "$RAW_BODY" \
  | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -hex
```

Подпись и timestamp обязательны: без проверки свежести получатель уязвим к
replay. Тело ограничено 64 KiB, таймауты 5 с, redirect-ответы считаются
permanent failure.

## curl: вызов slash-команды и ответ бота

```bash
# Вызов из MANAGED-чата. 202 {"delivery_id":"..."}; сообщение в чат НЕ пишется.
curl -X POST "$SOVA_API/chats/$CHAT_ID/commands" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo","args":"привет"}'
```

Webhook получает:

```json
{
  "type": "slash_command",
  "id": "<event-id>",
  "created_at": "2026-…Z",
  "workspace_id": "…",
  "chat_id": "…",
  "command": "echo",
  "args": "привет",
  "user_id": "…",
  "response_url": "https://sova.example/api/v1/bot-responses/<one-time-token>"
}
```

Ответ ровно один раз (TTL 5 минут). JWT и `X-Device-Id` не нужны: capability
токен сам авторизует одно сообщение.

```bash
curl -X POST "$RESPONSE_URL" \
  -H "Content-Type: application/json" \
  -d '{"text":"Эхо: привет"}'
```

- `201 Message` — создано обычное BOT-сообщение (проверки scope/install/
  MANAGED/rate-limit действуют);
- `409 BOT_RESPONSE_USED` — токен уже использован;
- `410 BOT_RESPONSE_EXPIRED` — истекли 5 минут;
- `401 BOT_RESPONSE_INVALID` — битый/чужой токен.

Повторный `POST` не создаёт второе сообщение; для новой команды бот получает
новый `response_url`.

## Ошибки

| Код                         | Значение                                                          |
| --------------------------- | ----------------------------------------------------------------- |
| `BOT_EVENTS_URL_INVALID`    | `events_url` не absolute https / содержит userinfo/query/fragment |
| `BOT_EVENTS_NOT_CONFIGURED` | Нет активного URL или signing secret (test/command невозможны)    |
| `BOT_COMMAND_NOT_FOUND`     | Ни один установленный бот не регистрирует команду (`404`)         |
| `BOT_COMMAND_AMBIGUOUS`     | Команду регистрируют ≥2 ботов (`409`)                             |
| `BOT_E2EE_UNSUPPORTED`      | E2EE-чат (`422`)                                                  |
| `BOT_RESPONSE_INVALID`      | Битый/чужой response-токен (`401`)                                |
| `BOT_RESPONSE_EXPIRED`      | Истёк TTL response-токена (`410`)                                 |
| `BOT_RESPONSE_USED`         | Токен уже израсходован (`409`)                                    |

`429 RATE_LIMITED` + `Retry-After` действует отдельно для команд и ответов.

## MSW

`src/mocks/handlers.ts` покрывает `POST .../secret`, `GET .../deliveries`,
`POST .../test-event` и `POST /chats/{id}/commands`: валидация https/команд,
одноразовая выдача секрета, content-free доставки, `202` без сообщения,
`404/409/422` для команд. Response-токен во фронтенде не используется; его
поведение описано в backend-контракте.

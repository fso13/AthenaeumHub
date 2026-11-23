# Боты и плагины Sova

Практическое руководство: как написать бота, подключить его к пространству и как
собрать внешний плагин. Подробные справочники:

- [`PLUGIN-DEVELOPMENT.md`](./PLUGIN-DEVELOPMENT.md) — manifest v1, ZIP, sandbox, postMessage;
- [`frontend/docs/BOTS.md`](../frontend/docs/BOTS.md) — боты: UI, токены, отправка сообщений;
- [`frontend/docs/BOT-EVENTS.md`](../frontend/docs/BOT-EVENTS.md) — события и slash-команды.

## 1. Бот

Бот — это workspace-сущность с одноразовым bearer-токеном. Он не является
пользователем: у него нет пароля, устройств, доступа к чтению истории, файлам или
звонкам. В MVP разрешён scope `chat.write`.

### 1.1 Создание

Создавать и менять ботов может OWNER/ADMIN пространства.

```bash
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Сова Помощник","scopes":["chat.write"]}'
```

Ответ содержит `token` **один раз**. Сервер хранит только SHA-256 хеш. Токен нельзя
восстановить: при утере нужна ротация.

```bash
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID/token" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID"
```

### 1.2 Установка в канал

Только MANAGED GROUP; установку делает OWNER/ADMIN канала.

```bash
curl -X POST "$SOVA_API/chats/$CHAT_ID/bots" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"bot_id":"'$BOT_ID'"}'
```

### 1.3 Отправка сообщения

```bash
curl -X POST "$SOVA_API/bots/$BOT_ID/messages" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"'$CHAT_ID'","text":"Привет от бота"}'
```

`Idempotency-Key` обязателен. Повтор с тем же ключом и телом возвращает исходное
сообщение; другое тело — `409 IDEMPOTENCY_KEY_REUSED`.

Сообщение приходит с `sender_type=BOT`, `bot_id` и бейджем «БОТ». Бот не может
выдавать себя за пользователя.

### 1.4 События (webhooks)

Настройте `events_url` (только https), события и signing secret:

```bash
curl -X PATCH "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "events_url":"https://bot.example/sova/events",
    "events":["message.created","app_mention"],
    "events_enabled":true,
    "commands":[{"command":"deploy","description":"Запустить деплой"}]
  }'
```

Секрет показывается один раз в ответе PATCH (`signing_secret`); ротация:

```bash
curl -X POST "$SOVA_API/workspaces/$WORKSPACE_ID/bots/$BOT_ID/secret" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID"
```

Доставка:

```
POST https://bot.example/sova/events
X-Sova-Signature: v1=<hex hmac-sha256>
X-Sova-Timestamp: <unix seconds>
X-Sova-Event-Type: message.created
X-Sova-Event-Id: <event uuid>
X-Sova-Delivery-Id: <delivery uuid>
Content-Type: application/json
```

Проверка подписи (Node):

```js
const crypto = require('node:crypto');

function verify(rawBody, signature, secret) {
  const expected = 'v1=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

Тело:

```json
{
  "type": "message.created",
  "id": "event-uuid",
  "created_at": "2026-01-01T00:00:00Z",
  "workspace_id": "uuid",
  "chat_id": "uuid",
  "message": {
    "id": "uuid",
    "seq": 42,
    "sender_display_name": "Дмитрий",
    "text": "привет @Сова",
    "sender_type": "USER"
  }
}
```

Доставки: `GET .../bots/{botId}/deliveries` — статусы без контента;
`POST .../test-event` — подписанный ping.

### 1.5 Slash-команды

Команда регистрируется в PATCH (`commands`). Пользователь вводит `/deploy production`;
клиент вызывает:

```bash
curl -X POST "$SOVA_API/chats/$CHAT_ID/commands" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"command":"deploy","args":"production"}'
```

Бот получает событие `slash_command` с `response_url` (одноразовый, 5 минут). Ответ
создаёт ровно одно сообщение:

```bash
curl -X POST "$RESPONSE_URL" \
  -H "Content-Type: application/json" \
  -d '{"text":"Деплой запущен"}'
```

`response_url` содержит одноразовый токен: не логируйте его.

### 1.6 Ограничения

- только managed-чаты; E2EE получает `422 BOT_E2EE_UNSUPPORTED`;
- бот не читает историю, не ходит в файлы/звонки/админку;
- события не создаются для сообщений ботов/плагинов (защита от циклов);
- SSRF-guard: https, без redirects, private/loopback/link-local запрещены;
- ретраи 6 попыток с backoff; ответ провайдера игнорируется.

## 2. Плагин

Плагин — статический ZIP с UI в sandbox-iframe. Серверный код не исполняется.

### 2.1 Структура

```
hello-panel.zip
├── manifest.json
├── index.html
└── assets/app.js
```

`manifest.json`:

```json
{
  "id": "hello-panel",
  "name": "Hello panel",
  "version": "1.0.0",
  "description": "Пример панели",
  "author": "Sova",
  "entry": "index.html",
  "permissions": ["chat.messages.read"],
  "modes": ["MANAGED"]
}
```

Правила: id slug, версия semver, entry `.html`, лимит ZIP 5 MiB / распаковано
10 MiB / 200 файлов, только относительные пути. Полный список permissions и
ограничений — в [`PLUGIN-DEVELOPMENT.md`](./PLUGIN-DEVELOPMENT.md).

### 2.2 Сборка и установка

```bash
cd hello-panel
zip -r ../hello-panel.zip . -x '.*' -x '__MACOSX/*'

curl -X POST "$SOVA_API/admin/plugins" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@hello-panel.zip;type=application/zip"
```

Установка доступна platform admin; включение в чате — владельцу/админу канала.
Плагин появляется в «Плагины чата».

### 2.3 iframe и postMessage

Хост загружает HTML/asset пакета и вставляет в iframe с
`sandbox="allow-scripts"` (без `allow-same-origin`). Скрипты исполняются в
opaque-origin, сеть запрещена CSP.

Минимальный плагин:

```html
<!doctype html>
<html lang="ru">
  <body>
    <button id="send">Отправить привет</button>
    <script src="./assets/app.js"></script>
  </body>
</html>
```

```js
// assets/app.js
window.addEventListener('message', (event) => {
  // Хост присылает init с capability-контекстом.
  if (event.data?.type === 'init') {
    document.body.dataset.ready = '1';
  }
});

document.getElementById('send').addEventListener('click', () => {
  parent.postMessage({ type: 'action', action: 'message.send', text: 'Привет' }, '*');
});
```

Фактический набор host-RPC ограничен manifest permissions и текущим срезом.
Абсолютные URL, `fetch`, `localStorage` и доступ к DOM приложения запрещены.

## 3. Отладка

- бот: `POST .../test-event`, `GET .../deliveries`, curl с `Idempotency-Key`;
- плагин: DevTools → iframe, `console` внутри sandbox; проверяйте CSP-ошибки;
- серверные ошибки: `application/problem+json` с `code`, `detail`, `trace_id`;
- E2EE-чаты: боты и серверные плагины отключены by design.

## 4. Безопасность

- токены/секреты показываются один раз и не логируются;
- бот-токен — только `Authorization: Bearer`, не query;
- подпись webhook проверяйте **до** JSON.parse и с constant-time сравнением;
- не храните `response_url` и signing secret в открытом виде;
- плагин не должен рассчитывать на сеть: `connect-src 'none'`.

# Krug WebSocket protocol v1 (E3 slice)

> Контракт для E3-B/E3-F. Источник: `docs/SYSTEM-ANALYSIS.md` §7.5, `docs/TASKS-E3.md`.
> Транспорт: один WS-канал; JSON-кадры UTF-8. Бинарный режим — v1.

## 1. Подключение

1. Клиент: `POST /api/v1/realtime/ticket` с `Authorization: Bearer` и `X-Device-Id`.
2. Ответ: `{ticket, expires_at, ws_url}`; `ticket` одноразовый, TTL 30 с.
3. Клиент: `GET ws_url?ticket=<ticket>` (WSS в prod).
4. Сервер проверяет тикет, устройство, пользователя; при ошибке — HTTP 401/403 до upgrade.
5. После upgrade сервер отправляет `hello`.

## 2. Общий конверт

```json
{
  "v": 1,
  "type": "event",
  "event_id": "uuid",
  "event": "message.created",
  "chat_id": "uuid",
  "seq": 42,
  "ts": "2026-11-16T10:00:00Z",
  "payload": {}
}
```

- `v` — версия протокола (1).
- `event_id` — UUID; клиент дедуплицирует по нему.
- `seq` — per-chat seq; порядок только по нему.
- Эфемерные события (`typing`, `presence`) могут не иметь `seq`/`event_id`; они не replay-ятся.

## 3. Сервер → клиент

| `type`            | Payload                                                 | Когда                                        |
| ----------------- | ------------------------------------------------------- | -------------------------------------------- |
| `hello`           | `session_id`, `server_time`, `heartbeat_ms`, `protocol` | Сразу после upgrade                          |
| `subscribed`      | `chats:[{chat_id, accepted, server_last_seq, reason?}]` | Ответ на `subscribe`                         |
| `event`           | `event`, `chat_id`, `seq`, `event_id`, `payload`        | Доменное событие                             |
| `resume.gap`      | `chat_id`, `from_seq`, `to_seq`, `reason`               | Replay не помещается в окно                  |
| `pong`            | `server_time`                                           | Ответ на `ping`                              |
| `error`           | `code`, `message`, `request_id`, `chat_id?`             | Ошибка                                       |
| `session.revoked` | `reason`                                                | Устройство/сессия отозваны; далее close 4403 |

### События

| `event`               | `payload`                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `message.created`     | Объект `Message` из OpenAPI **полями на верхнем уровне `payload`** (не `payload.message`) |
| `message.receipt`     | `user_id`, `last_read_seq`                                                                |
| `chat.member.changed` | `user_id`, `role`, `status`, `epoch`                                                      |
| `chat.pin.changed`    | `message_id`, `action`                                                                    |
| `chat.keys.changed`   | `chat_id`, `reason`, `device_id?`, `key_generation?` (без `seq`, не replay-ится)          |
| `device.list.changed` | `device_id`, `status`, `key_generation` (свои устройства)                                 |
| `typing`              | `user_id`, `expires_at`                                                                   |
| `presence`            | `user_id`, `status`, `last_seen_at`                                                       |

`message.created` payload — `Message` из OpenAPI. Для E2EE-сообщения `payload.text=null`, а
`payload.crypto` — конверт **только для устройства соединения**; для отправителя на том же
устройстве `crypto:null` (локальная копия уже есть). `client_message_id` присутствует всегда
(nullable) и не является секретом. При `krug.e2ee.enabled=false` live- и replay-кадры
E2EE не публикуются: ни `message.created`, ни `crypto` (P2-03 review-06); managed-события
не затронуты.

`chat.keys.changed.reason`: `DEVICE_ADDED | DEVICE_REVOKED | IDENTITY_KEY_CHANGED |
VERIFICATION_CHANGED | KEY_GENERATION_CHANGED`. Событие несёт только метаданные ключей/устройств,
не содержимое сообщений; клиент на него перечитывает `GET /chats/{id}/keys`, на reconnect — всегда.
`key_generation` в payload — текущая generation затронутого устройства (для
`KEY_GENERATION_CHANGED` после revoke она уже увеличена). Ротация prekey (SPK/OPK) публикуется с
`reason=KEY_GENERATION_CHANGED` (в фиксированном enum §6.3.1 C нет отдельного prekey-reason;
generation при этом не меняется) плюс `device.list.changed` владельцу — клиент обязан перечитать
ключи, сессии это не сбрасывает.

**`chat.session.reset` как WS-событие не вводится:** reset передаётся только зашифрованным
`content_type=2` внутри нового prekey-конверта (§4.4/§5.5 E2EE-SPEC). `chat.member.changed`
в E2EE-чате не порождает системных сообщений.

Пример плоского payload:

```json
{
  "v": 1,
  "type": "event",
  "event": "message.created",
  "event_id": "...",
  "chat_id": "...",
  "seq": 42,
  "ts": "...",
  "payload": {
    "id": "...",
    "chat_id": "...",
    "seq": 42,
    "type": "TEXT",
    "sender_id": "...",
    "sender_display_name": "...",
    "text": "...",
    "created_at": "..."
  }
}
```

## 4. Клиент → сервер

| `type`      | Payload                                 | Правило                                           |
| ----------- | --------------------------------------- | ------------------------------------------------- |
| `subscribe` | `chats:[{chat_id,last_seq}], presence?` | ≤200 чатов; membership проверяется на каждый чат  |
| `ack`       | `last_seq`                              | Для backpressure/метрик; не является read receipt |
| `ping`      | `client_time`                           | Heartbeat                                         |
| `typing`    | `chat_id`                               | Эфемерно; сервер ставит TTL 5 с                   |

```json
{"v":1,"type":"subscribe","chats":[{"chat_id":"...","last_seq":41}],"presence":true}
{"v":1,"type":"ack","last_seq":42}
{"v":1,"type":"typing","chat_id":"..."}
{"v":1,"type":"ping","client_time":"2026-11-16T10:00:00Z"}
```

## 5. Replay и gap

- На `subscribe` сервер для каждого чата:
  - проверяет membership; иначе `accepted:false`, `reason:"FORBIDDEN"`;
  - читает `messages` с `seq > last_seq` ORDER BY `seq ASC` LIMIT 500;
  - отправляет `event: message.created` по порядку;
  - если `max_seq - last_seq > 500`, отправляет `resume.gap` с `from_seq=last_seq`, `to_seq=max_seq-500`; клиент добирает REST-страницами и продолжает live.
- Клиент игнорирует `seq <= last_seq`; дубликаты — по `event_id`.
- `message.receipt` не replay-ится; актуальное состояние — `GET /sync`.
- `typing`/`presence` не replay-ятся.

## 6. Reconnect

1. `GET /sync?workspace_id=...` → `last_seq` по чатам.
2. `POST /realtime/ticket` (новый тикет).
3. Connect → `hello` → `subscribe` с `last_seq`.
4. Если WS закрыт/ошибка: backoff 1, 2, 4, 8, 16, 30 с + jitter; не более 60 попыток/час.
5. Тикет одноразовый; повторное использование → 401.

## 7. Close codes и backpressure

| Код  | Причина                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 1000 | Нормальное закрытие                                                                                  |
| 1008 | Policy violation (плохой кадр/лимит); reason `HEARTBEAT_TIMEOUT` — reconnect, остальные 1008 — fatal |
| 1013 | Slow consumer: outbound queue >256; сначала drop `typing`/`presence`                                 |
| 4401 | Невалидный/просроченный тикет                                                                        |
| 4403 | Нет доступа/сессия отозвана                                                                          |

- Outbound queue на соединение — 256 кадров.
- При переполнении: drop ephemeral; если после этого очередь полна — close 1013 с `last_delivered_seq`.
- Heartbeat: server ping 25 с, timeout 60 с.

## 8. Ограничения E3

- Один узел: fan-out через in-process hub; Redis/Kafka pub/sub — следующий срез.
- E2EE `crypto` в `message.created` — только конверт для устройства соединения; сервер не
  расшифровывает и не отдаёт конверты других устройств. E2EE send/fan-out реализован в
  E7-B3/B4: кадр собирается per-connection device, конверты других устройств доступны
  только через `GET /chats/{id}/messages` (и тоже только для своего `X-Device-Id`).
- `chat.keys.changed`/`device.list.changed` — метаданные ключей; контент по-прежнему только
  через `message.created`.
- Плагины и серверный поиск/DLP по E2EE-контенту отсутствуют.
- E2EE-лимиты (10 конвертов, ciphertext 272..33040 B / 363..44054 b64u, тело запроса 512 KiB) относятся к
  REST-отправке; WS-кадр содержит один конверт устройства соединения.
- Нет durable replay старше 500 сообщений: клиент идёт в REST.
- `typing`/`presence` — эфемерные, без истории.

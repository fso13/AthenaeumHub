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
- Эфемерные события (`typing`, `presence`, `call.signal`, `call.unavailable`) могут не иметь
  `seq`/`event_id`; они не replay-ятся.

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
| `message.updated`     | Объект `Message` из OpenAPI (flat), с новыми `version`, `edited_at`, `reactions` и `text`  |
| `message.deleted`     | `message_id`, `seq`, `deleted_at`, `deleted_by`, `scope` (`all`); tombstone              |
| `message.reaction.changed` | `message_id`, `seq`, `user_id`, `emoji`, `action` (`ADDED\|REMOVED`), `count`          |
| `message.receipt`     | `user_id`, `last_read_seq`                                                                |
| `chat.member.changed` | `user_id`, `role`, `status`, `epoch`                                                      |
| `chat.pin.changed`    | `message_id`, `action`                                                                    |
| `chat.keys.changed`   | `chat_id`, `reason`, `device_id?`, `key_generation?` (без `seq`, не replay-ится)          |
| `device.list.changed` | `device_id`, `status`, `key_generation` (свои устройства)                                 |
| `typing`              | `user_id`, `expires_at`                                                                   |
| `presence`            | `user_id`, `status`, `last_seen_at`                                                       |
| `call.signal`         | `payload`: `call_id`, `kind`, `video`, `sdp?`, `candidate?`, `conference?`, `recipients?`; кадр: `from_user_id`, `from_device_id` |
| `call.unavailable`    | `call_id`, `kind`, `reason` (`PEER_OFFLINE`)                                              |

`message.created` payload — `Message` из OpenAPI. Для сообщений `type=POLL|TASK` (создаются
только сервером вместе с опросом/задачей, отдельного клиентского POST сообщения нет)
`payload.text=null`, а `payload.poll_id`/`payload.task_id` и встроенные `payload.poll`/
`payload.task` несут актуальную проекцию (в `poll.my_option_id` — выбор зрителя). После
голосования/закрытия опроса или выполнения задачи сервер не переписывает сообщение: клиент
получает актуальное встроенное состояние при следующем REST-чтении/replay. Tombstone
(`deleted_at != null`) не несёт `poll`/`task`, как и прочие content-поля. Для E2EE-сообщения
`payload.text=null`, а
`payload.crypto` — конверт **только для устройства соединения**; для отправителя на том же
устройстве `crypto:null` (локальная копия уже есть). `client_message_id` присутствует всегда
(nullable) и не является секретом. `thread_root_id` присутствует всегда (nullable): `null` —
сообщение основной ленты, `uuid` — ответ в тред с этим корнем (глубина 1). `thread_summary`
в WS-кадр не входит: сервер считает его только в `GET /chats/{id}/messages`, клиент
инкрементирует счётчик/превью корня локально по `message.created`. При
`krug.e2ee.enabled=false` live- и replay-кадры E2EE не публикуются: ни `message.created`, ни
`crypto` (P2-03 review-06); managed-события не затронуты.

`message.updated`/`message.deleted`/`message.reaction.changed` — live-события после
commit REST-операции. Они **не входят в durable replay** `seq > last_seq` (replay
по-прежнему отдаёт `message.created` с актуальным состоянием строки, включая
`edited_at`/`version`/`deleted_at`/`reactions`), поэтому после reconnect клиент
перечитывает страницу REST, если получил `resume.gap`. `event_id` детерминирован от
факта (`message_id` + `version` для updated, `message_id` + `scope` + `deleted_at` для
deleted), поэтому live/повторная доставка дедуплицируются. `message.deleted` со
`scope=me` **не публикуется**: скрытие для себя — локальное состояние вызывающего,
остальные участники не должны его видеть; другие устройства пользователя
синхронизируются через REST. Реакции на E2EE-чат и редактирование E2EE запрещены
(`422 E2EE_METADATA_FORBIDDEN`), поэтому такие события для E2EE не возникают.

`payload.poll`/`payload.task` — объекты `Poll`/`Task` из OpenAPI (не `message_id`); ids
`payload.poll_id`/`payload.task_id` присутствуют всегда (nullable) и для остальных типов
равны `null`. E2EE-чат не может включить серверный плагин, поэтому такие кадры в E2EE не
возникают.

`payload.attachments[]` — объекты `AttachmentRef` из OpenAPI; с D1-BE2 managed-вложение
несёт `media` (или `null`) с теми же sanitized-полями, что и REST. Для E2EE `attachments`
всегда пуст: E2EE-сообщение не может нести attachment_ids, поэтому plaintext-метаданные
медиа в WS не попадают. Сервер не парсит медиа-байты и не запрашивает `artwork_url`.

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
    "thread_root_id": null,
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
| `call.signal` | `chat_id`, `call_id`, `kind`, `video`, `sdp?`, `candidate?`, `conference?`, `recipients?` | DIRECT или GROUP (`conference:true` + 1..50 `recipients`); эфемерный relay |

```json
{"v":1,"type":"subscribe","chats":[{"chat_id":"...","last_seq":41}],"presence":true}
{"v":1,"type":"ack","last_seq":42}
{"v":1,"type":"typing","chat_id":"..."}
{"v":1,"type":"ping","client_time":"2026-11-16T10:00:00Z"}
{"v":1,"type":"call.signal","chat_id":"...","payload":{"call_id":"...","kind":"offer","video":true,"sdp":"v=0\r\n..."}}
```

## 5. Replay и gap

- На `subscribe` сервер для каждого чата:
  - проверяет membership; иначе `accepted:false`, `reason:"FORBIDDEN"`;
  - читает `messages` с `seq > last_seq` ORDER BY `seq ASC` LIMIT 500;
  - отправляет `event: message.created` по порядку;
  - если `max_seq - last_seq > 500`, отправляет `resume.gap` с `from_seq=last_seq`, `to_seq=max_seq-500`; клиент добирает REST-страницами и продолжает live.
- Replay/live `message.created` содержат **все** сообщения чата, включая ответы тредов
  (`thread_root_id != null`): это тот же seq-поток, что и раньше. Клиент раскладывает их по
  `thread_root_id`; REST-лента без `thread_root_id` отдаёт только корни.
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
- `call.signal`/`call.unavailable` — эфемерные, без истории, без offline-очереди и без
  серверных записей звонка.

## 9. Звонки: signaling (audio/video)

Срез — **только WebRTC signalling** через существующий WS-канал. Сервер не проксирует медиа,
не парсит SDP, не хранит звонки и ничего не пишет в БД. `call.state` не вводится: состояние
звонка (ringing/connected/ended) клиент выводит из `call.signal` и `call.unavailable`.
REST-записей звонка нет.

§9.1–9.4 описывают 1:1 DIRECT-звонки без изменений. §9.5 добавляет GROUP-звонки (mesh,
без SFU): тот же кадр `call.signal` с дополнительными `conference`/`recipients`.

### 9.1 Клиент → сервер: `call.signal`

```json
{
  "v": 1,
  "type": "call.signal",
  "chat_id": "uuid",
  "payload": {
    "call_id": "uuid",
    "kind": "offer|answer|ice|hangup|busy",
    "video": true,
    "sdp": "v=0\r\n...",
    "candidate": {"candidate": "candidate:...", "sdp_mid": "0", "sdp_mline_index": 0}
  }
}
```

- `call_id`, `kind`, `video` обязательны всегда. `video` — boolean (audio-only = `false`).
- `offer`/`answer`: обязателен непустой `sdp`; `candidate` запрещён.
- `ice`: обязателен объект `candidate` (структура — `RTCIceCandidateInit` на клиенте);
  `sdp` запрещён. Конец candidate-потока отдельным кадром не требуется.
- `hangup`/`busy`: `sdp` и `candidate` запрещены.
- `chat_id` и `payload.call_id` — канонические UUID (36 символов). Неизвестные `kind` или
  лишние поля отклоняются, сообщение об ошибке не содержит SDP/candidate.
- `call.signal` не является durable-событием: ответа с `seq`/`event_id` нет.

### 9.2 Сервер → клиент: `call.signal`

Сервер валидирует отправителя и relay-ит payload всем **живым WS-сессиям второго участника**
DIRECT-чата в том же workspace, добавляя `from_user_id`, `from_device_id`:

```json
{
  "v": 1,
  "type": "event",
  "event": "call.signal",
  "workspace_id": "uuid",
  "chat_id": "uuid",
  "ts": "2026-11-19T10:00:00Z",
  "from_user_id": "uuid",
  "from_device_id": "uuid",
  "payload": {
    "call_id": "uuid",
    "kind": "offer",
    "video": true,
    "sdp": "v=0\r\n..."
  }
}
```

- `from_user_id`/`from_device_id` — на верхнем уровне кадра; `payload` совпадает с
  валидированным payload клиента (`sdp`/`candidate` не переписываются).
- `seq` и `event_id` отсутствуют; событие не replay-ится и не буферизуется offline.
- Подписка на `chat_id` для получения звонка не требуется: достаточно live-сессии
  участника. Это позволяет показать входящий звонок, даже если чат не открыт.
- Все устройства получателя получают кадр; отвечает то устройство, которое приняло звонок.
  Кадры `answer`/`ice`/`hangup`/`busy` от него relay-ятся всем live-сессиям вызывающего.
- Отправитель не получает эхо собственного `call.signal`.

### 9.3 Сервер → клиент: `call.unavailable`

Если у второго участника нет ни одной live-сессии, вызывающая сессия получает эфемерное
событие (offline-очереди нет):

```json
{
  "v": 1,
  "type": "event",
  "event": "call.unavailable",
  "workspace_id": "uuid",
  "chat_id": "uuid",
  "ts": "2026-11-19T10:00:00Z",
  "payload": {"call_id": "uuid", "kind": "offer", "reason": "PEER_OFFLINE"}
}
```

`call.unavailable` отправляется только инициатору текущего кадра (не всем его устройствам).
Клиент завершает попытку звонка; повторный вызов — новый `call_id`.

### 9.4 Авторизация и лимиты

- Только ACTIVE-участник чата; неизвестный/чужой чат → `error` `FORBIDDEN`, `status:403`
  (существование чата не раскрывается).
- DIRECT: только живой DIRECT-чат с одним peer; `conference:true` или непустые
  `recipients` в DIRECT запрещены → `error` `WS_FRAME_INVALID`, `status:400`.
- GROUP: только с `conference:true` и `recipients` (1..50); GROUP без них →
  `error` `CALL_NOT_SUPPORTED`, `status:422`. Подробности — §9.5.
- Лимиты payload: SDP ≤ 32 KiB (32768 байт UTF-8), `candidate` ≤ 4 KiB (4096 байт JSON),
  `recipients` ≤ 50 UUID, весь WS-кадр ≤ 64 KiB. Превышение SDP/candidate →
  `error` `CALL_PAYLOAD_TOO_LARGE`, `status:413`; остальные нарушения формы →
  `WS_FRAME_INVALID`, `status:400`.
- Rate limit — на сессию: по умолчанию 120 кадров `call.signal` за 60 с
  (`krug.realtime.call-signal-limit` / `call-signal-window`). Превышение → `error`
  `RATE_LIMITED`, `status:429`; кадр отбрасывается, соединение остаётся живым.
- Любая ошибка `call.signal` (400/403/413/422/429) **не закрывает WS**: остальные кадры
  (`typing`, `presence`, сообщения) продолжают работать.
- Сервер не логирует `sdp`, `candidate` и IP-адреса; в debug-логе допустимы только
  `call_id`, `kind`, `chat_type` и число получателей. SDP передаётся как есть только в
  relay-кадре.

### 9.5 Групповые звонки: GROUP + conference (mesh, без SFU)

Групповой звонок — это набор попарных WebRTC-соединений (mesh). Сервер остаётся
**stateless relay**: у него нет конференций, участников, микшера, SFU, TURN, записи звонка
или истории. Каждый клиент сам устанавливает `RTCPeerConnection` с каждым получателем.

#### 9.5.1 Клиент → сервер: GROUP `call.signal`

Каждый GROUP-кадр (включая `answer`, `ice`, `hangup`, `busy`) обязан содержать
`conference:true` и явный список `recipients`:

```json
{
  "v": 1,
  "type": "call.signal",
  "chat_id": "uuid",
  "payload": {
    "call_id": "uuid",
    "kind": "offer",
    "video": true,
    "conference": true,
    "recipients": ["uuid-bob", "uuid-carol"],
    "sdp": "v=0\r\n...",
    "candidate": {"candidate": "candidate:...", "sdp_mid": "0", "sdp_mline_index": 0}
  }
}
```

- `conference` — boolean; для GROUP обязателен `true`. `false` эквивалентно отсутствию:
  такой кадр считается обычным (не групповым) и в GROUP отклоняется.
- `recipients` — непустой массив 1..50 **канонических UUID** без дублей. Это пользователи
  чата, которым адресован именно этот кадр; caller в списке запрещён.
- `recipients` без `conference:true` → 400. `conference:true` без `recipients` → 400.
- `call_id`, `kind`, `video`, `sdp`/`candidate` и правила по kind — те же, что в §9.1.
- В DIRECT `conference:true` или непустые `recipients` запрещены → 400;
  `conference:false` эквивалентно отсутствию. DIRECT-поведение не изменилось.

#### 9.5.2 Сервер → клиент: relay

Сервер проверяет, что caller — ACTIVE-участник GROUP-чата, а **каждый** `recipient` —
ACTIVE-участник того же чата (не удалён, не INVITED, не чужой workspace). Затем кадр
уходит только живым WS-сессиям перечисленных пользователей:

```json
{
  "v": 1,
  "type": "event",
  "event": "call.signal",
  "workspace_id": "uuid",
  "chat_id": "uuid",
  "ts": "2026-11-19T10:00:00Z",
  "from_user_id": "uuid-alice",
  "from_device_id": "uuid-device",
  "payload": {
    "call_id": "uuid",
    "kind": "offer",
    "video": true,
    "conference": true,
    "recipients": ["uuid-bob", "uuid-carol"],
    "sdp": "v=0\r\n..."
  }
}
```

- Relay идёт **только** указанным `recipients`; остальные участники чата кадр не получают.
- Caller не получает эхо собственного кадра; его собственные сессии исключены всегда.
- Подписка на `chat_id` не требуется: достаточно live-сессии получателя.
- Кадр получают все live-сессии каждого получателя.
- Offline-получатели просто пропускаются: offline-очереди, push и повторов нет.
- `busy`/`hangup` — обычные сигналы. `busy` от одного участника не завершает конференцию
  на сервере: сервер не хранит состояние, а UI caller сам решает, продолжать ли звонок.

#### 9.5.3 `call.unavailable` для GROUP

Если **ни один** получатель кадра не имеет live-сессии, вызывающая сессия получает
`call.unavailable` с `reason:"PEER_OFFLINE"` (как в §9.3). Если доставлен хотя бы один —
ошибки и события нет: частичная доставка в MVP не является ошибкой.

#### 9.5.4 Ошибки GROUP

| Ситуация | Ответ |
| --- | --- |
| caller не ACTIVE-участник / чужой или неизвестный чат | `FORBIDDEN`, 403 |
| `recipient` не ACTIVE-участник этого чата, чужой/неизвестный UUID | `FORBIDDEN`, 403 |
| `recipient` равен caller | `WS_FRAME_INVALID`, 400 |
| GROUP без `conference`/`recipients` | `CALL_NOT_SUPPORTED`, 422 |
| DIRECT с `conference:true` или непустыми `recipients` | `WS_FRAME_INVALID`, 400 |
| `recipients` пуст, >50, с дублями, не UUID или без `conference:true` | `WS_FRAME_INVALID`, 400 |
| `conference:true` без `recipients` | `WS_FRAME_INVALID`, 400 |
| SDP > 32 KiB / candidate > 4 KiB | `CALL_PAYLOAD_TOO_LARGE`, 413 |
| весь кадр > 64 KiB (транспортный лимит) | `WS_FRAME_INVALID`, 400 |
| rate limit сессии исчерпан | `RATE_LIMITED`, 429 |

Любая из этих ошибок **не закрывает WS**; соединение остаётся пригодным для сообщений,
`typing`, `presence` и следующих звонков.

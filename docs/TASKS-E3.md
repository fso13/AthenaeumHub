# E3 — Realtime WebSocket slice (E3-B / E3-F)

> **Цель:** живая доставка сообщений и receipts через WS, reconnect/resume без дублей, базовая typing/presence.  
> **Контракты:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>) (`POST /realtime/ticket`), [`contracts/ws-protocol.md`](<../contracts/ws-protocol.md>).  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §7.5, §8.3, §9, §14.4; [`docs/TASKS.md`](<TASKS.md>).

## 0. Правила

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**`, `infra/**` | E3-B | всё внутри | `frontend/**`, `docs/**`, `contracts/**` |
| `frontend/**` | E3-F | всё внутри | `backend/**`, `infra/**`, `docs/**`, `contracts/**` |
| `contracts/**` | PM | — | — |

- Контракт WS уже зафиксирован; расхождения — `[BLOCKED]`, не придумывать.
- Auth-стек оставлен: Keycloak 8180, backend 8081, frontend 5173, PostgreSQL 5432. `8080` — чужой проект, не трогать.
- E3 — **single-node** fan-out (in-process hub). Redis/Kafka pub/sub — следующий срез; не тащить инфраструктуру сейчас.
- Сохранить `dev` и `keycloak` профили; WS должен работать в обоих.

## 1. E3-B — backend: ticket, WS, fan-out, replay

**Владелец:** backend-сессия  
**Оценка:** 2–3 сессии  
**Статус:** **DONE** — 167 backend-тестов, ArchUnit 10/10, live dev + keycloak smoke, real WS E2E 1/1

### Scope

1. **Realtime bounded context** (`ru.krug.backend.realtime`):
   - `domain`: `RealtimeTicket` (aggregate/value), `TicketId`, TTL, consumed; исключения.
   - `application`: `IssueTicketUseCase`, `OpenSessionUseCase`/`SubscriptionService`, ports `RealtimePublisherPort`, `ChatAccessPort`.
   - `infrastructure`: WS handler/config, in-memory hub, ticket JPA adapter, publisher.
   - `api`: `POST /api/v1/realtime/ticket` controller, DTO, mapper.
   - DDD/ArchUnit обновить.
2. **Ticket**
   - `POST /api/v1/realtime/ticket` с Bearer + `X-Device-Id` → `{ticket, expires_at, ws_url}`.
   - TTL 30 с, одноразовый. Вариант: JWT с `jti` + таблица `realtime_tickets` (миграция V7) либо подписанный opaque ticket + store. Одноразовость обязательна.
   - Невалидный/просроченный/использованный → 401; чужое устройство → 403.
   - `ws_url` из конфига (`ws://localhost:8081/ws` в dev; за reverse proxy — `wss://...`).
3. **WS endpoint** `/ws`
   - Spring WebSocket (`spring-boot-starter-websocket`), handshake auth по тикету; без токена в query.
   - `hello`, `subscribe`, `ack`, `ping`, `typing`; `subscribed`, `event`, `resume.gap`, `pong`, `error`, `session.revoked`.
   - Проверка membership на каждый чат; ≤200 подписок.
   - Replay: `messages WHERE seq > last_seq ORDER BY seq LIMIT 500`; `resume.gap` при разрыве >500.
   - Heartbeat 25 с, timeout 60 с; close 4401/4403/1008/1013.
4. **Fan-out**
   - После коммита `message.created` публиковать в `RealtimePublisherPort`; in-process hub рассылает подписчикам чата.
   - `message.receipt` — при `POST /read` (после коммита).
   - `typing` — клиент → сервер → подписчики чата, TTL 5 с, не персистить.
   - `presence` — по connect/disconnect, TTL 60 с, не персистить.
   - Outbound queue 256; drop ephemeral; close 1013 при переполнении.
5. **Тесты**
   - Unit: ticket TTL/one-time, subscribe auth, replay/gap, dedupe/order, queue.
   - Integration (Testcontainers PG): ticket endpoint, WS handshake, subscribe/replay, live fan-out from `POST /messages` (second user), receipt, 401/403, expired/used ticket.
   - Contract: ticket response + WS frame JSON schema.
   - Не ломать 122 существующих теста; ArchUnit 8/8 + новые правила.

### Вне scope

Redis/Kafka multi-node, E2EE envelopes, файлы, стикеры, плагины, durable replay >500, presence-between-workspaces, typing в E2EE (только managed).

## 2. E3-F — frontend: WS-клиент и интеграция

**Владелец:** frontend-сессия  
**Оценка:** 2 сессии  
**Статус:** **DONE** — WS-клиент/store/UI, 101 unit, E2E mock 4/4, real WS 1/1 против backend 8081

### Scope

1. **Realtime client**
   - `RealtimeClient`: `POST /realtime/ticket`, connect `ws_url` (через Vite proxy `/ws`; `VITE_WS_URL` optional), frames, heartbeat, close codes.
   - Auth: Bearer + `X-Device-Id`; тикет одноразовый; reconnect с новым тикетом.
   - Backoff 1/2/4/8/16/30 с + jitter; не более 60/час.
2. **Интеграция с chat store**
   - После bootstrap/`/sync`: subscribe active chat с `last_seq`.
   - `message.created`: merge по `seq`, dedupe по `event_id`/`id`; обновить `last_seq`, unread.
   - `message.receipt`: обновить read state (только свои/разрешённые).
   - `resume.gap`: REST-добор `GET /messages?after_seq=...` страницами, затем live.
   - `typing`: показывать «печатает…» с TTL; `presence` — статус.
   - Reconnect: `GET /sync` → новый тикет → subscribe; без дублей.
   - При `session.revoked`/4403 — разлогинить/показать ошибку.
3. **UI**
   - Индикатор соединения (online/reconnecting/offline) в шапке/баннере.
   - Не блокировать отправку при WS down: REST работает, сообщение появится после reconnect.
   - Не дублировать optimistic-сообщение при `message.created` (сопоставление по `client_message_id`/id/seq).
   - A11y: aria-live для новых сообщений/статуса, не спамить screen reader.
4. **Тесты**
   - Unit: frame parser, dedupe, gap, backoff, close codes.
   - Mock WS server (Vitest) или MSW + fake WebSocket: replay, live, receipt, typing, reconnect.
   - Playwright real: два контекста/пользователя — A отправляет, B видит без reload; reconnect после reload; без дублей.
   - `npm run check` зелёный; axe без блокеров.

### Вне scope

E2EE, файлы, стикеры, плагины, Redis/Kafka, push, offline-очередь сообщений (только текущая REST-очередь).

### E3: результат

| Проверка | Результат |
|---|---|
| Backend E3-B | 167 тестов, ArchUnit 10/10, dev + keycloak live smoke |
| Frontend E3-F | 101 unit, mock E2E 4/4, `npm run check` зелёный |
| Real WS E2E | **1 passed**: ticket → live message → reload/reconnect без дублей |
| Ticket | 200, one-time; reuse → 401, foreign device → 403 |
| WS | hello, subscribe, replay, resume.gap, 401/403, close codes |
| Fan-out | message.created + message.receipt; typing/presence эфемерны |
| Reconnect | `/sync` → новый ticket → subscribe; без дублей |

Оговорки:
- Single-node in-process hub; Redis/Kafka — следующий срез.
- Replay ≤500; глубже — REST.
- Нет E2EE WS payload.
- `realtime_tickets` пока без GC/отдельного rate limit.
- Typing/presence без privacy-настроек (FR-PRES-1 v1).

## 3. Acceptance (E3-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| E3-AC-01 | `POST /realtime/ticket` | 200, TTL 30 с, повторное использование → 401 |
| E3-AC-02 | WS connect | `hello`, heartbeat; без тикета → 401 |
| E3-AC-03 | Subscribe | `subscribed`, replay сообщений по `seq` |
| E3-AC-04 | Live message | второй пользователь отправляет → первый видит без reload |
| E3-AC-05 | Receipt | read → `message.receipt` второму участнику |
| E3-AC-06 | Reconnect | после разрыва нет дублей/потерь; gap → REST |
| E3-AC-07 | Authz | чужой чат → `accepted:false`/403, нет утечки |
| E3-AC-08 | Backpressure | медленный клиент → 1013, не блокирует других |
| E3-AC-09 | Typing/presence | эфемерные, TTL, не replay-ятся |

## 4. Решения

| ID | Решение | Причина |
|---|---|---|
| E3-D-01 | Single-node in-process hub | Не тащить Redis/Kafka в вертикальный срез; scale-out отдельно |
| E3-D-02 | Ticket TTL 30 с, one-time | Не светить access token в URL; replay-защита |
| E3-D-03 | Replay ≤500, gap → REST | Ограниченная память/БД; предсказуемо |
| E3-D-04 | `message.created` payload = поля `Message` на верхнем уровне `payload` | Клиенту не нужен дополнительный GET; контракт зафиксирован flat |
| E3-D-05 | WS только для managed-текста в E3 | E2EE envelopes — отдельный срез |

## 5. Известный долг

- Нет multi-node fan-out (Redis/Kafka) — single-node.
- Нет durable replay >500; клиент REST.
- Нет E2EE WS payload.
- Нет push/typing privacy settings (FR-PRES-1 v1).
- Backpressure 1013 тестируется unit/integration, не нагрузочно.

# «Сова»: разделение модульного монолита на микросервисы

> **Статус:** предложение к обсуждению (draft for review), 25.11.2026.
> **Область:** backend `krug-backend` (Java 21 / Spring Boot 3.4), контракты, данные, эксплуатация.
> **Не входит:** переписывание frontend, выбор облака, биллинг, мобильные приложения.
> **Связанные документы:** [MIGRATION.md](MIGRATION.md) · [ADR.md](ADR.md) · [EVENTS.md](EVENTS.md) · [service-catalog.yaml](service-catalog.yaml) · [галерея диаграмм](README.md).

---

## 0. TL;DR

1. **Монолит уже хорошо подготовлен к разделению.** 13 bounded context'ов живут в отдельных пакетах и схемах PostgreSQL, слои `domain → application → infrastructure → api` закреплены ArchUnit, межконтекстные связи идут через порты. Это не «big ball of mud».
2. **Но runtime-связность сильнее, чем кажется по коду.** 93 FK-ссылки между схемами (16 уникальных целей), 60 `SECURITY DEFINER`-функций, WebSocket fan-out в памяти одного узла, `ops.outbox` — заглушка, которая пишет в лог, Redis/Kafka/OpenSearch не используются. Разделение начинается не с выделения сервисов, а с **платформенных enablers**.
3. **Целевая архитектура — 10 сервисов + edge.** `identity`, `workspace`, `conversation`, `media`, `realtime`, `notification`, `extensions`, `audit`, `search`, `admin`.
4. **`chat` и `message` остаются одним сервисом `conversation`.** Отправка сообщения — одна транзакция: ACL + `seq` + сообщение + конверты + outbox. Разделение даст сагу, рост p95 и риск потери порядка `seq` без выигрыша в масштабе. Это зафиксировано в [ADR-001](ADR.md#adr-001-chat-и-message--один-сервис).
5. **Порядок выделения:** enablers → `realtime` + `audit` → `media` + `notification` → `extensions` + `admin` → `identity` + `workspace` → hardening `conversation`. Начинать с `chat`/`message` — типичная и самая дорогая ошибка.
6. **Не делать «сервис на модуль».** `sticker` уходит в `media`, `bot` — в `extensions`, `room` — в `conversation`, `ops` растворяется между `admin`, владельцами данных и per-service воркерами.

Ключевые цифры:

| Метрика | Значение | Источник |
|---|---|---|
| Bounded context'ов | 13 (+ `shared`) | `backend/src/main/java/ru/krug/backend` |
| Java-код | ~77,7 тыс. LOC, 1458 файлов | подсчёт по каталогам |
| Схем PostgreSQL | 13 | Flyway V1…V63 |
| Миграций | 62 | `backend/src/main/resources/db/migration` |
| FK между схемами | 93 ссылки, 16 уникальных целей | grep по миграциям |
| `SECURITY DEFINER`-функций | 60 | grep по миграциям |
| REST-операций | 182 (135 paths) | `contracts/openapi.yaml` |
| Тестов | 498 backend, ArchUnit 10/10 | README / STATUS |
| Межконтекстных импортов | 53 связи, 8 с импортом `domain` | [матрица](diagrams/coupling-matrix.md) |

---

## 1. Контекст и допущения

### 1.1. Что есть сейчас

Один deployable `krug-backend` (Spring Boot 3.4, Java 21), одна PostgreSQL 16 с 13 схемами, Keycloak как IdP, MinIO/S3 для блобов, Caddy/nginx и SPA. В `deploy/` — docker-compose для одного хоста; Kubernetes-манифестов нет.

Модульный монолит реализован честно:

- каждый контекст — пакет `ru.krug.backend.<context>` с четырьмя слоями;
- JPA-сущности только в `infrastructure.persistence`, DTO только в `api.dto`;
- межконтекстные вызовы — через `application.port`, а не через чужие репозитории (за редкими исключениями, см. §2.2);
- своя схема PostgreSQL у модуля, RLS по `workspace_id`/`user_id`;
- ArchUnit запрещает домену зависеть от Spring/JPA, application — от infrastructure/api, API — от domain/infrastructure, а домену — от домена другого контекста.

Это означает: **основная работа по разделению — не «распилить код», а разорвать данные, транзакции и runtime-состояние**.

### 1.2. Драйверы разделения

| Драйвер | Проявление сегодня | Что даёт сервис |
|---|---|---|
| Масштабирование WebSocket | in-memory hub, один узел, нет sticky-less fan-out | `realtime` масштабируется по connections независимо от REST |
| Изоляция медиа | загрузки/скан/превью делят heap и пул с API | `media` масштабируется по IO/CPU, падение не роняет чат |
| Изоляция риска плагинов | код пакетов и боты в том же процессе | `extensions` + sandbox, отдельный blast radius |
| Независимые релизы | один образ, одна Flyway-история | сервисные релизы, canary, откат |
| Комплаенс-аудит | аудит пишется в той же транзакции | `audit` как отдельный append-only контур с SIEM |
| Команды | один код-оунер на весь backend | ownership по сервисам и SLO |
| Отказоустойчивость | падение процесса = падение всего | деградация по функциям, а не целиком |

### 1.3. Драйверы **не** разделять

- «Так модно» и «в резюме» — не драйвер. Монолит с 13 контекстами и RLS дешевле в эксплуатации, чем 10 сервисов без платформы.
- Нет команды эксплуатации (on-call, IaC, observability) — сначала строим её, потом плодим deployables.
- Нет реальной нагрузки на конкретный модуль — сначала измеряем, потом выделяем. Сегодня узкое место — WebSocket и медиа, а не `workspace`.
- Нельзя выделять сервис, у которого нет владельца данных и SLO. «Общий» сервис — антипаттерн.

### 1.4. Допущения

- Аудитория — команда 8–15 инженеров, 3–4 продуктовых потока.
- Целевой масштаб: 100 тыс. DAU, 20 тыс. одновременных WS-соединений, пик 2 тыс. сообщений/с, 5 тыс. файлов/час.
- Managed-режим — основной; E2EE — пилот (флаг `false`), но архитектура обязана его не ломать.
- Kubernetes — целевая платформа; docker-compose остаётся для локальной разработки.
- Kafka допустима как managed-сервис (или Redpanda); Redis — managed/cluster.
- Бюджет на инфраструктуру ограничен: на старте допустим один кластер PostgreSQL с отдельной database и ролью на сервис.

---

## 2. As-is: факты, а не ощущения

### 2.1. Модули

| Контекст | LOC | Ответственность | Схема |
|---|---:|---|---|
| `auth` | 12 376 | BFF, Keycloak, пользователи, сессии, устройства, 2FA, prekeys, блокировки | `auth` |
| `workspace` | 8 503 | Воркспейсы, членство, роли, инвайты, лимиты, security/DLP-политики | `workspace` |
| `chat` | 7 172 | Чаты, участники, права, пины, read state, счётчики, `seq` | `chat` |
| `message` | 8 339 | Сообщения, конверты, реакции, edit/delete, треды, упоминания | `message` |
| `file` | 10 982 | Загрузки, вложения, квоты, S3, AV, превью, GC | `file` |
| `sticker` | 1 399 | Наборы, стикеры, избранное | `sticker` |
| `notification` | 2 120 | In-app лента, настройки, email/push | `notification` |
| `plugin` | 5 941 | Каталог, пакеты, установка, capability, polls/tasks, перевод | `plugin` |
| `bot` | 5 313 | Боты, токены, доставки, команды | `bot` |
| `room` | 1 392 | Аудио/видео-комнаты поверх GROUP-чата, presence | `room` |
| `realtime` | 4 554 | WS-тикеты, сессии, подписки, replay, presence, calls | `realtime` |
| `ops` | 6 116 | Admin API, setup, health, retention, outbox, идемпотентность | `ops` |
| `audit` | 420 | Append-only аудит, hash chain, экспорт | `audit` |
| `shared` | 3 097 | `Principal`, `TenantContext`, ошибки, порты, конфиг | — |

`ops` — не bounded context. Это платформенный слой: admin-контроллеры по чужим данным, setup, воркеры, retention. Именно поэтому он импортирует `auth`, `chat`, `file`, `workspace` и мешает выделению.

### 2.2. Связность

Полная матрица — [coupling-matrix.md](diagrams/coupling-matrix.md) и [heatmap](diagrams/svg/04-coupling-matrix.svg). Сводка:

- 53 направленных связи между контекстами;
- 8 связей импортируют `domain`-классы чужого контекста (нарушение границы);
- самые тяжёлые: `realtime → message` (25 импортов, 5 domain), `message → chat` (18, 3), `file → chat` (13), `bot → message` (13, 4), `auth → chat` (11), `realtime → chat` (10, 2), `ops → auth` (21), `auth → ops` (15), `workspace/chat → audit` (26/20).

Что это значит:

1. **`realtime` читает `message` и `chat` напрямую.** `RealtimeChatHistoryAdapter` тянет `MessageRepository`, `MessageEnvelopeRepository` и `ChatRepository` — это не порт, а прямой доступ к чужим агрегатам. При выделении `realtime` нужен внутренний read-API `conversation`.
2. **`message` и `chat` уже связаны транзакционно.** `MessageSubmissionHandler` в одной транзакции вызывает `ChatAccessPort`, `ChatPermissionPort`, `SeqAllocator` (row lock в `chat.chat_counters`), пишет `message.*` и `ops.outbox`. Это главный аргумент не разделять их.
3. **`bot` и `plugin` пишут сообщения через `message`.** `BotMessageService` и `PluginMessageService` импортируют `message.domain` — при выделении нужен внутренний API `conversation` и capability-токены.
4. **`ops` — точка сбора кросс-контекстных admin-запросов.** `AdminUsersController`, `AdminChatsController`, `AdminStorageController` читают чужие схемы через `SECURITY DEFINER`-функции. При разделении это либо CQRS read model, либо API composition.

### 2.3. Данные

| Проблема | Масштаб | Почему блокирует разделение |
|---|---|---|
| Межсхемные FK | 93 ссылки на 16 целей: `auth.users` (27), `workspace.workspaces` (20), `chat.chats` (19), `file.attachments` (5), `auth.devices` (4), `plugin.*` (11) | Нельзя разнести БД, пока FK связывают таблицы |
| `SECURITY DEFINER` | 60 функций, 84 упоминания; `ops.platform_overview`, `ops.admin_users_page`, `chat.member_directory`, `workspace.member_directory` | Это кросс-схемные read-модели; в сервисах их заменяют API/проекции |
| RLS | 31 миграция с `ROW LEVEL SECURITY` | Хорошо переносится, но каждая БД должна иметь свои роли и `app.workspace_id` |
| Flyway | 62 миграции, одна история `flyway_schema_history` | Нужны per-service baseline и независимые релизы |
| Партиционирование | 3 партиционированные таблицы (`messages` и связанные) | Сохраняется внутри `conversation` |

Ключевой вывод: **схемы — не границы сервисов**. Граница появляется, когда у схемы есть свой владелец, своя роль, своя история миграций и нет FK в чужую схему.

### 2.4. Runtime

| Компонент | Сейчас | Следствие |
|---|---|---|
| WebSocket | `InMemoryRealtimeHub`, `ConcurrentHashMap` сессий, per-chat lock | Горизонтальное масштабирование невозможно: клиент должен попасть на тот же узел |
| События | Spring `@TransactionalEventListener(AFTER_COMMIT)` + `LoggingEventPublisher` | События не покидают процесс; outbox помечается published, но никуда не публикуется |
| Redis | не используется | Presence/typing/rate limit — в памяти или БД |
| Kafka | не используется | Нет durable fan-out, replay, consumer lag |
| OpenSearch | не используется | Поиск — SQL `ILIKE`/триграммы по `message` |
| Деплой | docker-compose, Caddy, один хост | Нет HPA, PDB, NetworkPolicy, canary |

Поэтому «выделить realtime» сейчас нельзя: он не сможет получать события из другого процесса. Сначала — брокер и реальный outbox relay.

### 2.5. Что это значит для декомпозиции

- **Код готов к сервисным границам на 70%.** Осталось убрать 8 domain-leak'ов и заменить прямые адаптеры на внутренние API.
- **Данные готовы на 40%.** Схемы разделены, но FK и `SECURITY DEFINER` связывают их крепче, чем код.
- **Runtime готов на 10%.** Нет брокера, внешнего состояния WS, per-service миграций.
- **Организационно готов на 0%.** Нет владельцев сервисов, SLO, on-call, runbook'ов. Это надо строить параллельно с Wave 0.

---

## 3. Метод декомпозиции

### 3.1. Критерии

Границу проводим не по «модулю», а по совокупности:

1. **Владение данными.** Кто единственный писатель? Есть ли транзакция, которую нельзя разорвать?
2. **Транзакционная связность.** Сколько инвариантов ломается при разделении? Можно ли заменить сагой/событием без потери корректности?
3. **Синхронная связность.** Сколько вызовов в hot path? Можно ли закэшировать/сделать асинхронно?
4. **Масштабирование.** Есть ли отдельный профиль нагрузки (connections, IO, CPU, память)?
5. **Изоляция риска.** Что произойдёт при компрометации/падении модуля?
6. **Частота изменений и ownership.** Меняется ли модуль независимо? Есть ли команда?

### 3.2. Оценка модулей

Шкала: `++` — сильный аргумент за отдельный сервис, `+` — скорее за, `−` — против, `−−` — блокер.

| Модуль | Данные | Транзакции | Sync | Масштаб | Риск | Вердикт |
|---|---|---|---|---|---|---|
| `realtime` | ++ (только тикеты) | ++ (нет записи в домен) | − (читает message/chat) | ++ (connections) | ++ | **Сервис, Wave 1** |
| `audit` | ++ | ++ (append-only) | ++ (только события) | + | ++ | **Сервис, Wave 1** |
| `file` + `sticker` | ++ | + (квота) | + | ++ (IO/CPU) | ++ | **`media`, Wave 2** |
| `notification` | ++ | ++ | + | + | + | **Сервис, Wave 2** |
| `plugin` + `bot` | ++ | + | − (message) | + | ++ (sandbox) | **`extensions`, Wave 3** |
| `auth` | ++ | + | + | + | ++ (ключи/сессии) | **Сервис, Wave 4** |
| `workspace` | ++ | + | + | + | + | **Сервис, Wave 4** |
| `chat` + `message` | + | −− (одна транзакция) | −− | ++ | + | **Один сервис, не дробить** |
| `room` | − (транзакция с chat) | − | + | − | − | **В `conversation`** |
| `sticker` | + | + | − | − | − | **В `media`** |
| `bot` | + | + | − | + | + | **В `extensions`** |
| `ops` | −− (сборная солянка) | −− | −− | − | − | **Растворить** |
| `shared` | — | — | — | — | — | **Платформенная библиотека** |

### 3.3. Правила границ

1. **Один сервис — одна БД и одна роль.** В переходный период — отдельная database в общем кластере, но без кросс-БД грантов.
2. **Транзакция не пересекает границу сервиса.** Всё, что должно быть атомарным, остаётся в одном сервисе. Всё остальное — сага/событие.
3. **Синхронный вызов — только чтение/валидация в рамках запроса.** Побочные эффекты — через outbox.
4. **Максимум 2 синхронных hops.** Цепочка `A → B → C → D` в запросе — признак неверной границы.
5. **Событие — контракт, а не дамп агрегата.** Только ID, версия, минимально необходимые поля; без plaintext и секретов.
6. **Кэш — не источник истины.** Проекция всегда восстанавливается из API/событий; TTL и инвалидация обязательны.
7. **Никакой общей доменной библиотеки.** Общие — только платформенные вещи: security, observability, outbox, тест-утилиты.

---

## 4. Целевая архитектура

### 4.1. Обзор

```text
Клиент ──HTTPS/WSS──> edge (Gateway + BFF)
                         ├─ identity     — пользователи, сессии, устройства, ключи
                         ├─ workspace    — тенанты, членство, роли, лимиты, политики
                         ├─ conversation — чаты + сообщения + seq + комнаты
                         ├─ media        — файлы, вложения, квоты, S3, AV, стикеры
                         ├─ realtime     — WS, тикеты, presence, calls
                         ├─ notification — in-app, email/push
                         ├─ extensions   — плагины, боты, polls/tasks
                         ├─ audit        — append-only, hash chain, SIEM
                         ├─ search       — OpenSearch (managed)
                         └─ admin        — platform admin + CQRS read model

Kafka · Redis · PostgreSQL (DB per service) · S3 · OpenSearch · Keycloak · KMS · ClamAV
```

Диаграммы: [C4 L2 target](diagrams/svg/03-c4-container-target.svg) · [sync-вызовы](diagrams/svg/05-service-map-sync.svg) · [event flow](diagrams/svg/06-event-flow.svg) · [data ownership](diagrams/svg/07-data-ownership.svg) · [deployment](diagrams/svg/13-deployment.svg).

### 4.2. Каталог сервисов

#### `edge` — Gateway + BFF

- **Ответственность:** TLS, WAF, rate limit, валидация JWT, маршрутизация по префиксам, WebSocket upgrade, композиция экранов (bootstrap, список чатов, admin overview), cookie/CSRF для `/auth/*`.
- **Не владеет данными.** Кэширует JWKS, маршруты, rate-limit counters в Redis.
- **Публичный API:** весь `/api/v1/**`, `/ws`.
- **Внутренние вызовы:** все сервисы.
- **Почему отдельно:** единая точка безопасности и совместимости; клиент не должен знать топологию.
- **Риск:** BFF обрастает логикой. Правило: в edge нет доменных инвариантов, только orchestration + DTO.

#### `identity` — Identity & Access

- **Ответственность:** регистрация, вход, 2FA, сессии, refresh-cookie, устройства, prekeys, верификация ключей, блокировки, профиль, аватары (метаданные; блоб — в `media`).
- **Данные:** `auth.users`, `devices`, `device_prekeys`, `user_identities`, `user_totp`, `user_recovery_codes`, `session_activity`, `key_verifications`, `user_blocks`, `email_verifications`.
- **Публичный API:** `/auth/*`, `/me*`, `/devices*`, `/keys*`, `/users/{id}/block`, `/me/blocked`.
- **Публикует:** `user.registered`, `user.updated`, `user.deleted`, `device.revoked`, `device.keys.updated`, `session.revoked`.
- **Синхронные зависимости:** Keycloak (OIDC/Admin API), PostgreSQL, Redis (rate limit), SMTP.
- **Масштаб:** 2+ реплики, read-heavy.
- **SLO:** login p95 < 400 мс; refresh p95 < 150 мс; доступность 99.95%.

#### `workspace` — Workspace & Policy

- **Ответственность:** воркспейсы, членство, роли и права уровня workspace, инвайты, тариф/лимиты, security-настройки, DLP-политики (определения), retention-политики, seat limit.
- **Данные:** `workspaces`, `memberships`, `invites`, `workspace_limits`, `role_permissions`, `security_settings`, `dlp_policies`, `retention_runs`.
- **Публичный API:** `/workspaces*`, `/workspaces/{id}/members|invites|limits|permissions|security|dlp`, `/workspace-invites/*`.
- **Публикует:** `workspace.created/updated/deleted`, `member.changed`, `invite.accepted`, `limits.changed`, `policy.changed`.
- **Синхронные зависимости:** PostgreSQL; `identity` — только через события/кэш.
- **SLO:** membership check p95 < 50 мс (кэш), 99.95%.

#### `conversation` — Chat & Message Core

- **Ответственность:** чаты и каналы, участники, роли/права в чате, инвайты, пины, архив, read state, счётчики, `seq`, сообщения, конверты, реакции, edit/delete, треды, упоминания, комнаты (метаданные + backing chat).
- **Данные:** `chat.chats`, `chat_members`, `chat_counters`, `chat_permissions`, `chat_pins`, `read_receipts`, `invites`, `message.messages`, `message_envelopes`, `message_reactions`, `mentions`, `message_deletions`, `room.rooms`.
- **Публичный API:** `/chats*` (кроме plugins/polls/tasks/commands), `/workspaces/{id}/chats`.
- **Внутренние API:** ACL-batch, replay, envelopes-by-device, message snapshot batch.
- **Публикует:** `message.created/edited/deleted/reaction.changed`, `chat.created/updated/member.changed/pin.changed`, `message.read`.
- **Синхронные зависимости:** `workspace` (лимиты/DLP, кэш), `media` (готовность вложений, batch), `identity` (профили/устройства, кэш).
- **SLO:** send p95 < 150 мс, p99 < 400 мс; history p95 < 120 мс; 99.95%.
- **Ключевое решение:** `chat` + `message` — один сервис и одна БД. См. [ADR-001](ADR.md#adr-001-chat-и-message--один-сервис).

#### `media` — Media & Stickers

- **Ответственность:** preflight, resumable upload, multipart S3, вложения, квоты (reserve/commit/release), AV-скан, превью/artwork, стикеры и наборы, файловый центр, GC/retention.
- **Данные:** `file.uploads`, `upload_parts`, `attachments`, `attachment_keys`, `quota_reservations`, `workspace_usage`, `workspace_limits` (кэш политики), `sticker.sticker_packs`, `stickers`, `sticker_favorites`; S3-бакеты.
- **Публичный API:** `/uploads*`, `/media/*`, `/attachments/*`, `/files*`, `/workspaces/{id}/files`, `/sticker-packs`, `/stickers/*`.
- **Публикует:** `upload.completed`, `media.scan.completed`, `quota.threshold.reached`, `sticker.pack.changed`, `attachment.deleted`.
- **Синхронные зависимости:** `workspace` (лимиты, кэш), S3, ClamAV, KMS (managed).
- **SLO:** init p95 < 150 мс; part p95 < 300 мс (без учёта сети); scan lag p95 < 60 с; 99.9%.

#### `realtime` — Realtime Gateway

- **Ответственность:** WS-тикеты, сессии, подписки, replay, fan-out по устройствам, presence, typing, call signaling (WebRTC), разрыв сессий при revoke.
- **Данные:** `realtime.realtime_tickets`; Redis — presence, typing, маршрутизация соединений. Доменных данных не хранит.
- **Публичный API:** `POST /realtime/ticket`, `WSS /ws`.
- **Потребляет:** `message.*`, `chat.member.changed`, `device.revoked`, `media.scan.completed`.
- **Публикует:** `message.delivered`, `message.read` (в Kafka, для `conversation`).
- **Синхронные зависимости:** `conversation` (ACL + replay, batch), `identity` (валидация сессии/устройства).
- **SLO:** connect p95 < 300 мс; fan-out p95 < 200 мс после коммита; 10k соединений/узел; 99.9%.
- **Особенность E2EE:** событие несёт только флаг `e2ee`; конверты на устройство запрашиваются у `conversation` batch-ом, чтобы не раздувать Kafka и не рассылать чужие конверты.

#### `notification` — Notifications

- **Ответственность:** in-app лента, настройки, quiet hours, dedupe, email/push, retry, retention.
- **Данные:** `notifications`, `notification_preferences`.
- **Публичный API:** `/notifications*`, `/notification-preferences`.
- **Потребляет:** `message.created`, `chat.member.changed`, `invite.accepted`, `quota.threshold.reached`, `device.revoked`.
- **Публикует:** `notification.sent/failed` (для аудита/метрик).
- **Синхронные зависимости:** `identity` (email/профиль, кэш), SMTP, Web Push.
- **SLO:** in-app p95 < 2 с после события; email/push — at-least-once, dedupe по `dedupe_key`.

#### `extensions` — Plugins & Bots

- **Ответственность:** каталог плагинов, версии, пакеты и подписи, установка/enablement, consent, capability-токены, RPC-брокер, kill switch, боты (токены, signing secret, event deliveries, commands), polls/tasks, перевод (провайдер).
- **Данные:** `plugin.catalog`, `packages`, `package_objects`, `poll_options`, `polls`, `tasks`, `bot.bots`, `chat_bots`, `command_tokens`, `event_deliveries`; S3 для пакетов.
- **Публичный API:** `/plugins*`, `/bots*`, `/bot-responses/*`, `/chats/{id}/plugins|polls|tasks|commands`, `/admin/plugins/*`.
- **Потребляет:** `message.created`, `chat.member.changed`, `device.revoked`.
- **Публикует:** `plugin.installed/enabled/disabled/killed`, `plugin.consent.changed`, `bot.event.delivered/failed`, `poll.closed`, `task.updated`.
- **Синхронные зависимости:** `conversation` (публикация plugin-сообщения), `media` (ассеты), S3, plugin registry, sandbox runtime.
- **SLO:** install p95 < 2 с; bot delivery p95 < 5 с; sandbox не влияет на core.

#### `audit` — Audit & Compliance

- **ответственность:** append-only аудит, hash chain, anchors, экспорт, SIEM, DLP-события, break-glass, retention.
- **Данные:** `audit.audit_events`, `audit_chain`, `audit_anchors`; S3 WORM для anchors/экспорта.
- **Публичный API:** `/workspaces/{id}/audit`, `/workspaces/{id}/audit/export`, `/admin/audit*`.
- **Потребляет:** все топики (audit-envelope), `media.scan.completed`, `plugin.*`.
- **Публикует:** `audit.appended` (SIEM), `audit.anchor.created`.
- **Синхронные зависимости:** PostgreSQL, S3, KMS, SIEM. **Не вызывает другие сервисы.**
- **SLO:** append lag p95 < 5 с; query p95 < 300 мс; 99.9%; ноль потерь (outbox + DLQ).

#### `search` — Search (managed)

- **Ответственность:** индексация managed-контента, ACL-фильтр, DLP-редакция, reindex, query API.
- **Данные:** OpenSearch-индекс; PostgreSQL не является SoT.
- **Публичный API:** `/workspaces/{id}/search/messages`.
- **Потребляет:** `message.*`, `chat.*`, `member.changed`.
- **Синхронные зависимости:** OpenSearch, `conversation` (reindex batch).
- **SLO:** index lag p95 < 10 с; query p95 < 200 мс; E2EE не индексируется.

#### `admin` — Platform Admin

- **Ответственность:** platform admin BFF, CQRS read model (users/chats/storage/overview/audit), команды (suspend, delete chat, revoke sessions), setup wizard, system settings.
- **Данные:** `admin_read.*` (проекции), `ops.system_settings` (переезжает сюда).
- **Публичный API:** `/admin/*`, `/setup/*`, `/health`.
- **Потребляет:** все доменные события для проекций.
- **Синхронные зависимости:** владельцы данных (команды), `audit` (экспорт).
- **Правило:** никаких кросс-БД JOIN; списки и overview — из read model, команды — через API владельца.

#### Растворённые модули

| Модуль | Куда | Почему |
|---|---|---|
| `sticker` | `media` | Тот же S3/AV/лимиты, нет своей транзакционной истории |
| `bot` | `extensions` | Общий lifecycle «внешнее расширение», общие capability-токены |
| `room` | `conversation` | Создаёт backing chat в одной транзакции, метаданные чата |
| `ops` | `admin` + владельцы + воркеры | Не bounded context; admin API, setup, retention, outbox |
| `shared` | платформенная библиотека | `Principal`, ошибки, OTel, outbox-клиент; без домена |

### 4.3. Границы и почему так

**Почему `chat` + `message` вместе.** Отправка сообщения сегодня — одна транзакция: idempotency + ACL + `seq` (row lock в `chat.chat_counters`) + insert message + envelopes + outbox. Если разделить:

- `seq` придётся либо оставить в `chat` (синхронный вызов в hot path, distributed lock), либо перенести в `message` (ломается `chat.last_message_at`/счётчики);
- появится сага «сообщение записано, но счётчик не обновлён»;
- p95 вырастет на сетевой hop + retry;
- E2EE-валидация требует доступа к устройствам и чату в одной транзакции.

Выигрыша нет: `chat` и `message` масштабируются одинаково (оба — PostgreSQL + CPU), а нагрузка на них общая. Граница проходит **вокруг** пары, а не между ними.

**Почему `realtime` отдельно.** У него другой профиль: тысячи долгоживущих соединений, память, event loop, Redis pub/sub. Он не пишет домен, кроме тикетов. Это лучший первый кандидат.

**Почему `media` отдельно.** IO/CPU, S3, AV, квоты; всплески загрузок не должны влиять на send. `conversation` нужен только readiness вложений — batch-вызов и кэш.

**Почему `extensions` отдельно.** Недоверенный код (плагины/боты) и внешние вебхуки. Отдельный namespace, egress-proxy, capability-токены, resource limits. Даже если код пока не исполняется на сервере, граница нужна до открытия каталога.

**Почему `audit` отдельно.** Append-only, hash chain, WORM, SIEM — другой профиль записи и комплаенс. Аудит не должен падать вместе с бизнес-транзакцией; outbox даёт at-least-once.

**Почему `admin` отдельно.** Сегодня admin — это `ops`-контроллеры, читающие чужие схемы через `SECURITY DEFINER`. После разделения нужен либо API composition (медленно, N+1), либо CQRS read model. Выбираем read model + команды через владельцев.

**Почему `search` отдельно.** Managed-only, OpenSearch, другой индекс и другой профиль деградации. E2EE не индексируется. Можетстартовать как воркер `conversation`, но граница должна быть с самого начала.

---

## 5. Взаимодействие

### 5.1. Синхронные вызовы

Правила:

- только чтение/валидация в рамках запроса;
- timeout 200–500 мс, circuit breaker, bulkhead;
- идемпотентные retry только для GET;
- batch-эндпоинты вместо N+1;
- кэш + инвалидация событиями;
- максимум 2 hops.

Разрешённые связи:

| From | To | Зачем | Режим |
|---|---|---|---|
| `conversation` | `workspace` | лимиты, DLP-политика | кэш + fallback |
| `conversation` | `media` | готовность вложений | batch, кэш |
| `conversation` | `identity` | профили, устройства | кэш + события |
| `realtime` | `conversation` | ACL, replay, конверты | batch |
| `realtime` | `identity` | сессия/устройство | тикет |
| `media` | `workspace` | лимиты/тариф | кэш |
| `extensions` | `conversation` | публикация plugin-сообщения | команда |
| `extensions` | `media` | ассеты плагина | чтение |
| `notification` | `identity` | email/профиль | кэш |
| `admin` | владельцы | команды | API |
| `admin` | `audit` | экспорт | API |

Запрещено:

- `conversation → extensions` в hot path (цикл и лишний hop);
- `conversation → notification` синхронно;
- `media → conversation` (только события);
- цепочки длиннее 2 hops;
- distributed transaction/2PC.

### 5.2. События

- **Broker:** Kafka (или Redpanda), RF=3, `min.insync.replicas=2`.
- **Outbox:** в БД каждого сервиса, relay через `SKIP LOCKED` или Debezium.
- **Envelope:** `event_id`, `type`, `version`, `occurred_at`, `workspace_id`, `aggregate_type`, `aggregate_id`, `partition_key`, `trace_id`, `producer`, `payload`.
- **Семантика:** at-least-once; идемпотентный консьюмер по `event_id`; порядок в пределах `partition_key`.
- **Partition key:** `chat_id` для `message/chat`, `workspace_id` для `workspace/media/audit`, `user_id` для `identity`.
- **DLQ:** `<topic>.dlq`, алерт по лагу и размеру.
- **Ретеншн:** 7–14 дней для доменных, compacted для ACL-снапшотов (`chat.acl.v1`).
- **Схемы:** JSON Schema в репозитории, CI-валидация; Avro/Schema Registry — позже, если появится потребность.

Топики и маршрутизация — [EVENTS.md](EVENTS.md). Диаграмма — [06-event-flow](diagrams/svg/06-event-flow.svg).

### 5.3. Консистентность

| Инвариант | Владелец | Механизм |
|---|---|---|
| `seq` монотонен в чате | `conversation` | row lock в `chat_counters`, одна транзакция с insert |
| Уникальный `client_message_id` | `conversation` | unique index `(chat_id, sender_id, client_message_id)` |
| Идемпотентность send | `conversation` | `idempotency_keys` в той же транзакции |
| Вложение готово до send | `media` | статус `SCANNING/CLEAN/INFECTED`, fail-closed |
| Квота не превышена | `media` | reserve/commit/release + TTL, reconciliation |
| ACL чата | `conversation` | источник истины; кэш в `realtime`/`media` |
| Лимиты workspace | `workspace` | кэш в `conversation`/`media`, инвалидация событием |
| Read receipts монотонны | `conversation` | `max(last_read_seq)` |
| Device revoke | `identity` | событие → `realtime` закрывает WS, `conversation` чистит кэш |
| Audit hash chain | `audit` | последовательный append по workspace, anchor в S3 WORM |
| Capability плагина | `extensions` | короткоживущий токен + проверка на границе |

Правило: **если инвариант нельзя обеспечить без распределённой транзакции — граница проведена неверно.**

### 5.4. Кэши и проекции

| Кэш | Где | TTL | Инвалидация |
|---|---|---|---|
| Лимиты/тариф | `conversation`, `media` | 60 с | `limits.changed` |
| DLP-политика | `conversation` | 60 с | `policy.changed` |
| ACL чата | `realtime` | 5 мин | `chat.member.changed` + epoch |
| Профиль пользователя | `conversation`, `notification` | 5 мин | `user.updated` |
| Готовность вложения | `conversation` | 60 с | `media.scan.completed` |
| JWKS | `edge` | по `cache-control` | ротация ключей |
| Тикеты | `realtime` (Redis) | 30 с | одноразовое потребление |

Кэш всегда имеет fallback на API и не является источником истины. При недоступности владельца: для DLP — fail-closed (managed), для лимитов — последний известный snapshot с метрикой `stale_cache_used`.

---

## 6. API и маршрутизация

### 6.1. Публичный API

Контракт остаётся `contracts/openapi.yaml` (182 операции). Меняется только владелец и маршрут в edge.

| Префикс | Сервис |
|---|---|
| `/auth/*`, `/me*`, `/devices*`, `/keys*`, `/users/*/block`, `/me/blocked` | `identity` |
| `/workspaces*` (кроме `/chats`, `/files`, `/search`, `/audit`, `/security`, `/sessions`, `/dlp`) | `workspace` |
| `/workspaces/{id}/chats`, `/chats/*` (кроме plugins/polls/tasks/commands) | `conversation` |
| `/workspaces/{id}/files`, `/uploads*`, `/media/*`, `/attachments/*`, `/files*`, `/sticker-packs`, `/stickers/*` | `media` |
| `/realtime/ticket`, `/ws` | `realtime` |
| `/notifications*`, `/notification-preferences` | `notification` |
| `/plugins*`, `/bots*`, `/bot-responses/*`, `/chats/{id}/plugins|polls|tasks|commands`, `/admin/plugins/*` | `extensions` |
| `/workspaces/{id}/audit*`, `/admin/audit*`, `/workspaces/{id}/dlp/events` | `audit` |
| `/workspaces/{id}/search/messages` | `search` |
| `/admin/*` (кроме plugins/audit), `/setup/*`, `/health` | `admin` |

Правила:

- путь и владелец не обязаны совпадать 1:1; edge маршрутизирует по **самому специфичному** префиксу;
- публичный контракт версионируется в `contracts/`; внутренние API — `/internal/v1/*` и не публикуются через edge;
- ломающие изменения — только через новую версию пути или поля с `deprecated`.

### 6.2. Внутренние API

| Сервис | Эндпоинт | Назначение |
|---|---|---|
| `identity` | `POST /internal/v1/users:batch` | профили по ID |
| `identity` | `GET /internal/v1/sessions/{id}` | валидация сессии |
| `identity` | `POST /internal/v1/devices/keys:batch` | устройства и prekeys |
| `workspace` | `POST /internal/v1/memberships:batch` | членство/роли |
| `workspace` | `GET /internal/v1/workspaces/{id}/limits` | лимиты/тариф |
| `workspace` | `GET /internal/v1/workspaces/{id}/dlp-policy` | DLP snapshot |
| `conversation` | `POST /internal/v1/chats:acl-batch` | ACL + last_seq + epoch |
| `conversation` | `GET /internal/v1/chats/{id}/replay` | события с seq |
| `conversation` | `POST /internal/v1/messages/envelopes:batch` | конверты по device_id |
| `conversation` | `POST /internal/v1/messages:batch` | снапшоты сообщений |
| `media` | `POST /internal/v1/attachments:batch` | готовность вложений |
| `media` | `GET /internal/v1/attachments/{id}/download-url` | presigned GET |
| `extensions` | `POST /internal/v1/capabilities/check` | capability-токен |
| `audit` | `GET /internal/v1/audit/export` | экспорт |

Требования: mTLS, `X-Request-Id`, `traceparent`, `X-Actor-Id`, `X-Workspace-Id`, таймауты, лимит размера ответа, версия в пути.

### 6.3. Права и контекст

- Пользовательский JWT выпускает `identity` (через Keycloak), проверяет `edge`.
- В JWT: `sub`, `sid`, `device_id`, `exp`, `aud`, `iss`; **не** все workspace'ы.
- Workspace выбирается из пути/заголовка и проверяется `workspace`/`conversation`; в БД — RLS по `app.workspace_id`.
- Внутренний вызов несёт `X-Actor-Id`, `X-Workspace-Id`, `X-Request-Id`, `X-Device-Id`; доверие — только mTLS + network policy.
- Для ботов — отдельный `bot_token` и `act` claim; для плагинов — capability-токен с ограниченным scope и TTL.
- Platform admin — отдельный claim/роль; break-glass — 2 approval, JIT, TTL, аудит.

---

## 7. Данные

### 7.1. Владение

| Сервис | Схема/хранилище | Ключевые таблицы |
|---|---|---|
| `identity` | `auth` | `users`, `devices`, `device_prekeys`, `user_identities`, `user_totp`, `session_activity`, `key_verifications`, `user_blocks` |
| `workspace` | `workspace` | `workspaces`, `memberships`, `invites`, `workspace_limits`, `role_permissions`, `security_settings`, `dlp_policies` |
| `conversation` | `chat`, `message`, `room` | `chats`, `chat_members`, `chat_counters`, `chat_permissions`, `chat_pins`, `read_receipts`, `messages`, `message_envelopes`, `message_reactions`, `mentions`, `rooms` |
| `media` | `file`, `sticker` + S3 | `uploads`, `upload_parts`, `attachments`, `quota_reservations`, `workspace_usage`, `sticker_packs`, `stickers`, `sticker_favorites` |
| `realtime` | `realtime` + Redis | `realtime_tickets`; Redis: `presence`, `typing`, `ws_session` |
| `notification` | `notification` | `notifications`, `notification_preferences` |
| `extensions` | `plugin`, `bot` + S3 | `catalog`, `packages`, `package_objects`, `polls`, `poll_options`, `tasks`, `bots`, `chat_bots`, `command_tokens`, `event_deliveries` |
| `audit` | `audit` + S3 WORM | `audit_events`, `audit_chain`, `audit_anchors` |
| `search` | OpenSearch | индекс `messages` (managed only) |
| `admin` | `admin_read` | проекции `admin_users`, `admin_chats`, `admin_storage`, `admin_overview` |

`ops.system_settings` переезжает в `admin`; `ops.idempotency_keys` и `ops.outbox` — в БД каждого сервиса.

### 7.2. 93 FK: что делать

93 FK-ссылки — главный блокер. Категории:

| Категория | Примеры | Решение |
|---|---|---|
| Ссылки на `auth.users` (27) | `workspace.memberships.user_id`, `message.messages.sender_id` | Убрать FK; ID проверяется при создании через `identity` API/кэш; reconciliation-джоба |
| Ссылки на `workspace.workspaces` (20) | `chat.chats.workspace_id`, `file.attachments.workspace_id` | Убрать FK; `workspace_id` — обязательный tenant-ключ, RLS; проверка членства в `workspace` |
| Ссылки на `chat.chats` (19) | `message.messages.chat_id`, `plugin.polls.chat_id` | Внутри `conversation` — оставить; в `media`/`extensions` — убрать, проверка через `conversation` API |
| Ссылки на `file.attachments` (5) | `message` attachment binding | `attachments` в `media`; `message` хранит `attachment_id[]` без FK, readiness — API |
| Ссылки на `auth.devices` (4) | `message_envelopes.device_id` | Внутри `conversation` — денормализованный `device_id` без FK; валидация через `identity` |
| `plugin.*`, `bot.*` (11) | `poll_options.poll_id`, `chat_bots.bot_id` | Внутри `extensions` — оставить |
| `sticker.*`, `room.*` (3) | `stickers.pack_id`, `rooms.chat_id` | `sticker` → `media`; `room` → `conversation`; FK внутри сервиса |

Порядок:

1. Инвентаризация: сгенерировать граф FK (уже есть в [data ownership](diagrams/svg/07-data-ownership.svg)).
2. Для каждой связи — решить: `keep` (внутри сервиса), `drop` (межсервисная), `replace` (FK → проверка/сага).
3. Добавить `NOT VALID` FK? Нет: для межсервисных — не добавлять.
4. Ввести reconciliation-джобы: orphan-детект, soft-delete, отчёты.
5. Удалять FK только после появления проверки в коде и мониторинга.

Важно: **удаление FK не означает отказ от целостности.** Меняется механизм: с «БД гарантирует» на «сервис гарантирует + reconciliation».

### 7.3. Read models

- `admin` — CQRS-проекции из событий; списки/overview без кросс-БД JOIN.
- `realtime` — ACL-кэш и last_seq; источник — `conversation`.
- `conversation` — кэш лимитов/DLP; источник — `workspace`.
- `notification` — профиль/email; источник — `identity`.
- `search` — индекс; источник — `conversation`.

Проекции всегда идемпотентны, версионируются и восстанавливаются полным replay'ем топика (compact + retention).

### 7.4. Миграции

- Каждый сервис — свой Flyway и своя история.
- Переходный период: одна БД-кластер, отдельная database/role на сервис.
- Схема меняется по expand/contract: сначала добавить, потом dual-read, потом удалить.
- Запрещены миграции, которые читают чужие схемы.
- Baseline для нового сервиса — `pg_dump --schema=<schema>` + проверка counts/checksums.

---

## 8. Безопасность

### 8.1. Аутентификация и доверие

- Браузер → только `edge`; Keycloak не публикуется.
- `edge` проверяет JWT (JWKS, audience, exp), device binding, CSRF origin для refresh/logout.
- Внутренние вызовы — mTLS + NetworkPolicy; никаких «доверяем заголовку X-User-Id» извне.
- Сервисные аккаунты — отдельные, least privilege; секреты — Vault/External Secrets.
- Сессии: access 15 мин, refresh — HttpOnly/Secure/SameSite=Lax, ротация, revoke через событие.

### 8.2. E2EE

- Приватные ключи не покидают устройство; сервер хранит public keys/prekeys и opaque envelopes.
- События не содержат plaintext; `message.created` несёт `e2ee=true`, конверты — по запросу на устройство.
- Push/email — без контента; поиск и DLP не применяются к E2EE.
- При выключенном флаге E2EE live/replay кадры не публикуются (kill switch).
- Аудит E2EE фиксирует метаданные (кто, когда, chat_id), не контент.

### 8.3. Плагины и боты

- Пакеты подписаны, проверяются при установке; allowlist.
- Sandbox: отдельный namespace, без БД, egress только через proxy, CPU/memory limits.
- Capability-токен: scope, TTL, audience, отзыв при disable/kill.
- Consent в E2EE-чатах; серверные плагины запрещены в E2EE.
- Bot webhooks: HMAC signing secret, retry с backoff, SSRF-защита.

### 8.4. Аудит

- Append-only, hash chain по workspace, anchors в S3 Object Lock.
- Все сервисы пишут audit-события в outbox; `audit` — единственный писатель в свою БД.
- Break-glass: 2 approval, JIT, TTL, KMS grant, уведомление владельцу, каждое чтение — событие.
- SIEM-экспорт: HTTPS webhook, батчи, retry, DLQ.

---

## 9. NFR

### 9.1. SLO

| Сервис | SLI | SLO |
|---|---|---|
| `conversation` | send p95 / p99 | 150 мс / 400 мс |
| `conversation` | history p95 | 120 мс |
| `realtime` | connect p95 | 300 мс |
| `realtime` | fan-out p95 | 200 мс |
| `media` | upload init p95 | 150 мс |
| `media` | scan lag p95 | 60 с |
| `identity` | login p95 | 400 мс |
| `notification` | in-app p95 | 2 с |
| `audit` | append lag p95 | 5 с |
| Все | доступность | 99.9% (core — 99.95%) |
| Все | consumer lag p95 | < 2 с |

Error budget: 0.1% в месяц; при сгорании >50% — заморозка релизов и разбор.

### 9.2. Отказоустойчивость

| Отказ | Поведение | Деградация |
|---|---|---|
| Kafka | outbox копится, send работает | fan-out/уведомления/поиск с задержкой; алерт |
| `realtime` | клиент переподключается, REST работает | нет live-доставки; polling/replay |
| `media` | новые вложения не принимаются | чтение/скачивание работает, send без вложений |
| `identity` | существующие JWT валидны до exp | нет логина/refresh; read-only сессии |
| `workspace` | кэш лимитов/DLP | fail-closed для DLP, stale для лимитов |
| `audit` | события в Kafka/outbox | комплаенс-алерт, нет потери |
| PostgreSQL | failover 30–60 с | retry, 503 на запись |
| Redis | realtime деградирует | reconnect, presence по TTL |

### 9.3. Наблюдаемость

- OTel tracing: HTTP, JDBC, Kafka producer/consumer; `trace_id` в envelope.
- Метрики: RED по endpoint, USE по ресурсам, доменные — send rate, fan-out lag, outbox lag, consumer lag, WS connections, scan queue, quota.
- Логи: JSON, `request_id`, `workspace_id`, `user_id` (хеш), без plaintext/токенов.
- Дашборды: по сервису + сквозной «send → receive».
- Алерты: SLO burn rate, lag, DLQ, 5xx, saturation.
- Синтетика: login → send → WS receive → upload, каждые 5 мин.

### 9.4. Тестирование

- Unit/domain — как сейчас (498 тестов).
- ArchUnit — per service, включая запрет кросс-контекстных domain-импортов.
- Contract: OpenAPI + JSON Schema событий; consumer-driven (Pact) — для критичных пар.
- Integration: Testcontainers (PostgreSQL, Kafka, Redis, MinIO).
- E2E: login → send → WS → file → scan → search.
- Chaos: broker down, service down, DB failover, duplicate events.
- Migration: shadow read/compare, checksums, rollback.

---

## 10. Риски и антипаттерны

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| Распределённый монолит (chatty sync) | высокая | высокое | правила §5.1, budget на hops, contract-тесты |
| Потеря консистентности `seq`/ACL | средняя | высокое | не дробить chat/message; row lock; мониторинг gap |
| E2EE plaintext в событиях/логах | средняя | критическое | schema review, redaction, тесты, kill switch |
| 93 FK удалены без проверок | высокая | высокое | reconciliation, orphan-мониторинг, поэтапно |
| Рост операционной сложности | высокая | среднее | платформа, IaC, runbook, on-call, SLO |
| Дорогой Kubernetes/брокер | средняя | среднее | начать с одного кластера, managed, HPA |
| «Сервис на модуль» | средняя | высокое | каталог §4.2, запрет nano-services |
| Общая БД «пока что» | высокая | высокое | ADR-003, запрет кросс-грантов, CI-проверка |
| Дублирование событий | высокая | низкое | idempotency по `event_id`, upsert |
| Плагины ломают core | средняя | высокое | sandbox, capability, resource limits |

Антипаттерны, которые запрещены явно:

- shared database / shared tables;
- 2PC и распределённые транзакции;
- synchronous call chain для send;
- event-carried state transfer с PII/plaintext;
- общий «common» сервис;
- общая доменная библиотека;
- Kafka как база данных;
- retry без идемпотентности;
- сервис без владельца, SLO и runbook.

---

## 11. Открытые вопросы

1. **Команда и ownership.** Кто владелец каждого сервиса? Без этого план нереализуем.
2. **Kafka vs NATS JetStream.** Выбран Kafka; если ops-команда против, NATS дешевле, но экосистема беднее.
3. **PostgreSQL: один кластер или per-service.** На старте — один кластер + database per service; триггер разделения — шумный сосед / комплаенс.
4. **Search: отдельный сервис или воркер `conversation`.** Граница нужна, deployable — по нагрузке.
5. **Admin: CQRS read model или API composition.** Рекомендация — CQRS; альтернатива — BFF с кэшем.
6. **E2EE: конверты по запросу или в событии.** Рекомендация — по запросу; нужен замер latency.
7. **Multi-region.** Не сейчас; заложить `region` в ключи и topic naming.
8. **Плагины на сервере.** Если каталог не открывается — `extensions` можно оставить одним deployable с `bot`, без runtime.

---

## 12. Приложения

- [Матрица связности](diagrams/coupling-matrix.md) — 13×13, сгенерирована из кода.
- [Каталог сервисов](service-catalog.yaml) — машинночитаемый.
- [Каталог событий](EVENTS.md) — топики, схемы, совместимость.
- [План миграции](MIGRATION.md) — волны, playbook, cutover, rollback.
- [ADR](ADR.md) — 14 решений с альтернативами.
- [Галерея диаграмм](README.md) — все 13 схем.

---

*Документ описывает целевую архитектуру и путь к ней. Он не является разрешением на немедленное разделение: сначала Wave 0 (enablers), затем пилот на `realtime`.*

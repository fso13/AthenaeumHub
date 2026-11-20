# «Сова» — доска задач: первый вертикальный срез

> **Фаза:** база Совы + E8–E12 + F7B приняты · G4 final review (E2EE flag off) · D1 Dashboard v1.0 queued (P1)  
> **Контракт:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>)  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §5–§7, §10–§12, §15–§16  
> **Промты:** [`docs/PROMPTS-FRONTEND-BACKEND.md`](<PROMPTS-FRONTEND-BACKEND.md>) §2, §3, §6

## 0. Правила параллельной работы

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**` | Backend-сессия | всё внутри `backend/` | `frontend/**`, `docs/**`, `design/**`, `contracts/**` |
| `frontend/**` | Frontend-сессия | всё внутри `frontend/` | `backend/**`, `docs/**`, `design/**`, `contracts/**` |
| `contracts/openapi.yaml` | PM/лид | только через задачу `I-01` | — |
| `docs/TASKS.md` | PM/лид | статусы, решения | — |

- Контракт — **единственный** источник API-форм. Если чего-то не хватает: сообщить PM, не придумывать поле.
- Backend и frontend работают одновременно; frontend не ждёт backend: использует MSW по контракту, затем переключается на реальный API.
- Любая сессия обязана прислать отчёт по формату из §5.
- Не менять `docs/SYSTEM-ANALYSIS.md`; расхождения — в отчёт/ADR.

## 1. B-01 — Backend: каркас + managed-сообщения

**Владелец:** backend-сессия  
**Директория:** `backend/`  
**Приоритет:** P0, критический путь  
**Оценка:** 3–4 рабочие сессии (DDD-маппинг и ArchUnit добавляют объём)  
**Статус:** **DONE** — live на `localhost:8081`, 84/84 теста, ArchUnit 6/6, контракт не изменён

### Цель

Поднять запускаемый Spring Boot 3 / Java 21 сервис с PostgreSQL 16, реализовать контракт `contracts/openapi.yaml` для managed-чата: dev-сессия, список чатов, история, отправка, read receipt, sync. Заложить правильные границы модулей, RLS, `seq`, идемпотентность и outbox.

### Архитектурное требование: DDD и разделение слоёв

Каждый модуль — bounded context с четырьмя слоями. Это не «папки для красоты»: зависимости строго направлены внутрь, domain не знает о Spring/JPA/HTTP.

```
ru.krug.<context>              // auth, workspace, chat, message, ops
├── domain
│   ├── model                  // aggregate root, entities, value objects
│   ├── event                  // domain events
│   ├── exception              // domain exceptions
│   └── repository             // интерфейсы репозиториев (порты)
├── application
│   ├── command                // use case: SendMessageCommand/Handler
│   ├── query                  // use case: ListMessagesQuery/Handler
│   └── port                   // ChatAccessPort, SeqAllocator, IdempotencyPort, OutboxPort
├── infrastructure
│   ├── persistence            // JPA entities, Spring Data, adapters, mappers
│   ├── messaging              // outbox publisher, Kafka
│   └── security               // JWT/dev-auth adapters
└── api
    ├── rest                   // controllers
    ├── dto                    // request/response DTO + validation
    └── mapper                 // DTO ↔ application/domain
```

Правила:
1. `domain` — чистый Java: без Spring, JPA, Jackson, DTO, HTTP, `@Transactional`. Инварианты (текст 1..8000, `seq > 0`, reply только из чата) — здесь, а не только в DTO.
2. `application` — use cases и транзакционные границы (`@Transactional` здесь), вызывает domain и port’ы; не зависит от `infrastructure` и `api`.
3. `infrastructure` — JPA entities **отдельно** от domain entities, Spring Data repositories, adapters, outbox/Kafka, mappers. Зависит от `domain`/`application`.
4. `api` — controllers, request/response DTO, validation, API mappers, `@RestControllerAdvice`; зависит от `application`, не от `infrastructure`/`domain`; наружу — только DTO.
5. Межконтекстные связи — только через IDs, port’ы и события; никаких импортов domain-классов чужого контекста и кросс-модульных SQL.
6. DTO не являются JPA entity; controller не принимает/не возвращает entity. JPA entity не является domain entity.
7. ArchUnit-тесты обязательны: domain ↛ application/infrastructure/api/Spring/JPA; application ↛ infrastructure/api; api ↛ infrastructure/domain; нет кросс-контекстных domain-зависимостей.

### Обязательный scope

1. **Каркас**
   - `backend/pom.xml`, Java 21 (`maven.compiler.release=21`), Spring Boot 3.x.
   - Bounded contexts `auth`, `workspace`, `chat`, `message`, `ops`; в каждом — `domain/application/infrastructure/api` (без микросервисов).
   - Конфигурация `dev` и `test`; PostgreSQL через env; Flyway.
   - `docker-compose.yml` внутри `backend/` для PostgreSQL 16 (Redis/Kafka не обязательны для этого среза).
   - `backend/README.md`: как поднять, как прогнать тесты, какие env.

2. **Dev-сессия (только профиль `dev`)**
   - `POST /api/v1/dev/session`: создаёт/переиспользует пользователя, воркспейс `MANAGED`, групповой чат, устройство; возвращает JWT и ids по контракту.
   - JWT подписывается локальным dev-ключом; в `prod` endpoint отсутствует (`404`).
   - `X-Device-Id` обязателен для защищённых endpoint’ов и сверяется с claim.
   - Это **временный** dev-механизм; Keycloak — следующая задача, не в этом срезе.

3. **Данные**
   - `users`, `workspaces`, `memberships`, `chats`, `chat_members`, `chat_counters`, `messages`, `read_receipts`, `idempotency_keys`, `outbox`.
   - `messages` — партиционирование по месяцу (минимум текущая + следующая партиция), `seq` per chat, `client_message_id` unique partial index.
   - RLS по `workspace_id`; отдельные DB-роли `krug_migrator`/`krug_app`.
   - Индексы: `(chat_id, seq)`, `(chat_id, created_at)`, partial `(chat_id, client_message_id)`.

4. **API**
   - `GET /workspaces/{workspaceId}/chats` — только чаты, где пользователь active member; `unread_count` и `last_seq`.
   - `GET /chats/{chatId}/messages` — `after_seq`/`before_seq`/`limit`, курсор, порядок по `seq`; 403/404 по правилам.
   - `POST /chats/{chatId}/messages` — `Idempotency-Key`, `client_message_id`, текст 1..8000, `reply_to_id` только из того же чата; ответ 201; повтор — тот же ответ.
   - `POST /chats/{chatId}/read` — монотонный `last_seq`; 204.
   - `GET /sync?workspace_id=` — `server_time`, чаты, `last_seq`, `unread_count`.
   - `GET /health`.

5. **Инварианты**
   - `seq` выдаётся в транзакции вставки; дырки допустимы, повтор — нет.
   - `Idempotency-Key`: тот же body → исходный статус/тело + `Idempotent-Replay: true`; другой body → `409 IDEMPOTENCY_KEY_REUSED`; конкурентный дубль → `409 IDEMPOTENCY_IN_PROGRESS`.
   - `client_message_id`: повтор в чате → существующее сообщение, не дубль.
   - Outbox-запись `message.created` в той же транзакции; публикация в Kafka — заглушка/лог в этом срезе, но строки outbox и тест на них обязательны.
   - Ошибки: `{code,message,details,request_id}`; коды из §7.1.
   - Логи без текста сообщений и токенов.

6. **Тесты (обязательны)**
   - Unit: domain-инварианты, `seq`, идемпотентность, валидация, права; ArchUnit на слои.
   - Integration (Testcontainers PostgreSQL): миграции + RLS cross-tenant, повтор `POST`, конкурентный дубль, `after_seq`, read receipt.
   - Contract: ответы соответствуют `contracts/openapi.yaml` (валидация схем).
   - Негативные: 401, 403, 404, 409, 422, 429 (если rate limit включён).

### Вне scope

- E2EE/envelopes, файлы/S3, стикеры, плагины, поиск, WS fan-out, Keycloak, Kafka-consumer, редактирование/удаление, реакции/пины.
- Микросервисы, Kubernetes, сложный API Gateway.

### Definition of Done

- `mvn test` зелёный, включая ArchUnit; `docker compose up` + `mvn spring-boot:run` поднимает сервис; `POST /dev/session` работает.
- Контракт `contracts/openapi.yaml` не изменён; расхождения перечислены в отчёте.
- README содержит точные команды/env и дерево DDD-слоёв.
- Есть отчёт с файлами, тестами, рисками.

### B-01: известный технический долг

Не блокирует I-01, но должно быть закрыто до production/v1.

| ID | Долг | Риск | Когда закрыть |
|---|---|---|---|
| TD-B01-01 | `SendMessageUseCase` — 2 локальные транзакции: idempotency in-progress коммитится до message tx | Падение между ними оставляет `IDEMPOTENCY_IN_PROGRESS` до TTL; повтор застревает | B-02: одна транзакция с advisory lock или cleanup/retry-политика |
| TD-B01-02 | In-memory rate limiter | Не работает между узлами; обходится при scale-out | v1: Redis token bucket |
| TD-B01-03 | Локальный AES-256-GCM ключ контента вместо KMS | Не managed-модель; ключ в env | v1: KMS/Vault envelope encryption |
| TD-B01-04 | Dev-пароли `krug_app`/`krug_migrator` в V1 | Опасен при случайном prod-запуске | до production: prod-guard + секреты Vault |
| TD-B01-05 | Нет cleanup job для `idempotency_keys`/`outbox` | Рост таблиц, старые in-progress | B-02: scheduled GC + метрика |
| TD-B01-06 | `outbox` без RLS | Relay читает cross-tenant metadata | до production: worker-role/tenant guard |
| TD-B01-07 | `messages.sender_display_name` денормализован | Смена имени не отражается в истории | v1: join/read model или update-job |
| TD-B01-08 | `read` требует Idempotency-Key, но без replay-строки | Естественная монотонность, но контрактный нюанс | задокументировать/выровнять в v1 |

## 2. F-01 — Frontend: экран managed-чата

**Владелец:** frontend-сессия  
**Директория:** `frontend/`  
**Приоритет:** P0, критический путь  
**Оценка:** 2–3 рабочих сессии  
**Статус:** **DONE** — mock 33/33 + Playwright 2/2; real I-01 1/1 против B-01 на 8081 (Vite proxy)

### Цель

Поднять Vite + React + TypeScript приложение, собрать экран чата по контракту: история, optimistic send, retry, read receipts, reconnect/sync, состояния ошибок. Использовать MSW для контрактных моков; уметь переключиться на реальный backend.

### Обязательный scope

1. **Каркас**
   - `frontend/package.json`, Vite, React, TypeScript strict.
   - `frontend/README.md`: команды, env `VITE_API_BASE_URL`, `VITE_USE_MOCKS`.
   - CSS: собственные стили/токены; `design/index.html` — только референс, не импортировать прототип.
   - ESLint/Prettier или существующий аналог; `npm run build`, `npm test`.

2. **API-слой**
   - Типы из `contracts/openapi.yaml` (генерация или ручные типы, синхронные с контрактом).
   - Клиент: `Authorization: Bearer`, `X-Device-Id`, `Idempotency-Key`, `request_id` в ошибках.
   - MSW-хендлеры: dev/session, chats, messages, read, sync; фикстуры с `seq`, пагинацией, 409/422/429.
   - Переключение mock/real через env; real-режим — на backend B-01.

3. **Экран чата**
   - Список сообщений: порядок по `seq`, группировка по датам, автор, время, reply.
   - История: первая загрузка, «подгрузить ещё» вверх, сохранение позиции скролла.
   - Composer: Enter — отправить, Shift+Enter — новая строка; пустой текст не отправляется; лимит 8000 с счётчиком.
   - Optimistic send: сразу показать сообщение, затем заменить серверным по `client_message_id`.
   - Retry: повтор с тем же `client_message_id` и `Idempotency-Key`; ошибка не теряет текст.
   - Read receipts: `POST /read` после просмотра; не спамить (debounce).
   - Reconnect: `GET /sync` → сравнить `last_seq` → догрузить историю; WS в этом срезе можно не поднимать, но sync-путь обязателен.
   - Состояния: loading, empty, error, offline, forbidden, rate-limit.

4. **Ошибки**
   - 401 → dev/session/повтор логина; 403/404 → «нет доступа»; 409 → конфликт/повтор; 422 → текст/лимит; 429 → `Retry-After`; 5xx → retry.
   - Не показывать сырые коды пользователю без перевода; `request_id` — в «деталях».

5. **Безопасность и качество**
   - Нет `dangerouslySetInnerHTML`; текст — текстовые узлы.
   - Токен в памяти; не в localStorage.
   - Клавиатура/фокус/aria; контраст; `prefers-reduced-motion`.
   - Строки через i18n-заготовку (можно простой словарь RU).

6. **Тесты**
   - Vitest + RTL: optimistic send, retry, ошибка 409/422, пагинация, пустое состояние.
   - MSW: контрактные ответы.
   - Playwright smoke (если браузеры доступны): открыть чат → отправить → увидеть сообщение → retry при 500.
   - `npm run build` без ошибок.

### Вне scope

- E2EE-крипто, файлы, стикеры, поиск, плагины, WS-канал, редактирование/удаление, реакции/пины.
- Мобильная нативная версия, сложный дизайн-системный рефакторинг.

### Definition of Done

- `npm test`, `npm run build` зелёные.
- В mock-режиме проходится сценарий: загрузка → отправка → retry → ошибка → повтор.
- В real-режиме (если backend доступен) — тот же сценарий.
- Нет XSS/токенов в localStorage; есть a11y-проверка.
- Отчёт с файлами, тестами, рисками.

## 3. I-01 — Integration checkpoint

**Владелец:** PM/лид + обе сессии  
**Когда:** backend + frontend готовы; I-01 пройден

- Backend поднят на `localhost:8081` (профиль `dev`); health/dev-session/chats/messages/read/sync проверены PM.
- Frontend: `VITE_USE_MOCKS=false`, `VITE_DEV_SESSION=true`, `VITE_API_BASE_URL=/api/v1`, `VITE_API_PROXY_TARGET=http://localhost:8081` (CORS у B-01 выключен; браузер идёт через Vite-прокси). Порт 8080 занят другим проектом — не убивать.
- Проверить: dev/session → список чатов → история → отправка → read → sync.
- Проверить: повтор `POST` с тем же `Idempotency-Key` не создаёт дубль.
- Проверить: 403/404/409/422/429 отображаются по UX.
- Зафиксировать расхождения контракта; изменения — только через `contracts/openapi.yaml` + обе сессии.

### I-01: результат

**Статус:** принят с оговорками.

| Проверка | Результат |
|---|---|
| Backend B-01 на 8081 | health 200, dev/session 200, chats/messages/read/sync — контракт |
| Frontend `npm run check` | exit 0: lint, format, contract, security, 33/33 Vitest, build |
| Playwright mock | 2/2 (send → 500 → retry; dark axe) |
| Playwright real | 1/1 против 8081 через Vite proxy: session → chats → history → send → replay → read → sync |
| Ошибки | 401/403/404 — контрактный envelope; 403/404 UI дополнительно проверены перехватом |
| Идемпотентность | повтор `Idempotency-Key` → `Idempotent-Replay: true`, тот же id/seq |

Оговорки:
- Реальная пагинация >30 сообщений не проверена: в B-01 мало данных; mock-пагинация покрыта. Нужен seed и повторный real-run.
- CORS у B-01 выключен: браузер работает через Vite proxy; для production — reverse proxy/ingress same-origin.
- `Message` не эхоит `client_message_id`: после reload корреляция только локальная. Решение — отдельная задача, не менять контракт сейчас.
- 403/404 в real UI недостижимы через dev-сессию (один чат/воркспейс), проверены конверты + перехват.
- Playwright browsers удалены из workspace после прогона; для повтора — установить chromium.

## 4. Порядок запуска

1. PM фиксирует контракт и эту доску.
2. Backend-сессия: B-01.
3. Frontend-сессия: F-01 (параллельно, на MSW).
4. I-01: интеграция.
5. Следующие срезы: E2EE 1:1, файлы, стикеры, плагины — отдельными задачами.

## 5. Формат отчёта сессии

```text
## Статус
DONE / PARTIAL / BLOCKED

## Сделано
- ...

## Файлы
- ...

## Проверки
- команда → результат
- какие тесты/сценарии покрыты

## Контракт
- отклонения от contracts/openapi.yaml: нет/список

## DDD
- дерево пакетов: domain/application/infrastructure/api
- ArchUnit: команда и результат

## Риски и вопросы
- ...

## Что дальше
- ...
```

## 6. Следующие задачи (backlog)

| ID | Задача | Владелец | Приоритет | Зависимость |
|---|---|---|---|---|
| B-04 | Auth backend: Keycloak OIDC, JIT provisioning, `/me`, `/devices`, `/workspaces`, keycloak-profile | backend | P0 | **DONE** (Keycloak 26.2, live) |
| F-04 | Auth frontend: OIDC PKCE login/register/logout, auth guard, onboarding, device registration | frontend | P0 | **DONE** (real smoke 1/1) |
| E3-B | WS backend: ticket, подписки, fan-out, resume по last_seq, backpressure | backend | P0 | **DONE** (167 tests, ArchUnit 10/10) |
| E3-F | WS frontend: reconnect, event dedupe, resume.gap, typing/presence | frontend | P0 | **DONE** (100 tests, real WS 1/1) |
| B-02 | Hardening B-01: атомарная идемпотентность, GC, outbox RLS/worker-guard, prod-guard | backend | P1 | **DONE** (181 tests, ArchUnit 10/10) |
| E4-B | Files backend: preflight, upload/chunk/resume, quota, S3/MinIO, scan, attachments | backend | P0 | **DONE** (230 tests, s3mock live 20 MiB) |
| E4-F | Files frontend: picker, limits, progress/resume, attachments, download | frontend | P0 | **DONE** (143 tests, real UI 1/1) |
| E5-B | Stickers backend: built-in packs, favorites, STICKER messages | backend | P0 | **DONE** (249 tests) |
| E5-F | Stickers frontend: picker, send, render, favorites | frontend | P0 | **DONE** (166 tests, real 1/1) |
| E6-B | Notifications backend: in-app, unread, read, prefs, fan-out | backend | P0 | **DONE** (269 tests) |
| E6-F | Notifications frontend: bell, panel, read, prefs | frontend | P0 | **DONE** (180 tests, real 1/1) |
| E7-S | E2EE crypto spike: протокол, wire format, test vectors, API delta | security | P0 | **DONE** (spec + 24 vectors) |
| E7-G0 | Независимый crypto-review | security | P0 | **DONE** — GO WITH CONDITIONS (4 P0, 12 P1) |
| E7-S2 | Spec remediation по P0/P1 + новые векторы | security | P0 | **DONE** (34 vectors, 189/0) |
| E7-G1 | Re-review S2: P0/P1 closure | security | P0 | **DONE** — GO WITH CONDITIONS |
| E7-S3 | Remediation P0-2b/P1-A/P1-E + P1-B..H | security | P0 | **DONE** (43 vectors, 273/0) |
| E7-G2 | Re-review S3 | security | P0 | **DONE** — GO WITH CONDITIONS, P0 4/4 closed |
| E7-S4 | Fix backfill/handoff/P1-B/C/G | security | P0 | **DONE** (45 vectors, 345/0) |
| E7-I01 | Apply contract I-01 (openapi/ws/schema.d.ts) | PM/backend | P0 | **DONE** (28 paths/33 ops/58 schemas) |
| E7-B1 | Device keys/prekeys/claim + V16, flag off | backend | P0 | **DONE в границах flag-off**; I-01 = contract-side DONE (A–D), behavior-side **PARTIAL** (E 9/13, 4 строки → B3/B4), F-3 — нет git (282 tests) |
| E7-G3 | Implementation review B1: V16/keys/claim/flag | security | P0 | **DONE** — GO WITH CONDITIONS, P0 0, P1 6 |
| E7-B1F | B1 fixes: claim rate limit, identity scoping, WS events, migration guard, uniqueness | backend | P0 | **DONE** — P1 6/6 (P1-04 зафиксирован, не реализуется), P2 12/13 (P2-08 вне списка), 300 tests, ArchUnit 10/10 |
| E7-B3/B4 | E2EE backend: chat, envelopes, send/history/WS, coverage | backend | P0 | **DONE** — 314 tests, ArchUnit 10/10, I-01 behavior-side E 13/13 |
| E7-B | E2EE backend: devices/prekeys/claim, envelopes, verification | backend | P0 | devices/prekeys/claim — B1/B1F DONE; envelopes/send — B3/B4 **DONE** |
| E7-F | E2EE frontend: crypto core, 1:1, safety numbers | frontend | P0 | после E7-S |
| B-03 | Redis rate limiter + KMS envelope encryption | backend | v1 | B-02 |
| F-02 | E2EE 1:1: устройства, prekeys, decrypt, key-change warning | frontend | P1 | после crypto review |
| F-03 | Файлы: preflight, лимиты, прогресс, докачка | frontend | v1 | E4 file pipeline |
| D1 | Message Dashboard «Сова»: рейл/бейджи 99+, страницы, треды, голосовые, метаданные песен, переключатель пространств | FE+BE | P1 | design v1.2.0; [тикет](TASKS-DASHBOARD-V1.md) |

## 7. Решения по срезу

| ID | Решение | Причина |
|---|---|---|
| SL-01 | Dev-сессия через `POST /dev/session` только в профиле `dev` | Не блокировать вертикальный срез Keycloak-интеграцией; prod-путь — отдельная задача |
| SL-02 | Kafka-публикация в B-01 — заглушка, outbox-строки обязательны | Проверить транзакционность сейчас, не тащить инфраструктуру в первый срез |
| SL-03 | WS в F-01 не обязателен; reconnect через `GET /sync` | Сначала проверить seq/idempotency/sync, WS — следующий срез |
| SL-04 | MSW как основной режим frontend до I-01 | Параллельная работа без ожидания backend |
| SL-05 | Один Spring Boot модуль, пакеты по модулям | MVP-каркас; выделение Maven-модулей — позже по ADR-01 |
| SL-06 | DDD + 4 слоя в каждом bounded context; domain без Spring/JPA | Требование заказчика; изоляция инвариантов и тестируемость; JPA entity — только infrastructure |


## 8. E7-B1F — B1 fixes after E2EE-REVIEW-04 (отчёт по §5)

> Зона: `backend/**` + минимальные правки `contracts/**`, `frontend/src/api/schema.d.ts`,
> `frontend/scripts/check-contract.mjs` (guard) + этот раздел `docs/TASKS.md` и runbook §6.5.2
> `docs/E2EE-SPEC.md` (явно запрошены задачей). Полный отчёт —
> [`backend/E7-B1-FIX-REPORT.md`](<../backend/E7-B1-FIX-REPORT.md>).

### Статус

**DONE.** Все P1, кроме P1-04 (по заданию отложен в B3/B4), и все P2 из запроса, кроме P2-08
(не входил в список), закрыты. 300 тестов, 0 падений, ArchUnit 10/10; V1→V17 исполняется
non-superuser owner'ом без `BYPASSRLS`.

### Сделано

- **P1-01:** `RateLimitPort.checkKeyClaim` (per user / chat / target device) → `429 RATE_LIMITED`
  + `Retry-After`; лимиты независимы от message-send; отклонённый claim не расходует OPK.
- **P1-02:** все identity-lookup'ы (`findByPositioningIdentityKeys`, `findRevoked`, `findByIdentityDhKey`,
  `findByIdentitySigningKey`) скоупятся `user_id`; `POST /devices` больше не активирует workspace-контекст;
  cross-user/tenant bundle → `409 IDENTITY_KEY_CONFLICT` (не 404/500).
- **P1-03:** `chat.keys.changed` (без `seq`/`event_id`, не replay) и `device.list.changed` после commit
  (Spring AFTER_COMMIT + outbox), при revoke/verification/prekey/device add; `session.revoked` + close 4403
  отозванному устройству проактивно; повторный revoke событий не дублирует.
- **P1-05:** V16 backfill реально исполним: временный `NO FORCE` на `auth.devices`/`chat.chats`/
  `chat.chat_members`, fail-fast `DO`-проверки, затем `FORCE`; runbook §6.5.2 + README.
- **P1-06:** V17 — глобальные unique-индексы identity-ключей без `status <> 'REVOKED'`; preflight/cleanup
  дублей и неполных строк в `auth.identity_key_quarantine`; own revoked → 410, чужой/дубль → 409.
- **P1-04:** не реализуется (E2EE send/coverage/4 E-строки → B3/B4); формулировка «I-01 применён»
  исправлена выше (E7-B1: behavior-side PARTIAL). F-3: git отсутствует, contract + `schema.d.ts`
  согласованы и проверены `contract:check`.
- **P2-01:** NULL-safe all-or-none CHECK (V17, `NOT VALID` → `VALIDATE`).
- **P2-02:** единый SQL-предикат `auth.device_is_e2ee_capable(...)` во всех агрегатах (summary/peer/claim-count/
  devices) + домен `Device.isE2eeCapable` (fingerprint уже обязателен инвариантом).
- **P2-03:** scope-триггер `key_verifications`: target ACTIVE+capable, verifier device ACTIVE (+ membership/чат).
- **P2-04:** `verified`/`verified_count` только при `target_key_generation == device.key_generation`.
- **P2-05:** `409 KEY_CHANGED` (optional `expected_key_generation`) + `Idempotency-Key` у verification
  (replay отдаёт ту же строку/`verified_at`).
- **P2-06:** DIRECT-create race — `ON CONFLICT DO NOTHING` + перечитывание → `200`/`201`, без 500;
  GROUP идемпотентен по `Idempotency-Key`.
- **P2-07:** `flush()` внутри `try/catch`; `ck_devices_*` → `422 INVALID_KEY_FORMAT`, unique → `409`.
- **P2-09:** `length = 33` → `===`; mutation-проверка: 32 → guard красный, 33 → зелёный.
- **P2-10:** E2EE-воркспейс не создаёт default GROUP-чат; правило «E2EE ⇒ только DIRECT» в домене
  `Chat.requireSupportedType`, используется API и provisioning; E2EE DIRECT требует capable-устройства у обоих
  (`E2EE_NO_ACTIVE_DEVICES`).
- **P2-11:** `one_time_prekeys:[null]` → `422 INVALID_KEY_FORMAT`; `400` добавлен в `POST /devices`.
- **P2-12:** `EXPLAIN` для claim/device/identity/envelopes — индексные планы, без Seq Scan
  (`E2eeQueryPlanIT`).
- **P2-13:** тесты 409/DEVICE_LIMIT/NO_SPK/DIRECT repeat+cross-tenant claim/`[null]`/KEY_CHANGED/replay.
- **P2-08** (не входил в список): не менялся — prekey cap race/retention остаются долгом B3.

### Файлы

- Миграции: `V16__e2ee_device_keys.sql` (NO FORCE + fail-fast), **новый**
  `V17__e2ee_identity_hardening.sql`.
- Backend: `auth/**` (DeviceRepository/Adapter, registration/revoke/prekey/claim/chat-keys,
  DeviceKeyEvents, домен Chat/Device), `chat/**` (ChatCreateService, ChatRepository/Adapter,
  ChatKeyScopePort/Adapter, onboarding), `ops/**` (RateLimitPort/InMemoryRateLimiter),
  `realtime/**` (publisher/hub/codec/listener), `shared/**` (KrugProperties, application.yml).
- Контракт: `contracts/openapi.yaml` (400 `/devices`, 429 `/keys/claim`,
  `expected_key_generation`), `contracts/ws-protocol.md` (уточнение prekey-reason),
  `frontend/src/api/schema.d.ts` (regen), `frontend/scripts/check-contract.mjs` (guard).
- Тесты: `E2eeLimitsIT` (10), `E2eeClaimRateLimitIT` (1), `E2eeRealtimeIT` (2),
  `E2eeFlagOnIT` (1), `E2eeQueryPlanIT` (1), `E2eeMigrationIT` (3→6),
  `WsTestClient`/`ws-frames.schema.json`, обновлён `WorkspaceOnboardingServiceTest`.

### Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 300, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit 10/10; baseline 282 + 18 новых
cd frontend && npm run api:types && npm run contract:check
# Contract check passed: 33 operations, 58 schemas, types in sync
npx tsc -p tsconfig.json --noEmit   # exit 0
# P2-09 mutation: length === 32 → contract check failed; === 33 → passed
```

### Контракт

- Delta: `400` на `POST /devices`; `429` на `POST /keys/claim`; optional
  `expected_key_generation` в `VerificationRequest`. Схемы/пути не выдуманы; 28 paths/33 operations/58 schemas.
- `schema.d.ts` перегенерирован `npm run api:types`; `contract:check` зелёный; guard больше не тавтология.
- I-01: contract-side DONE (A–D), behavior-side PARTIAL (E 9/13; 4 строки — B3/B4), F-3 unverifiable (no git).

### DDD

- `auth.application.service.DeviceKeyEvents` — единственная точка key-events; `realtime.infrastructure.event`
  слушает AFTER_COMMIT; `chat.application.port.ChatKeyScopePort` — published read port вместо кросс-модульного SQL.
- ArchUnit 10/10 (домен без Spring/JPA, application ↛ infrastructure/api, api ↛ domain/infrastructure).

### Риски и вопросы

- P2-08 (prekey cap race/retention) не закрыт — вне списка задания, нужен retention-джоб до B3.
- `reason=KEY_GENERATION_CHANGED` для ротации prekey — интерпретация фиксированного enum §6.3.1 C
  (отдельного prekey-reason нет; generation не меняется). Зафиксировано в `contracts/ws-protocol.md`.
- Outbox-строка `device.list.changed` пишется только при наличии workspace-claim (колонка NOT NULL);
  WS-доставка от этого не зависит.
- Multi-node: hub по-прежнему in-process (E3-ограничение), Redis pub/sub — следующий срез.

### Что дальше

1. E7-B3/B4 — **DONE** (§9): E2EE chat/envelopes/send/history/WS, coverage, 4 отложенные
   E-строки I-01 закрыты (E 13/13), 314 tests.
2. P2-08 retention/гонка prekey; Redis rate limiter (B-03).
3. E7-F: клиентский X3DH/Double Ratchet, локальная копия/outbox, безопасный рендер.
4. G2/G4 (браузерные KAT, внешний crypto-review) до включения `KRUG_E2EE_ENABLED`.

## P1/P2 closure

| ID | Статус | Доказательство |
|---|---|---|
| P1-01 | closed | `RateLimitPort.checkKeyClaim`, `E2eeClaimRateLimitIT` (429 + Retry-After, OPK не сожжён, send жив) |
| P1-02 | closed | user-scoped identity queries + `E2eeLimitsIT.crossUserIdentityBundleIsConflictNotNotFound` (409, не 404) |
| P1-03 | closed | `E2eeRealtimeIT` (оба события, no seq/event_id, 4403, без дублей/реплея) |
| P1-04 | deferred (B3/B4) | E2EE send/coverage/4 E-строки не реализованы; I-01 behavior-side PARTIAL зафиксирован |
| P1-05 | closed | V16 NO FORCE + fail-fast; `E2eeMigrationIT.nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17` |
| P1-06 | closed | V17 global unique + quarantine; `v17MakesIdentityUniquenessHardAndAllOrNoneNullSafe` |
| P2-01 | closed | NULL-safe CHECK (V17) + negative insert-тест |
| P2-02 | closed | `auth.device_is_e2ee_capable` во всех SQL-путях + assertion против домена |
| P2-03 | closed | scope-триггер target ACTIVE+capable / verifier ACTIVE + negative-тесты |
| P2-04 | closed | `verified` по generation + тест «generation 1→2→1» |
| P2-05 | closed | `409 KEY_CHANGED` + verification idempotency replay-тест |
| P2-06 | closed | DIRECT race/cross-create тесты (200/201, один чат) + GROUP idempotency |
| P2-07 | closed | flush внутри try + `409 IDENTITY_KEY_CONFLICT` (не 500) |
| P2-08 | out of scope | не входил в список B1F; остаётся долгом B3 |
| P2-09 | closed | `length === 33`; mutation-проверка (32 → красный) |
| P2-10 | closed | onboarding без default E2EE GROUP + `E2eeFlagOnIT` (GROUP 409, DIRECT gate) |
| P2-11 | closed | `[null]` → 422; `400` в контракте `/devices` |
| P2-12 | closed | `E2eeQueryPlanIT`: claim/device/identity/envelopes — индексы, без Seq Scan |
| P2-13 | closed | 409/DEVICE_LIMIT/NO_SPK/DIRECT 200/cross-tenant claim/`[null]`/KEY_CHANGED |

## Contract

| Что | Изменение | Зачем |
|---|---|---|
| `POST /devices` | добавлен ответ `400` | bean-validation (`name`/`platform`) и `[null]`-кейсы документированы (P2-11) |
| `POST /keys/claim` | добавлен ответ `429` + `Retry-After` | новый rate limit (P1-01) |
| `VerificationRequest` | optional `expected_key_generation` (integer ≥ 1) | `409 KEY_CHANGED` достижим и проверяем (P2-05) |
| `contracts/ws-protocol.md` | уточнение: prekey-ротация → `KEY_GENERATION_CHANGED` | в enum §6.3.1 C нет prekey-reason; поведение не изобретает код |

- `npm run api:types` → `schema.d.ts` синхронен; `npm run contract:check` зелёный; `tsc --noEmit` — 0.
- 28 paths / 33 operations / 58 schemas не изменились (только ответы/поля).
- Git-репозитория нет: I-01 F-3 («одним PR») невыполним; contract + `schema.d.ts` согласованы в рабочем дереве.

## 9. E7-B3/B4 — E2EE chat + envelopes + send/history/WS (отчёт по §5)

> Зона: `backend/**`, минимальные правки `contracts/**` (только §8 `ws-protocol.md`) и
> этот раздел. Полный отчёт — [`backend/E7-B3-B4-REPORT.md`](<../backend/E7-B3-B4-REPORT.md>).
> `contracts/openapi.yaml`, `frontend/src/api/schema.d.ts` не менялись: контракт I-01
> уже содержал все схемы/пути/коды; `contract:check` зелёный.

### Статус

**DONE в границах E7-B3/B4.** E2EE DIRECT-чат создаётся и неизменяем, `envelopes[]`
валидируются по форме/правам/покрытию, сервер не расшифровывает и не хранит plaintext,
`GET` отдаёт `crypto` только адресату `X-Device-Id`, `message.created` собирается
per-device. **I-01 behavior-side E закрыт 13/13** (4 отложенные строки реализованы).
F-3 («одним PR») непроверяем — git нет. Вне scope: E7-F (X3DH/DR), key backup, E2EE
groups/files/stickers, G4, включение флага по умолчанию.

### Сделано

- **Create (§6.2.8):** E2EE DIRECT 201/200, режим наследуется от воркспейса,
  `E2EE + GROUP → 409 E2EE_GROUP_NOT_SUPPORTED`, immutability (DB-триггеры), 0
  `SYSTEM`-сообщений, флаг off → `409 E2EE_DISABLED` для create/send/read.
- **Send (§4.1/§4.2/§4.5/§4.7):** `EnvelopeCodec` (canonical b64u, длины, диапазоны,
  `additionalProperties:false`, ciphertext 16..33040 / encoded ≤44054 / form guard
  65536); `E2eeEnvelopeValidator` (chat/sender/recipient/generation/prekey-binding,
  legacy → `422 E2EE_LEGACY_DEVICE`, self/dup, coverage только capable,
  `E2EE_NO_ACTIVE_DEVICES`/`E2EE_NO_PEER_ENVELOPE`/warning, plaintext →
  `422 E2EE_PLAINTEXT_FORBIDDEN`); envelopes пишутся opaque в
  `message.message_envelopes`, `seq` только после валидации; `client_message_id`
  scoped `(chat,sender)` + `409 CLIENT_MESSAGE_ID_CONFLICT`; `EnvelopeFingerprint` для
  replay-равенства (не хранится/не логируется).
- **История (§4.3):** `text:null`, `crypto` только своему устройству, чужие конверты и
  их число не отдаются, no server search/DLP.
- **Realtime (§4.4):** `RealtimeEvent.cryptoByDevice` (in-process), per-device
  `WsFrameCodec.event(event, deviceId)`, replay по `deviceId` сессии; ключевые события
  B1F не менялись.
- **Лимиты:** 10 конвертов, ciphertext 16..33040/≤44054, тело ≤512 KiB **до** парсинга
  (`PayloadLimitFilter` → `413 PAYLOAD_TOO_LARGE`), `ENVELOPE_TOO_LARGE` c
  `details.reason=form|canonical`.
- **Коды §4.8:** `E2EE_DISABLED`, `E2EE_LEGACY_DEVICE`, `E2EE_NO_ACTIVE_DEVICES`,
  `E2EE_NO_PEER_ENVELOPE`, `E2EE_PLAINTEXT_FORBIDDEN`, `ENVELOPES_REQUIRED`,
  `ENVELOPES_NOT_ALLOWED`, `TOO_MANY_ENVELOPES`, `DUPLICATE_ENVELOPE`,
  `INVALID_ENVELOPE_FORMAT`, `UNSUPPORTED_ENVELOPE_VERSION`, `ENVELOPE_TOO_LARGE`,
  `PAYLOAD_TOO_LARGE`, `KEY_CHANGED`, `CLIENT_MESSAGE_ID_CONFLICT`, `UNKNOWN_DEVICE` —
  все достижимы и покрыты.

### Файлы

- Domain: `message/domain/model/{CryptoScheme,CryptoEnvelope,EnvelopeHeader,EnvelopePrekey,
  MessageEnvelope}`, `Message` (+`cryptoScheme`/`createE2ee`), `MessageEnvelopeRepository`,
  `MessageRepository` (sender-scoped replay/owner).
- Application: `EnvelopeBatch`, `EnvelopeCoverageView`, `E2eeSendPlan`,
  `MessageDeviceView`; порты `MessageDeviceDirectoryPort`, `MessageChatContextPort`;
  сервисы `EnvelopeCodec`, `EnvelopeLimits`, `EnvelopeWireMapper`,
  `EnvelopeFingerprint`, `E2eeEnvelopeValidator`; use cases `SendMessageUseCase`,
  `MessageSubmissionHandler`, `MessageQueryHandler`.
- Infrastructure/API: адаптеры device-directory/chat-context,
  `MessageEnvelopeRepositoryAdapter` (native SQL, JSONB/bytea, partitions), JPA/mapper
  `crypto_scheme`, sender-scoped queries; `EnvelopeCoverageResponse`, `MessageResponse`
  (+nullable `envelope_coverage`), mapper/controller; `PayloadLimits`,
  `PayloadLimitFilter`, `CachedBodyHttpServletRequest`, `DomainException.payloadTooLarge`;
  realtime `RealtimeEvent`/factory/history/hub/codec/listener.
- Contract/docs: `contracts/ws-protocol.md` §8 (уточнение, wire не менялся),
  `backend/README.md` (раздел E7-B3/B4), `backend/E7-B3-B4-REPORT.md`, этот §9.
- Тесты: новые `E2eeMessageIT` (12), `E2eeMessageFlagOffIT` (1),
  `E2eeMessageRealtimeIT` (1); адаптированы `MessageDomainTest`,
  `SubscriptionServiceTest.FakeHistory` (не отключены).

### Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd backend && mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 314, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# baseline 300 + 14 новых; ArchUnit 10/10
# (известный timing-flake OutboxIT в одном промежуточном прогоне; изолированно/повтор — зелёный)
mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMessageIT,E2eeMessageFlagOffIT,E2eeMessageRealtimeIT' test
# 14/14
cd ../frontend && npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas, types in sync
```

Покрыто: create flag off/on + immutability + no SYSTEM; envelope storage/fan-out/
coverage (partial peer/self warnings); legacy-target/no-peer/no-active-devices; plaintext
reject; ключевые generation/prekey-binding; `crypto` per device (включая `null` для
своего/третьего/legacy); idempotency/`client_message_id` conflicts; seq без «дыр»;
RLS (0 строк под чужим workspace, INSERT → violation); no decrypt (ciphertext байт-в-байт,
body NULL); 512 KiB/413; WS (per-device envelope, sender `crypto:null`, replay, no leak).

### Контракт

| Что | Изменение | Зачем |
|---|---|---|
| `contracts/openapi.yaml` | **нет** | все схемы/пути/коды были в I-01 |
| `frontend/src/api/schema.d.ts` | **нет** | контракт не менялся; `contract:check` in sync |
| `contracts/ws-protocol.md` | §8: E2EE fan-out реализован; `crypto` — конверт устройства соединения, чужие — только через GET; REST-лимиты | убрать устаревшее «E2EE fan-out — E7-B3/B4» |

Отклонений поведения от контракта нет: `envelope_coverage` только в E2EE-ответе,
managed-ответ без поля; `401/403/404/409/413/422/429` — по контракту.

### DDD

```
message.domain.model     CryptoScheme, CryptoEnvelope, EnvelopeHeader, EnvelopePrekey,
                         MessageEnvelope, Message (+E2EE invariants)
message.domain.repository MessageRepository, MessageEnvelopeRepository
message.application      model/port/service/usecase (EnvelopeCodec, E2eeEnvelopeValidator,
                         MessageDeviceDirectoryPort, MessageChatContextPort, …)
message.infrastructure   adapter (auth/chat read-порты), persistence (native SQL, JPA),
                         api.dto/api.mapper
realtime.application     RealtimeEvent (+cryptoByDevice), RealtimeChatHistoryPort (+deviceId)
realtime.infrastructure  WsFrameCodec (per-device), InMemoryRealtimeHub, history adapter
shared                   PayloadLimits, PayloadLimitFilter, CachedBodyHttpServletRequest
```

ArchUnit: `-Dtest=ArchitectureTest` → **10/10**; domain без Spring/JPA/Jackson,
application ↛ infrastructure/api, API ↛ domain, cross-context — только порты/ids,
WS-транспорт — в `realtime.infrastructure.ws`.

### Риски и вопросы

1. **Ciphertext minLength:** контракт `minLength: 363`, спека §4.5 — decoded 16..33040;
   сервер следует спеке (реальные клиенты паддят до 272 B = 363 символа). Строгая
   контрактная граница — одно правило в `EnvelopeCodec`, нужно решение PM.
2. **Replay coverage** пересчитывается best-effort; при исчезнувшем peer-устройстве
   `peer_devices=0` нарушит `minimum: 1` контракта (крайний случай; хранение coverage
   потребовало бы новой колонки/таблицы вне §6.5).
3. **WS vs GET:** реализован §4.4/`ws-protocol.md` (конверт устройства соединения,
   `crypto:null` у отправителя/без конверта); «всегда null в WS» был бы изменением
   wire-контракта, не кода.
4. **Durable outbox** несёт только метаданные (без конвертов) — by design; multi-node
   fan-out требует Redis/Kafka pub/sub (E3-ограничение).
5. **P2-08** (гонка лимита 200 OPK + retention) — долг B1F, не входил в задачу.
6. **G2/G4** — предусловия включения `KRUG_E2EE_ENABLED`; B3/B4 их не заменяют.
7. **Git отсутствует** — I-01 F-3 («одним PR») непроверяем; contract ↔ `schema.d.ts`
   согласованы и проверены `contract:check`.

### Что дальше

1. E7-F: клиентский X3DH/Double Ratchet, локальная копия/outbox, безопасный рендер
   (`crypto:null` → «недоступно на этом устройстве»), safety number.
2. Redis/Kafka pub/sub для multi-node per-device fan-out и durable key-events.
3. P2-08 (атомарный лимит prekey + retention).
4. Решения PM по п.1/п.3 рисков, затем G2/G4 и включение флага.

## 10. E7-B3F3 — P2-09/P2-10/P2-11/P2-12 после E2EE-REVIEW-08 (отчёт по §5)

### Статус

**DONE по P2-09/P2-10/P2-11/P2-12.** Без новых фич, wire/contract не менялись; флаг
`KRUG_E2EE_ENABLED` остаётся `false`.

### Сделано

- **P2-10 (docs):** убрано ложное «старые строки остаются читаемыми»; в `docs/E2EE-SPEC.md`
  §4.1/§5.4/§6.5.1 + новый §6.5.3 описаны V18/V19, quarantine, tolerant read (`crypto:null`,
  no 500), lossless `DELETE ... WHERE EXISTS`, maintenance window/backup/forward-only и
  retention V20. В `backend/README.md` добавлен раздел V18/V19/V20 и поведение history/WS.
- **P2-09 (replay):** выбран и задокументирован явный `422/409` для legacy-only replay:
  те же короткие bytes → `422 INVALID_ENVELOPE_FORMAT` (`ciphertext_too_short`); валидное
  другое тело с тем же `client_message_id` → `409 CLIENT_MESSAGE_ID_CONFLICT`; с тем же
  `Idempotency-Key` → `409 IDEMPOTENCY_KEY_REUSED`. Настоящий idempotency-replay с валидным телом (тот же
  ключ + те же bytes) остаётся `201`, повтор исходных коротких bytes — `422`; 201 для legacy-only не выдумывает несуществующий
  конверт.
- **P2-11 (quarantine):** V19 `DELETE` теперь удаляет live-строку только при побайтовом
  совпадении копии в quarantine (`WHERE EXISTS` по PK + `session_id`/`header`/`ciphertext`);
  V20 включает RLS без policy (owner-only, runtime denied даже при будущем `GRANT`),
  отзывает табличные гранты, добавляет индекс по `quarantined_at` и bounded
  `message.purge_envelope_quarantine(days)` (`SECURITY DEFINER`, 1..3650 дней), которую
  вызывает `EnvelopeQuarantineRetentionScheduler` (90 дней по умолчанию, в `test` выключен).
- **P2-12 (tests):** real-HTTP regressions для encoded/nested paths, floor
  `271/272/33040/33041` и chunked `524288/524289`; WS legacy replay; 271 B HTTP;
  `toDomainOrNull` + log-capture без ciphertext; byte-level quarantine assertion; DELETE
  conflict (не удаляет не-скопированное); V20 RLS/retention. `ApiRequestPath` теперь
  отвергает nested `%` (`%2563`) — закрыт double-decode-класс P0-01.

### Файлы

- Migrations: `V19__e2ee_legacy_envelope_quarantine.sql` (DELETE hardening),
  `V20__e2ee_envelope_quarantine_hardening.sql` (новый, RLS/retention).
- Code: `MessageEnvelopeRepositoryAdapter` (`toDomainOrNull` ловит `RuntimeException`),
  `ApiRequestPath` (nested `%`), `KrugProperties.E2ee` (+retention), `application.yml`,
  `application-test.yml`, `EnvelopeQuarantineRetentionScheduler`.
- Tests: `MessageEnvelopeRepositoryAdapterTest` (новый), `E2eeMigrationIT`,
  `E2eeLegacyEnvelopeIT`, `E2eeMessageRealtimeIT`, `TestProperties`.
- Docs: `docs/E2EE-SPEC.md` (§4.1/§5.4/§6.5.1/§6.5.3), `backend/README.md`, этот §10,
  `backend/E7-B3F3-REPORT.md`.
- Не менялись: `contracts/**`, `frontend/**`, `design/**`.

### Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd backend && mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 340, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# baseline 332 + 8 новых; ArchUnit 10/10
mvn -o -Dmaven.repo.local=.m2repo -Dtest='MessageEnvelopeRepositoryAdapterTest,E2eeMigrationIT,E2eeLegacyEnvelopeIT,E2eeMessageRealtimeIT' test
# 19/19
cd ../frontend && npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas, generated types in sync
```

### Контракт

| Что | Изменение | Зачем |
|---|---|---|
| `contracts/openapi.yaml` | **нет** | `crypto:null`, лимиты и коды уже описаны |
| `contracts/ws-protocol.md` | **нет** | `message.created` уже допускает `crypto:null` |
| `frontend/src/api/schema.d.ts` | **нет** | contract не менялся; `contract:check` in sync |

### DDD

Изменения — в infrastructure (`ApiRequestPath`, adapter, scheduler, config) и migrations;
домен/application/API не менялись. ArchUnit 10/10.

### P2 closure

| Finding | Статус | Доказательство |
|---|---|---|
| P2-09 legacy-only replay | **closed (documented 422/409)** | `E2eeLegacyEnvelopeIT.legacyOnlyReplayIsDocumented422Or409AndNever500`: 201 для true replay с валидным телом, 409 conflict/idempotency, 422 short bytes, 500=0 |
| P2-10 stale docs | **closed** | §4.1/§5.4/§6.5.1/§6.5.3 + README V18/V19/V20; «legacy rows remain readable» удалено |
| P2-11 quarantine RLS/retention/DELETE | **closed** | V19 `DELETE ... WHERE EXISTS`; V20 RLS+revoke+retention function; `E2eeMigrationIT.v19DeleteOnlyRemovesRowsActuallyCopiedToQuarantine`, `v20EnablesOwnerOnlyRlsAndBoundedQuarantineRetention` |
| P2-12 test gaps | **closed** | encoded/nested paths, chunked 524288/524289, floor 271/272/33040/33041, WS legacy replay, 271 B HTTP, `toDomainOrNull`+log-capture, byte-level quarantine |

### Риски и вопросы

0. **V19 checksum:** V19 усилен (`WHERE EXISTS`), его checksum отличается от B3F2-версии; V19 не деплоился (флаг off, локальная dev-БД на V15). Если на стенде B3F2-V19 уже применён — перед обновлением `flyway repair`; V20 применится отдельно.
1. **V19/V20 rollout:** maintenance window/backup обязательны (`ACCESS EXCLUSIVE` + полный
   `VALIDATE`); forward-only. `DB_USER != FLYWAY_USER` должен быть гарантирован ops.
2. **Retention:** 90 дней — политика по умолчанию; окно/включение настраиваются
   `krug.e2ee.quarantine-retention-*`. Решение PM по точному сроку хранения evidence всё ещё
   нужно.
3. **G2/G4/git/one-PR** остаются внешними условиями GO; §10 их не заменяет.
4. **Jar:** `backend/target/krug-backend-0.1.0-SNAPSHOT.jar` (mtime 10:28) старше B3F2/B3F3;
   перед деплоем собрать заново на финальном дереве. Не деплоился.

### Что дальше

1. Внешние G2 (браузерные KAT), G4 (crypto-review), git/one-PR.
2. Решение PM по retention window quarantine и `DB_USER != FLYWAY_USER` в prod.
3. Собрать release-candidate jar на финальном дереве и прогнать `E2eeLegacyEnvelopeIT` +
   `E2eeMigrationIT`; только затем рассматривать flag-on.

---

## 12. D1 — Message Dashboard v1.0 (запланирован, P1/XL)

> Источник истины: [`docs/TASKS-DASHBOARD-V1.md`](TASKS-DASHBOARD-V1.md), замороженный дизайн [`design/dashboard/`](../design/dashboard/) v1.0.0. Не менять макет; отклонения — change request v1.1.

| ID | Задача | Роль | Оценка | Зависимости | Статус |
|---|---|---|---|---|---|
| D1 | Epic: Dashboard v1.0 (рейл/99+, треды, голос/аудио/видео, песни, страницы) | FE+BE | 35–45 d | contract I-01, E4, E6, E12, E7 flag off | **MVP DONE**; D1.1 #57 |
| D1-C1 | Contract: threads, `AttachmentRef.media`, `PATCH /chats/{id}` | PM/BE | 2 d | I-01 | pending |
| D1-BE1 | Threads schema/API/summary/WS/RLS/idempotency | BE | 6 d | D1-C1 | **DONE** (467 tests) |
| D1-BE2 | Media metadata/artwork/MIME/limits | BE | 4 d | D1-C1, E4 | **DONE** (486 tests) |
| D1-BE3 | Chat settings PATCH + audit + members | BE | 3 d | D1-C1, E12 | **DONE** (498 tests) |
| D1-FE1 | Shell: rail/sidebar/pages/routing/themes | FE | 5 d | D1-C1 | in progress (switcher v1.2 ready) |
| D1-FE2 | Flat feed + voice/audio/video/song + ID3 | FE | 6 d | D1-BE2 | in progress |
| D1-FE3 | Threads UI + realtime + mobile | FE | 4 d | D1-BE1 | in progress |
| D1-FE4 | Overview/Files + limits + empty/error | FE | 4 d | D1-BE1/BE2 | **DONE** (в FE1) |
| D1-FE5 | Profile/Chat settings modals | FE | 3 d | D1-BE3 | **DONE** (852 tests) |
| D1-QA1 | E2E/a11y/responsive/contract | QA | 3 d | all | in progress |

**Порядок:** C1 → BE1/BE2/BE3 → FE1/FE2/FE3/FE4/FE5 → QA1. E2EE threads/E2EE media metadata — D1.1, не MVP. D1 не включает звонки, marketplace, DLP-движок, изменение криптопротокола.

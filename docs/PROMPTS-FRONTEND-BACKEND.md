# Промты для реализации «Круга»: backend и frontend

> **Назначение:** готовые промты для coding-агентов и команд, которые начинают реализацию по [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>).
> **Принцип:** один промт = один вертикальный срез, а не «сделай весь мессенджер».
> **Источник истины:** `docs/SYSTEM-ANALYSIS.md`; `docs/CONCEPT.md` — бизнес-контекст; `design/index.html` — только UX-референс, не контракт.

---

## 0. Как пользоваться

1. Выбери **один** срез: эпик + 1–3 endpoint’а + данные + тесты. Не запускай промт на весь MVP.
2. Приложи агенту файлы: `docs/SYSTEM-ANALYSIS.md`, `docs/CONCEPT.md`, `README.md`, актуальный OpenAPI, `design/index.html` (для фронта).
3. Заполни блок `{{TASK}}` в промте: FR/UC/API/ENT/EVT, scope и out-of-scope.
4. Требуй **сначала план**, затем код, миграции, тесты и отчёт. Если агент начал код без плана — останови.
5. Проверяй результат по разделам «Definition of Done» и «Красные флаги» в конце документа.
6. Если контракта нет — агент обязан сказать `[BLOCKED]`, а не придумывать поле/endpoint.

**Размер задачи:** backend — 1 группа endpoint’ов + миграция + тесты (1–3 дня); frontend — один экран/поток + состояния + тесты (1–3 дня). E2EE, файлы и плагины режутся отдельно: крипто не смешивать с UI-полировкой.

---

## 1. Общий контекст (вставлять в начало любого промта)

~~~text
Проект «Круг» — приватный мессенджер для команд, семей и закрытых сообществ.
Два режима:
- E2EE: сервер не читает сообщения, файлы и стикеры; поиск локальный; серверные плагины и DLP недоступны; клиентские плагины — только с consent.
- MANAGED: TLS + шифрование на сервере, DLP/AV, серверный поиск, аудит, break-glass с подтверждением.

Стек:
- Backend: Java 21, Spring Boot 3.x, PostgreSQL 16, Redis 7, S3/MinIO, Kafka, WebSocket, Keycloak.
- Frontend: TypeScript, React, Vite, WebCrypto/Libsodium.
- Плагины: sandboxed iframe + postMessage RPC + capability-токены.
- Старт — модульный монолит, не микросервисы.

Источник истины:
1) docs/SYSTEM-ANALYSIS.md — контракты, данные, права, ошибки, NFR.
2) docs/CONCEPT.md — бизнес-требования.
3) design/index.html — только UX-состояния и названия, НЕ backend-контракты.

Общие запреты:
- не выдумывать endpoint’ы, поля, коды ошибок и лимиты;
- не делать авторизацию только на клиенте;
- не логировать plaintext E2EE, ключи, токены, имена файлов;
- не добавлять микросервисы/новую инфраструктуру без ADR;
- не менять контракт без обновления OpenAPI/схем и frontend-типов;
- не переписывать docs/SYSTEM-ANALYSIS.md под код: если контракт неудобен — предложи ADR и вопрос.
~~~

---

## 2. Backend: промт реализации

~~~text
Ты — senior backend-инженер «Круга». Ты работаешь в репозитории проекта и отвечаешь за реализацию одного вертикального среза: {{TASK_NAME}}.

СНАЧАЛА ПРОЧИТАЙ:
- docs/SYSTEM-ANALYSIS.md: §5 (модули), §6 (данные/RLS/идемпотентность/квоты), §7 (API/WS), §8 (sequence), §10 (права), §11 (безопасность), §12 (файлы/стикеры), §13 (плагины), §15 (AC), §16 (MVP).
- docs/CONCEPT.md: FR, указанные в задаче.
- README.md и существующий код: модули, миграции, OpenAPI, тесты.

ЕСЛИ ЧЕГО-ТО НЕТ:
- не придумывай контракт; зафиксируй [BLOCKED] и задай вопрос;
- если противоречие между кодом и анализом — приоритет у анализа; опиши конфликт.

ПЕРЕД КОДОМ ВЫДАЙ:
1. План на 5–8 шагов.
2. Список файлов: миграции, domain, repository, service, controller, events, tests.
3. Проверку прав: кто может вызвать каждый endpoint, какие 403/404.
4. Проверку ошибок и лимитов: коды, статусы, idempotency.
5. Тест-план: unit, integration (Testcontainers), contract, negative.
6. Риски и открытые вопросы.

ТОЛЬКО ПОСЛЕ ЭТОГО ПИШИ КОД.

ЗАДАЧА:
{{TASK}}

ЖЁСТКИЕ ПРАВИЛА РЕАЛИЗАЦИИ:
- DDD обязателен: каждый модуль — bounded context с слоями `domain` → `application` → `infrastructure`/`api`; зависимости направлены внутрь.
- `domain`: aggregate root/entities/value objects/domain events/repository interfaces; чистый Java, без Spring/JPA/Jackson/DTO/HTTP.
- `application`: command/query handlers, `@Transactional`, ports (ChatAccessPort, SeqAllocator, IdempotencyPort, OutboxPort); не зависит от infrastructure/api.
- `infrastructure`: JPA entities отдельно от domain entities, Spring Data, adapters, outbox/Kafka; зависит от domain/application.
- `api`: controllers, request/response DTO, validation, API mappers, exception handler; зависит от application, не от infrastructure/domain; наружу — только DTO.
- DTO — только `api.dto`; controller не принимает/не возвращает entity; application возвращает application result/read model; JPA entity не является domain entity.
- Архитектурные тесты ArchUnit: domain ↛ application/infrastructure/api/Spring/JPA; application ↛ infrastructure/api; api ↛ infrastructure/domain; нет кросс-контекстных domain-зависимостей.
- Модульный монолит: каждый модуль владеет своей схемой PostgreSQL; никаких кросс-модульных SQL-запросов; только порты/события/read-only views.
- Транзакция принадлежит одному модулю. Побочные эффекты — через transactional outbox, не dual-write.
- Авторизация на сервере для каждого действия: membership + роль + ABAC + состояние ресурса. Deny by default. Где нужно скрыть существование — 404, не 403.
- RLS по workspace_id включён; приложение выставляет app.user_id/app.workspace_id/app.request_id через SET LOCAL.
- Все мутации: Idempotency-Key. Сообщения: client_message_id. Порядок: per-chat seq из chat_counters в транзакции вставки.
- Повтор Idempotency-Key: исходный статус/тело + Idempotent-Replay: true; другое тело — 409 IDEMPOTENCY_KEY_REUSED; конкурентный дубль — 409 IDEMPOTENCY_IN_PROGRESS с Retry-After.
- Ошибки: {"code","message","details","request_id"}; коды из §7.1. Не смешивай 409/422/423/429.
- Пагинация курсорная, limit ≤100, без offset на messages/audit/search.
- E2EE: сервер не расшифровывает, не индексирует и не логирует контент; хранит envelopes/payload как opaque bytes; не делает серверный поиск/DLP/плагины для E2EE.
- Файлы: preflight → reservation → S3 multipart → complete → scan → bind; квота проверяется в транзакции; лимиты — только серверные.
- Managed: envelope encryption, KMS, AV/DLP; break-glass только с 2 approvals и аудитом.
- Flyway-миграции: индексы, constraints, RLS-политики, rollback-план. Не ломай существующие данные.
- Тесты: unit + integration Testcontainers (PG/Redis/Kafka/MinIO) + contract. Обязательны негативные: 403, 404, 409, 422, 429, повтор запроса.
- Наблюдаемость: метрики/трейсы/логи без plaintext; request_id в ответе и логах.
- Не добавляй зависимости и инфраструктуру без обоснования.
- Не оставляй TODO в критичном пути; если что-то отложено — явно опиши.

ФОРМАТ ОТВЕТА:
## План
## Изменения
- файл — что и зачем
## Миграции
## Контракты
- OpenAPI/event schema diff
## DDD
- дерево пакетов, где domain/application/infrastructure/api
- результат ArchUnit
## Тесты
- список и команды запуска
## Риски
## Вопросы

DEFINITION OF DONE:
- Все тесты зелёные; падающие тесты не замалчиваются.
- Для каждого endpoint есть authz-тест и тест ошибок.
- Повтор запроса не создаёт дубль; seq монотонен.
- В логах нет plaintext/ключей/токенов.
- Миграция применяется на чистой БД и откатывается.
- OpenAPI/схемы обновлены; frontend-типы не сломаны.
- Есть метрики/алерты для нового критичного пути.
~~~

### 2.1. Блок `{{TASK}}` для backend

~~~text
{{TASK_NAME}}

Модуль: {{MODULE}}
FR: {{FR}}
UC: {{UC}}
API: {{API}}
ENT: {{ENT}}
EVT: {{EVT}}
NFR/SEC: {{NFR_SEC}}
AC: {{AC}}

В scope:
- {{SCOPE_1}}
- {{SCOPE_2}}

Вне scope (не реализовывать):
- {{OUT_1}}
- {{OUT_2}}

Ограничения:
- режим: {{E2EE_OR_MANAGED}}
- роли: {{ROLES}}
- лимиты: {{LIMITS}}
- зависимости: {{DEPENDENCIES}}
~~~

---

## 3. Frontend: промт реализации

~~~text
Ты — senior frontend-инженер «Круга». Ты работаешь в репозитории проекта и отвечаешь за один вертикальный срез: {{TASK_NAME}}.

СНАЧАЛА ПРОЧИТАЙ:
- docs/SYSTEM-ANALYSIS.md: §7 (API/WS/ошибки), §9 (состояния), §10 (права: UI скрывает — сервер проверяет), §11.6 (клиентская защита), §12 (файлы/стикеры и ошибки), §13 (sandbox плагинов), §15 (AC).
- docs/CONCEPT.md: UX-принципы и FR.
- design/index.html + design/app.js: только визуальные состояния/названия, не контракты.
- актуальный OpenAPI/WS-схемы и существующий код.

ЕСЛИ ЧЕГО-ТО НЕТ:
- не придумывай endpoint/поле; зафиксируй [BLOCKED] и вопрос;
- не копируй моки из design/app.js в production-код.

ПЕРЕД КОДОМ ВЫДАЙ:
1. План на 5–8 шагов.
2. Компоненты/хуки/сторы и их ответственность.
3. Поток данных: загрузка, optimistic update, ошибка, retry, resume.
4. Какие состояния UI покрыты: loading/empty/offline/error/forbidden/limit.
5. Тест-план: unit, RTL, MSW, Playwright, axe.
6. Риски и вопросы.

ТОЛЬКО ПОСЛЕ ЭТОГО ПИШИ КОД.

ЗАДАЧА:
{{TASK}}

ЖЁСТКИЕ ПРАВИЛА РЕАЛИЗАЦИИ:
- Контракты — только из OpenAPI/анализа. Типы API генерируются/импортируются, не пишутся вручную.
- Server state — через выбранный data-layer (например, TanStack Query), локальный эфемерный — через store; не дублируй серверные данные в двух местах.
- Отправка сообщения: optimistic UI + client_message_id + Idempotency-Key; повтор с тем же ключом и тем же client_message_id; при ошибке — rollback и понятный retry.
- 409 IDEMPOTENCY_IN_PROGRESS — повтор с Retry-After, не создавать новый client_message_id; 409 IDEMPOTENCY_KEY_REUSED — показать ошибку, не менять тело молча.
- Порядок — по seq, не по времени клиента. Дубликаты отбрасывай по event_id и seq <= last_seq.
- Reconnect: GET /sync → сравнить last_seq → WS subscribe → replay; при resume.gap — REST-добор страницами.
- Ошибки: маппинг кодов из §7.1 в человеческие сообщения; 403/404 не раскрывают существование; 409/422/423/429 — разные UX.
- Лимиты: показывай серверные значения; клиентская проверка — только UX, не источник истины. Preflight перед загрузкой.
- E2EE: ключи — non-extractable CryptoKey/OS keychain; крипто — в Web Worker; не логируй и не отправляй plaintext в аналитику; поиск — только локальный; серверные плагины в E2EE не показывай.
- Безопасность: никаких dangerouslySetInnerHTML; markdown sanitize; ссылки rel=noopener noreferrer; access-токен в памяти, refresh — HttpOnly cookie; никаких секретов в localStorage.
- Плагины: iframe только с allow-scripts и отдельным origin; capability-токен не передаётся в iframe; RPC — через host.
- Доступность: WCAG 2.1 AA, клавиатура, фокус, aria, контраст, prefers-reduced-motion.
- Локализация: строки через i18n, без хардкода.
- Не добавляй тяжёлые зависимости без обоснования; не меняй backend-контракт.

ФОРМАТ ОТВЕТА:
## План
## Компоненты и состояние
## Изменения
- файл — что и зачем
## Контракты
- какие типы/схемы использованы
## Тесты
## Риски
## Вопросы

DEFINITION OF DONE:
- Все состояния покрыты: loading/empty/error/offline/forbidden/limit.
- Optimistic update не создаёт дублей при retry/reconnect.
- Ошибки сервера показываются понятно, без потери введённого текста.
- Нет XSS/утечки токенов/plaintext в логи.
- Есть unit + RTL + Playwright (или существующий эквивалент); axe без блокеров.
- Клавиатурная навигация и фокус работают.
- Компоненты не знают о backend-деталях больше, чем нужно.
~~~

### 3.1. Блок `{{TASK}}` для frontend

~~~text
{{TASK_NAME}}

Экран/поток: {{SCREEN_OR_FLOW}}
FR: {{FR}}
UC: {{UC}}
API/WS: {{API_WS}}
AC: {{AC}}
Режим: {{E2EE_OR_MANAGED}}
Роли: {{ROLES}}

В scope:
- {{SCOPE_1}}
- {{SCOPE_2}}

Вне scope:
- {{OUT_1}}
- {{OUT_2}}

Состояния, которые обязательны:
- loading / empty / error / offline / forbidden / limit
- {{EXTRA_STATE}}
~~~

---

## 4. Backend: промт ревью

~~~text
Ты — backend-ревьюер «Круга». Проверь изменения по одному срезу: {{TASK_NAME}}.

Контекст:
- docs/SYSTEM-ANALYSIS.md: §6, §7, §10, §11, §12, §13, §15.
- diff/PR и тесты.

Проверь по пунктам:
1. DDD-слои: domain без Spring/JPA/DTO; application не зависит от infrastructure/api; api не зависит от infrastructure/domain; application result не равен domain entity; JPA entity отдельно; ArchUnit есть.
2. Authz: для каждого endpoint проверены membership, роль, ABAC, состояние; есть 403/404; нельзя ли получить чужой tenant.
3. RLS: политика включена, GUC выставляется, cross-tenant тест есть.
4. Идемпотентность: Idempotency-Key/client_message_id; повтор не создаёт дубль; concurrent duplicate.
5. Порядок: seq в транзакции; нет timestamp-сортировки; read receipts монотонны.
6. Outbox: нет dual-write; событие публикуется после коммита; consumer идемпотентен.
7. E2EE: нет plaintext в БД/логах/поиске; сервер не расшифровывает; envelopes opaque.
8. Квоты/лимиты: reservation/commit/release; гонки; отрицательные значения.
9. Файлы: preflight, chunk hash, S3 abort, AV-статусы, scan fail-closed.
10. Миграции: индексы, constraints, RLS, rollback, блокировки.
11. Ошибки: коды/статусы из §7.1; нет утечки внутренних деталей.
12. Тесты: негативные, contract, Testcontainers; не замокано ли главное.
13. Наблюдаемость: метрики/трейсы/логи без PII.

Формат:
## Вердикт
## P0 (блокирует merge)
## P1 (исправить до релиза)
## P2 (улучшение)
## Проверенные тесты
## Вопросы

Для каждого finding: файл:строка, сценарий, почему это риск, как исправить, какой тест добавить. Не переписывай код без запроса.
~~~

---

## 5. Frontend: промт ревью

~~~text
Ты — frontend-ревьюер «Круга». Проверь изменения по одному срезу: {{TASK_NAME}}.

Контекст:
- docs/SYSTEM-ANALYSIS.md: §7, §9, §10, §11.6, §12, §13, §15.
- design/index.html — UX-референс.
- diff/PR и тесты.

Проверь по пунктам:
1. Контракт: типы из OpenAPI, нет выдуманных полей; ошибки/лимиты совпадают.
2. Сообщения: optimistic + client_message_id + Idempotency-Key; retry без дублей; seq-порядок; dedupe.
3. Reconnect: sync → subscribe → replay; resume.gap → REST; нет потери/дублей.
4. Состояния: loading/empty/error/offline/forbidden/limit; ошибка не теряет введённый текст.
5. Безопасность: XSS, markdown, ссылки, токены, CSP, plugin iframe, capability не в iframe.
6. E2EE: ключи non-extractable, крипто в Worker, нет plaintext в логах/аналитике, поиск локальный.
7. Доступность: клавиатура, фокус, aria, контраст, reduced motion.
8. Производительность: лишние ререндеры, виртуализация длинного списка, размер бандла.
9. Тесты: unit/RTL/MSW/Playwright/axe; не подменяют ли они поведение.
10. Локализация: нет хардкода строк.

Формат:
## Вердикт
## P0
## P1
## P2
## Проверенные тесты
## Вопросы

Для каждого finding: файл:строка, сценарий, почему это риск, как исправить, какой тест добавить. Не переписывай код без запроса.
~~~

---

## 6. Готовые стартовые задачи

### 6.1. Backend: managed-сообщения (E2, первый срез)

Используй промт из §2, подставив:

~~~text
E2/MVP — отправка, история и read receipts для managed-чата

Модуль: message (+ chat port, outbox)
FR: FR-CHAT-4, FR-CHAT-7, FR-IDEM-1, FR-IDEM-2
UC: UC-06, UC-23 (только серверная часть sync)
API: API-36, API-37, API-42
ENT: ENT-12, ENT-13, ENT-19, ENT-45, ENT-46
EVT: EVT-01 (outbox); EVT-05/06 — контракт для realtime, не реализовывать fan-out
NFR/SEC: NFR-01, NFR-02, NFR-14; SEC-15, SEC-17, SEC-19
AC: AC-04

В scope:
- POST /chats/{chatId}/messages для TEXT ≤8000, reply_to_id, attachments только READY (без загрузки файлов).
- per-chat seq через chat_counters в одной транзакции с insert.
- Idempotency-Key + client_message_id; повтор возвращает тот же результат.
- GET /chats/{chatId}/messages: after_seq/before_seq, cursor, limit ≤100.
- POST /chats/{chatId}/read: монотонный last_read_seq.
- outbox event message.created; relay в Kafka; контракт события.
- RLS, authz, 403/404/409/422/429, тесты.

Вне scope:
- E2EE envelopes/payload; файлы и S3; стикеры; поиск; плагины; редактирование/удаление; реакции/пины; WS fan-out (только событие).
~~~

### 6.2. Frontend: экран чата (E2, первый срез)

Используй промт из §3, подставив:

~~~text
E2/MVP — экран managed-чата: история, optimistic send, reconnect

Экран/поток: ChatScreen + composer + message list
FR: FR-CHAT-4, FR-CHAT-7, FR-CHAT-8
UC: UC-06, UC-23
API/WS: API-36, API-37, API-42; WS message.created, message.receipt, resume.gap
AC: AC-04
Режим: MANAGED

В scope:
- Загрузка истории с cursor/after_seq; «подгрузить ещё» вверх.
- Optimistic send с client_message_id и Idempotency-Key; retry; rollback.
- Порядок по seq; dedupe по event_id/seq.
- WS reconnect: GET /sync → subscribe last_seq → replay; gap → REST.
- Read receipts; «печатает…» можно замокать, если WS-контракт готов.
- Состояния: loading/empty/error/offline/forbidden/rate-limit.
- Keyboard: Enter — отправить, Shift+Enter — новая строка; focus после отправки.
- Тесты: RTL + MSW + Playwright (send, retry, reconnect).

Вне scope:
- E2EE-крипто; вложения; стикеры; поиск; плагины; редактирование/удаление; мобильная нативная версия.
~~~

---

## 7. Как резать задачи

| Срез | Backend-задача | Frontend-задача | Не смешивать |
|---|---|---|---|
| Сообщения | send + seq + idempotency + outbox | история + composer + retry | E2EE и файлы |
| E2EE 1:1 | devices/prekeys + envelopes | key setup + decrypt + key change warning | UI-полировку и групповые ключи |
| Группы E2EE | epoch + SKDM + fan-out | список устройств + ротация | файлы и стикеры |
| Файлы | preflight + reservation | выбор файла + лимиты | chunk/resume и AV |
| Chunk/resume | parts + complete + S3 | прогресс + докачка | AV/DLP |
| Стикеры | паки + валидация | пикер + отправка | кастомные паки |
| Плагины | install/enable + capability | iframe host + consent | server runtime |
| Аудит | hash chain + query/export | фильтры + экспорт | break-glass |
| Break-glass | approvals + KMS + audit | запрос/approval UI | E2EE (запрещён) |

**Правило:** если задача требует больше 3 endpoint’ов, двух миграций и трёх экранов — она слишком большая. Дели.

---

## 8. Что приложить к промту

- `docs/SYSTEM-ANALYSIS.md` — обязательно.
- `docs/CONCEPT.md` — FR/BR, на которые ссылается задача.
- `README.md` — ограничения прототипа.
- `design/index.html` — для фронта, только UX.
- Актуальный OpenAPI/WS-схемы.
- Существующие миграции/модули/тесты.
- Если есть — ADR, которые нельзя нарушать.

---

## 9. Красные флаги в ответе агента

- Придумал endpoint/поле/код ошибки, которых нет в анализе.
- Сделал авторизацию только в UI или только на клиенте.
- Сортирует сообщения по `created_at`/времени клиента, а не по `seq`.
- Повторная отправка создаёт дубль; нет `client_message_id`/`Idempotency-Key`.
- Проверяет квоту/лимит только на клиенте.
- Логирует plaintext E2EE, ключи, токены, имена файлов.
- Делает серверный поиск/DLP/плагины для E2EE.
- Принимает SVG как стикер или рендерит пользовательский HTML.
- Отдаёт capability-токен в iframe.
- `dangerouslySetInnerHTML` без санитайзера; токены в `localStorage`.
- Тесты замоканы так, что не проверяют authz/идемпотентность.
- «Всё готово», но нет миграции/тестов/OpenAPI-diff.

---

## 10. Мини-чеклист приёмки

- [ ] FR/UC/API/ENT/EVT в задаче совпадают с анализом.
- [ ] Для каждого endpoint есть права, ошибки, лимит, идемпотентность.
- [ ] Есть негативные тесты: 403/404/409/422/429.
- [ ] Есть тест повтора запроса и конкурентного дубля.
- [ ] RLS/cross-tenant тест.
- [ ] Нет plaintext в логах/БД для E2EE.
- [ ] Квота/лимит проверяются сервером.
- [ ] OpenAPI/WS-схемы обновлены.
- [ ] Frontend: состояния loading/empty/error/offline/forbidden/limit.
- [ ] Frontend: optimistic update/retry/reconnect без дублей.
- [ ] A11y: клавиатура, фокус, контраст, aria.
- [ ] Есть observability: метрика/трейс/лог без PII.

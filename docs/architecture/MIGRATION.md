# План миграции: от модульного монолита к сервисам

> Практический документ для команд. Архитектурные обоснования — в [MICROSERVICES.md](MICROSERVICES.md), решения — в [ADR.md](ADR.md), события — в [EVENTS.md](EVENTS.md).
> Диаграмма волн — [12-roadmap](diagrams/svg/12-roadmap.svg).

---

## 1. Принципы

1. **Strangler Fig.** Монолит остаётся работающим; новый сервис постепенно забирает трафик через edge. Никакого «big bang».
2. **Никаких dual writes.** Источник истины один. Переход — через outbox/CDC и переключение маршрута, а не запись в две БД.
3. **Expand / contract.** Сначала расширяем контракт и данные, потом переключаем, потом удаляем старое.
4. **Одна волна — один владелец данных.** Нельзя одновременно переносить `chat` и `media`.
5. **Каждая волна обратима.** Пока монолит жив, rollback = переключить маршрут обратно и остановить consumer'ов.
6. **Сначала измеряем.** Exit criteria волны — цифры, а не «вроде работает».
7. **Не начинать с `conversation`.** Это последнее, что трогаем; `chat`/`message` не дробим.

---

## 2. Wave 0 — платформенные enablers

Без этого блока выделение сервисов невозможно. Wave 0 не меняет публичный API и не создаёт новых deployables (кроме инфраструктуры).

### 2.1. Брокер и outbox

| Задача | Детали | Exit |
|---|---|---|
| Kafka/Redpanda | 3 брокера, RF=3, `min.insync=2`, топики по [EVENTS.md](EVENTS.md) | продовый кластер, ACL, мониторинг |
| Реальный outbox relay | заменить `LoggingEventPublisher` на Kafka producer; `SKIP LOCKED`; метрика `outbox_lag_seconds`; retry с backoff | событие доходит до consumer'а; lag p95 < 2 с |
| Идемпотентный consumer | библиотека: `processed_events(event_id)` или upsert; DLQ после N попыток | duplicate-тест: 2 доставки → 1 эффект |
| Схемы событий | JSON Schema в `contracts/events/`, CI-валидация, версия в envelope | CI ловит несовместимое изменение |
| Топики и ACL | naming `krug.<domain>.v1`, per-service produce/consume ACL | документировано, применено |

### 2.2. Redis и runtime-состояние

| Задача | Детали | Exit |
|---|---|---|
| Redis cluster | presence, typing, rate limit, кэш тикетов, pub/sub | latency p95 < 5 мс |
| Rate limit | вынести из in-memory в Redis (token bucket) | переживает рестарт, работает на N узлах |
| Сессии WS | подготовить маршрутизацию `session → node` в Redis | 2 узла видят соединения друг друга |

### 2.3. Данные

| Задача | Детали | Exit |
|---|---|---|
| Роли и гранты | `krug_identity`, `krug_conversation`, ...; никаких грантов между схемами | `\dp` показывает изоляцию |
| Инвентаризация FK | граф 93 ссылок, классификация keep/drop/replace | таблица в репозитории |
| Read-модели | вынести `ops.platform_overview`, `admin_users_page`, `member_directory` в API/проекции (поэтапно) | admin не читает чужие схемы напрямую |
| Flyway | per-service baseline, отдельная история | сервис мигрируется независимо |

### 2.4. Контракты и наблюдаемость

| Задача | Детали | Exit |
|---|---|---|
| OpenAPI по сервисам | разбить `contracts/openapi.yaml` по тегам, генерировать агрегированный | контрактные тесты зелёные |
| OTel | tracing HTTP/JDBC/Kafka, `trace_id` в envelope | сквозной трейс send → WS |
| Метрики | RED/USE, outbox/consumer lag, WS connections, scan queue | дашборды по сервисам |
| SLO | определить SLI/SLO из §9 MICROSERVICES | алерты по burn rate |
| CI/CD | multi-module Maven, affected build, per-service image, SBOM, scan | образ собирается и деплоится отдельно |

### 2.5. Каркас сервиса

Шаблон нового сервиса (cookiecutter/archetype):

- Spring Boot 3.4, Java 21, Actuator, OTel, Micrometer;
- `domain/application/infrastructure/api`, ArchUnit;
- Flyway, Testcontainers, contract-тесты;
- Dockerfile, Helm chart, NetworkPolicy, PDB, HPA;
- README + runbook + dashboards + alerts;
- `outbox`/`idempotency` библиотека;
- mTLS и service account.

**Exit Wave 0:** пилотный сервис-пустышка поднимается в K8s, получает трафик от edge, публикует и потребляет событие, имеет SLO-дашборд. Монолит при этом не меняет поведение.

---

## 3. Волны

| Волна | Сервисы | Длительность* | Зависит от | Ключевой риск |
|---|---|---|---|---|
| 0 | enablers | 2–3 спринта | — | незаметно оставить заглушки |
| 1 | `realtime`, `audit` | 3–4 | 0 | fan-out latency, ACL-кэш |
| 2 | `media`, `notification` | 3–4 (параллельно) | 0 | квоты, AV fail-closed |
| 3 | `extensions`, `admin` | 4–5 | 1, 2 | sandbox, CQRS-проекции |
| 4 | `identity`, `workspace` | 4–5 | 1–3 | сессии/cookie, policy-кэш |
| 5 | `conversation` hardening, `search` | ongoing | 1–4 | не разделить chat/message |

\* Оценка для команды 3–4 человека на волну; параллельно можно вести 1 и 2.

### Wave 1 — `realtime` + `audit`

**`realtime`:**

1. Вынести WS-слой в отдельный сервис, сохранив протокол (`contracts/ws-protocol.md`).
2. Тикеты — в БД `realtime`; валидация сессии/устройства — через `identity` API.
3. Подписка/ACL — batch-вызов `conversation`; кэш в Redis с epoch.
4. Replay — `GET /internal/v1/chats/{id}/replay`; конверты E2EE — batch по device.
5. Kafka consumer `message.*`, `chat.member.changed`, `device.revoked`.
6. Edge маршрутизирует `/ws` и `/realtime/ticket` в новый сервис.
7. Монолитный `InMemoryRealtimeHub` остаётся за флагом на время cutover; после стабилизации удаляется.

**`audit`:**

1. Все сервисы (пока монолит) пишут audit-события в outbox.
2. `audit` потребляет топики, строит hash chain по workspace.
3. Query/export API; SIEM-вебхук.
4. Admin-запросы аудита переводятся на `audit` API.
5. Транзакционная запись `audit.append` в монолите отключается после сверки.

**Exit:** 10k WS на узел; reconnect без потери `seq`; audit lag p95 < 5 с; chain verification зелёная; 0 расхождений за 7 дней.

**Rollback:** вернуть маршруты `/ws` и `/realtime/ticket` в монолит; новый сервис оставить read-only; audit-события продолжать писать в outbox (не теряются).

### Wave 2 — `media` + `notification`

**`media`:**

1. Перенести `file` + `sticker` + S3-адаптер + AV-воркер.
2. Preflight/init/parts/complete/abort; квоты reserve/commit/release.
3. `conversation` получает readiness через `POST /internal/v1/attachments:batch`.
4. Публикация `upload.completed`, `media.scan.completed`, `quota.threshold.reached`.
5. GC/retention — воркеры `media`.

**`notification`:**

1. Вынести in-app ленту, настройки, dedupe.
2. Email/push — воркеры; SMTP/Push креды — только у `notification`.
3. Потребление событий вместо in-process listeners.
4. Удалить `notification`-адаптеры из монолита после сверки.

**Exit:** квота сходится (reserve+commit+release), orphan-файлов 0; скан fail-closed; push dedupe 100% на тесте; media p95 в SLO.

**Rollback:** маршруты `/uploads|/files|/attachments|/media` и `/notifications` → монолит; новые таблицы остаются read-only; S3-ключи совместимы.

### Wave 3 — `extensions` + `admin`

**`extensions`:**

1. Каталог, пакеты, подписи, установка, enablement, consent.
2. Capability-токены и проверка на границе.
3. `plugin-runtime` — отдельный namespace, egress-proxy, лимиты; пока может быть выключен.
4. Боты: токены, signing secret, event deliveries, retry, SSRF-защита.
5. Polls/tasks; публикация plugin-сообщения через `conversation` API.
6. Удалить `plugin`/`bot` из монолита.

**`admin`:**

1. CQRS-проекции из событий (`admin_users`, `admin_chats`, `admin_storage`, `admin_overview`).
2. Команды — через API владельцев (suspend/activate, delete chat, revoke sessions).
3. `/admin/*`, `/setup/*`, `/health` — в `admin`.
4. Удалить `ops` admin-контроллеры и `SECURITY DEFINER`-функции.

**Exit:** плагин не имеет доступа к БД/сети; kill switch < 5 с; admin не делает кросс-БД JOIN; проекции сходятся с источником.

### Wave 4 — `identity` + `workspace`

**`identity`:**

1. BFF/cookie, login/refresh/logout, 2FA, регистрация.
2. Сессии, устройства, prekeys, key verification, блокировки.
3. Keycloak Admin API — service account.
4. `session.revoked`/`device.revoked` → `realtime`/`conversation`.
5. Edge проверяет JWT; `/auth/*` проксируется в `identity`.

**`workspace`:**

1. Воркспейсы, членство, роли, инвайты, лимиты, security/DLP.
2. `member.changed`/`limits.changed`/`policy.changed` — события.
3. Кэши в `conversation`/`media` переводятся на события.

**Exit:** revoke < 5 с; login/refresh p95 в SLO; policy-кэш инвалидируется; 0 паролей в БД/логах.

### Wave 5 — `conversation` hardening + `search`

- Убрать оставшиеся domain-leak'и; все межсервисные связи — через API/события.
- ACL-кэш и `epoch`; batch-эндпоинты.
- `search` — отдельный индексер/запросчик (managed only).
- **Decision gate:** дробить ли `chat`/`message`. По умолчанию — **нет**. Пересмотреть, если:
  - `chat` и `message` требуют разного масштабирования (например, message — 10× CPU);
  - появляется независимая команда на `chat`;
  - `seq` можно перенести в `message` без потери инвариантов.
- Если дробим — только через ADR и с сагой `seq`/счётчиков.

---

## 4. Playbook выделения сервиса

Для каждой волны/сервиса — одинаковый порядок.

### Шаг 0. Паспорт сервиса

- владелец, on-call, SLO;
- данные (схема/таблицы), API, события, зависимости;
- план容量 и стоимость;
- threat model (кратко).

### Шаг 1. Контракт

- OpenAPI `/internal/v1/*` + публичные пути;
- JSON Schema событий;
- ошибки, идемпотентность, таймауты;
- contract-тесты (consumer-driven для критичных пар).

### Шаг 2. Каркас

- репозиторий/модуль, CI, Dockerfile, Helm, NetworkPolicy;
- Flyway baseline;
- OTel, метрики, дашборды, алерты, runbook;
- load test с целевым профилем.

### Шаг 3. Теневое чтение

- edge дублирует GET-запросы в новый сервис (shadow traffic);
- сравнение ответов (diff, latency, ошибки);
- расхождения — в отчёт, не пользователю.

### Шаг 4. Данные

- создать БД/схему/роль;
- backfill (dump/restore или batch);
- CDC/логическая репликация для дельты;
- сверить counts/checksums/инварианты;
- включить dual-read (не dual-write).

### Шаг 5. Запись

- переключить write-трафик фича-флагом (1% → 10% → 50% → 100%);
- старый путь — read-only или за флагом;
- мониторить ошибки, latency, duplicate, outbox.

### Шаг 6. События

- включить публикацию из нового сервиса;
- переключить consumer'ов;
- старый публикатор отключить после lag=0 и сверки.

### Шаг 7. Вывод монолита

- удалить модуль/адаптеры/контроллеры;
- удалить таблицы после retention-периода;
- удалить `SECURITY DEFINER`-функции;
- обновить docs/ADR.

### Шаг 8. Пост-проверка

- 7 дней без инцидентов;
- SLO в норме;
- стоимость в бюджете;
- runbook протестирован (chaos/on-call).

### Шаг 9. Ретроспектива

- что оказалось дороже;
- какие связи недооценили;
- обновить чек-лист.

---

## 5. Данные: паттерны переноса

### 5.1. Тот же кластер PostgreSQL

Самый дешёвый путь на старте:

```sql
CREATE DATABASE krug_identity OWNER krug_identity;
CREATE ROLE krug_identity LOGIN PASSWORD '...';
-- перенос схемы
pg_dump --schema=auth --no-owner krug | psql krug_identity
-- логическая репликация для дельты (публикация таблиц auth.*)
```

Плюсы: быстро, без CDC. Минусы: общий кластер = шумный сосед, единая точка отказа. Триггер разделения — SLO/комплаенс.

### 5.2. Отдельный кластер

- initial: `pg_dump`/restore;
- delta: Debezium/CDC или outbox-события;
- cutover: короткая заморозка записи (30–60 с) + догон + переключение;
- последовательности: sync `setval`;
- проверка: counts, checksums, sampled reads, инварианты.

### 5.3. Backfill больших таблиц

- батчи по 5–10 тыс. строк, по PK;
- throttling, чтобы не убить primary;
- идемпотентный upsert;
- progress-метрика, restartable;
- финальная сверка.

### 5.4. Проверки

| Проверка | Инструмент |
|---|---|
| Количество строк | `count(*)` по таблицам/партициям |
| Контрольные суммы | `md5` агрегатов по ключевым полям |
| Инварианты | SQL: orphan, дубли, отрицательные квоты, разрывы seq |
| Сэмплы | случайные 1000 записей, сравнение API-ответов |
| События | lag=0, нет DLQ, нет duplicate-эффектов |

### 5.5. Откат данных

- до cutover: просто не переключать;
- после cutover: reverse CDC или восстановление из бэкапа + replay outbox;
- **никогда** не писать в две БД «на всякий случай».

---

## 6. Удаление 93 FK

### 6.1. Классификация

| Класс | Что делать | Когда |
|---|---|---|
`keep` | FK внутри одного сервиса | остаётся |
`drop` | FK между сервисами, ID проверяется API/кэшем | при выделении владельца |
`replace` | FK заменяется сагой/reconciliation | если нужна строгая целостность |

### 6.2. Порядок

1. Построить граф FK (есть в [data ownership](diagrams/svg/07-data-ownership.svg)).
2. Для каждой связи — владелец, проверка, orphan-риск.
3. Добавить проверку в код/событие и метрику `orphan_rows`.
4. Выпустить миграцию `ALTER TABLE ... DROP CONSTRAINT ...` (без `CASCADE`, точечно).
5. Оставить индексы на FK-колонках.
6. Reconciliation-джоба: ежедневно, отчёт, алерт при росте.
7. Удалять данные-сироты только по политике retention.

### 6.3. Особые случаи

- **`auth.users`**: 27 ссылок. До Wave 4 `identity` ещё в монолите, FK можно оставить. При выделении — drop + проверка `user_id` через кэш/событие + soft-delete.
- **`workspace.workspaces`**: 20 ссылок. Аналогично; `workspace_id` остаётся tenant-ключом и RLS-предикатом.
- **`chat.chats`**: 19 ссылок. Внутри `conversation` — keep; в `media`/`extensions` — drop + проверка через API.
- **`file.attachments`**: 5 ссылок в `message`. `conversation` хранит `attachment_id[]`; readiness — API; удаление вложения — событие `attachment.deleted`.
- **`plugin.*`/`bot.*`**: после слияния в `extensions` — keep внутри.

### 6.4. Мониторинг

- `orphan_rows{service,table}` — 0 в норме;
- `fk_violation_total` — алерт;
- reconciliation report — ежедневно;
- chaos-тест: удалить родителя → проверить поведение.

---

## 7. Cutover / rollback runbook (шаблон)

### 7.1. Preconditions

- [ ] контракт заморожен, consumer-driven тесты зелёные;
- [ ] backfill завершён, checksums совпали;
- [ ] shadow-read diff < 0.1%;
- [ ] SLO/алерты/дашборды готовы;
- [ ] runbook протестирован на staging;
- [ ] rollback-план и владелец решения назначены.

### 7.2. Cutover

1. Объявить окно (30–60 мин), заморозить релизы.
2. Включить write-freeze или перевести старый путь в read-only.
3. Догнать CDC/outbox до lag=0.
4. Переключить фича-флаг: 1% → 10% → 50% → 100% (по 5–10 мин).
5. Smoke: login → send → WS → upload → search.
6. Мониторить 60 мин: ошибки, p95, lag, DLQ, orphan.
7. Закрыть окно, снять freeze.

### 7.3. Rollback triggers

- 5xx > 1% в течение 5 мин;
- p95 > SLO × 2;
- рост DLQ/orphan;
- потеря `seq`/дубликаты;
- E2EE-инцидент.

### 7.4. Rollback

1. Вернуть фича-флаг на старый путь.
2. Остановить consumer'ов нового сервиса (или перевести в read-only).
3. Сохранить события в outbox/DLQ для разбора.
4. Сверить данные: не потерялись ли записи, сделанные новым сервисом.
5. Если запись была только в новой БД — reverse CDC/скрипт.
6. Пост-мортем, обновить чек-лист.

---

## 8. CI/CD и окружения

- **Монорепозиторий** с Maven multi-module: `platform/`, `services/*`, `legacy/`.
- **Affected build**: собирать только изменённые модули и зависимости.
- **Пайплайн сервиса**: compile → unit → ArchUnit → contract → integration (Testcontainers) → image → SBOM/scan → deploy staging → smoke → canary.
- **Миграции**: backward-compatible; проверка `flyway validate`; запрет destructive без approval.
- **Окружения**: dev (compose), staging (K8s, 1 AZ), prod (3 AZ).
- **Секреты**: Vault/External Secrets, никаких `.env` в git.
- **Релизы**: canary 5% → 25% → 100%, автоматический откат по SLO.

---

## 9. Команды и ownership

| Поток | Сервисы | Ответственность |
|---|---|---|
| Platform | `edge`, Kafka, Redis, observability, CI/CD | маршрутизация, SLO-платформа, безопасность цепочки |
| Identity & Tenancy | `identity`, `workspace` | сессии, ключи, членство, политики |
| Conversation | `conversation`, `realtime` | чаты, сообщения, WS, presence |
| Media & Extensions | `media`, `extensions` | файлы, AV, плагины, боты |
| Trust & Insights | `audit`, `search`, `notification`, `admin` | аудит, поиск, уведомления, backoffice |

Правила:

- у каждого сервиса — owner и on-call;
- изменения контракта — через PR владельца + consumer-driven тест;
- общие библиотеки — только platform;
- архитектурные решения — ADR, не Slack.

---

## 10. Оценка и DoD

### 10.1. Оценка

| Волна | Команда | Спринты | Календарь (3 команды) |
|---|---|---|---|
| 0 | Platform | 2–3 | 1–1,5 мес |
| 1 | Conversation + Platform | 3–4 | 1,5–2 мес |
| 2 | Media + Trust | 3–4 | 2 мес (параллельно с 1) |
| 3 | Media/Extensions + Trust | 4–5 | 2 мес |
| 4 | Identity + Platform | 4–5 | 2–2,5 мес |
| 5 | Conversation | ongoing | — |

Итого: **6–9 месяцев** до целевой топологии без `chat`/`message` split. Оценка зависит от того, сколько людей реально выделено; это не обещание.

### 10.2. Definition of Done для сервиса

- [ ] паспорт сервиса и ADR (если меняется граница);
- [ ] OpenAPI + JSON Schema событий, contract-тесты;
- [ ] SLO, дашборды, алерты, runbook, on-call;
- [ ] load test на целевом профиле;
- [ ] failover/chaos-тест;
- [ ] security review ( secrets, mTLS, least privilege, PII);
- [ ] миграция и rollback протестированы;
- [ ] документация и диаграммы обновлены;
- [ ] 7 дней без инцидентов, SLO в норме.

---

## 11. Чек-лист готовности к первой волне

- [ ] Kafka в prod, outbox lag p95 < 2 с;
- [ ] Redis cluster, rate limit и presence работают на 2+ узлах;
- [ ] per-service БД/роль, кросс-гранты запрещены;
- [ ] OpenAPI/события версионируются, CI валидирует;
- [ ] OTel-трейс проходит send → Kafka → consumer;
- [ ] шаблон сервиса собран и задеплоен в staging;
- [ ] SLO/алерты для пилота;
- [ ] owner и on-call назначены;
- [ ] rollback-учения проведены.

Если хотя бы один пункт не выполнен — Wave 1 не начинается. Это дешевле, чем откатывать полуразделённый `realtime`.

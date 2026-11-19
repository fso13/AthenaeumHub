# E2EE-PILOT-2 — durable retry/drain (#30)

> **Зона:** только `frontend/**`. Не изменялись `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `src/api/schema.d.ts`, base-флаги. Крипто-ядро, KAT, wire v1 и
> `Idempotency-Key`-контракт не ослаблялись. Base `VITE_E2EE_ENABLED=false` /
> `KRUG_E2EE_ENABLED=false`; overlay включался только на время F7B и затем снят.
>
> **Вход:** `docs/E2EE-REVIEW-13.md` (условие 3, P2-16/P2-21), `src/e2ee/outbox/**`,
> `src/e2ee/app/chatBridge.ts`, `src/e2ee/app/resetRetry.ts`, `src/store/chatStore.ts`,
> `src/e2ee/outbox.test.ts`, `chatBridge.test.ts`, `E7-F8D-REPORT.md`, `E7-F7B-REPORT.md`.

## 1. Итог

`#30 durable retry/drain` реализован и покрыт committed-тестами.

- pending/failed replacement’ы переживают reload и **автоматически** дозавершаются
  durable worker’ом с persisted exponential backoff и single-flight;
- ambiguous POST (сервер принял, ответ потерян) разрешается сначала поиском серверной
  строки по `client_message_id`, затем replay’ем **того же** `Idempotency-Key`; дубликат
  не создаётся;
- `confirmSent` replacement’а **в той же IndexedDB-транзакции** помечает оригинал
  `superseded`/`supersededAt`, поэтому сбой отдельного `markSuperseded` больше не теряет
  replacement и не воскрешает оригинал;
- повторный `markOutboxSuperseded` идемпотентен по timestamp; `retryOutboxEntry` не
  поднимает оригинал, у которого уже есть replacement;
- на load/chat switch выполняется идемпотентный reconcile: лечит потерянный
  `confirmSent → markSuperseded`, дедуплицирует replacement’ы, удаляет failed-сессию
  только когда все её replacement’ы подтверждены;
- в outbox хранится durable retry-intent (только метаданные: session id, публичный
  chain DH, `n`, reason, anchor client id); после reload восстанавливается явный
  `retry_pending` UI (счётчик + кнопка «Повторить переотправку»);
- R-15-окно больше не перешифровывает оригинал, пока его replacement pending/failed:
  окно сообщает `pendingReplacements`, а store сначала drain’ит точные байты.

**Статус #30: DONE.** Условие 3 REVIEW-13 закрыто. Остальные условия пилота
(2, 4–10) остаются открытыми и в эту задачу не входят.

## 2. Изменения по слоям

### 2.1. Durable state machine — `src/e2ee/outbox/types.ts`, `outboxStore.ts`

Добавлены durable-поля outbox-строки (не secret):

| Поле              | Смысл                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `sendOrder`       | уже существующий durable порядок; теперь валидируется на чтении          |
| `supersededAt`    | уже существующий маркер; валидируется и идемпотентен по timestamp        |
| `retryOfClientId` | top-level зеркало sealed payload для атомарного supersede                |
| `nextAttemptAt`   | persisted deadline backoff’а; `null` = не запланировано / permanent fail |
| `lastAttemptAt`   | время старта последней durable-попытки                                   |

`decryptOutboxEntry` fail-closed проверяет эти поля (integer/timestamp/UUID, согласованность
top-level `retryOfClientMessageId` с payload). Legacy-строки без top-level поля читаются по
payload и лечатся reconcile’ом.

Ключевые переходы:

- `markOutboxAttempt` — pending/failed → pending, `attempts+1`, `lastAttemptAt`,
  `nextAttemptAt=null`; `sent`/`superseded` терминальны; не-due строка не стартует.
- `markOutboxSent` — replacement → `sent` и **атомарно** `supersedeOriginalInTransaction`
  (оригинал pending/failed → `superseded`, уже `sent` → `sent + supersededAt`; local copy
  всегда `superseded`).
- `markOutboxFailed` — `failed`, persisted `nextAttemptAt = now + backoff(attempts)` для
  retryable-кодов (или `Retry-After`); permanent-ошибка получает `nextAttemptAt=null`.
- `markOutboxSuperseded` — повторный вызов не переписывает `supersededAt`.
- `retryOutboxEntry` — только failed и только если у строки **нет** replacement-строки.

Backoff: `2s * 2^(attempts-1)`, cap `5 min`, детерминированный (single-flight делает
thundering herd маловероятным; тесты не флакают). Retryable-коды включают network/timeout,
5xx, 429/rate limit и `IDEMPOTENCY_IN_PROGRESS`; store также принимает явный
`retryable` из `ApiError.isRetryable`.

### 2.2. Drain / reconcile — `src/e2ee/outbox/outboxStore.ts`

- `listDrainCandidates` — pending + due retryable failed, по `sendOrder`; исключает
  `sent`/`superseded`, не-due и **оригиналы, у которых уже есть replacement**.
- `outboxRetryStatus` — durable агрегат на чат: `pending`, `permanent`, `nextAttemptAt`.
- `reconcileOutbox` — идемпотентный проход:
  - sent replacement всегда суперсидит оригинал;
  - у оригинала остаётся не более одного live replacement (lowest `sendOrder`/sent);
  - возвращает failed-сессии, у которых все replacement’ы `sent`/`superseded`.
- `drainOutbox`:
  - внутри `krug-outbox` lock (single-flight между вкладками; fallback — best effort);
  - batch limit `20` (продолжение следующим проходом);
  - перед replay’ем строки с `attempts>0` вызывает `lookup(entry)`;
  - при ошибке классифицирует код и persist’ит backoff;
  - crash после POST → строка остаётся pending; следующий проход повторяет тот же key.
- Retry-intent: `putRetryState` / `listRetryStates` / `deleteRetryState` в том же
  object store `outbox` под префиксом `retry:`; только метаданные, без plaintext/ключей.

### 2.3. Bridge — `src/e2ee/app/chatBridge.ts`

Новые методы (без network в bridge, как и раньше):

- `saveRetryState` / `clearRetryState`;
- `reconcileRetryState(chatId?)` — reconcile outbox + удаление failed-сессии и intent’а,
  когда все replacement’ы подтверждены; возвращает `E2eeRetryStatus[]` с durable retry;
- `drainOutbox(send, options)` — обёртка над storage drain с lazily созданным outbox-lock;
- `markAttempt`.

`handleReset` при `pendingReplacements>0` возвращает `pending` с пустыми candidates,
**не удаляя** failed-сессию. `finishReset(completed)` удаляет и сессию, и retry-intent.

### 2.4. Store/UI — `src/store/chatStore.ts`, `src/components/E2eeBanner.tsx`

- `drainE2eeOutbox(chatId?, {force})` — single-flight в store + bridge lock; POST
  собран из точных stored envelopes и stored `Idempotency-Key`; ambiguous lookup через
  `GET /chats/{id}/messages?limit=100` по `client_message_id`.
- `resumeE2eeRetries(chatId?)` — вызывается после `initialize`, `loadChat`,
  `setActiveChat` и после failed/partial batch: reconcile, drain due-строк, восстановление
  `pendingResets` и явного retry-UI, до-пере-шифровка оставшегося окна только когда
  durable outbox чист.
- `scheduleE2eeDrain` — точный persisted deadline (без busy-loop).
- `reconcileE2eeRetries` — записывает durable `retryPendingCount`/`resetProgress` и
  убирает optimistic failed-строки, которые drain уже подтвердил (ambiguous POST).
- `handleIncomingReset`: сохраняет retry-intent **до** первого replacement’а; при
  candidates=[] и pending replacement’ах не шифрует заново, а запускает drain; после
  `confirmSent` вызывает идемпотентный `markSuperseded` в try/catch (сбой не делает
  доставленный replacement «failed»); на ошибке пишет retryable-код в outbox.
- `retryPendingReset` сначала force-drain’ит durable outbox, затем re-drive’ит окно.
- `E2eeBanner`: состояние `retryPendingCount` теперь имеет кнопку «Повторить
  переотправку» (тот же `onRetryReset`).

## 3. Тесты

Новые committed-тесты (+13 к базовым 852 → **865**):

`src/e2ee/outbox.test.ts` (+9):

1. `confirmSent` replacement’а атомарно суперсидит оригинал без `markSuperseded`
   (сбой follow-up не теряет replacement и не воскрешает оригинал).
2. `markOutboxSuperseded` идемпотентен по timestamp для pending и sent.
3. reconcile лечит потерянный `confirmSent → markSuperseded` и идемпотентен.
4. drain pending replacement после reload тем же `Idempotency-Key`, без повторного
   шифрования.
5. ambiguous POST: сервер принял, ответ потерян → следующий проход находит строку
   lookup’ом, POST’ов ровно один, дубликата нет.
6. persisted exponential backoff: не-due строка пропускается, due — отправляется.
7. permanent failure не auto-retry, но доступен для явного retry.
8. partial batch: drain’ится только pending replacement, sent replacement не повторяется.
9. retry-intent survive/clear, в storage нет plaintext.

`src/e2ee/app/resetRetry.test.ts` (+2):

- R-15-окно с pending replacement: `pendingReplacements=1`, candidates пусты; после
  подтверждения replacement окно `empty` (никакой повторной перешифровки).
- pure-selector: replaced-original исключён, pending replacement репортится.

`src/e2ee/app/chatBridge.test.ts` (+1):

- retry-intent + reconcile: failed-сессия жива, пока replacement pending; после
  `confirmSent` reconcile возвращает completed, удаляет сессию и intent.

`src/store/e2eeChat.test.ts` (+1):

- reload: второй store с тем же durable bridge/outbox восстанавливает
  `retryPendingCount=1`, `resetProgress.status='failed'`; replacement не потерян и не
  перешифрован.

Проверки:

```
npm run check        # EXIT 0
# lint/format/contract/stickers/security/session-writers: ok
# vitest: 81 files / 865 tests passed
# tsc --noEmit: clean; vite build: 445 modules
```

KAT/crypto не менялись: `vectors.test.ts`, `kStorageKAT.test.ts`, `sessionKAT.test.ts`
входят в 865.

## 4. F7B (real two-device E2EE)

Собран test-only overlay из этого дерева и прогнан реальный сценарий:

```bash
cd deploy
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml build frontend
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --no-deps --force-recreate backend frontend
```

| Проверка         | Результат                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| image            | `sha256:e0d80c8bcb50a4aa9524fe4b473f9395b844942d251b453964cdb6a51b989f8d`                             |
| image created    | `2026-11-18T14:45:25Z`                                                                                |
| SPA asset        | `assets/index-lPWgvzO0.js`, sha256 `f4682101e5e83f315d406229d38b484dfeb9f54e4bcc0967c8949a8a6dec8f4e` |
| asset E2EE flag  | `VITE_E2EE_ENABLED:"true"`                                                                            |
| F7B              | **2 passed (20.6 s)**: chromium 8.7 s, firefox 9.8 s                                                  |
| backend flag run | `KRUG_E2EE_ENABLED=true` (только overlay)                                                             |

F7B прошёл keyed registration/prekeys, A↔B send/decrypt, reload, R-15, safety number,
envelopes-only DB и no-plaintext в DB/WS/backend-логах. Fault injection ambiguous POST /
`markSuperseded` failure в F7B не добавлялся (эти ветки покрыты unit-тестами; реальный
сбой IndexedDB/сети в браузере не инсценировался).

Стенд возвращён в base:

```
KRUG_E2EE_ENABLED=false
frontend image sha256:6825881327f42475e884bad686782ec1108a6fd4e6231d720f10c1e2a66493dd
asset: VITE_E2EE_ENABLED:"false"
/api/v1/health: 200
```

Побочные эффекты прогонов: overlay rebuild/recreate контейнеров; F7B создал тестовый
workspace/устройства в одноразовой БД (как и предыдущие прогоны F7B). Base-флаги и
compose-файлы не изменялись.

## 5. Остаточные риски / ограничения

1. Retry-intent — **незапечатанные метаданные** (session id, публичный DH, reason,
   client id) в object store `outbox` под `retry:`. Plaintext/ключей там нет; локальный
   tamper может только удалить intent (доступ к IndexedDB вне threat model E2EE).
2. Ambiguous lookup ограничен последними 100 сообщениями чата (`limit=100`). Если
   idempotency-запись истекла **и** строка старше окна, replay идёт с тем же
   `Idempotency-Key`/`client_message_id`; уникальность на сервере по-прежнему
   предотвращает дубль, но это опирается на серверный контракт.
3. Backoff детерминированный, без jitter. Single-flight (store + `krug-outbox`) делает
   параллельные проходы маловероятными; для multi-tab fallback-lock остаётся best effort.
4. Permanent-ошибки (4xx/validation) не retry’ятся автоматически — нужен явный retry.
5. Store re-drive’ит оставшееся R-15-окно на init/load/chat switch; отдельного
   периодического глобального сканера нет.
6. Receiver-side R-15 v1.1 (дедуп по `retry_of_client_message_id` в inner TEXT) не
   реализован: получатель после reload может показать оригинал и replacement. Это
   sender-side durable retry, а не решение условия 5.
7. Условия REVIEW-13, не входящие в #30, остаются открытыми: clean-stack fixture (2),
   negative key-change/TOFU live (4), receiver v1.1 (5), Safari/iOS UI (6), векторы (7),
   release-CI/git (8), legacy-миграция (9), kill-switch/rollout (10). Mutation-check
   «тесты падают на pre-F8C алгоритме» для новых durable-полей не выполнялся (старый код
   не содержит этих полей; committed regression фиксирует новую семантику).
8. Git/CI в workspace нет: единственный автоматический барьер — committed unit-тесты и
   F7B-прогон, зафиксированный в этом отчёте.

## 6. Файлы

Изменены (только `frontend/**`):

- `src/e2ee/outbox/types.ts`, `src/e2ee/outbox/outboxStore.ts`;
- `src/e2ee/app/chatBridge.ts`, `src/e2ee/app/resetRetry.ts`, `src/e2ee/app/types.ts`;
- `src/store/chatStore.ts`, `src/components/E2eeBanner.tsx`;
- `src/test/e2eeBridgeFake.ts`;
- тесты: `src/e2ee/outbox.test.ts`, `src/e2ee/app/resetRetry.test.ts`,
  `src/e2ee/app/chatBridge.test.ts`, `src/store/e2eeChat.test.ts`.

Новый: `frontend/E2EE-PILOT-2-REPORT.md` (этот файл).

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`, `schema.d.ts`,
base-флаги, compose-файлы, crypto/KAT/vectors.

---

**Статус #30: DONE.** Durable retry/drain, атомарный supersede, ambiguous-POST
разрешение, reload-восстановление retry-UI и committed regression — выполнены;
`npm run check` EXIT 0 (865 тестов), F7B 2/2 на overlay-образе, base-стек восстановлен
(`KRUG_E2EE_ENABLED=false`). Оставшиеся условия G4e-пилота (2, 4–10) — открыты и
относятся к следующим задачам, не к #30.

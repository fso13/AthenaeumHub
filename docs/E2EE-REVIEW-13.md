# E2EE-REVIEW-13 — G4e re-review после E7-F8C

> **Рецензент:** независимый security/crypto-ревьюер; в E7-F8C не участвовал.
> **Дата:** 2026-11-18. **Вход:** `docs/E2EE-REVIEW-12.md`, `docs/E2EE-REVIEW-11.md`,
> `docs/E2EE-REVIEW-10.md`, `docs/E2EE-REVIEW-09.md`, `frontend/E7-F8C-REPORT.md`,
> `frontend/e2e/e2ee.real.spec.ts` (reload-A/`markerLost`), `frontend/src/e2ee/app/resetRetry.ts`,
> `frontend/src/e2ee/outbox/outboxStore.ts` (`commitOutgoingMessage`, `sendOrder`,
> `markOutboxSuperseded`), `frontend/src/e2ee/outbox/types.ts`, `frontend/src/e2ee/app/resetRetry.test.ts`,
> `frontend/src/store/chatStore.ts` (R-15 retry), фактический образ/контейнер, живая БД и логи.
> **Зона:** создан только этот файл. Временный test-only harness (unit-уровень на production-модулях)
> создавался вне production-кода и удалён после прогона; код, контракты, спека, векторы, `docs/TASKS*`
> не изменялись. Git-репозитория в workspace нет, поэтому one-PR/diff по-прежнему не проверяем.
> Побочные эффекты прогонов: F7B добавил 2 workspace/4 device и отозвал устройства fixture-пользователей;
> `test-results/.last-run.json` перезаписан Playwright. Контейнеры остаются flag-on overlay.

## Вердикт

**GO WITH CONDITIONS — только для пилота Chromium/Firefox. Безусловный/base flag-on — NO-GO.**

P0 не найдено. P1-01c и P1-05 **в коде исправлены** и независимо воспроизведены на
production-модулях (test-only harness 5/5): superseded-якорь больше не теряется, а окно
строится по durable `sendOrder`, а не по per-chain `header.n`. F7B независимо прошёл **2/2**
(Chromium 7.8 s, Firefox 8.6 s) на образе `sha256:ccf7e985…`; full frontend — **757/757**;
`tsc`, eslint и prettier по изменённым F8C-файлам зелёные.

Но **F8C не добавил ни одного committed regression-теста**, хотя отчёт утверждает обратное:
`resetRetry.test.ts` не менялся с F8B (mtime 14:27:01 против 14:42:47–53 у F8C-файлов), а
единственный partial-batch тест — та же одна DH-цепочка, на которой **старый** (pre-F8C)
алгоритм тоже даёт `['second']`. То есть оба release-blocking фикса держатся только на
ревьюерском harness, но не на CI/committed-тестах. Ни одно из условий включения (ниже, 1–10;
в REVIEW-12 — 1–11) не закрыто полностью: P1-01c/P1-05 исправлены в коде, но условие 1
(committed regression) не выполнено; 2–10 открыты. Пилот — после 1–3; base flag-on — после
всех 1–10. Safari/iOS — отдельный gate (условие 6).

## P0

**Открытых P0 нет.**

F8C меняет только `outbox/types.ts` (`sendOrder?`), `outboxStore.ts` (`commitOutgoingMessage`,
`decryptOutboxEntry`) и `resetRetry.ts` (`bySendOrder`, anchor-lookup); крипто-ядро, wire,
контракты и серверные проверки не тронуты. Повторно проверены классы P0:

| P0-класс | Результат | Доказательство |
|---|---|---|
| Plaintext E2EE-строк на сервере | нет | независимый F7B: последний workspace `f3c22d15-cd67-42b2-b2db-737c04857339` — 6 messages / 6 envelopes, все `E2EE_PAIRWISE`, `body_ciphertext IS NULL`, `content_meta='{}'`, 0 не-E2EE строк; F7B SQL: 0 вхождений `markerA`/`markerB`/`markerR15` в `row_to_json` (`e2ee.real.spec.ts:978-985`; `markerLost` в этот запрос не входит — P2-20); мой SQL: 0 не-E2EE строк |
| Plaintext/ciphertext в логах/WS | нет | F7B сканирует WS-кадры и backend logs in-memory; мой `docker logs --since 10m` по backend/frontend: 0 вхождений `f7b_`/маркеров |
| Конверты чужих устройств / `X-Device-Id` | не переоткрыто | F8C не менял `ApiRequestPath`/`DeviceBindingFilter`; F7B идёт реальным keyed-flow |
| 512 KiB / floor 272 B / canonical b64u | держится | live envelopes — 272..272 B (6 шт.); `ck_envelopes_ciphertext_min.convalidated=t` на parent и всех partitions (4 constraint-row); `envelope.test.ts:183-197` требует минимум 272 B |
| RLS/tenant boundary | держится | `relforcerowsecurity=t` для `message_envelopes` и `key_verifications`; не менялось |
| Nonce/MK reuse в store | не найден | F8C не трогал крипто-ядро; full unit suite 757/757, включая KAT/session-store |
| KAT/tamper ядра | зелёные | full 757/757 (KAT/tamper входят); F7A не перезапускался, т.к. крипто-ядро не менялось — ограничение evidence, не регрессия |
| Type/schema drift | нет | `sendOrder?` в stored-типе и `sendOrder: number` в decrypted-типе; `npx tsc --noEmit` exit 0; eslint/prettier по F8C-файлам чистые |

Почему найденные дефекты — не P0: plaintext/ключи не утекают, sealed copies остаются,
конфиденциальность не ломается. Остаются доставка/целостность (пропуск/дубликат replacement)
и evidence-полнота, поэтому это release-blocker для flag-on, а не P0.

## P1 closure

| ID | Статус после E7-F8C | Независимый результат |
|---|---|---|
| **P1-01a** Reload-дубль после R-15 | **CLOSED** | F8B-семантика не менялась; E2E `:869-891` требует ровно один `markerA`/`markerLost`/`markerR15`; F7B 2/2 прошёл эту проверку. `copyView` (`chatStore.ts:2042-2053`) скрывает `superseded`-копию. |
| **P1-01b** Повторная перешифровка заменённого | **CLOSED (normal path)** | `selectRetryWindow` исключает `superseded`/`supersededAt`-строки (`resetRetry.ts:239-245`); committed same-chain тест `resetRetry.test.ts:174-218` даёт `['second']`. Error-path остаётся P2-16. |
| **P1-01c** Superseded anchor → `anchor_unknown` | **FIXED (runtime) / EVIDENCE OPEN** | Якорь ищется по **полному** списку до фильтра (`:214-237`), окно строится от него с пропуском superseded (`:239-245`). Harness: cross-chain partial batch → `pending ['second']`; pre-F8C симуляция → `anchor_unknown`. Committed regression отсутствует. |
| **P1-01 overall** | **FIXED (runtime) / PARTIAL (committed evidence)** | P1-01a/b/c закрыты в коде; P2-15 закрыт; committed-тестов на cross-chain/partial-batch нет. |
| **P1-05** Cross-chain порядок окна | **FIXED (runtime) / EVIDENCE OPEN** | `sendOrder` назначается при commit (`outboxStore.ts:702-711`), читается (`:874`), сортировка (`resetRetry.ts:187-193`). Harness: `[1,2,3,4]`; окна `['second','third','fourth']` и `['third','fourth']`. Committed regression отсутствует. |
| **P1-02** Verification/safety number | **CLOSED** (без изменений) | Код/тесты/F7B из E7-F8; F8C не трогал. Live negative key-change остаётся P2-07/условием 4. |
| **P1-03** Sync/resume-gap catch-up | **CLOSED** (без изменений) | `runSync().catchUp`/`resume.gap` → `decryptE2eeSlice`; F7B проходит reset без обязательного `R15_CATCH_UP_RELOAD`. Узкий race «E2EE state ещё не ready» остаётся P2. |
| **P1-04** WebKit runtime floor | **CLOSED для runtime; P2 для app-level UI/CI** | F7A 12/12 из REVIEW-11/12 (не перезапускался, crypto не менялся); WebKit expected-unsupported; password-bootstrap UI — P2-11, матрица не в release-CI — P2-08. |
| **P2-10** F7B evidence на финальном образе | **CLOSED** | Образ `sha256:ccf7e985…` и asset `index-cfIpRIA1.js` `4a766968…` воспроизведены; F7B 2/2. |

### P1-01c. Superseded anchor больше не исчезает до anchor-lookup

**Механика (production-путь).**

1. `selectRetryWindow` строит `all` без фильтра статуса (`resetRetry.ts:214-223`), сортирует по
   `sendOrder` и только затем ищет якорь по `retryOfClientMessageId` (`:227-235`).
2. Если якорь — `sent`+`supersededAt` (типичный partial batch: первый replacement уже принят),
   он остаётся в `all`, `findIndex` находит его позицию. Fallback `(failed_chain_dh, failed_n)`
   (`:230-235`) применяется только если id реально не найден.
3. `window = all.slice(anchorIndex).filter(status !== 'superseded' && supersededAt == null)`
   (`:239-245`) — заменённые строки не переотправляются, но и не «съедают» якорь.
4. `chatBridge.handleReset` удаляет failed-сессию только на `anchor_unknown`/`empty`
   (`chatBridge.ts:871-880`); на `pending` он добавляет сессию в `resettingSessions` (`:885`)
   и возвращает кандидатов. `chatStore` кладёт reset в `pendingResets` и выставляет
   retry-UI (`chatStore.ts:2248-2259`), т.е. в этом сценарии сессия не удаляется и UI не
   очищается.

**Репро (test-only harness на production-модулях, удалён; 5/5 passed).**

```
A/B registered; first: session S, chain C1, n=0
B decrypts first, replies; A receives reply -> DH ratchet
second: same session S, chain C2, n=0
markOutboxSent(first); markOutboxSuperseded(first)
reset: failedSessionId=S, failedChainDh=C1, failedN=0,
       retryOfClientMessageId=first.clientMessageId
current selectRetryWindow -> {status:'pending', candidates:['second']}
pre-F8C simulation        -> ['<anchor_unknown>']
```

Повторный вызов `selectRetryWindow` с тем же reset даёт ровно `['second']` (кандидат не
дублируется); `anchorRow.status='sent'`, `supersededAt` — число. То есть «второе pending-
сообщение переотправляется один раз, без `anchor_unknown`» выполнено. **Ограничение:** это
доказано reviewer-harness’ом; committed-теста нет.

### P1-05. Durable `sendOrder` вместо per-chain `header.n`

`commitOutgoingMessage` под `readwrite`-транзакцией сканирует существующие outbox-строки,
берёт максимум `sendOrder` и пишет `max+1` (`outboxStore.ts:702-711`). Поле durable
(в `StoredOutboxEntry`, `types.ts:47-48`), переживает `markOutboxSent`/`Failed`/`Superseded`
(они делают spread stored-записи) и читается как `stored.sendOrder ?? 0` (`:874`).
`bySendOrder` (`resetRetry.ts:187-193`) сортирует по нему, `header.n` в порядке больше не
участвует.

**Репро (test-only harness, детерминированные `createdAt`).**

```
first  C1 n=0 (t0)
second C1 n=1 (t1)
B decrypts both, replies; A receives reply -> ratchet
third  C2 n=0 (t3)
fourth C2 n=1 (t4)
A outbox sendOrder = [1,2,3,4]
```

| Запрос | pre-F8C (симуляция) | current |
|---|---|---|
| anchor=`second` | `['second','fourth']` — `third` потерян | `['second','third','fourth']` |
| anchor=`third` | `['third','second','fourth']` — `second` (до якоря) дублируется | `['third','fourth']` |
| anchor=`second`, `maxBatch=2` | — | `['second','third']`, `remaining=1` |

Оба pre-F8C результата воспроизведены faithful-симуляцией старого алгоритма (фильтр
superseded до anchor-lookup + сортировка по `header.n`), поэтому это не «теория»: старый
код действительно даёт потерю/дубликат, новый — нет.

**Legacy/ same-ms.** `sendOrder` не бэкфиллится: у pre-F8C строк поле отсутствует → 0, и
сортировка падает на `createdAt`/`clientMessageId`. Для новых строк `sendOrder` уникален и
снимает same-ms tie; для legacy-строк с одинаковым `createdAt` порядок снова не-тотальный
(кандидаты могут начаться не с якоря при fallback без id). Это P2-17/условие 10, не
production-дефект при base-флаге false. Дополнительно: старый открытый таб (pre-F8C SPA)
после деплоя может писать строки без `sendOrder` (0) уже после новых; такие строки сортируются
до новых якорей. Multi-tab/stale-version риск — в «Остаточных рисках».

### Что F8C не сделал: committed regression отсутствует

Это главный дефект F8C, и он release-blocking по условиям 1–3 REVIEW-12.

- `frontend/src/e2ee/app/resetRetry.test.ts` mtime **14:27:01**, F8C-файлы —
  **14:42:47–14:42:53**, образ — **14:43:51**. Тест-файл F8C не менял.
- Единственный partial-batch тест (`resetRetry.test.ts:174-218`) использует `first`/`second`
  **одной** DH-цепочки (`n=0,1`). Pre-F8C алгоритм на нём: `first` отфильтрован, anchor по id
  не найден, chain-fallback находит `second` (n=1 >= 0) → `['second']`. Тест **зелёный и на
  старом коде**; P1-01c он не ловит.
- Cross-chain/ratchet теста нет ни в `resetRetry.test.ts`, ни в `outbox.test.ts`, ни в
  `chatBridge.test.ts` (grep по `selectRetryWindow`/`sendOrder`).
- Full suite остаётся **757/757** — ровно как в REVIEW-12; если бы F8C добавил regression,
  счёт вырос бы (или отчёт должен был объяснить замену тестов).
- F7B не инжектирует сбой отправки и не создаёт partial batch; его R-15-окно — одно
  сообщение/одна цепочка, поэтому P1-01c/P1-05 им не покрываются.

Следствие: заявление отчёта «Regression: partial-batch test + cross-chain ordering covered
by `sendOrder`» **не подтверждается деревом**. Коммит-тесты — единственный автоматический
барьер (git/CI нет), поэтому следующий рефакторинг снова откроет P1 незаметно. Это условие 1.

### P1-02/P1-03/P1-04

Без изменений: F8C не трогал verification, sync/catch-up, WebKit runtime. Full 757/757
включает соответствующие тесты; F7B 2/2 подтверждает keyed-flow и reset. F7A не
перезапускался (crypto не менялся) — ограничение evidence, отмечено в P0-таблице.

## P2

### P2-15. Committed E2E reload-A — CLOSED

`e2ee.real.spec.ts:869-891` после R-15 перезагружает A и требует ровно один `markerA`,
`markerLost`, `markerR15`; F7B 2/2 прошёл. Повторная проверка `markerR15` (`:886-891`)
дублирует цикл `:878-885`; безвредно, но лишнее.

### P2-16. Расщеплённое состояние / error-path — PARTIAL

F8C не добавлял copy-status guard и не менял `markOutboxSuperseded`. Остаётся:

- `decryptOutboxEntry` (`outboxStore.ts:820-834`) валидирует `createdAt`/`updatedAt`, но не
  `supersededAt`/`sendOrder`; локальный tamper может обнулить маркер или подменить порядок
  (поля читаются как есть, `:874-875`).
- Повторный `markOutboxSuperseded` для `sent`-строки перезаписывает `supersededAt` новым
  `now` (семантика статуса идемпотентна, timestamp — нет); теста на двойной вызов нет.
- Если `markSuperseded` упадёт после `confirmSent`, оригинал останется без маркера; следующий
  retry снова перешифрует заменённое → дубликат.
- **Ambiguous POST:** если сервер принял replacement, а ответ потерян, `confirmSent`/
  `markSuperseded` не выполняются; replacement остаётся `pending` в outbox, оригинал — без
  маркера. Следующий reset перешифрует оригинал с **новым** `client_message_id`; production
  не вызывает `drainOutbox` (он импортируется только тестами), поэтому старый pending не
  переотправляется по idempotency-key, а создаётся второй replacement → дубликат у B
  (receiver-дедуп v1.1 отсутствует). Это не введено F8C, но остаётся release-риском.

Рекомендация: при выборе кандидата пропускать `copy.status === 'superseded'`; валидировать
`supersededAt`/`sendOrder`; сделать `markOutboxSuperseded` идемпотентным по timestamp;
перед перешифровкой drain’ить pending replacement по его idempotency-key (или явно принять
риск).

### P2-17. Legacy-состояние не мигрируется — OPEN (расширен)

Pre-F8A (outbox `sent`, copy `sent`), pre-F8B (`sent`, copy `superseded`, без `supersededAt`)
и pre-F8C (`sendOrder` отсутствует) не бэкфиллятся. Для pre-F8B `selectRetryWindow` не
исключает запись по copy-статусу, а `lookupLocalCopy` возвращает текст без проверки статуса
копии (`outboxStore.ts:1187-1215`) → повторная перешифровка и дубликат. Для pre-F8C
`sendOrder=0` и same-ms fallback (см. P1-05). Harness подтвердил: строка с `copy.status=
'superseded'` без `supersededAt` всё ещё попадает в окно (`['first','second']`). Base-флаг
false и production-копий нет, поэтому это условие 10/пилотная миграция, а не текущий
production-дефект.

### P2-18. Неполнота store/regression-тестов — OPEN

F8C не добавил ни одного теста. По-прежнему нет: cross-chain partial batch; `sendOrder`
(назначение, монотонность, legacy=0, same-ms); `supersededAt` для `sent`; идемпотентности
двойного `markOutboxSuperseded`; `SPK_DELETED`/`DECRYPT_FAILED` copy-restore; счётчиков
`remaining/skipped`; bridge-проверки «failed-сессия не удалена, retry-UI не очищен».
P2-14 остаётся PARTIAL.

### P2-19. Устаревшие комментарии в `resetRetry.ts` — NEW

Шапка `resetRetry.ts:8-13` до сих пор утверждает, что «F4 outbox хранит точный send order в
`createdAt`», а `:168-172` — что «локальный порядок — это `header.n`» и что per-envelope
header в outbox не сохраняется. После F8C это неверно (есть durable `sendOrder` и
`failedEnvelope`/`matchesFailedChain` по сохранённым envelopes). Такие комментарии — ровно
тот механизм, который породил P1-05; их надо привести к коду вместе с regression-тестами
(условие 1).

### P2-20. F7B DB plaintext scan не включает `markerLost` — NEW

`e2ee.real.spec.ts:978-985` ищет в `row_to_json` только `markerA`/`markerB`/`markerR15`;
`markerLost` проверяется в WS/логах (`:911-916`) и в UI, но не в DB-скане. Практический риск
низок (whole-chat invariant `:959-975` и `body_ciphertext IS NULL`), но полнота evidence
страдает. Добавить `markerLost` в оба DB-запроса.

### P2-21. Retry-состояние только в памяти; pending replacement не drain-ится — NEW

`pendingResets`/`retryPendingCount`/`resetProgress` живут в памяти store
(`chatStore.ts:2248-2259, 2344-2348`), `drainOutbox` в production не вызывается. Если batch
упал (сеть/сервер) и пользователь перезагрузил A, retry-UI исчезает, а pending replacement
остаётся в outbox без worker’а; следующего reset может не быть, т.к. B уже не получает
недоставленное. Детерминированная часть P1-01c исправлена (окно находится), но «no silent
drop» после reload остаётся частичным. Это P2 для пилота и условие 3 для flag-on.

### Остальные P2 из REVIEW-12 (статус)

| ID | Статус | Комментарий |
|---|---|---|
| P2-01 Чистый стек F7B | **OPEN** | Снова leftover `pickle-ui-1794919305193@krug.local`/`test@krug.local`; B не регистрируется через BFF/Mailpit; fixture user должен существовать (`e2ee.real.spec.ts:205-207`). |
| P2-02 Destructive SQL по умолчанию | **OPEN** | `DB_CHECK=true`; `UPDATE auth.devices … REVOKED` (`:205-218`) без `E2EE_REAL_ALLOW_DESTRUCTIVE=1`. |
| P2-03 Накопление workspace/flag-on стек | **OPEN** | 68 → **72** `E2EE F7B` workspace и 327 → **335** devices; мой прогон +2/+4, остальное — F8C. `krug-frontend:latest` — overlay flag-on. |
| P2-04 Legacy incoming copies без `serverMessageId` | **OPEN** | `outboxStore.ts` incoming-lookup не менялся. |
| P2-05 `normative_invariants` векторов | **OPEN** | `docs/E2EE-TEST-VECTORS.json`: `vector_set_version=4`; `ciphertext_cap` — `16..33040` вместо `272..33040`; `reset_retry_window` описывает `retry_of_client_message_id` в inner payload и receiver-дедуп как реализованные, хотя спека §3.5.1/§5.5 (`docs/E2EE-SPEC.md:689-691`) называет их v1.1. |
| P2-06 `protectedSessionIds` в receive-реконсиляции | **OPEN** | `receive.ts` не менялся; `chatBridge` передаёт их только в `loadChat`. |
| P2-07 Negative key-change/TOFU live | **OPEN** | В `frontend/e2e` нет `KEY_CHANGE`; F8C fixture не добавлял. E2EE-AC-04 остаётся частичным. |
| P2-08 CI/checklist/git/log-capture | **OPEN** | `.github/` нет; `deploy/E2EE-ENABLE-CHECKLIST.md` нет; F7A/F7B не входят в `npm run check` (там lint/format/contract/security/test/build); git-репозитория нет. |
| P2-09 Kill-switch/retention/multi-node | **OPEN** | Не менялось; F8C не проверял flag-off kill-switch. |
| P2-11 WebKit UI в password-bootstrap | **OPEN** | `chatStore.ts:695-714` даёт общий session-error, а не `E2eeBanner`; не менялось. |
| P2-12 Runtime Ed25519 KAT только empty | **OPEN** | `ed25519Kat.ts:18-70` — RFC 8032 TEST 1 (empty); не менялось. |
| P2-13 Аттестация не привязана к показанному hash | **OPEN** | Не менялось. |
| P2-14 Evidence P1-01 | **PARTIAL** | `markerLost` E2E есть, F7B 2/2; cross-chain/partial-batch/store-тестов нет. |

## F7B/image evidence

Независимо, не по отчёту:

| Проверка | Результат |
|---|---|
| container image | `krug-frontend:latest`, ID `ccf7e985a4a4`, `sha256:ccf7e985a4a47ebd7c9442106ea42565d2564484e56f73529e6affd1d23385a7`, created `2026-11-18T11:43:51Z` (14:43:51 MSK) |
| container | `krug-frontend` запущен `2026-11-18T11:43:53Z`, healthy; backend `KRUG_E2EE_ENABLED=true` (overlay) |
| SPA asset | `assets/index-cfIpRIA1.js` SHA-256 `4a766968e48d8f0ff6534ef720d01d50f0d1514047c0f0dc2603affb4c1213df`; `browser-SszFYBqO.js` `5c95fbac…`; `realtime-CSsX8U-Q.js` `dae966ab…`; `index-DjrJ1d5m.css` `5d546356…`; `index.html` `d18a4591…` |
| E2EE flag in asset | asset содержит `E2EE_UNSUPPORTED_BROWSER`; F7B прошёл keyed registration/send, т.е. SPA действительно flag-on |
| reproducibility | независимый `npx vite build` с overlay-args (`VITE_E2EE_ENABLED=true`, `VITE_MEDIA_ORIGINS=http://localhost:9000`, остальные из `deploy/docker-compose.yml:290-303`) в отдельный outDir воспроизвёл **все пять** хешей (4 JS/CSS + `index.html`) |
| source mtimes | F8C-файлы `outboxStore.ts`/`types.ts` — 14:42:47, `resetRetry.ts` — 14:42:53, `resetRetry.test.ts` — 14:27:01, `e2ee.real.spec.ts` — 14:26:45; все **старше** image 14:43:51 (отчёт 14:44:20 — уже после image). Файлов новее image нет |
| base flags | `deploy/.env:44` — `false`; base `docker-compose.yml:275,304` — `${KRUG_E2EE_ENABLED:-false}`; `Dockerfile:19` default `false`; `true` только в `docker-compose.e2ee-test.yml:11,15` |
| F7B | независимо: **2 passed** — Chromium 7.8 s, Firefox 8.6 s (суммарно 16.4 s; два инвокации, т.к. Firefox в sandbox ревьюера требует `TMPDIR`/`CFFIXED_USER_HOME` внутри workspace, иначе `Could not find profile folder`; это окружение ревьюера, не продукт) |
| markerLost | проверка `:869-891` реальна: после reload A ровно по одному `markerA`/`markerLost`/`markerR15`; `markerLost` — заменённый оригинал |
| full frontend | `npx vitest run` — **72 files / 757 tests passed** (13.3 s); `npx tsc --noEmit` exit 0; eslint/prettier по F8C-файлам чистые |
| targeted | `resetRetry.test.ts` 9 + `outbox.test.ts` 31 + `chatBridge.test.ts` 11 + `store/e2eeChat.test.ts` 27 = **78 passed** |
| DB | 72 `E2EE F7B` workspace, 335 devices (REVIEW-12: 68/327); мой прогон +2/+4. Последний workspace `f3c22d15…`: 6 messages / 6 envelopes, 0 не-E2EE строк, `body_ciphertext IS NULL`, `content_meta='{}'`; ciphertext 272..272 B; 3 prekey-конверта; scheme `PAIRWISE_X3DH_DR` |
| DB constraints | `ck_envelopes_ciphertext_min.convalidated=t` на parent и всех partitions (4 constraint-row); `relforcerowsecurity=t`; live `octet_length(ciphertext)` 272..272 |
| logs | backend/frontend за прогон: 0 вхождений `f7b_`/маркеров |
| F7A | не перезапускался: F8C не менял crypto-ядро; full unit suite включает KAT/tamper. Это ограничение evidence, не регрессия |

**Что F7B доказывает и что нет.** Подтверждает реальный keyed-flow, ENVELOPES-only,
отсутствие plaintext в DB/WS/логах, reload-A без дубля по `markerLost` и привязку evidence
к финальному образу. Не покрывает: (a) partial batch/сбой отправки — P1-01c/P1-05; (b)
receiver-side R-15 v1.1-дубликат (B не перезагружается и не дедуплицирует replacement);
(c) чистое окружение — снова leftover-B и destructive SQL (P2-01/P2-02); (d) negative
key-change/TOFU live (P2-07). F7B’s DB plaintext scan не включает `markerLost` (P2-20).

## Условия включения

Флаг остаётся `false`, пока не выполнены все пункты; каждый проверяем.

1. **Committed regression для P1-01c/P1-05 (blocking).** Добавить в `resetRetry.test.ts`/
   `chatBridge.test.ts`/`outbox.test.ts`: (a) cross-chain partial batch: anchor C1
   superseded, pending C2 → `pending ['second']`, failed-сессия не удалена, retry-UI не
   очищен; (b) C1→C2: anchor `second` → `['second','third','fourth']`, anchor `third` →
   `['third','fourth']`, без сообщений до якоря; (c) `maxBatch`/`remaining`; (d) `sendOrder`
   назначается/монотонен/legacy=0; (e) двойной `markOutboxSuperseded` идемпотентен. Каждый
   новый тест должен **падать на pre-F8C алгоритме** (mutation-check, как в этом ревью).
   Исправить ложное утверждение в `E7-F8C-REPORT.md` и устаревшие комментарии
   `resetRetry.ts:8-13,168-172`.
2. **Clean-stack F7B fixture (blocking для пилота).** B регистрируется через BFF/Mailpit
   (уникальные email/пароль), а не leftover; SQL-reset требует явного
   `E2EE_REAL_ALLOW_DESTRUCTIVE=1` и проверки контейнера/БД; после прогона — cleanup/reset и
   возврат base-compose; Firefox в release-CI — без reviewer-sandbox workaround. Сейчас
   `krug-frontend:latest` — flag-on overlay-образ; base `up -d` без rebuild поднимет flag-on
   SPA с flag-off backend.
3. **Durable retry/drain (blocking для пилота).** Либо drain pending replacement по его
   `Idempotency-Key` перед перешифровкой оригинала, либо персистить reset-окно/retry-UI и
   явно принять, что после reload незавершённый batch не переотправляется. Иначе
   P2-16/P2-21 (ambiguous POST, markSuperseded failure, reload) дают дубликат или тихую
   потерю.
4. **Negative key-change/TOFU live + verified reset.** Test-only fixture легитимной ротации
   identity (валидная binding-подпись) или контролируемая SQL-мутация на одноразовом стенде:
   `KEY_CHANGE_DETECTED`, send blocked до accept, OPK не расходуется, сессия не
   перезаписывается, `verified` сброшен, после accept — re-verify; плюс L3b и multi-device E2E.
5. **Receiver R-15 v1.1.** Либо реализовать `retry_of_client_message_id` в inner TEXT и
   receiver-дедуп, либо явно принять продуктовое ограничение v1 «0 дублей не обещается» и
   убрать обещание из UI/AC/отчётов. Решение владельца продукта до flag-on.
6. **Safari/iOS + WebKit UI.** App-level WebKit E2E с `VITE_E2EE_ENABLED=true` в
   password-режиме: unsupported browser показывает понятный экран/баннер, keyed registration
   и send не выполняются; либо ADR-решение, что весь SPA недоступен. Shipping Safari/iOS —
   отдельный gate; не объявлять Safari в floor без прогона.
7. **Векторы.** Исправить `normative_invariants` (`272..33040`, v1.1-статус receiver-дедупа),
   bump `vector_set_version`; `vectors.test.ts` не должен принимать 271 B и «16..33040» и не
   должен считать receiver-дедуп v1 реализованным; пересчитать/зафиксировать KAT hash.
8. **Release-CI/артефакт.** F7A-матрица с явной политикой (Chromium/Firefox blocking,
   WebKit expected-fail) и F7B на чистом стеке в release-CI; `log-capture` на отсутствие
   ciphertext/plaintext; полный backend suite; `deploy/E2EE-ENABLE-CHECKLIST.md`; clean
   rebuild после финальных правок с фиксацией image digest + asset SHA-256; git/tag/patch-
   bundle (one-PR). P2-10 закрыт для `ccf7e985…`, но после правок по условиям 1–3 rebuild
   обязателен.
9. **Legacy/local state.** Миграция/бэкфилл: `sendOrder` для pre-F8C outbox (или явный
   запрет смешанного legacy-порядка), `supersededAt` для pre-F8B, guard по
   `copy.status==='superseded'`, incoming-копии без `serverMessageId`/`client_message_id`
   (P2-04). Либо документированное принятие + переустановка pilot-устройств.
10. **Kill-switch/retention/rollout.** Проверить flag-off kill-switch (REST/WS/replay 409,
    `server_last_seq` не теряет seq), retention envelopes/quarantine, rate limits,
    demo/test users, отключение dev-session; сначала E2EE-workspace pilot на Chromium/Firefox,
    затем общий flag-on; Safari — отдельно.

Условия 1–3 — до пилота; 4–10 — до общего flag-on. После любого изменения
крипто-adjacent кода — rebuild образа, F7B 2/2 на чистом стеке и full 757.

## Остаточные риски

- **P2-16 ambiguous POST:** сервер принял replacement, ответ потерян → следующий reset
  перешифрует оригинал с новым `client_message_id`; receiver-дедупа v1.1 нет → дубликат у B.
  Production не drain’ит pending replacement.
- **P2-16 markSuperseded failure:** ошибка IndexedDB после `confirmSent` оставляет оригинал
  без маркера → следующий retry снова перешифрует заменённое.
- **P2-21 reload после failed batch:** `pendingResets`/retry-UI в памяти; pending replacement
  не drain-ится; B не получает недоставленное, пока не придёт новый reset.
- **P1-05 legacy:** pre-F8C строки с `sendOrder=0` и same-ms `createdAt` снова дают
  не-тотальный порядок; pre-F8A/F8B состояние без миграции (P2-17). Stale old tab может
  писать строки без `sendOrder` после деплоя.
- **Receiver-side R-15 v1.1:** B без маркера в TEXT не может сопоставить старый и новый
  client id; после reload B может показать оригинал и замену. В v1 не обещается.
- **TOFU-окно:** первый контакт уязвим; safety number — единственный независимый канал;
  attestation `verified` per-device, но серверный флаг не доказательство.
- **Malicious server replay:** legacy incoming copies без `serverMessageId` могут показать
  старый текст под новым `message.id` (P2-04); для новых копий binding есть.
- **WebKit/Safari:** runtime gate блокирует, но app-level UI и shipping Safari/iOS не
  проверены; Playwright WebKit ≠ shipping Safari.
- **No PCS/backup v1:** потеря ключей/профиля = потеря истории; local copies не backup.
- **Single-node:** WS/rate-limiter/outbox in-process; `chat.keys.changed`/
  `device.list.changed` не durable.
- **Retention/privacy:** envelope/quarantine retention не реализован; quarantine owner-only,
  RLS не FORCE; ciphertext/метаданные бессрочно.
- **Testing:** F7B — один host/два контекста, leftover-B и destructive SQL; нет git/one-PR;
  нет внешнего третьего crypto-аудита; workspace’ы накапливаются (68 → 72 за F8C + это
  ревью); flag-on образ остаётся `krug-frontend:latest`.
- **Артефакт:** отсутствие git/CI означает, что committed E2E/store-тесты — единственный
  автоматический барьер; пока cross-chain/partial-batch не покрыт, P1-01c/P1-05 могут
  вернуться незамеченными.

## Вопросы

1. **Regression:** кто и когда добавит committed cross-chain/partial-batch тесты с
   mutation-check? До этого пилот запускать нельзя по условию 1; согласен ли владелец?
2. **F8C report:** кто исправит ложное утверждение «cross-chain ordering covered» и
   устаревшие комментарии `resetRetry.ts`? Нужен ли отдельный post-mortem, почему фикс без
   теста был объявлен DONE?
3. **P2-16/P2-21:** делаем drain pending replacement (idempotency-key) и персист retry-UI
   или явно принимаем duplicate/loss на ambiguous POST и reload?
4. **Receiver v1.1:** входит ли receiver-дедуп в flag-on, или PM принимает ограничение v1
   «0 дублей не обещается» и убирает обещание из UI/AC?
5. **Key-change live:** кто предоставит test-only fixture легитимной ротации identity и
   одноразовый стенд для `KEY_CHANGE_DETECTED`/verified reset?
6. **Safari/iOS:** нужен ли отдельный экран «browser unsupported» в password-bootstrap, или
   допустим общий session-error? Кто владелец shipping-Safari gate?
7. **Clean F7B:** можно ли добавить регистрацию B через BFF/Mailpit и destructive-opt-in,
   чтобы F7B шёл в CI на чистом стеке? Кто владелец cleanup/CI-БД?
8. **Векторы/legacy:** исправляем `normative_invariants` с bump `vector_set_version` или
   отдельным erratum? Нужна ли миграция `sendOrder`/`supersededAt` для pilot-устройств или
   достаточно переустановки?
9. **Release:** когда git/tag/patch-bundle, финальный rebuild после условий 1–3, полный
   backend suite и F7A/F7B на release-candidate? Без этого G4-подпись неполная.

---

**Статус G4e: DONE (ревью завершено).** P0 нет. P1-01c и P1-05 **исправлены в коде** и
независимо воспроизведены: cross-chain partial batch даёт `pending ['second']` вместо
`anchor_unknown`, окно строится по durable `sendOrder` без пропусков/дубликатов; P1-01a/
P2-15 подтверждены F7B 2/2. Но **committed regression отсутствует**, и отчёт F8C заявляет
его ошибочно; условия 2–10 открыты, условие 1 (regression) не выполнено при исправленном
коде. F7B 2/2, образ `ccf7e985…` и asset
`index-cfIpRIA1.js` независимо подтверждены; full 757/757; base-флаги false. Итог: **пилот
Chromium/Firefox — GO WITH CONDITIONS (после 1–3); безусловный/base flag-on — NO-GO**
до всех условий 1–10. Код/контракты/спека/векторы/`docs/TASKS*` не изменялись; создан только
этот файл. Побочный эффект прогонов: +2 `E2EE F7B` workspace и +4 devices; SQL-reset отозвал
устройства fixture-пользователей (P2-02/P2-03); контейнеры backend/frontend остаются flag-on.

# E2EE-REVIEW-12 — G4d final re-review после E7-F8B

> **Рецензент:** независимый security/crypto-ревьюер; в E7-F8B не участвовал.
> **Дата:** 2026-11-18. **Вход:** `docs/E2EE-REVIEW-11.md`, `docs/E2EE-REVIEW-10.md`,
> `docs/E2EE-REVIEW-09.md`, `frontend/E7-F8B-REPORT.md`, `frontend/E7-F8A-REPORT.md`,
> `frontend/e2e/e2ee.real.spec.ts`, `frontend/src/e2ee/outbox/outboxStore.ts`
> (`markOutboxSuperseded`/`markOutboxSent`/`markOutboxFailed`/`retryOutboxEntry`),
> `frontend/src/e2ee/outbox/types.ts` (`supersededAt`), `frontend/src/e2ee/app/resetRetry.ts`
> (`selectRetryWindow`), `frontend/src/e2ee/app/resetRetry.test.ts`,
> `frontend/src/store/chatStore.ts` (partial batch/retry), `frontend/src/e2ee/app/chatBridge.ts`,
> фактический образ/контейнер, живой стенд и БД.
> **Зона:** в дереве создан только этот файл. Временные test-only harness'ы (unit-уровень
> на production-модулях) создавались вне production-кода и удалены после прогонов; код,
> контракты, спека, векторы, `docs/TASKS*` не изменялись. Git-репозитория в workspace нет,
> поэтому one-PR/diff по-прежнему не проверяемы; проверялось фактическое дерево, образ,
> БД и поведение.

## Вердикт

**NO-GO на включение `KRUG_E2EE_ENABLED=true` в текущем дереве.**

P0 не найдено. P1-02, P1-03, P1-04 (runtime) и P2-10 остаются закрытыми; F7B 2/2,
финальный образ и asset независимо подтверждены; full frontend — 757/757; base-флаги
`false`, flag-on только в test-overlay. **P1-01 закрыт не полностью, и это снова
release-blocking.** F8B действительно исправил reload-дубль (P1-01a) и перенацелил
committed E2E на `markerLost` (P2-15), но в `selectRetryWindow` остались два дефекта
окна retry, каждый воспроизведён на production-модулях:

1. **P1-01c (новый, введён F8B):** `supersededAt`-фильтр применяется **до** поиска якоря.
   Если якорь уже заменён (а в partial batch это всегда первый успешный кандидат), якорь
   исчезает из `entries`, поиск по `clientMessageId` невозможен, а chain-fallback не
   срабатывает при смене DH-цепочки. Результат — `anchor_unknown` → `chatBridge` удаляет
   failed-сессию → остаток batch’а молча не переотправляется.
2. **P1-05 (pre-existing, не покрыт F8B):** `bySendOrder` использует `header.n` как
   «локальный индекс отправки». `header.n` — счётчик **внутри sending chain** и
   сбрасывается после DH ratchet. Окно через разные цепочки получает неверный порядок:
   сообщения после якоря теряются, а сообщения **до** якоря попадают в окно и создают
   дубликаты у B.

Оба дефекта находятся в том же `selectRetryWindow`, которым F8B закрывал P1-01b;
committed-regression (P1-01b) проходит только на одной DH-цепочке и поэтому их не ловит.
Итог: **сейчас flag-on — NO-GO**. После исправления P1-01c/P1-05, расширения regression
на cross-chain и выполнения оставшихся условий 1–11 — **GO WITH CONDITIONS** для
пилота Chromium/Firefox; Safari/iOS — отдельный gate.

## P0

**Открытых P0 нет.**

F8B меняет только outbox-types/store, `selectRetryWindow`, его тест и E2E-спеку;
крипто-ядро, wire, контракты и серверные проверки не тронуты. Повторно проверены классы,
дававшие P0 в предыдущих ревью:

| P0-класс | Результат | Доказательство |
|---|---|---|
| Plaintext E2EE-строк на сервере | нет | независимый F7B: последний workspace — 6 сообщений / 6 envelopes, все `E2EE_PAIRWISE`, `body_ciphertext IS NULL`, `content_meta='{}'`; `f7b_`-маркеров в БД — 0 |
| Plaintext/ciphertext в логах/WS | нет | backend/frontend logs за прогон: 0 вхождений `f7b_`; F7B сканирует WS-кадры и backend logs in-memory |
| Конверты чужих устройств / `X-Device-Id` | не переоткрыто | F8B не менял `ApiRequestPath`/`DeviceBindingFilter`; F7B идёт реальным keyed-flow |
| 512 KiB / floor 272 B / canonical b64u | держится | `ck_envelopes_ciphertext_min.convalidated=t` на parent и всех partitions (4 constraint-row); live envelopes — 272..272 B (721 шт.); F7B проверяет 272..33040 в БД |
| RLS/tenant boundary | держится | `relforcerowsecurity=t` для `message_envelopes` и `key_verifications`; не менялось |
| Nonce/MK reuse в store | не найден | F8B не трогал крипто-ядро; full unit suite (включая KAT/session-store) 757/757 |
| KAT/tamper ядра | зелёные | full 757/757; F7A не перезапускался, т.к. crypto-ядро не менялось (ограничение evidence, не регрессия) |

Почему найденные P1 — не P0: plaintext/ключи не утекают, sealed copies остаются,
криптографическая конфиденциальность не ломается. Страдает доставка/целостность истории
(пропуск или дубликат replacement), поэтому это release-blocker для flag-on.

## P1 closure

| ID | Статус после E7-F8B | Независимый результат |
|---|---|---|
| **P1-01** История после `deleteSession`/R-15 | **PARTIAL — release-blocking** | P1-01a (reload-дубль) закрыт: copy `superseded`, F7B `markerLost==1`, P2-15 закрыт. P1-01b (duplicate на retry) исправлен только для одной DH-цепочки. **P1-01c** (superseded anchor → `anchor_unknown` → потеря) и **P1-05** (cross-chain порядок → пропуск/дубликат) открыты. |
| **P1-02** Verification/safety number | **CLOSED** (без изменений) | Код/тесты/F7B из E7-F8; F8B не трогал. Live negative key-change остаётся P2-07/условием 3. |
| **P1-03** Sync/resume-gap catch-up | **CLOSED** (без изменений) | `runSync().catchUp`/`resume.gap` → `decryptE2eeSlice`; F7B проходит reset без обязательного `R15_CATCH_UP_RELOAD`. Узкий race «E2EE state ещё не ready» остаётся P2. |
| **P1-04** WebKit runtime floor | **CLOSED для runtime; P2 для app-level UI/CI** | F7A 12/12 из REVIEW-11 (не перезапускался, crypto не менялся); WebKit expected-unsupported; password-bootstrap UI — P2-11, матрица не в release-CI — P2-08. |
| **P2-10** F7B evidence на финальном образе | **CLOSED** | Образ `sha256:7bb3e54b…` и asset `index-vvj_eLFp.js` `7957b370…` воспроизведены; F7B 2/2 (15.6 s). |
| **P1-05** Cross-chain порядок retry-окна | **NEW — release-blocking** | `bySendOrder` сравнивает `header.n`; n per-chain. Репро: `[second, fourth]` вместо `[second, third, fourth]`; `[third, second, fourth]` вместо `[third, fourth]`. |

### P1-01a. Reload-дубль действительно закрыт

- `markOutboxSuperseded` (`frontend/src/e2ee/outbox/outboxStore.ts:1097-1128`) для `sent`
  строки ставит `supersededAt` и переводит sealed outgoing copy в `superseded`; для
  `pending`/`failed` — и строку, и copy.
- `markOutboxFailed` (`:1072-1094`) не понижает `sent`/`superseded`; `retryOutboxEntry`
  (`:1130-1150`) поднимает только `failed`; `markOutboxSent` (`:1036-1069`) идемпотентен
  для того же `serverMessageId`/`seq` и запрещает `superseded`. Воскрешения через
  outbox-store нет.
- Committed E2E (`frontend/e2e/e2ee.real.spec.ts:869-891`) после R-15 перезагружает A и
  требует ровно один `markerA`, `markerLost`, `markerR15`. `markerLost` — именно
  заменённый оригинал; проверка настоящая, не косметическая.
- Независимый F7B: **2 passed (15.6 s)** — Chromium 5.8 s, Firefox 8.4 s; reload-A
  прошёл. Отрицательный контроль (pre-F8A state → `markerLost==2`) был показан в
  REVIEW-11; здесь не повторялся, но семантика проверки однозначна.
- P2-15 **CLOSED**. Замечание: повторная проверка `markerR15` (`:886-891`) дублирует
  цикл `:878-885`; безвредно, но лишнее.

### P1-01b. Что F8B починил, а что нет

F8B добавил `supersededAt` (`frontend/src/e2ee/outbox/types.ts:47-48,72`), запись в
`markOutboxSuperseded` и фильтр в `selectRetryWindow`
(`frontend/src/e2ee/app/resetRetry.ts:221-232`). Для строк `sent`+`supersededAt` это
работает: кандидат исключается, тест `resetRetry.test.ts:174-218` на двух сообщениях
**одной** цепочки даёт `['second']`. Это подтверждено targeted-прогоном (9/9).

Но заявленное «partial batch больше не переотправляет заменённое» верно только при
совпадении `header.dh` у якоря и следующего pending-сообщения. В реальном partial batch
якорь — это **всегда первый успешный кандидат**, то есть он всегда исключается фильтром
до поиска. Поэтому by-id ветка в этом сценарии мертва, и окно держится только на
chain-fallback, который не покрывает ratchet. Это и есть P1-01c/P1-05.

### P1-01c. Superseded anchor исключается до anchor-lookup → `anchor_unknown` → молчаливая потеря

**Механика (production-путь).**

1. В failed-сессии S у A есть m1 (якорь reset) и m2 (следующее pending-сообщение),
   причём между ними A получил сообщение B и выполнил DH ratchet: m1 в цепочке C1,
   m2 — в C2 (тот же `session_id` S).
2. A обрабатывает reset: перешифровывает окно от m1. m1′ подтверждён →
   `confirmSent` → `markSuperseded(m1)` → `m1.outbox.status='sent'`,
   `m1.supersededAt=now`, copy `superseded`. m2′ падает (сеть/сервер) → failed batch.
3. Пользователь нажимает «повторить»; тот же reset с `retry_of_client_message_id=m1`.
4. `selectRetryWindow` (`resetRetry.ts:221-245`) строит `entries` уже **без** m1
   (`supersededAt != null`). `findIndex(clientMessageId === m1)` → `-1`. Fallback
   `matchesFailedChain` ищет `dh == C1 && n >= n1`; m2 — в C2, поэтому тоже `-1`.
5. `status='anchor_unknown'`, `candidates=[]`. `chatBridge.ts:871-875` удаляет
   failed-сессию и возвращает `ignored`; `chatStore.ts:2236-2241` очищает
   `pendingResets`/retry-UI. Неуспешный m2′ остаётся `pending` в outbox, но
   production-вызова `drainOutbox` нет (он импортируется только тестами),
   `retryOutboxEntry` из UI не вызывается. Сообщение m2 не доставлено и больше не
   ретраится; A при этом видит свою локальную копию m2 как `sent`.

**Репро (test-only harness на production-модулях, удалён).**

```
first:  session S, chain C1, n=0
B decrypts first, replies; A receives reply -> DH ratchet
second: session S, chain C2, n=0
markOutboxSent(first); markOutboxSuperseded(first)
reset: failedSessionId=S, failedChainDh=C1, failedN=0,
       retryOfClientMessageId=first.clientMessageId
selectRetryWindow -> {status:'anchor_unknown', candidates:[]}
expected -> {status:'pending', candidates:['second']}
```

Вывод harness: `sameSession=true`, `dh1 != dh2`, `n1=n2=0`, окно `anchor_unknown`. То есть
дефект не в reload-пути (он закрыт), а в том, что F8B отфильтровал якорь **до** того, как
его позиция определена. Это P1: поддерживаемый сценарий (partial batch + явный retry,
E7-F6 UI), тихая потеря остатка batch’а и удаление failed-сессии; §5.5 прямо требует
«no silent drop» и окно от якоря.

**Что исправить.** Определять `anchorIndex` по полному списку (включая superseded-строки),
затем строить окно от него, **пропуская** superseded-кандидаты; `anchor_unknown` оставить
только для действительно неизвестного якоря. Считать `remaining/skipped` по
не-superseded остатку. Regression: две записи разных DH-цепочек, первая superseded →
`pending` + `['second']`; проверить, что failed-сессия не удаляется и retry-UI не
очищается.

### P1-05. Cross-chain порядок окна: `header.n` — не local send order

`sendIndex` (`resetRetry.ts:168-171`) и `bySendOrder` (`:191-200`) используют
`envelope.header.n` как индекс локальной отправки. В Double Ratchet `n` — счётчик
**текущей sending chain** и сбрасывается после DH ratchet; для сообщений одной сессии
из разных цепочек он не монотонен. Дополнительно компаратор нетранзитивен: при равных
`n` он падает на `createdAt`/`clientMessageId`, при разных — игнорирует `createdAt`.

**Репро (test-only harness, удалён), детерминированные `createdAt`:**

```
first  C1 n=0 (t0)
second C1 n=1 (t1)
B decrypts both, replies; A receives reply -> ratchet
third  C2 n=0 (t3)
fourth C2 n=1 (t4)
```

`selectRetryWindow`:

```
anchor=second -> {'status':'pending','texts':['second','fourth']}
expected      -> ['second','third','fourth']     // third потерян

anchor=third  -> {'status':'pending','texts':['third','second','fourth']}
expected      -> ['third','fourth']              // second (до якоря) перешифрован -> дубль у B
```

Первый случай — пропуск сообщения (при `completed` failed-сессия удаляется, B не получает
`third`); второй — повторная перешифровка уже доставленного `second`, то есть дубликат
у B, нарушение G4 «0 дублей» и §5.5. Дефект pre-existing, F8B его не трогал, но он
находится ровно в том окне, которым закрывался P1-01b, и F8B-regression его не ловит,
потому что `first`/`second` в тесте — одна цепочка (`n=0,1`).

**Что исправить.** Ввести durable local send sequence на outbox-строку (монотонный
счётчик, присваиваемый при commit) и сортировать окно по нему; `header.n`/`createdAt` как
единственный порядок не годятся (n per-chain; createdAt может совпасть). Regression:
цепочки C1→C2, якоря в C1 и C2; окно строго в локальном порядке, без сообщений до якоря.

## P2

### P2-15. Committed E2E reload-A — CLOSED

Проверка `markerLost == 1` в `e2ee.real.spec.ts:878-891` реальна и независимо прошла в
F7B 2/2 (Chromium и Firefox). Это regression именно для P1-01a; на pre-F8A state
(REVIEW-11 flip-эксперимент) она даёт 2. Замечание: F7B не инжектирует сбой отправки,
поэтому partial batch/P1-01c/P1-05 этим E2E не покрываются.

### P2-16. Расщеплённое состояние `outbox=sent` / `copy=superseded` — PARTIAL

`supersededAt` добавлен и виден потребителям, но инвариант «заменённое не отправляется»
по-прежнему живёт в двух записях; `selectRetryWindow` — единственное место, которое его
читает. Ошибка `markOutboxSuperseded` после успешного `confirmSent` (IndexedDB/quota)
оставит `sent` без `supersededAt`, и retry снова перешифрует заменённое (дубликат).
`decryptOutboxEntry` (`outboxStore.ts:864`) не валидирует `supersededAt` как timestamp
(в отличие от `status`); локальный tamper может обнулить маркер. Рекомендуется
defense-in-depth: при выборе кандидата также пропускать `copy.status === 'superseded'`.

### P2-17. Legacy-состояние до F8A/F8B не мигрируется — OPEN

Устройства, у которых R-15 уже был до F8A (outbox `sent`, copy `sent`) или между F8A и
F8B (outbox `sent`, copy `superseded`, `supersededAt` отсутствует), не получают
backfill. Для второго случая `selectRetryWindow` не исключает запись по copy-статусу и
`lookupLocalCopy` возвращает текст (статус копии не проверяется) → повторная
перешифровка и дубликат. Base-флаг false и production-копий нет, поэтому это
принятие/бэкфилл-решение, а не текущий production-дефект, но pilot-устройства с прошлым
flag-on нужно мигрировать или явно переустановить.

### P2-18. Неполнота store-тестов P1-01 — OPEN

По-прежнему нет: отдельных store-тестов `SPK_DELETED`/`DECRYPT_FAILED` copy-restore;
проверки, что `markOutboxSuperseded` для `sent` реально ставит `supersededAt`
(тест `outbox.test.ts:263-279` проверяет только `outbox='sent'` и `copy='superseded'`);
идемпотентности двойного `markOutboxSuperseded` для `sent` (повторный вызов
перезаписывает timestamp, хотя семантика статуса идемпотентна); cross-chain/partial-batch
сценария; `remaining/skipped`-счётчиков. P2-15 закрыт, но evidence P1-01 остаётся
частичным (P2-14).

### Остальные P2 из REVIEW-11 (статус)

| ID | Статус | Комментарий |
|---|---|---|
| P2-01 Чистый стек F7B | **OPEN** | Снова leftover `pickle-ui-1794919305193@krug.local`/`test@krug.local`; B не регистрируется через BFF/Mailpit. |
| P2-02 Destructive SQL по умолчанию | **OPEN** | `e2ee.real.spec.ts:50` `DB_CHECK=true`; `:205-218` `UPDATE auth.devices … REVOKED` без `E2EE_REAL_ALLOW_DESTRUCTIVE=1`. |
| P2-03 Накопление workspace/flag-on стек | **OPEN** | 61 → **68** `E2EE F7B` workspace и 313 → **327** devices после F8B + моих прогонов; контейнеры backend/frontend flag-on; `krug-frontend:latest` — overlay-образ. |
| P2-04 Legacy incoming copies без `serverMessageId` | **OPEN** | `outboxStore.ts:1248-1253`; не менялось. |
| P2-05 `normative_invariants` векторов | **OPEN** | `docs/E2EE-TEST-VECTORS.json:198-202`: `16..33040` вместо `272..33040`; `reset_retry_window` описывает `retry_of_client_message_id` в inner payload и receiver-дедуп как реализованные, хотя спека §3.5.1/§5.5 называет их v1.1; `vector_set_version` = 4. |
| P2-06 `protectedSessionIds` в receive-реконсиляции | **OPEN** | `frontend/src/e2ee/session/receive.ts:411-415`; `chatBridge` передаёт их только в `loadChat`. |
| P2-07 Negative key-change/TOFU live | **OPEN** | F8B не добавлял fixture; E2EE-AC-04 остаётся частичным; в E2E `KEY_CHANGE` нет. |
| P2-08 CI/checklist/git/log-capture | **OPEN** | `.github/` нет; `deploy/E2EE-ENABLE-CHECKLIST.md` нет; F7A/F7B не в `npm run check`; git-репозитория нет. |
| P2-09 Kill-switch/retention/multi-node | **OPEN** | Не менялось. |
| P2-10 F7B/image evidence | **CLOSED** | См. ниже. |
| P2-11 WebKit UI в password-bootstrap | **OPEN** | `chatStore.ts:695-714` даёт общий session-error, а не `E2eeBanner`; `browserUnsupported` выставляется, но bootstrap-путь другой. |
| P2-12 Runtime Ed25519 KAT только empty | **OPEN** | `ed25519Kat.ts:18-70` — RFC 8032 TEST 1 (empty). |
| P2-13 Аттестация не привязана к показанному hash | **OPEN** | Не менялось. |
| P2-14 Evidence P1-01 | **PARTIAL** | +`markerLost` E2E; по-прежнему нет `supersededAt`/idempotency/cross-chain/partial-batch store-тестов. |

## F7B/image evidence

Независимо, не по отчёту:

| Проверка | Результат |
|---|---|
| container image | `krug-frontend:latest`, `sha256:7bb3e54bf3634c703f0a4e38554b258f04bd4f0abfba0b6391a73a7d335cf137`, created `2026-11-18T11:27:59Z` (14:27:59 MSK) |
| container | `krug-frontend` запущен `2026-11-18T11:28:03Z`, healthy; backend `KRUG_E2EE_ENABLED=true` (overlay) |
| SPA asset | `assets/index-vvj_eLFp.js`, SHA-256 `7957b3707591f22ef41146134a5456d15545e95c23e2473b9630dd3c7b54dc61`; `browser-BrcbMjYG.js` `c5d778e4…`; `realtime-DUkkXm74.js` `97984e68…`; `index.html` `ee79c98e…` |
| E2EE flag in asset | asset содержит E2EE-код (`E2EE_UNSUPPORTED_BROWSER`); сборка с `VITE_E2EE_ENABLED=true` воспроизвела **все 4** хеша |
| reproducibility | `npx vite build` с точными overlay-args (`VITE_API_BASE_URL=/api/v1`, `VITE_USE_MOCKS=false`, `VITE_AUTH_MODE=password`, `VITE_DEV_SESSION=false`, `VITE_DEVICE_NAME="Pickle — браузер"`, `VITE_APP_VERSION=0.1.0`, `VITE_REALTIME_ENABLED=true`, `VITE_MEDIA_ORIGINS=http://localhost:9000`, `VITE_E2EE_ENABLED=true`) в отдельный outDir дал те же `index-vvj_eLFp.js`, `browser-BrcbMjYG.js`, `realtime-DUkkXm74.js`, `index.html` — образ соответствует текущему дереву |
| source mtimes | F8B-файлы `outboxStore.ts`/`types.ts`/`resetRetry.ts`/`e2ee.real.spec.ts` — 14:26:45, `resetRetry.test.ts` — 14:27:01, всё **старше** image 14:27:59; SPA-source новее образа нет (только `docs/TASKS.md` 14:28:27 и отчёты) |
| base flags | `deploy/.env:44` — `KRUG_E2EE_ENABLED=false`; base `docker-compose.yml:275,304` — `${KRUG_E2EE_ENABLED:-false}`; `Dockerfile:19` default `false`; `true` только в `docker-compose.e2ee-test.yml:11,15` |
| F7B | независимый прогон: **2 passed (15.6 s)**, Chromium 5.8 s, Firefox 8.4 s; запуск с `PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers`; Firefox в песочнице ревьюера требует `CFFIXED_USER_HOME` и `MOZ_DISABLE_CONTENT_SANDBOX=1` (иначе profile/sandbox error) — это окружение ревьюера, не изменение продукта |
| markerLost | проверка `:878-891` реальна: после reload A ровно по одному `markerA`/`markerLost`/`markerR15`; `markerLost` — заменённый оригинал |
| full frontend | `npx vitest run` — **72 files / 757 tests passed** (12.95 s) |
| targeted | `outbox.test.ts` 31 + `resetRetry.test.ts` 9 + `chatBridge.test.ts` 11 + `store/e2eeChat.test.ts` 27 — все зелёные (78 проверок в отдельных прогонах) |
| DB | 68 `E2EE F7B` workspace, 327 devices; мой прогон добавил +5 workspace/+10 devices (F8B: 63/317, REVIEW-11: 61/313); последний workspace — 6 сообщений/6 envelopes, 0 plaintext-маркеров |
| DB constraints | `ck_envelopes_ciphertext_min.convalidated=t` на parent и всех partitions (4 constraint-row); `relforcerowsecurity=t`; live `octet_length(ciphertext)` 272..272 |
| logs | backend/frontend за прогон: 0 вхождений `f7b_` |

**Что F7B доказывает и что нет.** F7B 2/2 подтверждает реальный keyed-flow, ENVELOPES-only,
отсутствие plaintext в DB/WS/логах и reload-A без дубля по `markerLost`. Но: (a) F7B не
инжектирует сбой отправки, поэтому partial batch (P1-01c/P1-05) не покрыт; (b) B после
R-15 не перезагружается, receiver-side v1.1-дубликат не проверяется; (c) прогон снова на
leftover-B и destructive SQL (P2-01/P2-02). То есть это доказательство финального
артефакта и reload-поведения A, но не полного «0 дублей» на retry-пути.

## Условия включения

Флаг остаётся `false`, пока не выполнены все пункты; каждый проверяем.

1. **P1-01c blocker — anchor не должен исчезать до anchor-lookup.** Определять позицию
   якоря по полному списку (включая superseded-строки), затем строить окно от неё,
   пропуская replaced-кандидаты; `anchor_unknown` — только для реально неизвестного
   якоря. Regression: partial batch, якорь superseded, следующее pending-сообщение в
   другой DH-цепочке → `pending` + `['second']`; failed-сессия не удаляется, retry-UI не
   очищается. **Плюс** P1-05 (см. 2). Без этого flag-on запрещён.
2. **P1-05 blocker — порядок окна.** Ввести durable local send sequence (или иной
   тотальный порядок фактической отправки) вместо `header.n`; regression C1→C2:
   anchor в C1 → окно `[anchor, …]` без потерь; anchor в C2 → ни одного сообщения до
   якоря; `remaining/skipped` корректны. Совместить с fix P1-01c.
3. **P1-01 evidence completeness.** Store-тесты `SPK_DELETED`/`DECRYPT_FAILED`
   copy-restore (0 error-bubble, 0 POST reset); прямая проверка `supersededAt` для
   `sent`; идемпотентность двойного `markOutboxSuperseded`; legacy-copy
   `copy.status='superseded'` guard/миграция; явно записать, что receiver-side R-15
   остаётся v1.1.
4. **Negative key-change/TOFU live + verified reset.** Test-only fixture легитимной
   ротации identity (валидная binding-подпись) или контролируемая SQL-мутация на
   одноразовом стенде: `KEY_CHANGE_DETECTED`, send blocked до accept, OPK не расходуется,
   сессия не перезаписывается, `verified` сброшен, после accept — re-verify; плюс L3b и
   multi-device E2E. Без этого E2EE-AC-04 остаётся частичным.
5. **Receiver R-15 v1.1.** Либо реализовать `retry_of_client_message_id` в inner TEXT и
   receiver-дедуп, либо явно принять продуктовое ограничение v1 «0 дублей не
   обещается» и убрать это обещание из UI/AC/отчётов. Решение владельца продукта,
   записанное до flag-on.
6. **Safari/iOS + WebKit UI.** App-level WebKit E2E с `VITE_E2EE_ENABLED=true` в
   password-режиме: unsupported browser показывает понятный экран/баннер, keyed
   registration и send не выполняются; либо отдельное ADR-решение, что весь SPA
   недоступен. Shipping Safari/iOS — отдельный gate; не объявлять Safari в floor без
   прогона.
7. **F7B чистая воспроизводимость/fixture.** `down -v` → overlay up → F7B 2/2 без ручной
   подготовки: B регистрируется через BFF/Mailpit (уникальные email/пароль), а не
   leftover; SQL-reset требует явного `E2EE_REAL_ALLOW_DESTRUCTIVE=1` и проверки
   контейнера/БД; после прогона — cleanup/reset и возврат base-compose. Сейчас
   `krug-frontend:latest` — flag-on overlay-образ; base `up -d` без rebuild поднимет
   flag-on SPA с flag-off backend.
8. **Векторы.** Исправить `normative_invariants` (`272..33040`, v1.1-статус
   receiver-дедупа), bump `vector_set_version`; `vectors.test.ts` не принимает 271 B и
   «16..33040» и не считает receiver-дедуп v1 реализованным; пересчитать/зафиксировать
   KAT hash.
9. **Release-CI/артефакт.** F7A-матрица с явной политикой (Chromium/Firefox blocking,
   WebKit expected-fail) и F7B на чистом стеке в release-CI; `log-capture` на отсутствие
   ciphertext/plaintext; полный backend suite; `deploy/E2EE-ENABLE-CHECKLIST.md`;
   clean rebuild после финальных правок с фиксацией image digest + asset SHA-256;
   git/tag/patch-bundle (one-PR). P2-10 закрыт для `7bb3e54b…`, но после P1-01c/P1-05
   rebuild обязателен.
10. **Legacy copies/local state.** Миграция/бэкфилл incoming-копий без
    `serverMessageId`/`client_message_id` и pre-F8A/F8B outbox/copy `sent` — или явное
    принятие: после включения такие копии могут не найтись/дать replay-риск/дубликат.
11. **Kill-switch/retention/rollout.** Проверить flag-off kill-switch (REST/WS/replay 409,
    `server_last_seq` не теряет seq), retention envelopes/quarantine, rate limits,
    demo/test users, отключение dev-session; сначала E2EE-workspace pilot на
    Chromium/Firefox, затем общий flag-on; Safari — отдельно.

После P1-01c/P1-05 и любого изменения крипто-adjacent кода — rebuild образа, F7B 2/2 на
чистом стеке и full 757; без этого G4-подпись неполная.

## Остаточные риски

- **P1-01c:** после partial batch с ratchet между якорем и остатком окно становится
  `anchor_unknown`; failed-сессия удаляется, pending-сообщения не переотправляются и не
  показываются как failed → тихая потеря доставки.
- **P1-05:** cross-chain окно может пропустить сообщение (потеря) или включить уже
  доставленное (дубликат у B и нарушение «0 дублей»). Особенно опасно сочетание с
  `MAX_RESET_BATCH=20` и `finishReset('completed')`.
- **P1-01b error path:** если `markOutboxSuperseded` упадёт после `confirmSent`, маркер
  не запишется; следующий retry снова перешифрует заменённое → дубликат (P2-16).
- **Legacy local state:** pre-F8A/F8B `sent`/`superseded` без `supersededAt` не
  мигрируется; устройства с прошлым flag-on сохранят дубликат (P2-17).
- **Receiver-side R-15 v1.1:** B без маркера в TEXT не может сопоставить старый и новый
  client id; после reload B может показать оригинал и замену. В v1 не обещается.
- **TOFU-окно:** первый контакт уязвим; safety number — единственный независимый канал;
  attestation `verified` per-device, но серверный флаг не доказательство.
- **Malicious server replay:** legacy incoming copies без `serverMessageId` могут показать
  старый текст под новым `message.id` (P2-04); для новых копий binding есть.
- **WebKit/Safari:** runtime gate блокирует, но app-level UI и shipping Safari/iOS не
  проверены; Playwright WebKit ≠ shipping Safari.
- **No PCS/backup v1:** потеря ключей/профиля = потеря истории; local copies не backup.
- **Single-node:** WS/rate-limiter/outbox in-process; `chat.keys.changed`/`device.list.changed`
  не durable.
- **Retention/privacy:** envelope/quarantine retention не реализован; quarantine
  owner-only, RLS не FORCE; ciphertext/метаданные бессрочно.
- **Testing:** F7B — один host/два контекста, leftover-B и destructive SQL; нет git/one-PR;
  нет внешнего третьего crypto-аудита; workspace'ы накапливаются (61 → 68 за F8B + это
  ревью); flag-on образ остаётся `krug-frontend:latest`.
- **Артефакт:** отсутствие git/CI означает, что committed E2E/store-тесты — единственный
  автоматический барьер; пока partial-batch cross-chain не покрыт, P1-01c/P1-05 могут
  вернуться незамеченными.

## Вопросы

1. **P1-01c/P1-05:** кто владелец фикса `selectRetryWindow`? Предпочтителен ли единый
   подход: anchor-lookup по полному списку + durable `localSendSeq` в outbox? Можно ли
   добавить поле в outbox-запись без изменения wire/контрактов?
2. **P1-01b evidence:** кто добавит cross-chain и partial-batch store-тесты, а также
   проверку `supersededAt`/двойного `markOutboxSuperseded`? Без этого regression остаётся
   узким.
3. **Legacy state:** нужна ли миграция pre-F8A/F8B `outbox=sent`/`copy=superseded` без
   `supersededAt`, или при отсутствии production-копий достаточно документированного
   принятия и переустановки pilot-устройств?
4. **Receiver v1.1:** входит ли receiver-дедуп в flag-on, или PM явно принимает
   ограничение v1 «0 дублей не обещается» и убирает обещание из UI/AC?
5. **Key-change live:** кто предоставит test-only fixture легитимной ротации identity и
   одноразовый стенд для `KEY_CHANGE_DETECTED`/verified reset?
6. **Safari/iOS:** нужен ли отдельный экран «browser unsupported» в password-bootstrap,
   или допустим общий session-error? Кто владелец shipping-Safari gate?
7. **F7B fixture:** можно ли добавить регистрацию B через BFF/Mailpit и
   destructive-opt-in, чтобы F7B шёл в CI на чистом стеке? Кто владелец cleanup/CI-БД?
   Firefox в release-CI должен запускаться без reviewer-sandbox workaround.
8. **Векторы:** исправляем `normative_invariants` с bump `vector_set_version` или
   отдельным erratum без изменения байтовых KAT? Кто перепроверит hash/24+3 KAT?
9. **Release:** когда git/tag/patch-bundle, финальный rebuild после P1-01c/P1-05, полный
   backend suite и F7A/F7B на release-candidate? Без этого G4-подпись неполная.

---

**Статус G4d: DONE (ревью завершено).** P0 нет; P1-01 — PARTIAL: reload/P2-15 закрыты,
но partial-batch retry имеет два release-blocking дефекта — P1-01c (superseded anchor →
`anchor_unknown`) и P1-05 (cross-chain порядок → пропуск/дубликат). P1-02/P1-03/P1-04
(runtime) и P2-10 закрыты. F7B 2/2, образ `7bb3e54b…` и asset `index-vvj_eLFp.js`
независимо подтверждены; full frontend 757/757; base-флаги false. Итог: **в текущем дереве
flag-on — NO-GO**; после P1-01c/P1-05 + условий 1–11 — **GO WITH CONDITIONS** для пилота
Chromium/Firefox. Код/контракты/спека/векторы/`docs/TASKS*` не изменялись; создан только
этот файл. Побочный эффект прогонов: +5 `E2EE F7B` workspace и +10 devices на одноразовом
стенде; SQL-reset отозвал устройства fixture-пользователей (P2-02/P2-03); контейнеры
backend/frontend остаются flag-on.

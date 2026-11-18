# E2EE-REVIEW-11 — G4c re-review после E7-F8A

> **Рецензент:** независимый security/crypto-ревьюер; в E7-F8A не участвовал.
> **Дата:** 2026-11-18. **Вход:** `docs/E2EE-REVIEW-09.md`, `docs/E2EE-REVIEW-10.md`,
> `frontend/E7-F8A-REPORT.md`, `frontend/E7-F8-REPORT.md`, `frontend/e2e/e2ee.real.spec.ts`,
> `frontend/src/e2ee/outbox/outboxStore.ts` (`markOutboxSuperseded`/`markOutboxSent`/
> `updateLocalCopyStatus`), `frontend/src/store/chatStore.ts` (R-15 путь),
> `frontend/src/e2ee/outbox.test.ts`, `frontend/src/e2ee/app/resetRetry.ts`,
> `frontend/src/e2ee/app/chatBridge.ts`, `docs/E2EE-SPEC.md` §5.5, `docs/E2EE-TEST-VECTORS.json`,
> `deploy/**`, фактический образ/контейнер и живой стенд.
> **Зона:** в финальном дереве создан только этот файл. Временные test-only harness'ы
> (unit-уровень на production-модулях и Playwright-копия спецификации) создавались вне
> production-кода и удалены после прогона; код, контракты, спека, векторы, `docs/TASKS*` не
> изменялись. Git-репозитория в workspace нет — one-PR/diff по-прежнему не проверяемы;
> проверялось фактическое дерево, образ и поведение.

## Вердикт

**NO-GO на включение `KRUG_E2EE_ENABLED=true` в текущем дереве.**

P0 не найдено. P1-02, P1-03, P1-04 и P2-10 (образ) остаются закрытыми; P2-10 подтверждён
байт-в-байт на новом образе. **P1-01 закрыт только частично — и это по-прежнему
release-blocking.** F8A действительно исправил reload-дубль: для уже отправленного
сообщения `markOutboxSuperseded` теперь переводит sealed outgoing copy в `superseded`,
и после reload A оригинал не рендерится (независимо подтверждено unit-тестом и моим
Playwright-harness'ом: ровно один экземпляр замены). Но **outbox-строка остаётся `sent`**,
а `selectRetryWindow` фильтрует именно по outbox-статусу и **повторно выбирает уже
заменённое сообщение** при retry после частично неуспешного batch. Это даёт второй
replacement того же текста: видимый дубликат у A и у B, то есть нарушение G4 «0 дублей»
и §5.5. Дефект воспроизведён на production-модулях (harness удалён).

Дополнительно: заявленная в F8A «A reload after R-15» проверка в
`e2ee.real.spec.ts:869-890` считает `markerA`/`markerR15`, а не фактически заменённый
`markerLost`. Экспериментально показано, что при эмуляции pre-F8A состояния
(`copy.status='sent'`) `markerLost` встречается 2 раза, а проверяемые `markerA==1` и
`markerR15==1` проходят — то есть committed E2E не ловит регрессию P1-01 (P2-15).

Итог по бинарному вопросу: **сейчас — NO-GO на flag-on**. После исправления P1-01b
(outbox/retry-window), перенацеливания E2E на `markerLost` и закрытия оставшихся
условий 3–10 — **GO WITH CONDITIONS** для поэтапного включения: сначала Chromium/Firefox,
E2EE-workspace pilot, с работающим kill-switch и наблюдением. Safari/iOS — отдельный gate,
не «молча поддерживается».

## P0

**Открытых P0 нет.**

Повторно проверялись классы, дававшие P0 в предыдущих ревью; F8A меняет только outbox-store,
тест и e2e-спеку, крипто-ядро/wire/контракты не тронуты:

| P0-класс | Результат | Доказательство |
|---|---|---|
| Серверный plaintext в E2EE-строках | нет | F7B 2/2 на текущем образе: `text:null`, `crypto:null`, envelopes-only, 0 plaintext в DB/WS/логах |
| Конверты других устройств через path/`X-Device-Id` | не переоткрыто | F8A не менял `ApiRequestPath`/`DeviceBindingFilter`; F7B использует реальный `X-Device-Id` |
| 512 KiB / floor 272 B / canonical b64u | не переоткрыто | F7B проверяет 272..33040; `ck_envelopes_ciphertext_min.convalidated=t` (по REVIEW-10/09) |
| RLS/tenant boundary | держится | не менялось; `relforcerowsecurity=t` (REVIEW-10) |
| Nonce/MK reuse в store | не найден | F8A не менял крипто-ядро; KAT/`sessionStore` зелёные |
| Серверный ciphertext/plaintext в логах | не найден | независимый F7B log/WS assertions |
| KAT/tamper ядра | зелёные | независимый F7A: **12/12** (Chromium 4/4, Firefox 4/4, WebKit 4/4 expected-unsupported) |

Почему найденный P1-01b — не P0: утечки plaintext/ключей нет, sealed copies остаются,
криптографическая конфиденциальность не ломается. Страдает целостность отображения
истории (дубликат замены после retry) и нарушается §5.5, поэтому это release-blocker
для flag-on, но не P0.

## P1 closure

| ID | Статус после E7-F8A | Независимый результат |
|---|---|---|
| **P1-01** История после `deleteSession`/R-15 | **PARTIAL — release-blocking** | Reload-дубль закрыт: `sent → copy superseded`, unit + e2e harness подтверждают один экземпляр. Но outbox остаётся `sent`, и `selectRetryWindow` при retry после частичного batch повторно перешифровывает уже заменённое сообщение → второй replacement (P1-01b). Committed E2E проверяет не тот маркер (P2-15). |
| **P1-02** Verification/safety number | **CLOSED** (без изменений) | Код/тесты/F7B из E7-F8; F8A не трогал. Live negative key-change остаётся P2-07/условием 3. |
| **P1-03** Sync/resume-gap catch-up | **CLOSED** (без изменений) | `runSync().catchUp`/`resume.gap` → `decryptE2eeSlice`; F7B проходит live reset без обязательной `R15_CATCH_UP_RELOAD`. Остаётся узкий race «E2EE state ещё не ready» (описан в REVIEW-10, P1-03). |
| **P1-04** WebKit runtime floor | **CLOSED для runtime; P2 для app-level UI/CI** | F7A независимо **12/12**; WebKit по-прежнему expected-unsupported; password-bootstrap UI — P2-11, матрица не в release-CI — P2-08. |
| **P2-10** F7B evidence на финальном образе | **CLOSED** | Новый image `sha256:7b3c182a…`, asset `index-BeQEVtf6.js` `311c0f41…`, локальная сборка с точными args воспроизвела те же хеши; F7B 2/2. |

### P1-01a. Что действительно закрыто: reload больше не показывает оригинал

- `markOutboxSuperseded` (`frontend/src/e2ee/outbox/outboxStore.ts:1096-1120`) больше не
  делает ранний выход для `sent`: outbox-строка остаётся терминальной `sent`, но
  `updateLocalCopyStatus(..., 'superseded')` (`:1019-1033`) переводит sealed outgoing copy
  в `superseded`. Для `pending`/`failed` в `superseded` переходят и outbox, и copy.
- `markOutboxSent` (`:1051-1057`) сохраняет идемпотентность `sent` и запрещает отправку
  `superseded`; `markOutboxFailed` (`:1082-1085`) не понижает `sent`/`superseded`;
  `retryOutboxEntry` (`:1132-1134`) переводит в `pending` только `failed`. То есть
  на уровне самого outbox-store «воскрешения» через retry нет; проблема — в отдельном
  потребителе outbox-статуса, `selectRetryWindow` (P1-01b).
- Reload-путь A: `decryptE2eeSlice` для своего сообщения с `crypto:null` зовёт
  `lookupLocalCopy` (`frontend/src/store/chatStore.ts:2090-2097`), `copyView`
  (`:2042-2053`) маппит `superseded` в скрытое состояние; `MessageList.tsx:44-46`
  фильтрует `superseded`.
- Новый тест `frontend/src/e2ee/outbox.test.ts:263-279` идёт реальным путём
  `markOutboxSent → markOutboxSuperseded → lookupLocalCopy` и требует
  `outbox='sent'`, `copy='superseded'`. Targeted-прогон:
  `outbox.test.ts` + `e2eeChat.test.ts` + `chatBridge.test.ts` + `resetRetry.test.ts` —
  **77/77**.
- Независимый Playwright-harness (копия e2e-спеки, удалена): после R-15 и reload A
  `markerLost` (фактически заменённый оригинал) встречается **ровно 1 раз**; добавленная
  проверка `markerLost==1` проходит. Значит, end-to-end поведение reload-дубля
  действительно исправлено, а не только unit-store.

### P1-01b. Что осталось: retry после частичного batch повторно перешифровывает заменённое

**Механика (production-путь).**

1. В failed-сессии S у A есть отправленные m1, m2 (outbox-статус `sent`). B не смог
   расшифровать m1, reset пришёл с якорем `retry_of_client_message_id = m1`
   (`frontend/src/e2ee/app/resetRetry.ts:233-245`).
2. `selectRetryWindow` выбирает окно от якоря: `[m1, m2]`
   (`resetRetry.ts:221-230, 245-283`); фильтр — `entry.status !== 'superseded'`.
3. A успешно отправляет и подтверждает replacement m1′ → `confirmSent` → `markSuperseded(m1)`
   (`frontend/src/store/chatStore.ts:2291-2296`). Теперь `m1.outbox.status='sent'`,
   `m1.copy.status='superseded'`.
4. Отправка m2′ падает (сеть/сервер) → `failed += 1`, `break`
   (`chatStore.ts:2325-2331`); `finishReset('failed')` оставляет failed-сессию S и
   забывает dedupe (`chatBridge.ts:895-914`), UI показывает retry. Комментарий самого
   bridge говорит «re-drive the **remaining** window» (`chatBridge.ts:911-913`), но
   `selectRetryWindow` re-drive'ит окно **целиком от якоря**, включая уже заменённое.
5. Пользователь нажимает retry → `retryPendingReset` (`chatStore.ts:2376-2386`) →
   `handleIncomingReset` с тем же reset → реальный `handleReset` → `selectRetryWindow`
   снова. Поскольку `m1.outbox.status` остался `sent`, фильтр `!== 'superseded'` его
   **не исключает**: окно снова `[m1, m2]`, и `lookupLocalCopy` для m1 по-прежнему
   возвращает текст (статус copy не проверяется, только `available/contentType/text`).
6. A перешифровывает m1 ещё раз → m1″. После reload A видны m1′ и m1″ (оба `sent`),
   оригинал m1 скрыт. B получает m1′ и m1″ как два новых сообщения (v1-дедупа нет).
   Итог: **две одинаковые записи** — то самое нарушение «0 дублей».

**Воспроизведение (test-only harness на production-модулях, удалён).**

```
two same-session outbox rows m1,m2; anchor=m1
markOutboxSent(m1); markOutboxSent(m2); markOutboxSuperseded(m1)
m1.outbox.status = 'sent',  m1.copy.status = 'superseded'
selectRetryWindow(anchor=m1) -> candidates = [m1, m2]
expected: [m2]   // m1 уже заменён
```

То есть баг не в reload-пути (он закрыт), а в связке «outbox-статус остаётся `sent`» ↔
«`selectRetryWindow` — единственное место, которое решает, что перешифровывать».
F8A осознанно оставил `sent` как audit (REVIEW-10 это допускал), но не учёл, что окно
retry фильтруется по тому же статусу.

**Почему это P1, а не P2.** Триггер — поддерживаемый продуктовый сценарий
(частичный batch + явный «повторить», E7-F6 UI), а не экзотика: batch до 20 сообщений,
сеть может отказать на втором. Результат — видимые дубликаты у обоих участников, то есть
прямое нарушение G4-условия «0 дублей» и §5.5; это тот же класс, что и исходный P1-01.
`docs/E2EE-SPEC.md:683-691, 1169-1177` обещает окно от якоря и дедуп повторного reset
(«повтор не перешифровывает окно ещё раз»); G4-условие — «0 дублей». Повторная
перешифровка уже заменённого сообщения противоречит и тому, и другому.

**Что должно быть исправлено.**

- В `selectRetryWindow` исключать записи, у которых outgoing local copy уже `superseded`
  (минимальная правка: после `lookupLocalCopy` пропускать `copy.copy.status === 'superseded'`
  и не считать это `skipped`-ошибкой), **или** писать в outbox отдельный `supersededAt`
  и фильтровать по нему, оставив `status='sent'` как audit.
- Regression-тест: две записи одной failed-сессии, первая уже superseded → окно содержит
  только вторую; store-тест «частичный batch → retry» даёт ровно один replacement на
  оригинал (не два). Полезно также проверить `remaining/skipped`-счётчики.
- После фикса — rebuild образа (asset hash изменится) и повторный F7B.

## P2

### P2-15. Committed E2E reload-A проверяет не тот маркер (доказано)

`frontend/e2e/e2ee.real.spec.ts:869-890` после R-15 перезагружает A и требует
`markerA == 1` и `markerR15 == 1`. Но фактически заменённый R-15 оригинал — это
**`markerLost`** (`:825`; якорь reset — именно его `client_message_id`,
`frontend/src/e2ee/app/chatBridge.ts:711-718`): `markerA` был доставлен B до потери
сессии и не попадает в окно (`selectRetryWindow` берёт записи от якоря и позже), а
`markerR15` — новое сообщение после reset и вообще не связано с supersede.

Эксперимент (Playwright-harness, Chromium, удалён): после R-15 и перед reload A
в IndexedDB `krug-e2ee`/`localMessages` переведена обратно в `sent` ровно одна
outgoing-копия со статусом `superseded` (эмуляция pre-F8A состояния; harness вывел
`flipped copies: 1`). После reload:

```
markerLost count = 2, markerA count = 1
committed проверки markerA==1 и markerR15==1 — прошли
добавленная проверка markerLost==1 — упала (received 2)
```

На исправленном дереве без эмуляции тот же harness даёт `markerLost == 1`. Вывод:
reload-фикс работает, но committed E2E **не является regression-тестом** для P1-01;
F8A-отчёт «проверяет ровно один markerA/markerR15» технически верен, но маркеры выбраны
неверно. Нужно проверять `markerLost == 1` (и, желательно, отсутствие `superseded`-строки
в DOM), а также добавить сценарий частичного batch (P1-01b) хотя бы на store-уровне.

### P2-16. Расщеплённое состояние outbox `sent` / copy `superseded`

Сам по себе выбор «outbox остаётся `sent` как audit» допустим, но теперь инвариант
«заменённое сообщение больше не отправляется» живёт в двух записях, и любой код,
фильтрующий по outbox-статусу, его не видит. Сейчас это ровно `selectRetryWindow`
(P1-01b). Рекомендуется либо `supersededAt` в outbox-записи, либо явный фильтр по copy;
иначе следующий потребитель `listOutboxEntries` снова наступит на те же грабли.
Дополнительно: если `markOutboxSuperseded` бросит (IndexedDB/quota) уже после
`confirmSent`, оригинал останется `sent`+`sent`, и retry снова даст дубль — это тот же
класс, что P1-01b, но по error-пути.

### P2-17. Legacy-состояние до F8A не мигрируется

Устройства, у которых R-15 уже произошёл до F8A, имеют `outbox=sent`, `copy=sent`;
повторный `markSuperseded` для них не вызывается (нет re-drive), поэтому дубликат после
reload останется навсегда. Base-флаг false и production-копий нет, поэтому это
принятие/бэкфилл-решение, а не текущий дефект. При наличии pilot-данных нужна одноразовая
сверка/миграция или явное «переустановить локальное состояние».

### P2-18. Неполнота store-тестов P1-01

Из условия 2 REVIEW-10 осталось: нет отдельных store-тестов на `SPK_DELETED` и
`DECRYPT_FAILED` copy-restore (код покрыт общим `E2EE_COPY_RESTORE_CODES`, но не
проверен поштучно); нет committed-теста идемпотентности двойного
`markOutboxSuperseded` для `sent` (мой harness проверял, но в репозитории этого нет);
нет теста «partial batch → retry не перешифровывает заменённое» (P1-01b).
`control`-copy и negative replay с `message.id` уже покрыты (`e2eeChat.test.ts:172,263,294`).

### Остальные P2 из REVIEW-10 (статус)

| ID | Статус | Комментарий |
|---|---|---|
| P2-01 Чистый стек F7B | **OPEN** | Прогон снова использовал leftover `pickle-ui-1794919305193@krug.local`; `deploy/keycloak/realm-export.json` содержит только `testuser`. |
| P2-02 Destructive SQL по умолчанию | **OPEN** | `e2ee.real.spec.ts:50` `DB_CHECK=true`; `:205-218` `UPDATE auth.devices … REVOKED` без `E2EE_REAL_ALLOW_DESTRUCTIVE=1`. |
| P2-03 Накопление workspace/flag-on стек | **OPEN** | 57 → **61** `E2EE F7B` workspace после моих прогонов; контейнеры backend/frontend всё ещё flag-on; `krug-frontend:latest` — overlay-образ. |
| P2-04 Legacy incoming copies без `serverMessageId` | **OPEN** | `outboxStore.ts:1248-1253`; не менялось. |
| P2-05 `normative_invariants` векторов | **OPEN** | `docs/E2EE-TEST-VECTORS.json:201-202`: `16..33040` вместо `272..33040`; receiver-дедуп описан как v1, хотя спека §3.5.1/§5.5 называет его v1.1; `vector_set_version` = 4. |
| P2-06 `protectedSessionIds` в receive-реконсиляции | **OPEN** | `frontend/src/e2ee/session/receive.ts:411-415`; `chatBridge` передаёт их только в `loadChat` (`:554,610`). |
| P2-07 Negative key-change/TOFU live | **OPEN** | F8A не добавлял fixture; E2EE-AC-04 остаётся частичным. |
| P2-08 CI/checklist/git/log-capture | **OPEN** | `.github/` нет; `deploy/E2EE-ENABLE-CHECKLIST.md` нет; F7A/F7B не в `npm run check`; git-репозитория нет. |
| P2-09 Kill-switch/retention/multi-node | **OPEN** | Не менялось. |
| P2-10 F7B/image evidence | **CLOSED** | Новый образ и asset воспроизведены (см. ниже). |
| P2-11 WebKit UI в password-bootstrap | **OPEN** | `chatStore.ts:696-714` даёт общий session-error, а не `E2eeBanner`. |
| P2-12 Runtime Ed25519 KAT только empty | **OPEN** | `ed25519Kat.ts:18-70` — RFC 8032 TEST 1 (empty). |
| P2-13 Аттестация не привязана к показанному hash | **OPEN** | Не менялось. |
| P2-14 Evidence P1-01 | **PARTIAL** | +тест `sent→superseded` (закрыто); E2E-маркер и `SPK_DELETED`/`DECRYPT_FAILED` — нет (P2-15, P2-18). |

## F7B/image evidence

Независимо, не по отчёту:

| Проверка | Результат |
|---|---|
| container image | `krug-frontend`, `sha256:7b3c182a64fcf0902422c8f1846ec7223d5cace0db459532485b851d6cdd7eca`, created `2026-11-18T11:14:48Z` (14:14:48 MSK) |
| container | `krug-frontend` запущен `2026-11-18T11:14:51Z`, healthy |
| SPA asset | `assets/index-BeQEVtf6.js`, SHA-256 `311c0f41c0acf1d32db4318575b9c47d8abc38558c9458f223ae155a77767fbd` |
| `index.html` | SHA-256 `4b3fb44feba5a1dd27cee98d14d8e1ced08a0b1f8be340af26420f74a888b7f8`, ссылается на `index-BeQEVtf6.js` |
| прочие chunks | `browser-DGROf2up.js` `c295f3c0…`, `realtime-utE0HUoz.js` `923c3131…` |
| reproducibility | локальный `vite build` с точными build args (`VITE_API_BASE_URL=/api/v1`, `VITE_AUTH_MODE=password`, `VITE_DEVICE_NAME="Pickle — браузер"`, `VITE_APP_VERSION=0.1.0`, `VITE_REALTIME_ENABLED=true`, `VITE_MEDIA_ORIGINS=http://localhost:9000`, `VITE_E2EE_ENABLED=true`, `VITE_USE_MOCKS=false`, `VITE_DEV_SESSION=false`) дал **те же** 4 хеша — образ соответствует текущему дереву |
| source mtimes | после сборки изменены только `frontend/E7-F8A-REPORT.md` и `docs/TASKS.md` (14:16); ни одного SPA-файла (`src/**`, `e2e/**`) новее образа нет |
| flag in asset | `VITE_E2EE_ENABLED:"true"` |
| backend flag | `KRUG_E2EE_ENABLED=true` (только overlay) |
| base flags | `deploy/.env:44` — `KRUG_E2EE_ENABLED=false`; `deploy/docker-compose.yml:275,304` — `${KRUG_E2EE_ENABLED:-false}` |
| F7B | независимый прогон: **2 passed (28.4 s)**, Chromium 11.6 s, Firefox 15.1 s, без падений; запускался с `PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers` |
| F7A | независимый прогон: **12 passed** (Chromium 4/4, Firefox 4/4, WebKit 4/4 expected-unsupported) |
| full frontend | `npx vitest run` — **72 files / 756 tests passed** |
| targeted | outbox + e2eeChat + chatBridge + resetRetry — **77/77** |
| lint/format | `eslint` и `prettier --check` на изменённых F8A файлах — чисто |
| DB | 61 `E2EE F7B` workspace (до моих прогонов 57), 313 devices; прогоны используют leftover-B и destructive SQL |

**Что F7B доказывает и что нет.** F7B 2/2 подтверждает реальный keyed-flow, ENVELOPES-only,
отсутствие plaintext в DB/WS/логах и то, что после reload A нет дубля **по проверяемым
маркерам**. Независимый harness с `markerLost` подтверждает именно supersede. Но:
(a) committed-проверка смотрит не на `markerLost` (P2-15); (b) B после R-15 не
перезагружается, поэтому receiver-side дубликат v1.1 не проверяется; (c) прогон снова
на leftover-B и destructive SQL (P2-01/P2-02). То есть это доказательство **финального
артефакта** и reload-поведения A, но не чистого стека и не полного «0 дублей» на
retry-пути.

## Условия включения

Флаг остаётся `false`, пока не выполнены все пункты; каждый проверяем.

1. **P1-01b blocker — retry не должен перешифровывать заменённое.** Исключить в
   `selectRetryWindow` записи с `copy.status='superseded'` (или ввести `supersededAt`
   в outbox и фильтровать по нему), сохранив `sent` как audit при желании. Regression:
   две записи одной failed-сессии, первая superseded → окно только со второй; partial
   batch → retry даёт ровно один replacement на оригинал. **Плюс** перенацелить
   committed E2E (`e2ee.real.spec.ts:869-890`) на `markerLost == 1`, иначе CI не ловит
   P1-01. Без этого flag-on запрещён.
2. **P1-01 evidence completeness.** Store-тесты `SPK_DELETED`/`DECRYPT_FAILED` copy-restore
   (0 error-bubble, 0 POST reset); идемпотентность двойного `markOutboxSuperseded`;
   legacy-copy статус; явно записать, что receiver-side R-15 остаётся v1.1 (B после
   reload может показать оригинал и замену).
3. **Negative key-change/TOFU live + verified reset.** Test-only fixture легитимной
   ротации identity (валидная binding-подпись) или контролируемая SQL-мутация на
   одноразовом стенде: `KEY_CHANGE_DETECTED`, send blocked до accept, OPK не расходуется,
   сессия не перезаписывается, `verified` сброшен, после accept — re-verify; плюс L3b и
   multi-device E2E. Без этого E2EE-AC-04 остаётся частичным.
4. **Receiver R-15 v1.1.** Либо реализовать `retry_of_client_message_id` в inner TEXT и
   receiver-дедуп, либо явно принять продуктовое ограничение v1 «0 дублей не
   обещается» и убрать это обещание из UI/AC/отчётов. Решение владельца продукта,
   записанное до flag-on.
5. **Safari/iOS + WebKit UI.** App-level WebKit E2E с `VITE_E2EE_ENABLED=true` в
   password-режиме: unsupported browser показывает понятный экран/баннер, keyed
   registration и send не выполняются; либо отдельное ADR-решение, что весь SPA
   недоступен. Shipping Safari/iOS — отдельный gate; не объявлять Safari в floor без
   прогона.
6. **F7B чистая воспроизводимость/fixture.** `down -v` → overlay up → F7B 2/2 без ручной
   подготовки: B регистрируется через BFF/Mailpit (уникальные email/пароль), а не
   leftover; SQL-reset требует явного `E2EE_REAL_ALLOW_DESTRUCTIVE=1` и проверки
   контейнера/БД; после прогона — cleanup/reset и возврат base-compose. Сейчас
   `krug-frontend:latest` — flag-on образ; base `up -d` без rebuild поднимет flag-on SPA
   с flag-off backend.
7. **Векторы.** Исправить `normative_invariants` (`272..33040`, v1.1-статус
   receiver-дедупа), bump `vector_set_version`; `vectors.test.ts` не принимает 271 B и
   «16..33040» и не считает receiver-дедуп v1 реализованным; пересчитать/зафиксировать
   KAT hash.
8. **Release-CI/артефакт.** F7A-матрица с явной политикой (Chromium/Firefox blocking,
   WebKit expected-fail) и F7B на чистом стеке в release-CI; `log-capture` на отсутствие
   ciphertext/plaintext; полный backend suite; `deploy/E2EE-ENABLE-CHECKLIST.md`;
   clean rebuild после финальных правок с фиксацией image digest + asset SHA-256;
   git/tag/patch-bundle (one-PR). P2-10 закрыт для `7b3c182a…`, но после P1-01b
   rebuild обязателен.
9. **Legacy copies/local state.** Миграция/бэкфилл incoming-копий без
   `serverMessageId`/`client_message_id` и pre-F8A outbox/copy `sent` — или явное
   принятие: после включения такие копии могут не найтись/дать replay-риск/дубликат.
10. **Kill-switch/retention/rollout.** Проверить flag-off kill-switch (REST/WS/replay 409,
    `server_last_seq` не теряет seq), retention envelopes/quarantine, rate limits,
    demo/test users, отключение dev-session; сначала E2EE-workspace pilot на
    Chromium/Firefox, затем общий flag-on; Safari — отдельно.

## Остаточные риски

- **P1-01b:** retry после частичного batch даёт второй replacement и видимый дубликат у A
  и B — до исправления. Это главный release-блокер.
- **Receiver-side R-15 v1.1:** B без маркера в TEXT не может сопоставить старый и новый
  client id; после reload B может показать оригинал и замену. В v1 не обещается.
- **Legacy local state:** pre-F8A `outbox=sent`/`copy=sent` не мигрируется; устройства с
  прошлым flag-on сохранят дубликат.
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
  нет внешнего третьего crypto-аудита; workspace'ы накапливаются (57 → 61 за это ревью);
  flag-on образ остаётся `krug-frontend:latest`.
- **Артефакт:** отсутствие git/CI означает, что committed E2E-проверки — единственный
  автоматический барьер; пока он смотрит не на тот маркер (P2-15), регрессия P1-01
  может вернуться незамеченной.

## Вопросы

1. **P1-01b:** кто владелец фикса `selectRetryWindow`? Предпочтителен фильтр по
   `copy.status='superseded'` или отдельный `supersededAt` в outbox (с сохранением
   `sent` как audit)? Можно ли считать `superseded` outbox-статусом для sent-строк,
   если late-confirm в текущем flow невозможен?
2. **E2E:** кто перенацелит reload-A на `markerLost == 1` и добавит partial-batch
   retry-сценарий (store-уровень обязателен, E2E — желателен)? Без этого CI не ловит
   P1-01.
3. **Receiver v1.1:** входит ли receiver-дедуп в flag-on, или PM явно принимает
   ограничение v1 «0 дублей не обещается» и убирает обещание из UI/AC?
4. **Key-change live:** кто предоставит test-only fixture легитимной ротации identity и
   одноразовый стенд для `KEY_CHANGE_DETECTED`/verified reset?
5. **Safari/iOS:** нужен ли отдельный экран «browser unsupported» в password-bootstrap,
   или допустим общий session-error? Кто владелец shipping-Safari gate?
6. **F7B fixture:** можно ли добавить регистрацию B через BFF/Mailpit и
   destructive-opt-in, чтобы F7B шёл в CI на чистом стеке? Кто владелец cleanup/CI-БД?
7. **Векторы:** исправляем `normative_invariants` с bump `vector_set_version` или
   отдельным erratum без изменения байтовых KAT? Кто перепроверит hash/24+3 KAT?
8. **Legacy state:** нужна ли миграция pre-F8A `outbox=sent`/`copy=sent`, или при
   отсутствии production-копий достаточно документированного принятия?
9. **Release:** когда git/tag/patch-bundle и финальный rebuild после P1-01b, полный
   backend suite, F7A/F7B на release-candidate? Без этого G4-подпись неполная.

---

**Статус G4c: DONE (ревью завершено).** P0 нет; P1-01 — PARTIAL из-за retry-пути
(P1-01b), reload-часть закрыта и независимо подтверждена; P1-02/P1-03/P1-04 и P2-10
закрыты. Итог: **в текущем дереве flag-on — NO-GO**; после P1-01b + условий 1–10 —
**GO WITH CONDITIONS** для пилота Chromium/Firefox. Код/контракты/спека/векторы/
`docs/TASKS*` не изменялись; создан только этот файл. Временные harness'ы удалены;
побочный эффект прогонов — +4 `E2EE F7B` workspace и +8 devices на одноразовом стенде,
SQL-reset отозвал устройства fixture-пользователей (P2-02/P2-03).

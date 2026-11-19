# E2EE-REVIEW-14 — G4f final enable review (после закрытия pilot-условий)

> **Рецензент:** независимый security/crypto-ревьюер; в E2EE-PILOT-1…4 не участвовал.
> **Дата:** 2026-11-19. **Вход:** `docs/E2EE-REVIEW-13.md`, `docs/E2EE-REVIEW-12.md`,
> `docs/E2EE-ENABLE-CHECKLIST.md`, `frontend/E2EE-PILOT-1/2/3/4-REPORT.md`,
> `docs/E2EE-SAFARI-IOS.md`, `docs/E2EE-LEGACY-OUTBOX.md`, `docs/E2EE-SPEC.md` (§3.5.1/§5.5/§7),
> `docs/E2EE-TEST-VECTORS.json` v5, `.github/workflows/ci.yml`, `.github/workflows/e2ee-gated.yml`,
> CI runs 44481313079 / 44481979508, `deploy/docker-compose*.yml`, `deploy/.env.example`,
> фактический образ/контейнеры, живая БД и логи.
> **Зона:** создан только этот файл. Код, контракты, спека, векторы, `docs/TASKS*`,
> base-флаги и compose-файлы не изменялись. Временный test-only harness (unit-уровень
> на production-модулях) создавался вне production-кода, прогнан и удалён; git-репозитория
> в workspace нет, поэтому проверялось фактическое дерево и GitHub-состояние.
> **Побочные эффекты:** независимый F7B-прогон (`E2EE_REAL_RESET=1`) на одноразовом
> overlay-стенде создал 2 fixture-пользователя `e2ee-r14-*`, удалил свой workspace
> (stale-cleanup выполнен); после прогона base-стек восстановлен
> (`KRUG_E2EE_ENABLED=false`, образ `a24ae4fb…`, asset `index-CioOgmBt.js`), логи без
> маркеров, в БД 0 `E2EE F7B` workspace’ов. F7A/F7B-спеки и `test-results` — побочные
> артефакты Playwright, не production-код.

## Вердикт

**NO-GO на включение `KRUG_E2EE_ENABLED=true` в base.** P0 нет.

Пилотные ворота по чеклисту — условия 1–3 + release-артефакт (8). Из них условие 1
(committed regression) и 3 (durable retry/drain) закрыты и проверены; условие 2
(clean-stack) и 8 (tag/release report) — **PARTIAL**; receiver-дедуп (5) и
kill-switch/rollout (10) для base — **не закрыты**. Поэтому формулировка «все pilot
conditions закрыты» деревом и GitHub-состоянием **не подтверждается**.

Главный новый дефект: **receiver-side R-15 v1.1 dedupe живёт только в памяти
рендера**. В одной сессии replacement скрывается корректно (`frontend/src/store/chatStore.ts:2803-2829`),
но после reload B восстанавливает sealed incoming copy и показывает и оригинал, и
замену; кроме того, сервер уже создал для replacement обычную строку/seq,
unread и notification, которые клиент не отменяет. Это ровно тот сценарий, который
v1.1 должен был закрыть, и он не покрыт ни committed-тестом, ни F7B.

| Scope | Вердикт |
|---|---|
| Base `KRUG_E2EE_ENABLED=true` (все пользователи/устройства) | **NO-GO** — P1-01, P1-02, P1-05; плюс P1-03/P1-04 |
| Chromium/Firefox canary (не base, отдельный стек, pilot users) | **GO WITH CONDITIONS** — после P1-04 и P1-03, и либо фикса P1-01, либо явного PM-acceptance reload/unread-дубля для пилота |
| Safari/iOS | отдельный gate; runtime floor блокирует, shipping Safari не сертифицирован |

F7A **12/12** (Chromium/Firefox/WebKit expected-unsupported) и F7B **2/2**
(Chromium 8.7 s, Firefox 11.3 s) независимо зелёные на overlay-образе
`4b0781a2b703` / asset `index-BiupBGzh.js` `a4d0645a…`; full frontend — **871/871**
с временным harness (870 без него), targeted — 134/134; base-флаги `false`.

## P0

**Открытых P0 нет.**

V5 не меняет крипто-ядро, wire-фрейминг, AD или серверные проверки: marker —
optional-поле внутри уже запечатанного `TEXT_JSON` (`frontend/src/e2ee/protocol/payload.ts:138-147`),
сервер его не видит. Нормальные v1-байты не изменились: D1 `body_hex` побайтно равен
`{"text":"Привет, Боб!","reply_to_id":null}`.

| P0-класс | Результат | Доказательство |
|---|---|---|
| Plaintext E2EE-строк на сервере | нет | независимый F7B: все строки чата `E2EE_PAIRWISE`, `body_ciphertext IS NULL`, `content_meta='{}'`; 0 не-E2EE строк; F7B DB-ассерты прошли |
| Plaintext/ciphertext в логах/WS | нет | F7B сканирует WS-кадры/backend logs; мой `logs --since 10m`: 0 вхождений `markerA/markerB/markerLost/markerR15/f7b_` |
| Конверты чужих устройств / `X-Device-Id` | не переоткрыто | v5 не менял `ApiRequestPath`/`DeviceBindingFilter`; F7B идёт реальным keyed-flow |
| 512 KiB / floor 272 B / canonical b64u | держится | live envelopes F7B — 272..33040 B; `ck_envelopes_ciphertext_min` validated; `envelope.test.ts:183-197` |
| RLS/tenant boundary | держится | `relforcerowsecurity=t` для `message_envelopes`/`key_verifications`; не менялось |
| Nonce/MK reuse в store | не найден | full unit suite, включая KAT/session-store; v5 не трогал ratchet |
| KAT/tamper ядра | зелёные | F7A 12/12 в реальных Chromium/Firefox/WebKit; vectors 24/24; session KAT в full suite |
| Type/schema drift | нет | `tsc --noEmit` exit 0; product-файлы побайтно совпадают с CI-коммитом 2fa90834 |

Почему receiver-дефект — не P0: конфиденциальность не ломается, ключи/plaintext не
утекают, sealed copies остаются. Страдает целостность UI/доставки (видимый дубль,
фантомный unread/notification), поэтому это release-blocker для base flag-on, а не P0.

## P1

### P1-01. Receiver R-15 v1.1 dedupe не durable и не подавляет unread/notification

**Статус:** OPEN; условие 5 REVIEW-13 не закрыто, `E2EE-PILOT-4-REPORT.md` и #32
заявляют DONE преждевременно.

**(a) В одной сессии работает.** Переотправленный TEXT несёт
`retry_of_client_message_id` (`payload.ts:138-147`), sender кладёт original
`client_message_id` (`frontend/src/store/chatStore.ts:3277`), а `decryptE2eeSlice`
при `outcome.kind === 'message'` скрывает replacement, если original уже
`decrypted`/`superseded`, и наоборот (`chatStore.ts:2803-2829`). Committed-тест
`frontend/src/store/e2eeChat.test.ts:953-993` это проверяет. Нормальные v1-байты
не меняются (D1 exact), marker серверу не виден.

**(b) После reload dedupe исчезает.** Sealed incoming copy не хранит marker и не
помечается `superseded`:
`LocalMessageCopy` (`frontend/src/e2ee/outbox/types.ts:126-140`) не содержит
`retryOfClientMessageId`, incoming-копия создаётся со статусом `received`
(`frontend/src/e2ee/outbox/outboxStore.ts:519`), а все `status: 'superseded'`
записи относятся к **outgoing** outbox/copy (`outboxStore.ts:1207-1214,1274-1291,1627-1637`).
На reload `receive()` отвечает `DUPLICATE_OR_OLD_MESSAGE` → `kind:'none'`
(`frontend/src/e2ee/app/chatBridge.ts:743-790`), store восстанавливает копию через
`lookupIncomingCopy`/`copyView` (`chatStore.ts:2722-2732,2792-2802`), а `copyView`
показывает `decrypted`, если статус не `superseded`. Клиент не знает, что это
replacement.

**Репро (test-only harness на production ChatStore, удалён; 1/1):**

```
original: client_message_id=X, decrypted -> copy status 'received'
replacement: client_message_id=Y, marker=X, hidden as 'superseded' in session 1
seed both incoming copies exactly as commitIncomingE2eeMessage writes them
reload store B: receiveQueue -> [{kind:'none'}, {kind:'none'}]
result: original='decrypted', replacement='decrypted'   // duplicate after reload
```

То есть `superseded` — это только view-состояние в памяти. Если original был
`failed` (не расшифрован), после reload он снова рендерится как error, а
replacement — как decrypted: ошибка + замена вместо «failed-row hidden».

**(c) Unread/notification не подавляются даже в одной сессии.** Replacement — это
новая строка с новым `seq`; сервер публикует обычный `MessageCreatedNotification`
(`backend/.../MessageSubmissionHandler.java:258`), listener создаёт in-app
notification (`NotificationMessageCreatedListener.java:30-35`,
`NotifyUseCase.java:72-95`), а `unread_count = next_seq-1 - last_read_seq`
(`ChatRepositoryAdapter.java:105-106`). Клиент скрывает bubble, но не помечает
replacement прочитанным и не удаляет notification. Спека §3.5.1/§5.5 требует
«0 UI-дублей, 0 unread, 0 уведомлений» (`docs/E2EE-SPEC.md:689-691,3069`).
Заявление PILOT-4 «no UI duplicate/unread/notification» **не подтверждается**.

**(d) F7B это не покрывает.** В R-15-сценарии B не перезагружается после получения
replacement: reload делает только A (`frontend/e2e/e2ee.real.spec.ts:869-900`).
F7B также не проверяет unread/notification для replacement.

**Что исправить.** Persist marker/outcome в sealed incoming copy (добавить
`retry_of_client_message_id` в `LocalCopyPayloadV1`/`StoredLocalMessageCopy`) или
durable local dedupe-запись; на reload скрывать replacement, если original
`decrypted`, и скрывать failed-original, если replacement показан; при dedupe
помечать replacement прочитанным/удалять notification (или не создавать его для
replacement на сервере — но сервер marker не видит). Regression: two-store reload
(как выше), unread/notification count, failed-original reload; mutation-check на
pre-fix коде.

**Классификация:** P1 / release-blocker условия 5 и base flag. Не P0: утечки нет.

### P1-02. #37 kill-switch/retention/rollout закрыт без evidence

Issue [#37](https://github.com/fso13/AthenaeumHub/issues/37) закрыт
`2026-11-19T07:21:37Z` **без комментария и без отчёта**, при этом
`docs/E2EE-ENABLE-CHECKLIST.md:52` всё ещё говорит **OPEN**, а #38 — BLOCKED.
Acceptance #37: «flag off/on without data loss; retention/quarantine policy;
dashboards/alerts; rollback steps».

Что есть: backend IT на `409 E2EE_DISABLED` (`E2eeMessageFlagOffIT`,
`E2eeMessageRealtimeIT`) — код kill-switch покрыт. Чего нет: live flag-off/on
rehearsal на canary, проверки `server_last_seq`/seq при выключении, retention/
quarantine purge, rate limits на E2EE-путях, dashboards/alerts, staged pilot/soak/
stop conditions, подписанного GO. Все preflight-боксы §2 чеклиста не отмечены.
Base-флаг глобальный (`krug.e2ee.enabled`), а не per-workspace, поэтому «пилот на
workspace» = canary-деплой, а не UI-toggle.

**Классификация:** P1 / blocker условия 10 и base flag-on.

### P1-03. Release-артефакт и tag не привязаны к финальному дереву

CI зелёный: run
[44481313079](https://github.com/fso13/AthenaeumHub/actions/runs/44481313079)
(коммит `2fa90834`, 4/4 job success) и более поздний
[44481979508](https://github.com/fso13/AthenaeumHub/actions/runs/44481979508)
(`713f52b4`, success). Product-файлы (`payload.ts`, `outbox/types.ts`,
`chatStore.ts`, vectors) побайтно совпадают с `2fa90834`; `outbox.test.ts` — с
`713f52b4`.

Но:

- **tag/release/patch-bundle отсутствуют:** GitHub API `/tags` — 0, `/releases` — 0;
  one-PR/tag из условия 8 не выполнен.
- **release-check report привязан к pre-v5 образам:** `docs/E2EE-CI-REPORT.md:165-177`
  фиксирует backend `b682140f…` (07:04Z), frontend `61008a3e…` (07:05Z), asset
  `index-uGIjhkd3.js` (07:05Z). Правки `payload.ts`/`chatStore.ts` — 07:31–07:32Z,
  vectors — 07:34Z. То есть отчёт старше v5.
- **Текущий base-образ не в отчёте:** `krug-frontend:latest` =
  `a24ae4fb1f84` (07:38:08Z), asset `index-CioOgmBt.js`
  `1e70ec1f0bd5…`; отчёта/digest-записи для него нет.
- **F7A/F7B не в release-CI:** `.github/workflows/e2ee-gated.yml` на GitHub имеет
  **0 runs** (API `total_count: 0`); F7A/F7B гонялись только локально.
  PILOT-4 не фиксирует ни image digest, ни asset SHA, ни run URL.

Я независимо прогнал F7A/F7B на overlay-образе `4b0781a2b703` / asset
`index-BiupBGzh.js` `a4d0645a…` (F7B 2/2) и на base-образе `a24ae4fb1f84` /
asset `index-CioOgmBt.js` `1e70ec1f…` (base flag false) — это reviewer-evidence,
но **не замена** release-check report/tag и gated CI.

**Классификация:** P1 / blocker условия 8; для пилота — release-артефакт ещё не
готов.

### P1-04. Clean-stack F7B (#29) не выполнени до конца

PILOT-1 честно фиксирует (residual risk #1): **DB volume не пересоздавался**;
clean-path доказан новыми BFF/Mailpit-аккаунтами и уникальным workspace на
существующем одноразовом volume. Condition 2 REVIEW-13 требует
`down -v → overlay up → F7B 2/2 без ручной подготовки`. Gated workflow
`real-two-device` делает `up -d --build` и `down` (volumes сохраняются, если
`reset_volumes=false`), то есть **не** `down -v` перед прогоном
(`.github/workflows/e2ee-gated.yml:199-204,245-256`). Checklist `:44` всё ещё
**OPEN**; issue #29 закрыт без комментария.

Fixture при этом существенно лучше прежнего: B регистрируется через BFF/Mailpit,
destructive SQL только по `E2EE_REAL_RESET=1`, workspace уникален. Мой F7B тоже
шёл на существующем volume (reset=1 чистил после), поэтому empty-volume evidence
по-прежнему нет.

**Классификация:** P1 для pilot gate; можно принять как P2 только с явным
документированным acceptance и отдельной CI-задачей.

### P1-05. Multi-device/L3b live и условие 4 закрыты не полностью

Condition 4 REVIEW-13 требовал negative key-change/TOFU **плюс L3b и multi-device
E2E**. PILOT-3 закрыл key-change live (2/2, SQL-мутация на одноразовом стенде) и
добавил два committed regression (chatBridge/e2eeChat; я прогнал 13+30 тестов —
зелёные). Но:

- F7B — **два устройства** A/B; fan-out на 3+ устройства (свои другие устройства
  отправителя, несколько устройств получателя) live не проверен;
- L3b live не проверен: F7B не перезагружает B после replacement и не проверяет
  dedupe/unread/notification (см. P1-01);
- PILOT-3 прямо пишет, что L3b/multi-device не входили в #31.

**Классификация:** P1 для base/general; для пилота можно принять 2 устройства с
записанным ограничением, но не для «всех пользователей».

## P2

### P2-01. Статусы условий расходятся с issue/деревом

`docs/E2EE-ENABLE-CHECKLIST.md` (коммит `713f52b4`) всё ещё:
#29 — **OPEN** (`:44`), #30 — **OPEN** (`:45`), #35 — **IN PROGRESS** (`:50`),
#37 — **OPEN** (`:52`), frontend — **867 tests** (`:67`). Фактически issue
#29–#37 закрыты, #35 имеет зелёные runs, локально 870 committed tests. Это не
функциональный дефект, но GO-запись нельзя подписывать по устаревшей таблице.

### P2-02. Метаданные spec/vectors отстали от v5

`docs/E2EE-SPEC.md:1-3` — «(v1)», «редакция S4», «vectors … `vector_set_version=4`»,
«Production-код не написан». Фактически v5/48 векторов, код в production-дереве
(flag off). `docs/E2EE-TEST-VECTORS.json:7` — `status: "normative v4 …"`;
`:12` — `verify_command` «273 checks»/v4. Нормативные инварианты при этом
исправлены: `ciphertext_cap` 272..33040 (`:202`), `reset_retry_window` описывает
receiver dedupe (`:201`). Нужен docs-пасс перед tag; на wire/крипту не влияет.

### P2-03. F7B DB plaintext scan не включает `markerLost`

`frontend/e2e/e2ee.real.spec.ts:994-1000` ищет `markerA/markerB/markerR15`, но не
`markerLost` (он проверяется в WS/логах `:931,:940` и в UI). P2-20 REVIEW-13
остаётся. Добавить `markerLost` в оба DB-запроса.

### P2-04. Safari/iOS: runtime gate есть, app-level WebKit E2E нет

`docs/E2EE-SAFARI-IOS.md` и `E2eeBanner` (`frontend/src/components/E2eeBanner.tsx:109-117`)
дают честный unsupported-баннер; unit-тест `E2ee.test.tsx:164-180` проверяет
disabled send. F7A WebKit row проходит как expected-unsupported (я прогнал 12/12).
Но condition 6 просил **app-level WebKit E2E с `VITE_E2EE_ENABLED=true` в
password-режиме**; такого теста в `frontend/e2e` нет — только runtime floor и
manual checklist. Shipping Safari/iOS — отдельный gate; не объявлять Safari в floor.

### P2-05. Legacy pre-F8B copy-superseded без `supersededAt` не guard-ится

`docs/E2EE-LEGACY-OUTBOX.md` говорит «heal on transition» и «`retryOutboxEntry`
never resurrects a row that … is superseded». Но `selectRetryWindow` фильтрует
только `entry.status`/`supersededAt` (`frontend/src/e2ee/app/resetRetry.ts:237-241`),
а не `copy.status`; pre-F8B состояние (`outbox=sent`, `copy=superseded`, без
`supersededAt`, без replacement-строки) не имеет перехода, который бы его вылечил.
Для base с нулём production-копий это acceptance-риск; для pilot-устройств с
прошлым flag-on — переустановка/wipe. Doc стоит уточнить, что это не
«never resurrects» для legacy-copy.

### P2-06. PILOT-4/F7A/F7B evidence не привязан к артефакту

`frontend/E2EE-PILOT-4-REPORT.md` не содержит image digest, asset SHA или run URL;
F7A 12/12 и F7B 2/2 заявлены «after v5» без привязки. Я независимо привязал:
overlay `4b0781a2b703` / asset `index-BiupBGzh.js` `a4d0645a…` (F7B 2/2),
base `a24ae4fb1f84` / asset `index-CioOgmBt.js` `1e70ec1f…` (flag false). Отчёт
стоит дополнить этими хэшами и датой/временем.

### P2-07. Fixture users/workspace’ы накапливаются

После моего F7B остались 2 пользователя `e2ee-r14-*` (всего 26 `e2ee-*`);
workspace’ы удалены reset-режимом. Для CI нужен периодический reset чистой БД;
это не дефект E2EE, но гигиена одноразового стенда.

### P2-08. Нет внешнего третьего crypto-аудита

F7A/F7B/KAT/векторы — сильное инженерное evidence, но не заменяют независимый
внешний аудит крипто-ядра; для base flag-on это остаётся residual risk.

## Условия

| # | Условие REVIEW-13 | Статус на 2026-11-19 | Evidence / чего не хватает |
|---|---|---|---|
| 1 | Committed regression P1-01c/P1-05 | **CLOSED** | `frontend/src/e2ee/app/resetRetry.test.ts:175-299` (cross-chain, superseded anchor, `maxBatch`); 12/12 tests pass; тест падает на старом anchor-фильтре |
| 2 | Clean-stack F7B (#29) | **PARTIAL** | BFF/Mailpit, destructive opt-in, уникальный workspace — DONE; empty-volume/`down -v` — нет; checklist `:44` OPEN |
| 3 | Durable retry/drain (#30) | **CLOSED** | `outbox.test.ts` 41/41 (ambiguous POST, reload drain, atomic supersede, retry intent); F7B 2/2; PILOT-2 |
| 4 | Key-change/TOFU + L3b + multi-device (#31) | **PARTIAL** | key-change live 2/2 (PILOT-3), committed tests; multi-device 3+ и L3b live — нет |
| 5 | Receiver R-15 v1.1 (#32) | **NOT CLOSED** | marker + in-session hide работают; reload-дубль и unread/notification — P1-01 |
| 6 | Safari/iOS + WebKit UI (#33) | **PARTIAL** | runtime gate, banner, unit test, F7A WebKit expected-unsupported; app-level WebKit password-mode E2E — нет; shipping Safari — отдельно |
| 7 | Vectors v1.1 (`272..33040`, v5) (#34) | **CLOSED (functional)** | `vector_set_version=5`, 48/18, cap 272..33040, D1 exact; vectors 24/24 + F7A 12/12; metadata P2-02 |
| 8 | Release CI/artifact/tag (#35) | **PARTIAL** | CI runs 44481313079/44481979508 green; checklist/scripts в дереве; tag/release/patch-bundle — нет; release report pre-v5; gated workflow 0 runs |
| 9 | Legacy/local state (#36) | **PARTIAL** | read fallback + heal on transition + test; pre-F8B copy-superseded без `supersededAt` не guard-ится; pilot devices — wipe |
| 10 | Kill-switch/retention/rollout (#37) | **NOT CLOSED** | code IT на 409; live rehearsal/retention/dashboards/canary/GO — нет; issue closed без evidence, checklist OPEN |
| — | Enable (#38) | **BLOCKED** | by #29–#37 + P1-01/02/05 |

**Pilot gate (Chromium/Firefox):** 1, 3, 7 — закрыты; 2 и 8 — PARTIAL; P1-01
(receiver) для пилота нужно либо починить, либо явно принять с записанным
ограничением. **Base gate:** все 1–10, включая 5, 10, 4, 6, 9; сейчас — NO-GO.

## Evidence

### CI и GitHub-состояние

| Проверка | Результат |
|---|---|
| CI run 44481313079 | `2fa90834`, 4/4 jobs success, created 2026-11-19T07:39:34Z; backend/frontend/contract/guardrails |
| CI run 44481979508 | `713f52b4`, success (последний коммит с Safari/legacy docs + test) |
| CI run 44478559905 | `afab4914`, success (ранний #35) |
| Product-tree ↔ commit | `payload.ts`, `outbox/types.ts`, `chatStore.ts`, `E2EE-TEST-VECTORS.json` — SAME at `2fa90834`; `outbox.test.ts` — SAME at `713f52b4` |
| Tags/releases | 0 tags, 0 releases (GitHub API) |
| Gated workflow | `e2ee-gated.yml` — 0 runs (API) |
| Issues | #29–#37 closed; #38 open; #37 закрыт без комментария при checklist OPEN |

### Независимые прогоны

| Проверка | Результат |
|---|---|
| Full frontend | **81 files / 870 tests passed** без harness (82 files / 871 с temporary harness); 51–53 s |
| Targeted | vectors 24 + payload 14 + resetRetry 12 + outbox 41 + e2eeChat 30 + chatBridge 13 = **134/134** |
| `tsc --noEmit` | exit 0 |
| Base flag guard | `scripts/check-e2ee-base-flags.sh` — 6/6 ok, exit 0 |
| F7A | **12/12 passed** (Chromium 4, Firefox 4, WebKit 4 expected-unsupported), 12.7 s; KAT из `docs/E2EE-TEST-VECTORS.json` с SHA-сверкой |
| F7B | **2 passed, 2 skipped** (key-change gate off): Chromium 8.7 s, Firefox 11.3 s; overlay image `4b0781a2b703`, asset `index-BiupBGzh.js` `a4d0645a…`; backend flag true |
| F7B logs | 0 вхождений `markerA/markerB/markerLost/markerR15/f7b_` |
| F7B DB | все строки E2EE, `body_ciphertext IS NULL`, envelopes 272..33040; после cleanup 0 `E2EE F7B` workspace |
| Base restore | `krug-frontend` `a24ae4fb1f84`, asset `index-CioOgmBt.js` `1e70ec1f…`, `KRUG_E2EE_ENABLED=false`, health `ok` |
| Receiver harness | both `decrypted` after reload (P1-01b); test-only file deleted |

### Base/overlay flags

| Место | Значение | Проверка |
|---|---|---|
| `deploy/.env.example:45` | `KRUG_E2EE_ENABLED=false` | guard 6/6 |
| `deploy/docker-compose.yml:275,304` | `${KRUG_E2EE_ENABLED:-false}` для backend и `VITE_E2EE_ENABLED` | base defaults false |
| `frontend/Dockerfile:19` | `ARG VITE_E2EE_ENABLED=false` | guard |
| `deploy/docker-compose.e2ee-test.yml:11,15` | `"true"` | только test overlay |
| running backend | `KRUG_E2EE_ENABLED=false` после restore | `docker inspect` |
| SPA asset base | `index-CioOgmBt.js` `1e70ec1f…` | flag off |

### Vectors/wire

`vector_set_version=5`, 48 vectors / 18 sections, `ciphertext_cap` 272..33040,
`reset_retry_window` описывает optional marker + receiver dedupe; D1 body exact;
marker добавляется только при наличии (`payload.ts:142-147`), normal v1 TEXT
не меняется. F7A 12/12 подтверждает KAT/vectors в реальных браузерах; WebKit
блокируется по RFC 8032 (expected-unsupported).

### Что evidence не доказывает

- не доказывает reload-дедуп получателя (P1-01) — наоборот, harness его опровергает;
- не доказывает unread/notification suppression для replacement;
- не доказывает multi-device 3+;
- не доказывает clean-volume F7B;
- не доказывает live kill-switch/retention/canary (#37);
- не заменяет tag/release-check report и внешний crypto-аудит.

## Rollout

Вердикт **NO-GO** для base; ниже — условный план, который станет применим только
после закрытия P1-01/P1-02/P1-05 и evidence P1-03/P1-04.

### Preflight (до любого flag change)

1. Закрыть P1-01: durable receiver dedupe + reload/failed-original/unread/
   notification regression; full suite зелёный.
2. Закрыть P1-02: live kill-switch на canary, `server_last_seq` не назад,
   retention/quarantine purge, rate limits, dashboards/alerts, canary/soak/stop
   conditions; подписанный GO (§8 чеклиста).
3. Закрыть P1-05: 3+ устройства, fan-out/self-devices, L3b live.
4. Release artifact: `git tag`/patch-bundle, `scripts/release-check.sh --build-images`
   на финальном коммите, report с image digest + asset SHA; `check-e2ee-base-flags.sh`;
   `.github/workflows/e2ee-gated.yml` F7A (Chromium/Firefox blocking, WebKit
   expected-fail) + F7B clean-stack 2/2; log-capture.
5. Clean-stack: `down -v` → overlay up → F7B 2/2 → cleanup → base restore.
6. Backup/restore rehearsal (§3), V19/V20 preflight on DB copy (§4), metrics §5.
7. Base flags остаются `false`; overlay — только disposable; SPA для canary
   собирается отдельно с `VITE_E2EE_ENABLED=true` (не через production base).

### Canary (Chromium/Firefox only)

```bash
# отдельный canary stack/project, не test overlay и не production base
cd deploy
KRUG_E2EE_ENABLED=true docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
curl -fsS http://localhost:8088/healthz
# F7A: Chromium/Firefox blocking, WebKit expected-fail
# F7B: E2EE_REAL=1 E2EE_REAL_DB_CHECK=1 E2EE_REAL_RESET=0 npm run test:e2e:e2ee:real
```

Пилотные users/workspaces — только Chromium/Firefox; Safari/iOS исключены;
soak ≥ 7 дней (предложение чеклиста); exit criteria — §5 metrics green.

### Rollback / kill switch

```bash
# 1) backend runtime (без rebuild)
cd deploy
KRUG_E2EE_ENABLED=false docker compose --env-file .env up -d backend

# 2) SPA compile-time: rebuild с флагом off
KRUG_E2EE_ENABLED=false docker compose --env-file .env up -d --build frontend

# 3) verify
curl -fsS http://localhost:8088/healthz
./scripts/check-e2ee-base-flags.sh
```

Проверить: E2EE REST/WS отвечают `409 E2EE_DISABLED` до парсинга; managed-сообщения
идут; `server_last_seq` не назад; envelopes **не** удалены; stale bundle получает
409; retention/quarantine jobs работают; rollback на предыдущий image digest.
V19/V20 forward-only: DB restore возвращает и schema version, приложение
откатывать к соответствующему образу. При data-level сбое — restore §3 в окне
обслуживания.

## Остаточные риски

- **P1-01 reload:** после R-15 B может показать original + replacement (или
  error + replacement) после reload; unread/notification остаются. До фикса это
  пользовательский дефект, не утечка.
- **P1-02 rollout:** kill-switch/retention/canary не проверены live; flag-off
  тесты покрывают 409, но не seq/retention/dashboards.
- **Multi-device:** 3+ устройства, свои другие устройства, несколько устройств
  получателя live не проверены; fan-out/coverage может дать пропуск/дубль.
- **Legacy:** pre-F8B `sent`+copy `superseded` без `supersededAt` может
  переотправить заменённое; pilot-устройства с прошлым flag-on — wipe.
- **Safari/iOS:** runtime gate блокирует, но app-level password-mode WebKit E2E
  нет; Playwright WebKit ≠ shipping Safari; shipping — отдельный gate.
- **No PCS/backup v1:** потеря ключей/профиля = потеря истории; local copies не
  backup.
- **TOFU:** первый контакт уязвим; safety number — единственный независимый
  канал; серверный `verified` — attestation, не доказательство.
- **Malicious server replay:** legacy incoming copies без `serverMessageId` могут
  показать старый текст под новым `message.id`; для новых копий binding есть.
- **Single-node:** WS/rate-limiter/outbox in-process; `chat.keys.changed`/
  `device.list.changed` не durable.
- **Retention/privacy:** envelope/quarantine retention не отрепетирован;
  ciphertext/метаданные бессрочно.
- **Testing:** F7B — один host/два контекста; no git/one-PR в workspace; нет
  внешнего аудита; fixture users накапливаются; release report/tag отсутствуют.
- **Unread/notification:** даже после reload-фикса серверный unread/notification
  нужно отдельно подавлять для скрытого replacement, иначе badge/bell врут.

## Вопросы

1. **P1-01:** кто владелец durable receiver-дедупа? Persist marker в
   `LocalCopyPayloadV1`/`StoredLocalMessageCopy` или отдельная dedupe-таблица?
   Входит ли подавление unread/notification в v1.1, или PM принимает «bubble
   скрыт, badge/bell остаются»?
2. **P1-02/#37:** кто предоставит live kill-switch/retention/canary evidence?
   Почему issue закрыт без комментария, а checklist всё ещё OPEN? Нужен ли
   отдельный rollout-отчёт до #38?
3. **P1-03:** когда tag/release/patch-bundle и release-check report на финальном
   коммите с image digest + asset SHA? Кто владелец gated-F7A/F7B run?
4. **P1-04/#29:** когда `down -v` clean-stack F7B и кто меняет default
   `reset_volumes`/pre-run cleanup в gated workflow?
5. **P1-05:** кто добавит 3+ устройства и L3b live? Достаточно ли 2 устройств
   для пилота с записанным ограничением?
6. **Safari:** нужен ли app-level WebKit password-mode E2E до base flag-on, или
   runtime gate + manual checklist достаточно, а Safari остаётся отдельным gate?
7. **Legacy:** переустановка pilot-устройств или миграция pre-F8B
   `sent`+`superseded`? Кто владелец?
8. **Release scope:** base flag-on сейчас или только Chromium/Firefox canary?
   Если base — нужны все 1–10; если canary — 1–3+8 и явное принятие P1-01.
9. **Docs:** кто обновит checklist (867→870, #29/#30/#37), spec header v1.1 и
   vectors meta `normative v4`/273 checks?

---

**Статус G4f: DONE (ревью завершено); вердикт — NO-GO для base
`KRUG_E2EE_ENABLED=true`.** P0 нет. Условия 1, 3, 7 закрыты; 2, 4, 6, 8, 9 —
PARTIAL; 5 и 10 — NOT CLOSED; #38 BLOCKED. Новый P1-01: receiver v1.1 dedupe
не durable и не подавляет unread/notification. F7A 12/12 и F7B 2/2 независимо
зелёные на overlay `4b0781a2b703` / asset `a4d0645a…`; base-флаги `false`,
base-стек восстановлен (`a24ae4fb…`, `index-CioOgmBt.js`). Код/контракты/спека/
векторы/`docs/TASKS*` не изменялись; создан только этот файл; test-only harness
удалён.

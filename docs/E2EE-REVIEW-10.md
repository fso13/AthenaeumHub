# E2EE-REVIEW-10 — G4b re-review после E7-F8

> **Рецензент:** независимый security/crypto-ревьюер; в E7-F8 не участвовал.
> **Дата:** 2026-11-18. **Вход:** `docs/E2EE-REVIEW-09.md` (P1-01…P1-04, P2-10, условия),
> `frontend/E7-F8-REPORT.md`, `frontend/E7-F7B-REPORT.md`, `frontend/E7-F6-REPORT.md`,
> `docs/E2EE-SPEC.md` §3.4.6/§5.5/§5.7/§7, `contracts/openapi.yaml` (verification),
> `deploy/docker-compose.e2ee-test.yml`, фактический код `frontend/src/**`, `frontend/e2e/**`.
> **Зона:** в финальном дереве создан только этот файл. Временный test-only repro-harness
> создавался вне production-кода и удалён после прогона; код, контракты, спека, векторы и
> `docs/TASKS*` не изменялись. Git-репозитория в workspace нет — one-PR/diff по-прежнему
> не проверяемы; проверялось фактическое дерево и поведение.

## Вердикт

**NO-GO на включение `KRUG_E2EE_ENABLED=true` в текущем дереве.**

P0 не найдено. P1-02 (verification), P1-03 (sync/resume-gap) и P1-04 (runtime browser floor)
закрыты кодом и независимо перепроверены; P2-10 (финальный образ) подтверждён
байт-в-байт. Но **P1-01 закрыт только частично**, и это release-blocking: sender-side
`superseded` для уже отправленного сообщения не сохраняется. После R-15 замены оригинал
скрывается только в памяти текущей сессии; после reload он снова рендерится из локальной
копии со статусом `sent` рядом с заменой. Это прямо нарушает требование G4 «0 дублей» и
спеку §5.5 («старые записи помечаются `superseded`»), а E7-F8 §2/§9 объявляет sender-side
закрытым.

Итог по бинарному вопросу: **сейчас — NO-GO на flag-on**. После исправления P1-01
(см. условия 1–2) и закрытия оставшихся условий — **GO WITH CONDITIONS** для поэтапного
включения: сначала Chromium/Firefox, E2EE-workspace pilot, с работающим kill-switch и
наблюдением. Safari/iOS — отдельный gate, не «молча поддерживается».

## P0

**Открытых P0 нет.**

Повторно проверялись классы, дававшие P0 в предыдущих ревью:

| P0-класс | Результат | Доказательство |
|---|---|---|
| Серверный plaintext в E2EE-строках | нет | F7B на текущем стенде: `text:null`, `crypto:null`, envelopes-only в БД, 0 plaintext в WS/логах (F7B 2/2) |
| Конверты других устройств через path/`X-Device-Id` | не переоткрыто | с E7-F8 не менялись `ApiRequestPath`/`DeviceBindingFilter`; F7B использует реальный `X-Device-Id` |
| 512 KiB / floor 272 B / canonical b64u | не переоткрыто | `ck_envelopes_ciphertext_min.convalidated=t` на parent+partitions; F7B проверяет 272..33040 |
| RLS/tenant boundary | держится | `message_envelopes`/`key_verifications` `relforcerowsecurity=t`; `krug_app` не имеет доступа к quarantine |
| Nonce/MK reuse в store | не найден | `sessionStore.test.ts`/`kStorage` KAT зелёные; F7B не менял крипто-ядро |
| Серверный ciphertext/plaintext в логах | не найден | F7B log/WS assertions; независимый прогон 2/2 |
| KAT/tamper ядра | зелёные (Chromium/Firefox) | F7A 12/12 с WebKit expected-unsupported; 22/22 KAT, 10/10 tamper |

Почему найденный дефект P1-01 — не P0: утечки plaintext/ключей нет, sealed copies остаются,
криптографическая конфиденциальность не ломается. Страдает целостность отображения истории
(дубликат после reload) и нарушается §5.5, поэтому это release-blocker для flag-on, но не P0.

## P1 closure matrix

| ID | Статус после E7-F8 | Независимый результат |
|---|---|---|
| **P1-01** История после `deleteSession`/R-15 | **PARTIAL — release-blocking** | Copy-first на error-пути и `message.id` binding работают; **sender-side `superseded` не сохраняется для sent-строк** → после reload оригинал снова виден. Тесты покрывают `NO_SESSION` и prekey, но не `SPK_DELETED`/`DECRYPT_FAILED`; F7B перезагружает только B, не A. |
| **P1-02** Verification/safety number | **CLOSED** | `PUT …/verification` VH v2, `expected_key_generation`, `Idempotency-Key`, чтение `verified/verified_at/method`, per-device scope, key-change gating, UI «Сверить»; F7B 201 и persistence после reload подтверждены. Live negative key-change остаётся P2/условием. |
| **P1-03** Sync/resume-gap catch-up | **CLOSED** | `runSync().catchUp` и `resume.gap` вызывают `decryptE2eeSlice` после merge; unit/store tests зелёные; F7B Chromium прошёл live reset без `R15_CATCH_UP_RELOAD` annotation. Остаётся узкий race «E2EE state ещё не ready» (P2). |
| **P1-04** WebKit runtime floor | **CLOSED для runtime-гейта; P2 для app-level UI/CI** | RFC 8032 KAT в `detect`/`require`, bridge `initialize` fail-closed, `browserUnsupported` + баннер; F7A WebKit `available=false`/`missing=['ed25519']`, Chromium/Firefox 4/4. В password-bootstrap unsupported browser даёт общий `sessionStatus=error`, а не баннер (P2-11); матрица не в release-CI (P2-08). |
| **P2-10** F7B evidence на финальном образе | **CLOSED** | image digest, asset SHA-256 и `index.html` SHA-256 совпали с отчётом; локальная сборка с точными Docker build args воспроизвела те же hash; source mtimes старше image; F7B 2/2 на этом образе. |

### P1-01. Copy-first закрыт, но sender-side `superseded` не персистится

**Что действительно закрыто.**

- `E2EE_COPY_RESTORE_CODES` = `NO_SESSION`, `KEY_HANDSHAKE_INVALID`, `SPK_DELETED`,
  `DECRYPT_FAILED` (`frontend/src/store/chatStore.ts:319-324`).
- На `kind:'none'` и на error-пути сначала читается sealed incoming copy; при наличии копии
  view становится `decrypted`/`control`/`superseded`, reset не отправляется
  (`chatStore.ts:2112-2146`).
- `message.id` binding реализован: `lookupIncomingCopy` передаёт `message.id`
  (`chatStore.ts:2021-2039`), `lookupIncomingLocalCopy` сверяет `copy.serverMessageId` с
  ожидаемым (`frontend/src/e2ee/outbox/outboxStore.ts:1201-1249`).
- Control-copy не рендерится как сообщение; `superseded`/`control` скрываются в
  `MessageList.tsx:44-46`. Store-тесты `NO_SESSION`, prekey, control и wrong-id зелёные;
  `sessionSendReceive.test.ts:210-277` реально удаляет сессию и проверяет копию.

**Найденный дефект (воспроизведён).**

`markOutboxSuperseded` делает ранний выход для уже отправленной строки:

```
frontend/src/e2ee/outbox/outboxStore.ts:1103-1112
if (stored.status === 'sent') return;
...
await updateLocalCopyStatus(transaction, stored, 'superseded', now);
```

При этом `confirmSent` вызывает `markOutboxSent`, который ставит `status='sent'` и
`localCopy.status='sent'` (`outboxStore.ts:1035-1067`, bridge `chatBridge.ts:940-943`),
а `handleIncomingReset` вызывает `bridge.markSuperseded` **после** `confirmSent`
(`frontend/src/store/chatStore.ts:2291-2296`). Поэтому для реальной R-15 замены:

1. в памяти store оригинал скрывается (`chatStore.ts:2310-2323`);
2. в IndexedDB outbox и outgoing local copy остаются `sent`;
3. после reload `decryptE2eeSlice` видит своё сообщение с `crypto:null`, вызывает
   `lookupLocalCopy` (`chatStore.ts:2090-2097`), получает `status='sent'`;
4. `copyView` скрывает только `superseded` (`chatStore.ts:2042-2052`), поэтому оригинал
   рендерится как `decrypted` рядом с переотправленной заменой.

Test-only repro на production-модулях (временный harness, удалён):

```
markOutboxSent(...)      -> copy.status='sent',   outbox.status='sent'
markOutboxSuperseded(...) -> copy.status='sent', outbox.status='sent'
expected:                  copy.status='superseded', outbox.status='superseded'
```

Это не косметика: после R-15 + reload пользователь видит две версии одного сообщения, что
прямо противоречит §5.5, G4-условию «0 дублей» и заявлению E7-F8 §2 «sender-side restore
закрыт». Существующий тест `e2eeChat.test.ts:315-330` этого не ловит: он подкладывает в fake
bridge уже готовую копию со `status:'superseded'`, минуя реальный переход
`markOutboxSent → markOutboxSuperseded`. `outbox.test.ts:255` проверяет supersede только для
`failed/pending`, не для `sent`.

**Почему F7B это не поймал.** F7B после R-15 проверяет баннер A, замену у B и новое
сообщение, но **не перезагружает A после reset** и не проверяет отсутствие оригинала. F7B
§5.1 старого отчёта проверял reload истории B, а не sender-side supersede A.

**Влияние.** Видимый дубликат истории, нарушение «no data loss/no duplicate» и spec §5.5;
конфиденциальность не страдает.

**Что должно быть исправлено.** `markOutboxSuperseded` должен обновлять local copy даже для
`sent` (outbox-статус можно оставить `sent` как audit, либо ввести отдельный
`supersededAt`); тест должен идти через реальные `markOutboxSent` → `markOutboxSuperseded` →
`lookupLocalCopy`, а E2E — перезагружать **A** после reset и требовать ровно один экземпляр
оригинала/замены. Дополнительно нужны store-тесты для `SPK_DELETED` и `DECRYPT_FAILED`
(код покрыт общим set, отдельных тестов нет).

### P1-02. Verification закрыт

Проверено по коду и F7B:

- `PUT /chats/{chatId}/keys/verification` с `device_id`, `method`, `vh_version=2`,
  `safety_number_hash` (b64u32), `expected_key_generation`, `Idempotency-Key`
  (`frontend/src/api/e2eeDeviceApi.ts:230-260`, `chatBridge.ts:761-834`).
- VH v2 считается из тех же 60 цифр, что показывает диалог
  (`verificationHash.ts:25-48`, `chatBridge.ts:311-344`); формула совпадает со §7.4.
- `DeviceKeyInfo.verified/verified_at/verification_method` читаются и валидируются
  (`device/binding.ts:173-228`); `loadChat` маппит per-device и **гасит stale verified при
  unaccepted key change** (`chatBridge.ts:618-634`).
- Per-device scope подтверждён сервером: `findByVerifierAndChat`, `verified` в `DeviceKeyInfo`
  null для self/чужой генерации; `revokeForTargetDevice` вызывается при revoke
  (`backend/.../ChatKeysService.java:230-252`, `DeviceRevocationService.java:63`).
- UI: per-device «Сверено/Не сверено», кнопка «Сверить», VH-хеш, дата, «Нужна повторная
  сверка» при key change (`SafetyNumberDialog.tsx:100-150`). F7B: A `PUT` 201, A «Сверено»
  после reload, B «Не сверено»; fake verified отсутствует.
- Тесты: `e2eeDeviceApi.test.ts` (path/body/idempotency/409), `chatBridge.test.ts` (+2),
  `e2eeChat.test.ts` (+3), `E2ee.test.tsx` (+2).

Замечания, не отменяющие закрытие: live negative key-change (same `device_id`, новые ключи)
не форсировался (условие 3); аттестация не связывает явно **показанный** hash/поколение с
отправляемым (P2-13), но TOFU-пин и `assertNotBlocked` закрывают практический TOFU-сценарий;
QR по-прежнему не рендерится (известное P2).

### P1-03. Catch-up закрыт

- `runSync` при `remote.last_seq > slice.lastSeq` вызывает `catchUp`
  (`chatStore.ts:3124-3132`); `catchUp` после merge страниц вызывает `decryptE2eeSlice`
  (`chatStore.ts:3151-3186`).
- `resume.gap` идёт через тот же `catchUp` (`chatStore.ts:3524-3534`).
- `decryptE2eeSlice` идемпотентен (`e2eeDecrypting` guard) и обрабатывает control
  `SESSION_RESET` тем же путём, что live (`chatStore.ts:2059-2171`).
- Store-тест `/sync` с E2EE-сообщением и encrypted reset — `e2eeChat.test.ts:503-554`;
  повторный sync без дублей — `:555-590`; `resume.gap` — `realtimeStore.test.ts:199-246`.
- Независимый F7B Chromium прошёл live reset без annotation `R15_CATCH_UP_RELOAD`
  (10.958 s); это подтверждает живой путь, а unit-тесты — sync/resume-путь.

Остаточный риск: `catchUp` вызывает decrypt только если `mergedAny` и только для активного
чата в `runSync`; если `e2ee.status` ещё не `ready`, decrypt откладывается до следующего
live/load. Это не воспроизводит исходный P1-03 на штатном bootstrap (initialize ожидается до
sync), но остаётся P2-12.

### P1-04. Runtime floor закрыт, app-level UI — P2

- `ed25519Kat.ts` содержит RFC 8032 §7.1 TEST 1 (seed, pubkey, empty message, signature
  `e556…`, tamper reject); `support.ts:152-167` требует KAT для `primitives.ed25519`,
  `requireE2eeSupport` бросает `E2EE_UNSUPPORTED_BROWSER` (`support.ts:186-197`).
- `chatBridge.initialize` вызывает `requireE2eeSupport()` **до** account switch/keyed
  registration (`chatBridge.ts:517-527`); при ошибке `initializeE2ee` ставит
  `browserUnsupported` (`chatStore.ts:1861-1869`), `E2eeBanner` показывает честный текст
  (`E2eeBanner.tsx:105-115`), composer/send блокируются через `e2eeBlockReason`
  (`chatStore.ts:1778-1790`).
- Независимый F7A: Chromium 4/4, Firefox 4/4, WebKit 4/4 expected-unsupported
  (`available=false`, `missing=['ed25519']`, `require` → `E2EE_UNSUPPORTED_BROWSER`), 12/12
  суммарно. 22/22 KAT и 10/10 tamper — Chromium/Firefox.
- Ограничения: password-bootstrap при unsupported browser бросает
  `E2EE_DEVICE_UNAVAILABLE` и уходит в общий `sessionStatus=error`
  (`chatStore.ts:696-714`), а не показывает `E2eeBanner` — это P2-11. Runtime KAT проверяет
  только empty-message вектор (P2-12). Матрица F7A не входит в release-CI (P2-08).

## P2

### P2-01. F7B по-прежнему не воспроизводится на чистом стеке

`frontend/e2e/e2ee.real.spec.ts:56-60` жёстко логинит
`pickle-ui-1794919305193@krug.local`; `deploy/keycloak/realm-export.json` содержит только
`test@krug.local` (grep: одна `username`). В текущей БД пользователь B есть только как
leftover прошлых прогонов (SQL: 1 строка), поэтому независимый F7B 2/2 выполнен на
**загрязнённом** стенде. На `down -v` + overlay F7B не стартует. Это остаётся условием
воспроизводимости и CI; F7B-отчёт §8 это признаёт.

### P2-02. Destructive SQL-reset в e2e включён по умолчанию

`e2ee.real.spec.ts:50` — `DB_CHECK` по умолчанию `true`; `:204-218` делает
`UPDATE auth.devices SET status='REVOKED'…` по захардкоженным `krug-postgres`/`krug_migrator`.
В нашем прогоне это снова массово отозвало устройства двух пользователей. Нет явного
`E2EE_REAL_ALLOW_DESTRUCTIVE=1`, проверки compose-project/overlay-маркера и API-revoke.
Это не E2EE-криптодефект, но условие безопасного CI/одноразовой БД.

### P2-03. Накопление workspace'ов и flag-on тестовый стек

В текущей БД **54** workspace'а `E2EE F7B` (на момент G4 было 39); API удаления workspace
нет. Контейнеры `krug-backend` (`KRUG_E2EE_ENABLED=true`) и `krug-frontend`
(`VITE_E2EE_ENABLED=true`) оставлены в flag-on; base `.env`/compose — `false`. Нужны
cleanup/CI-reset и возврат base-compose после прогона.

### P2-04. Legacy incoming copies без `serverMessageId`

`lookupIncomingLocalCopy` принимает копию с `serverMessageId=null` даже при ожидаемом
`message.id` (`outboxStore.ts:1242-1248`) — для копий до E7-F8 P2-04 replay-binding не
работает. Старые incoming-копии без `client_message_id` вообще не находятся после reload.
Base-флаг false, production-копий нет; при включении нужна миграция/бэкфилл или явное
принятие. Это остаётся условием.

### P2-05. `normative_invariants` в векторах всё ещё противоречат v1-спеке

`docs/E2EE-TEST-VECTORS.json:201-202`: `ciphertext_cap` — «decoded **16..33040**» (фактически
272..33040), `reset_retry_window` описывает receiver-дедуп по `retry_of_client_message_id`
как v1, хотя §5.5/§3.5.1 называют это **v1.1**. `vectors.test.ts` проверяет только
`vector_set_version=4`, а не инварианты. G4-условие №6 не закрыто (F8 не менял docs).

### P2-06. Receive-реконсиляция не получает `protectedSessionIds`

`frontend/src/e2ee/session/receive.ts:410-414` вызывает `reconcileParallelSessions` без
`protectedSessionIds`; `loadChat` передаёт `resettingSessions` (`chatBridge.ts:607-611`).
Редкий сбой simultaneous init + reset остаётся (P2 CR1d), не регрессия F8.

### P2-07. Negative key-change/TOFU live и полнота F7B

F7B форсирует `NO_SESSION`, но не `KEY_CHANGE_DETECTED` с валидной binding-подписью, не
`SPK_DELETED`/`DECRYPT_FAILED`, не L3b (`delivered_before_reset>0`), не multi-device/self-
envelope и не revoke→verified reset. Unit/UI-тесты key-change и verify есть, live-стенда нет.
Это остаётся условием E2EE-AC-04.

### P2-08. Процесс/наблюдаемость: нет git/CI/checklist/log-capture

Git в workspace отсутствует; one-PR/patch-bundle не проверяем. F7A-матрица запускается
`E2EE_BROWSER_MATRIX=1` и не входит в `npm run check`; F7B не в CI; нет `log-capture` теста
на отсутствие ciphertext/plaintext; нет `deploy/E2EE-ENABLE-CHECKLIST.md`; review-07
condition №1 (постоянные real-HTTP encoded-path/chunked/floor тесты) и V19-runbook открыты.
Всё это — условия release-подписи.

### P2-09. Остаточные pre-existing риски kill-switch/retention/multi-node

`SubscribedChat.server_last_seq` при flag-off включает скрытые E2EE-seq (G4b P2-03);
envelope/quarantine retention не реализован; quarantine owner-only, RLS не FORCE; WS/rate-
limiter/outbox in-process, single-node; `chat.keys.changed`/`device.list.changed` не durable;
SPK/OPK retention — B4-долг; multi-account (CR1d) — ограничение v1. Не криптографическая
граница, но условия эксплуатации.

### P2-10. F7B/image evidence — CLOSED

Подробности в разделе «F7B/image evidence»: image `sha256:5eaa2ed7…`, asset
`index-D7gHmGcS.js` `bf82d7bf…`, `index.html` `9b26a997…`; локальная сборка с точными
Docker build args дала те же hash; source mtimes старше image; F7B 2/2 на этом образе.
Замечание: F7B всё ещё использует leftover-B (P2-01), поэтому это доказательство финального
**артефакта**, но не чистого стека.

### P2-11. WebKit UI в password-bootstrap

`runPasswordBootstrap` при `initializeE2ee` fail (включая `E2EE_UNSUPPORTED_BROWSER`)
требует `e2ee.deviceId`, бросает `E2EE_DEVICE_UNAVAILABLE` и уходит в общий session-error
(`chatStore.ts:696-714`); `E2eeBanner` не рендерится, потому что `activeChatId` ещё null.
Пользователь WebKit получает общий экран ошибки, а не честное «браузер не прошёл RFC 8032».
Runtime-гейт при этом fail-closed (silent Safari нет). Нужен app-level WebKit E2E и явный
экран/режим «browser unsupported» либо документированное решение, что весь SPA недоступен.

### P2-12. Runtime Ed25519 KAT только на empty message

`ed25519Kat.ts` проверяет RFC 8032 TEST 1 (empty), а F7A gate — ещё и непустые A2/B3. Движок,
который проходит empty-вектор, но ломает непустые подписи, runtime-гейтом не отсекается.
Рекомендуется добавить второй RFC-вектор (TEST 2/3) или повторную подпись с побайтовым
сравнением. WebKit текущей версии отсекается, но floor был бы крепче.

### P2-13. Аттестация не привязана явно к показанному safety number

`verifyE2eeDevice` передаёт только `deviceId/method`; `chatBridge.verifyDevice` делает
`fetchChatInfos(..., {fresh:true})` и считает hash от **свежих** ключей
(`chatBridge.ts:761-792`), а не от `chatState.verificationHashes[deviceId]`/поколения,
которые видел пользователь. При наличии TOFU-пина смена ключей ловится `assertNotBlocked`,
поэтому практический TOFU-сценарий закрыт; но для строгой церемонии стоит сверять
показанный hash/поколение и отказывать при расхождении (reload + re-verify).

### P2-14. Пробелы evidence по P1-01

Нет store-тестов на `SPK_DELETED`/`DECRYPT_FAILED` copy-restore, нет теста реального
`sent → superseded` перехода (см. P1-01) и нет E2E reload **A** после R-15. Текущий
`e2eeChat.test.ts:315-330` использует fake-копию со статусом `superseded`, поэтому
production-переход не проверяется.

## F7B/image evidence

Независимо, не по отчёту:

| Проверка | Результат |
|---|---|
| container image | `krug-frontend`, image `sha256:5eaa2ed747d1b6cd8ddc6c21f561bb6719ae772ea6bddf25ab4adbf40619225a`, created `2026-11-18T11:02:24Z` (14:02 MSK) |
| asset | `/usr/share/nginx/html/assets/index-D7gHmGcS.js`, SHA-256 `bf82d7bfd439f1d5d2cfb8efd5ecf9e62e82e185ddd5c4b43f56b76c5c75f061` |
| `index.html` | SHA-256 `9b26a99724f6590152e6ecd0acff6c22b76772fda675df16324f6d2f5b2076bd` |
| flag in asset | `VITE_E2EE_ENABLED:"true"` |
| local overlay build | with exact Docker args (`VITE_API_BASE_URL=/api/v1`, `VITE_AUTH_MODE=password`, `VITE_DEVICE_NAME="Pickle — браузер"`, `VITE_APP_VERSION=0.1.0`, `VITE_REALTIME_ENABLED=true`, `VITE_MEDIA_ORIGINS=http://localhost:9000`, `VITE_E2EE_ENABLED=true`) produced the **same** `index-D7gHmGcS.js` `bf82d7bf…` and `index.html` `9b26a997…` |
| source mtimes | `find frontend/src … -newermt 2026-11-18T11:02:24Z` — **0 files**; source старше image |
| F7B | independent run: **2 passed (27.5 s)**; Chromium JSON run 10.958 s, no `R15_CATCH_UP_RELOAD` annotation |
| F7B scope | real keyed registration/prekeys, `GET /devices` `e2ee_capable`, DIRECT E2EE, A↔B send/decrypt, reload copies, `PUT` verification 201, R-15, DB/WS/logs no plaintext |
| F7A | independent run: **12 passed** (chromium 4/4, firefox 4/4, webkit 4/4 expected-unsupported) with `MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1`; first firefox run without sandbox env crashed (`Target crashed`, environment artifact) |
| full frontend | `npm run check` — **EXIT 0**, 72 files / **755 tests**, tsc clean, build 418 modules; lint 3 warnings (2 pre-existing `CreateChatDialog`, 1 new `chatBridgeSupport.test.ts`), 0 errors |
| DB | 54 `E2EE F7B` workspaces (accumulation); 1 leftover `pickle-ui-…` user; 1 `test@krug.local`; `ck_envelopes_ciphertext_min.convalidated=t`; `relforcerowsecurity=t` for key_verifications/message_envelopes |
| base flags | `.env`/compose — `false`; overlay — `true`; running stack — `true` |

F7B по-прежнему использует leftover-B и destructive SQL (P2-01/P2-02), поэтому это
доказательство финального образа, а не воспроизводимость из чистого репозитория.

## Browser floor

- **Chromium/Firefox:** 4/4 матрицы, 22/22 KAT, 10/10 tamper; `detectE2eeSupport` 8/8,
  `require` ok. Runtime-гейт вызывается bridge `initialize` до keyed registration.
- **WebKit (Playwright 27.2):** `available=false`, `primitives.ed25519=false`,
  `missing=['ed25519']`, `requireE2eeSupport` → `E2EE_UNSUPPORTED_BROWSER`; F7A 4/4
  expected-unsupported. Это осознанный expected-unsupported, не silent pass.
- **Runtime vs CI:** гейт реализован в runtime; F7A-матрица по-прежнему ручная
  (`E2EE_BROWSER_MATRIX=1`) и не входит в `npm run check`/release-CI. Нужна явная политика:
  Chromium/Firefox blocking, WebKit expected-fail/отдельный gate.
- **Safari/iOS:** shipping Safari/iOS этой матрицей не сертифицирован; Playwright WebKit —
  не то же, что shipping Safari. Пока продукт должен честно писать «не поддерживается».
  App-level password-bootstrap показывает общий session-error, а не `E2eeBanner` (P2-11).
- **KAT floor:** runtime проверяет только empty-message RFC 8032 TEST 1 (P2-12); для строгого
  floor рекомендуется второй непустой вектор.

## Условия включения

Флаг остаётся `false`, пока не выполнены все пункты; каждый проверяем.

1. **P1-01 blocker — sender `superseded`.** Исправить persistence для уже отправленных
   сообщений: при R-15 замене `markOutboxSuperseded` обязан обновить outgoing local copy
   (outbox-статус `sent` можно сохранить как audit или ввести отдельный маркер), чтобы после
   reload оригинал не рендерился. Тест: реальный `markOutboxSent` → `markOutboxSuperseded` →
   `lookupLocalCopy` даёт `superseded`; E2E A: R-15 → reload A → ровно один экземпляр
   оригинала/замены, 0 дублей. Без этого flag-on запрещён.
2. **P1-01 полнота.** Добавить store-тесты на `SPK_DELETED`/`DECRYPT_FAILED` copy-restore
   (без error-bubble и без POST reset), тест `control`-copy и negative replay с
   `message.id`; E2E reload **A** после R-15, а не только B. Проверить `superseded` для
   legacy/новых копий.
3. **Negative key-change/TOFU live + verified reset.** Test-only fixture легитимной ротации
   identity (валидная binding-подпись) или контролируемая SQL-мутация на одноразовом стенде:
   `KEY_CHANGE_DETECTED`, send blocked до accept, OPK не расходуется, сессия не
   перезаписывается, `verified` сброшен, после accept — re-verify; плюс L3b и multi-device
   E2E. Без этого E2EE-AC-04 остаётся частичным.
4. **Receiver R-15 v1.1.** Либо реализовать `retry_of_client_message_id` в inner TEXT и
   receiver-дедуп, либо явно принять продуктовое ограничение v1 «0 дублей не обещается» и
   убрать это обещание из UI/AC/отчётов. Решение владельца продукта, но оно должно быть
   записано до flag-on.
5. **Safari/iOS + WebKit UI.** App-level WebKit E2E с `VITE_E2EE_ENABLED=true` в
   password-режиме: unsupported browser показывает понятный экран/баннер, keyed registration
   и send не выполняются; либо отдельное ADR-решение, что весь SPA недоступен. Shipping
   Safari/iOS — отдельный gate; не объявлять Safari в floor без прогона.
6. **F7B чистая воспроизводимость/fixture.** `down -v` → overlay up → F7B 2/2 без ручной
   подготовки: B регистрируется через BFF/Mailpit (уникальные email/пароль), а не берётся
   leftover; SQL-reset требует явного `E2EE_REAL_ALLOW_DESTRUCTIVE=1` и проверки
   контейнера/БД; после прогона — cleanup/reset и возврат base-compose.
7. **Векторы.** Исправить `normative_invariants` (272..33040, v1.1-статус receiver-дедупа),
   bump `vector_set_version`; тест `vectors.test.ts` не принимает 271 B/«16..33040» и не
   считает receiver-дедуп v1 реализованным; пересчитать/зафиксировать KAT hash.
8. **Release-CI/артефакт.** F7A-матрица с явной политикой (Chromium/Firefox blocking,
   WebKit expected-fail) и F7B на чистом стеке в release-CI; `log-capture` на отсутствие
   ciphertext/plaintext; полный backend suite; `deploy/E2EE-ENABLE-CHECKLIST.md`;
   clean rebuild после финальных правок с фиксацией image digest + asset SHA-256;
   git/tag/patch-bundle (one-PR). P2-10 закрыт для текущего образа, но после fix P1-01
   rebuild обязателен.
9. **Legacy copies.** Миграция/бэкфилл incoming-копий без `serverMessageId`/`client_message_id`
   или явное принятие: после включения такие копии могут не найтись/дать replay-риск.
10. **Kill-switch/retention/rollout.** Проверить flag-off kill-switch (REST/WS/replay 409,
    `server_last_seq` не теряет seq), retention envelopes/quarantine, rate limits,
    demo/test users, отключение dev-session; сначала E2EE-workspace pilot на
    Chromium/Firefox, затем общий flag-on; Safari — отдельно.

## Остаточные риски

- **No PCS/backup v1:** потеря ключей/профиля = потеря истории; local copies не backup.
- **P1-01 sender duplicate после R-15 + reload** до исправления: видимые дубликаты истории.
- **Receiver-side R-15 duplicates** в v1 не исключены (нет `retry_of_client_message_id` в
  TEXT); v1.1 — отдельное решение.
- **TOFU-окно:** первый контакт уязвим; safety number — единственный независимый канал;
  attestation `verified` per-device, но серверный флаг не доказательство.
- **Malicious server replay:** legacy copies без `serverMessageId` могут показать старый
  текст под новым `message.id` (P2-04); для новых копий binding есть.
- **WebKit/Safari:** не сертифицирован; runtime gate блокирует, но app-level UI и shipping
  Safari/iOS не проверены.
- **Single-node:** WS/rate-limiter/outbox in-process; `chat.keys.changed`/`device.list.changed`
  не durable.
- **Retention/privacy:** envelope/quarantine retention не реализован; quarantine owner-only,
  RLS не FORCE; ciphertext/метаданные бессрочно.
- **Testing:** F7B — один host/два контекста, не два физических устройства; leftover-B и
  destructive SQL; нет git/one-PR; нет внешнего третьего crypto-аудита; тестовые workspace'ы
  накапливаются (54); flag-on тестовый стек оставлен запущенным.
- **Pre-existing:** `server_last_seq` при flag-off; demo/test users; proxy double-decode;
  SPK/OPK retention; admin suspend не отзывает E2EE keys; QR не рендерится.

## Вопросы

1. **P1-01:** кто владелец fix `sent → superseded` для local copy, и можно ли менять
   outbox-статус `sent` на `superseded` или нужен отдельный `supersededAt`? Кто добавит
   E2E reload **A** после R-15?
2. **P1-01 evidence:** принимается ли требование store-тестов на `SPK_DELETED` и
   `DECRYPT_FAILED`, или достаточно общего `E2EE_COPY_RESTORE_CODES`? Кто владелец
   legacy-copy политики?
3. **Receiver R-15 v1.1:** входит ли receiver-дедуп в flag-on, или PM явно принимает
   ограничение v1 «0 дублей не обещается» и убирает обещание из UI/AC?
4. **Key-change live:** кто предоставит test-only fixture легитимной ротации identity и
   одноразовый стенд для `KEY_CHANGE_DETECTED`/verified reset?
5. **Safari/iOS:** нужен ли отдельный экран «browser unsupported» в password-bootstrap, или
   допустим общий session-error? Кто владелец shipping-Safari gate?
6. **F7B fixture:** можно ли добавить регистрацию B через BFF/Mailpit и destructive-opt-in,
   чтобы F7B шёл в CI на чистом стеке? Кто владелец cleanup/CI-БД?
7. **Векторы:** исправляем `normative_invariants` с bump `vector_set_version` или отдельным
   erratum без изменения байтовых KAT? Кто перепроверит hash/24+3 KAT?
8. **Release:** когда git/tag/patch-bundle и финальный rebuild после P1-01 fix, полный
   backend suite, F7A/F7B на release-candidate? Без этого G4-подпись неполная.

---

**Статус G4b: DONE (ревью завершено).** P0 нет; P1-02/P1-03/P1-04 закрыты, P1-01 — PARTIAL
из-за sender-side `superseded`; P2-10 закрыт. Итог: **в текущем дереве flag-on — NO-GO**;
после исправления P1-01 и условий 1–10 — **GO WITH CONDITIONS** для пилота
Chromium/Firefox. Код/контракты/спека/векторы/`docs/TASKS*` не изменялись; создан только
этот файл.

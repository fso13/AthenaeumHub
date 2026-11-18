# E2EE-REVIEW-09 — G4 final review перед включением E2EE

> **Рецензент:** независимый security/crypto-ревьюер; в подготовке E7-F6/F7A/F7B и backend B3F2/B3F3 не участвовал.
> **Дата:** 2026-11-18. **Вход:** `docs/E2EE-SPEC.md` §4–§5/§7, `docs/ADR-26-E2EE-BROWSER-FLOOR.md`,
> `docs/E2EE-REVIEW-04.md` (G3), `docs/E2EE-REVIEW-06.md` (G4), `docs/E2EE-REVIEW-07.md` (G4b),
> `docs/E2EE-REVIEW-08.md` (G4c), `docs/E2EE-CLIENT-REVIEW-04.md` (CR1d),
> `frontend/E7-F6-REPORT.md`, `frontend/E7-F7A-REPORT.md`, `frontend/E7-F7B-REPORT.md`,
> `backend/E11-B-REPORT.md`/`E12-B-REPORT.md` (только auth/admin-контекст),
> `contracts/openapi.yaml`, `contracts/ws-protocol.md`, `deploy/docker-compose.e2ee-test.yml`,
> фактический код `frontend/src/**`, `e2e/**`, `backend/src/**`, V18/V19/V20.
> **Зона:** создан только этот файл; код, контракты, спека, векторы и `docs/TASKS*` не изменялись.
> Тестовые harness'ы — вне репозитория (`/tmp/e2ee-g4-review`); прогоны создали только ignored
> `frontend/dist` и данные в одноразовом тестовом стеке. Git-репозитория в workspace нет —
> one-PR/diff по-прежнему не проверяемы; проверялось фактическое дерево и поведение.

## Вердикт

**GO WITH CONDITIONS — но не «зелёный свет» на сегодня: в текущем дереве включать
`KRUG_E2EE_ENABLED=true` нельзя.**

Ядро E2EE (X3DH/DR, preamble/AD, envelope, opaque-хранение, RLS, per-device выдача, KAT,
tamper) подтверждено независимо: P0 не найдено. Backend-граница и «сервер не видит plaintext»
держатся на реальном PG16 + HTTP/WS; F7B два браузерных контекста действительно работают.

Однако финальный G4 подтвердил **четыре P1**, которые не были закрыты (а часть — лишь
упомянута как риск в отчётах) и являются release-blocking именно для flag-on:

1. **P1-01 — история после удаления сессии.** После штатного удаления сессии (R-15 completed,
   §5.7 loser, будущий TTL/GC) уже расшифрованные сообщения при reload снова идут в
   `receive()`, получают `NO_SESSION`/`KEY_HANDSHAKE_INVALID` и показываются как ошибка,
   хотя sealed incoming local copy существует и не используется. Это ломает §3.4.6/§4.3
   («после reload — из копии»), даёт видимую потерю истории, ошибки на месте control-сообщений
   и может провоцировать повторный `SESSION_RESET` с устаревшим якорем (дубликаты, если у
   отправителя сессия ещё жива). Воспроизведено отдельным harness'ом: копия `available=true`,
   повторный receive — `NO_SESSION`.
2. **P1-02 — verification/safety number не доведён до сервера.** UI показывает 60 цифр, но
   `verified` жёстко `false`, `PUT /chats/{id}/keys/verification` не вызывается,
   `verificationHash.ts` не используется, `DeviceKeyInfo.verified` не читается. E2EE-AC-04
   («verified сброшен») и §7.4/§7.5 в v1 недостижимы; «Сверить» как действие отсутствует.
3. **P1-03 — sync/resume-gap catch-up не расшифровывает E2EE.** `runSync().catchUp()` и
   `resume.gap` мержат сообщения в slice, но не вызывают `decryptE2eeSlice`. Пропущенный
   live-кадр `SESSION_RESET` (и обычные E2EE-сообщения) остаются необработанными до
   следующего live-сообщения или reload. Это ровно тот риск, который F7B обошёл
   `page.reload()`-catch-up.
4. **P1-04 — browser floor ADR-26 не исполняется в runtime.** `detectE2eeSupport()` в WebKit
   возвращает `available=true` (все 8 примитивов, self-consistent Ed25519), а приложение
   нигде не вызывает `requireE2eeSupport()`/не проверяет RFC 8032-детерминизм. При flag-on
   Safari/WebKit молча получает E2EE, хотя ADR-26 требует
   `E2EE_UNSUPPORTED_BROWSER`/недоступность; строгая матрица — только CI-гейт, не runtime.

Дополнительно есть **P2**, которые не блокируют криптографию, но обязаны быть закрыты или
явно приняты до production: F7B не воспроизводится на чистом стеке (второй пользователь не
засеян), destructive SQL-reset в e2e, накопление workspace'ов, stale `normative_invariants`
в векторах (16 B / v1.1 receiver-дедуп), replay входящей local copy по серверному
`client_message_id`, `protectedSessionIds` не передаётся из receive-реконсиляции, отсутствие
production enable checklist и прогона матрицы в release-CI.

Итог по бинарному вопросу: **сейчас — NO-GO на flag-on; после закрытия P1-01…P1-04 и
условий раздела «Условия включения» — GO WITH CONDITIONS** для поэтапного включения
(сначала Chromium/Firefox, E2EE-workspace pilot, с работающим kill-switch и наблюдением).

## P0

**Открытых P0 нет.**

Проверялись именно те классы, которые давали P0 в G4/G4b/G4c:

| P0-класс | Результат | Доказательство |
|---|---|---|
| Серверный plaintext в E2EE-строках | нет | 551 `E2EE_PAIRWISE` строк, `body_ciphertext IS NULL`, `content_meta='{}'`, `reply_to_id/sticker_id IS NULL` — 0 нарушений (SQL, текущая тестовая БД) |
| Конверты других устройств через path/`X-Device-Id` | не переоткрыто | G4b real-HTTP 30 path-вариантов; в этом ревью не менялись `ApiRequestPath`/`DeviceBindingFilter`; backend 25/25 targeted |
| 512 KiB / floor 272 B / canonical b64u | не переоткрыто | G4b/G4c; V18/V19 подтверждены на живой БД: `convalidated=t`, 0 строк вне 272..33040, 0 quarantine |
| RLS/tenant boundary | держится | `relforcerowsecurity=t` у parent и партиций; `krug_app` не имеет `SELECT` на quarantine; `DB_USER=krug_app` ≠ `FLYWAY_USER=krug_migrator` |
| Nonce/MK reuse в store | не найден | forward-KDF-инвариант в `sessionStore.ts:448-573`; реальные CK0-тесты `sessionStore.test.ts:569-650` зелёные (это закрывает store-level P1-01R-R/CR1d) |
| Серверный ciphertext/plaintext в логах | не найден | 4802 строки backend-логов за 2 ч: `ciphertext` — 0, `prekey` — 0 |
| KAT/tamper ядра | зелёные (Chromium/Firefox) | независимый прогон: 22/22 KAT, 10/10 tamper, hash `65aaac48…`/118817 B |

Почему P1-01 не P0: нет утечки plaintext/ключей и нет необратимой криптографической потери —
sealed copies остаются; страдает доступность/корректность истории и возможны дубликаты.
Это всё равно release-blocking для flag-on, потому что обещание «no data loss» и §3.4.6
нарушены.

## P1

### P1-01. После удаления сессии reload не читает уже расшифрованную историю из sealed copy

**Файл/секция.**
`frontend/src/store/chatStore.ts:2002-2043` — incoming-copy fallback срабатывает **только**
при `outcome.kind === 'none'`; в error-ветке копия не читается.
`frontend/src/e2ee/session/receive.ts:185-220` — при отсутствии сессии prekey-конверт идёт в
повторный handshake (OPK уже израсходован → `KEY_HANDSHAKE_INVALID`), обычный конверт →
`NO_SESSION`.
`frontend/src/e2ee/app/chatBridge.ts:641-656` — любой такой код превращается в
`kind:'error'` + `buildReceiverReset`.
`frontend/src/e2ee/app/chatBridge.ts:752-758` — успешный R-15 `finishReset` удаляет failed
session; `frontend/src/e2ee/session/parallel.ts:191-212` — §5.7 loser удаляется после окна;
`frontend/src/e2ee/session/sessionStore.ts:1109-1123` — `deleteSession` (вместе с sealed
secrets) не трогает `localMessages`.
`frontend/src/e2ee/outbox/outboxStore.ts:1201-1234` — `lookupIncomingLocalCopy` умеет найти
копию, но store его не зовёт на error-пути.

**Сценарий (воспроизведён).**
B принял m1–m3, затем m4 не расшифровался (потеря сессии/SPK/старый reset); R-15 завершился,
failed session удалена (или §5.7 loser удалён после winner-confirm). B перезагружает страницу:
`decryptE2eeSlice` заново прогоняет **всю** историю через `bridge.receive`; для m1–m3 сессии
уже нет → `NO_SESSION`/`KEY_HANDSHAKE_INVALID`; `lookupIncomingLocalCopy` не вызывается,
хотя копии есть. В UI — «Не удалось расшифровать сообщение» на месте ранее прочитанного
текста, а для control-сообщений — error-bubble вместо скрытия. Дополнительно store отправляет
`SESSION_RESET` с якорем m1; если у отправителя failed session ещё жива (асимметричное
удаление/GC), он перешифрует окно с m1 → дубликаты (receiver-дедуп v1.1 отсутствует).

Тестовый harness (вне репо, `/tmp/e2ee-g4-review/harness/repro2.test.ts`):
`deleteSession` после успешного receive, `lookupIncomingLocalCopy` → `available=true`,
`receiveE2eeMessage` того же не-prekey конверта → `NO_SESSION`. Для prekey-конверта —
`KEY_HANDSHAKE_INVALID` (OPK повторно не расходуется). Оба кода в store — error, не `none`.

**Влияние.**
Пользователь видит потерю уже прочитанной истории после reload; спека §3.4.6/§4.3
(«после reload — из копии») и F6-обещание «no data loss» не выполняются. Риск дубликатов
и reset-шторма при асимметричном удалении сессии. Конфиденциальность не страдает.

**Исправление.**
В `decryptE2eeSlice` для входящего сообщения с `client_message_id` пытаться восстановить
sealed incoming copy **до**/вместо error-ветки для кодов `NO_SESSION`,
`KEY_HANDSHAKE_INVALID`, `SPK_DELETED`, `DECRYPT_FAILED`; при наличии копии — `decrypted`
(или `control`/`superseded` по contentType/маркеру), reset не отправлять. Дополнительно
передавать в `lookupIncomingLocalCopy` `message.id` и сверять сохранённый `serverMessageId`
(см. P2-04). Для R-15 сохранять/восстанавливать `superseded`-маркер заменённых сообщений,
чтобы после reload оригиналы не рендерились. Для control-copy — не показывать как сообщение.

**Тест.**
Store/E2E: принять m1–m3, удалить сессию (или завершить R-15 при `delivered_before_reset>0`),
reload → m1–m3 видны из копий, 0 POST `SESSION_RESET` по уже принятым, 0 error/control-bubble,
0 дубликатов; отдельный §5.7-вариант с loser deletion; L3b-вариант (m1–m3 до якоря,
m4–m5 после reset).

### P1-02. Safety number показывается, но verification не реализован: `verified` всегда false

**Файл/секция.**
`frontend/src/e2ee/app/chatBridge.ts:562-571` — `devices` строятся с `verified: false`
безусловно; `DeviceKeyInfo.verified`/`verified_at` из `GET /chats/{id}/keys` не читаются.
`frontend/src/components/SafetyNumberDialog.tsx:105-110` — для peer всегда
`e2ee.safetyUnverified`; действия «Сверить»/QR нет, `qrPayload` не рендерится.
`frontend/src/e2ee/verification/verificationHash.ts` — `computeVerificationHash` нигде не
используется в production; в `E2eeDeviceTransport`/`E2eeBridge` нет `verifyDevice`/`PUT`.
Контракт при этом объявляет `PUT /chats/{id}/keys/verification` и `VerificationRequest`
(`contracts/openapi.yaml:1495-1527`, `2898-2930`), а acceptance E2EE-AC-04 требует
«предупреждение, verified сброшен» (`docs/TASKS-E7.md`).

**Сценарий.**
A и B сверяют 60-значный код (F7B это делает), но A не может зафиксировать сверку: `PUT` не
вызывается, `key_verifications` не пишется, `verified` на обеих сторонах остаётся false.
После key change/revoke «verified сброшен» невозможно продемонстрировать, потому что
verified никогда не выставлялся. Пользователь видит «Не сверено» даже после сравнения.

**Влияние.**
E2EE-AC-04 не выполнен; §7.4/§7.5 (attestation, verified на verifier-device, сброс при
key change/revoke) не реализованы в клиенте. TOFU-пин и key-change warning при этом работают
(это отдельный механизм), поэтому конфиденциальность не ломается, но заявленная
verification-церемония — фикция.

**Исправление.**
Добавить bridge-метод `verifyDevice(chatId, targetDeviceId, vhVersion=2, hash, method,
expectedKeyGeneration)`, считать hash через `computeVerificationHash` (цифры/QR), вызывать
`PUT` с `Idempotency-Key`, маппить `verified/verified_at/method` из `DeviceKeyInfo` в
`E2eeDeviceView`; показывать статус per `X-Device-Id` (P0-1: verified на другом устройстве
верификатора — информационно, не замочек); добавить кнопку «Сверить» и, если нужно, QR;
обрабатывать `409 KEY_CHANGED` (сброс verified, повторная сверка); при revoke/key change
показывать «Нужна повторная сверка».

**Тест.**
Два контекста: A сверяет B (`PUT` 201), A видит verified, B — нет (verifier-device scope);
второе устройство A — `verified=null`; key change/revoke → verified сброшен, warning,
re-verify; `PUT` идемпотентен; отрицательный TOFU/key-change сценарий (см. P2-07) — в том же
стенде.

### P1-03. Sync/resume-gap catch-up не вызывает decrypt: пропущенный SESSION_RESET не обрабатывается

**Файл/секция.**
`frontend/src/store/chatStore.ts:2996-3014` — `runSync` вызывает `catchUp`, затем
`applySync`; `3033-3059` — `catchUp` мержит страницы в slice, но не вызывает
`decryptE2eeSlice`; `3397-3410` — `handleResumeGap` делает то же для `resume.gap`;
`decryptE2eeSlice` вызывается только из live `message.created` (`:3288`), `chat.keys.changed`
(`:3205`), `loadChat`/`setActiveChat` (`:1542,1574`) и `acceptKeyChange` (`:1928`).

**Сценарий.**
B был offline/потерял WS; A отправил m1 и (после сбоя) зашифрованный `SESSION_RESET`.
B переподключается: `sync()`/`resume.gap` добирает оба сообщения в slice, но не расшифровывает
их. Control остаётся невидимым и необработанным, m1 — пустым/нерасшифрованным. Если новых
live-сообщений нет, reset не произойдёт до reload; именно поэтому F7B-spec делает
`pageA.reload()` как catch-up (F7B report §8.4). Спека §5.5 называет reset обязательным,
иначе R-15 — тихая потеря всех последующих сообщений сессии.

**Влияние.**
R-15 не срабатывает на штатном пути восстановления после обрыва (мобильные сети, sleep,
reconnect); E2EE-сообщения, добранные sync, остаются невидимыми/пустыми. Конфиденциальность
не страдает, но доступность и «no silent loss» — да.

**Исправление.**
После `catchUp` (и в `runSync`, и в `handleResumeGap`) для E2EE-slice вызывать
`decryptE2eeSlice(chatId)` (idempotent; `e2eeDecrypting` уже защищает от параллельного
запуска), либо отдельным шагом обрабатывать control-сообщения из добранной страницы.
Не полагаться на «следующий live-кадр».

**Тест.**
Два контекста: отключить WS у B, отправить E2EE-сообщение и reset, восстановить связь
(`sync`/`resume.gap`) → сообщение расшифровано, reset обработан, баннер/перешифровка без
reload; повторный sync не создаёт дублей; negative: control не arrives live, только sync.

### P1-04. WebKit/Safari молча получает E2EE: runtime floor из ADR-26 не реализован

**Файл/секция.**
`frontend/src/e2ee/crypto/support.ts:74-168,171-192` — `detectE2eeSupport` проверяет только
наличие примитивов и self-consistent `sign`/`verify` Ed25519; детерминизм/RFC 8032-вектор не
проверяются. `frontend/src/store/chatStore.ts:1805-1845` — `initializeE2ee` проверяет только
`e2eeBridge !== null`; `requireE2eeSupport()` в production не вызывается (grep — только
тесты). `docs/ADR-26-E2EE-BROWSER-FLOOR.md:10` требует в WebKit показывать
`E2EE_UNSUPPORTED_BROWSER`/недоступность.

**Сценарий (подтверждён в части support/KAT; app-level не прогонялся).**
Playwright WebKit 27.2: `detectE2eeSupport()` → 8/8, `available=true`; строгий KAT падает
только на A2/B3. По коду `initializeE2ee` при `VITE_E2EE_ENABLED=true` не проверяет
детерминизм и зарегистрирует keyed device в WebKit; никакого `E2EE_UNSUPPORTED_BROWSER` нет.
ADR-26 при этом объявляет WebKit неподдерживаемым, а F7B сознательно исключает WebKit.

**Влияние.**
Продукт нарушает собственный browser floor: непроверенная реализация Ed25519 (hedged/empty-
message) участвует в production-протоколе без предупреждения. Криптографическая
конфиденциальность, вероятно, не страдает (hedged-подписи могут быть валидны), но
нормативной гарантии нет; при регрессии WebKit пользователь узнает об этом поздно.
Для «Chromium/Firefox-only» включения это блокер, пока WebKit не заблокирован/не
сертифицирован.

**Исправление.**
Добавить в `detectE2eeSupport` runtime-пробу Ed25519: подписать фиксированное непустое
сообщение дважды и требовать побайтового совпадения (и/или `verify` нормативной RFC 8032
подписи); при провале — `E2EE_UNSUPPORTED_BROWSER`, `e2ee.status='error'`/`unsupported`,
блокировка keyed registration и send, честный текст в UI. Альтернатива — отдельное решение
crypto-review о допустимости hedged Ed25519 + новый ADR (не рекомендуется без анализа).
Матрицу F7A включить в release-CI: Chromium/Firefox — обязательный pass, WebKit — явный
ожидаемый fail/отдельный gate, а не «красный job, который игнорируют».

**Тест.**
Playwright WebKit с `VITE_E2EE_ENABLED=true` → E2EE-статус unsupported, keyed device не
регистрируется, send заблокирован; Chromium/Firefox — E2EE работает; unit-тест на
determinism-probe; CI-матрица с зафиксированной политикой.

## P2

### P2-01. F7B не воспроизводится на чистом стеке: второй пользователь не засеян

* **Файл:** `frontend/e2e/e2ee.real.spec.ts:55-60` — `USER_B = pickle-ui-1794919305193@krug.local`
  захардкожен; `:621` логинится без регистрации. `deploy/keycloak/realm-export.json` содержит
  только `test@krug.local`; `pickle-ui-…` в реалме нет, в текущей `auth.users` он есть только
  как leftover прошлых прогонов (проверено SQL). На чистом `down -v` + overlay пользователю B
  логиниться нечем (ни в реалме, ни в seed), поэтому F7B не стартует; это подтверждается
  отсутствием пользователя в артефактах, а не прогоном на чистом стеке (его в этом ревью нет).
* **Влияние:** G4-доказательство не воспроизводимо из репозитория/чистого стека; нельзя
  поставить в release-CI; reviewer вынужден доверять «стенду, который уже был».
* **Fix:** fixture регистрирует B через BFF (`POST /auth/register` + Mailpit verify) с
  уникальным email/паролем, либо test-overlay сеет второго realm-пользователя; убрать
  захардкоженные пароли из spec.
* **Тест:** `down -v` → overlay up → F7B 2/2 без ручной подготовки; CI job на чистом стеке.

### P2-02. Destructive SQL-reset в e2e включён по умолчанию и обходит revoke-семантику

* **Файл:** `frontend/e2e/e2ee.real.spec.ts:50,152-218` — `DB_CHECK` по умолчанию `true`;
  `preLoginRevokeAllDevices` делает `UPDATE auth.devices SET status='REVOKED'…` по
  захардкоженным `krug-postgres`/`krug`/`krug_migrator`. `UPDATE` не эмитит
  `device.list.changed`/`session.revoked`, не делает `key_generation++`, не закрывает WS
  (F7B report §8.2 это признаёт).
* **Влияние:** при `E2EE_REAL_BASE_URL` на общий/прод-стенд, но локальном контейнере с тем же
  именем, harness массово отзывает устройства двух пользователей; доказательство revoke
  подменяется SQL-фикстурой, а не product-путём.
* **Fix:** требовать явный `E2EE_REAL_ALLOW_DESTRUCTIVE=1` + проверку compose-project label/
  имени БД/наличия overlay-маркера; по возможности использовать API-revoke; для CI — отдельная
  одноразовая БД.
* **Тест:** без opt-in harness падает до SQL; с opt-in — на одноразовом стеке; revoke-события
  проверяются отдельным API-сценарием.

### P2-03. Накопление E2EE-workspace'ов и flag-on тестовый стек

* **Факт:** в текущей тестовой БД **39** workspace'ов `E2EE F7B` (и 39 E2EE всего); API
  удаления workspace нет; F7B создаёт новый на каждый прогон. Контейнеры `krug-backend`
  (`KRUG_E2EE_ENABLED=true`) и SPA (`VITE_E2EE_ENABLED:"true"`) оставлены в flag-on
  (F7B report §8.11); base `.env`/compose при этом `false` (`deploy/.env:44`,
  `deploy/docker-compose.yml:275,304`).
* **Влияние:** тестовая БД растёт; «base false» не отражает фактическое окружение; риск
  случайно принять flag-on стенд за production-конфигурацию.
* **Fix:** cleanup-job/reset БД в CI; после F7B возвращать base-compose; добавить проверку
  `docker inspect`/asset перед любым замером.
* **Тест:** CI teardown; preflight-скрипт, который проверяет флаги и отказывается работать на
  не-base стеке без явного флага.

### P2-04. Входящая local copy адресуется серверным `client_message_id` без привязки к `message.id`

* **Файл:** `frontend/src/e2ee/outbox/outboxStore.ts:1201-1234` — `lookupIncomingLocalCopy`
  принимает только `(chatId, senderDeviceId, clientMessageId)`; `serverMessageId` в копии
  хранится, но не сверяется. `frontend/src/store/chatStore.ts:2009-2012` — fallback на
  `kind:'none'` рендерит копию под новым серверным `id`.
* **Сценарий:** malicious/buggy server повторяет старый `client_message_id` с новым
  `message.id`; ratchet отвечает `DUPLICATE_OR_OLD_MESSAGE` (`none`), store показывает старый
  текст как новое сообщение (новая позиция/время). Это обходит display-level replay-защиту
  ratchet; нового plaintext сервер не получает.
* **Влияние:** ограниченная integrity-атака malicious server (повтор аутентичного старого
  текста под новым id), возможные ложные дубликаты.
* **Fix:** передавать `message.id` и требовать `copy.serverMessageId === message.id`, если
  сохранён; иначе — `unavailable`, не рендер. Для старых копий с `null` — отдельная политика.
* **Тест:** сервер отдаёт старый `client_message_id` под новым id → unavailable, не рендер;
  тот же id/тот же message.id → копия (reload).

### P2-05. `normative_invariants` в векторах противоречат v1-спеке и серверу

* **Файл:** `docs/E2EE-TEST-VECTORS.json:202` — `ciphertext_cap` всё ещё «decoded **16..33040**»,
  тогда как `limits.min_ciphertext_encoded_chars=363` (272 B) и сервер/DB/контракт — 272..33040;
  `:201` — `reset_retry_window` утверждает, что v1 шлёт `retry_of_client_message_id` в inner
  payload и получатель дедуплицирует по нему, хотя спека §3.5.1/§5.5 называет это **v1.1**
  (P2-10/P2-27 CR1d остаются OPEN).
* **Влияние:** нормативный G4-артефакт может ввести внешний conformance/аудит в заблуждение:
  принять 16..271 B и считать receiver-дедуп реализованным; расхождение с фактическим v1.
* **Fix:** исправить инварианты (272 B, v1.1-статус dedupe), bump `vector_set_version`
  (метаданные, не байтовые значения), перегенерировать/проверить KAT.
* **Тест:** `vectors.test.ts` проверяет `min decoded == 272` и отсутствие «16..33040»;
  конформанс-тест не принимает 271 B; L3b-инвариант помечен v1.1.

### P2-06. Реконсиляция из receive не получает `protectedSessionIds`

* **Файл:** `frontend/src/e2ee/session/receive.ts:407-414` — `reconcileParallelSessions` без
  `protectedSessionIds`; `parallel.ts:174,193` — защита есть только если набор передан;
  `chatBridge.ts:553-557` — `loadChat` передаёт `resettingSessions`, receive — нет.
* **Сценарий:** R-15 reset в процессе для loser-сессии; параллельный receive запускает
  reconcile и после окна удаляет сессию, которую reset ещё использует.
* **Влияние:** редкий сбой retry/данных при simultaneous init + reset; F6 report заявляет
  защиту «все сессии с активным reset», код защищает только loadChat-путь.
* **Fix:** передавать общий `resettingSessions` в receive-context/reconcile (или проверять
  reset-состояние внутри reconcile); тест state-machine.

### P2-07. Доказательства F7B частичные: negative key-change/TOFU, L3b, SPK_DELETED, multi-device, verify/QR

* **Факт:** F7B форсирует только `NO_SESSION` (очистка `sessions` store + reload). Не
  форсировались: тот же `device_id` с другими identity-ключами (`KEY_CHANGE_DETECTED`, send
  block, OPK не расходуется), `SPK_DELETED`/`KEY_HANDSHAKE_INVALID`/`DECRYPT_FAILED`,
  `delivered_before_reset>0` (L3b), второе устройство одного пользователя/self-envelope,
  safety-number verify/QR, revoke→verified reset. `USER_B`/`USER_A` — по одному устройству.
* **Влияние:** security-критичный TOFU/key-change путь и L3b остаются проверенными только
  unit/UI-тестами; G4-sign-off по E2EE-AC-04 неполный.
* **Fix:** test-only identity-rotation fixture (валидная binding-подпись нового ключа) +
  SQL/DB mutation; L3b E2E; multi-device fan-out E2E; verify/QR E2E.
* **Тест:** перечисленные сценарии в Chromium/Firefox; negative key-change — до accept send
  blocked, после accept — re-verify; verified сброшен.

### P2-08. Процесс/наблюдаемость: нет git/one-PR, log-capture, release-CI, checklist

* **Факт:** Git отсутствует; one-PR/patch-bundle не проверяемы. `log-capture` тест на
  отсутствие ciphertext/plaintext не добавлен (G4c condition №6) — есть только ручной grep
  (в этом ревью 2 ч логов, 0 `ciphertext`/`prekey`). `playwright.e2ee.config.ts` гейтится
  `E2EE_BROWSER_MATRIX=1` и не входит в `npm run check`; WebKit-job красный by design.
  Production enable checklist в `deploy/README.md` отсутствует (только «не использовать
  overlay»); review-07 condition №1 (постоянные real-HTTP regression-тесты на encoded paths/
  chunked/floor 524288/524289/272/363/33040/33041) и V19 в README/runbook по-прежнему открыты.
* **Влияние:** нельзя подтвердить «один PR/нет скрытых правок»; browser floor/log-инвариант
  могут регрессировать незаметно; оператор не имеет пошагового flag-on runbook.
* **Fix:** git/tag/patch-bundle; log-capture IT; release-CI с матрицей и F7B на чистом стеке;
  `deploy/E2EE-ENABLE-CHECKLIST.md` (см. условия).

### P2-09. Остаточные pre-existing риски kill-switch/retention/multi-node

* **Факт:** `SubscribedChat.server_last_seq` при flag-off включает скрытые E2EE-seq
  (G4b P2-03 residual) — после re-enable клиент может пропустить E2EE-сообщения до reload.
  Envelope/quarantine retention не реализован; quarantine — owner-only, RLS не FORCE
  (доступ runtime-роли закрыт grant'ом, но при `DB_USER==FLYWAY_USER`/широком GRANT станет
  читаемым). WS/rate-limiter/outbox — in-process, single-node; `chat.keys.changed`/
  `device.list.changed` не durable. SPK/OPK retention — B4-долг. Multi-account (P1-04 CR1d)
  остаётся ограничением. QR не рендерится. Safari не сертифицирован.
* **Влияние:** operational/compliance/UX, не криптографическая граница; для production
  нужны решения/владельцы.

### P2-10. F7B-evidence не привязано к финальному артефакту: образ старше последних правок

* **Факт:** `krug-frontend` image создан `2026-11-18T09:24:19Z` (12:24 MSK), а
  `src/e2ee/app/chatBridge.ts`, `src/store/chatStore.ts`, `src/store/e2eeChat.test.ts` и
  `e2e/e2ee.real.spec.ts` имеют mtime 13:20–13:22 MSK (10:20–10:22 UTC), т.е. **позже**
  сборки образа. Asset hash контейнера `bd730995…` (`index-CR-7e_FV.js`) не совпадает с
  локальной сборкой текущего дерева `fcf578df…` (`index-B_w0KzBS.js`). Наш независимый F7B
  прогон использовал существующий контейнер, а не rebuild финального дерева.
* **Влияние:** F7B 2/2 доказывает поведение образа 12:24, но не байт-в-байт финального
  источника; отчётный «финальный прогон» мог быть выполнен без rebuild после последних
  правок. Для G4-evidence и one-PR это существенно.
* **Fix:** `docker compose … up -d --build` на финальном дереве, зафиксировать image ID/
  digest, SHA-256 собранного asset и команду прогона в CI-артефакте; сравнить с git tag/
  patch-bundle. Только после этого F7B считать доказательством финального артефакта.
* **Тест:** clean rebuild → F7B 2/2 → asset hash и image digest записаны; повторный прогон
  на другом checkout даёт тот же hash при том же source/tag.

## Evidence (F6/F7A/F7B/server)

### F6 / §5.7

* `npx vitest run src/e2ee/parallelSessions.test.ts src/e2ee/sessionStore.test.ts
  src/e2ee/sessionSendReceive.test.ts src/store/e2eeChat.test.ts
  src/e2ee/app/chatBridge.test.ts src/e2ee/support.test.ts` — **6 files / 84 tests passed**.
* `parallelSessions.test.ts` **5/5**: simultaneous init, одинаковый winner на обеих сторонах,
  in-flight loser envelope, reload/idempotent recovery, pending-outbox deferral, winner keys
  после удаления.
* `sessionStore.test.ts` **26/26**, включая реальный CK0-форж (`:569-650`): `ns=0`/`ns+1` со
  старым CK0 отклоняются, MK/nonce не повторяются. Store-level P1-01R-R/CR1d закрыт в коде и
  тестах; F6 report risk №7 в этой части устарел.
* §5.7 metadata (`supersededBy/supersededAt/winnerConfirmedAt`) в plaintext+sealed, входят в
  `previousStateFingerprint`, монотонные переходы (`sessionStore.ts:448-490,1040-1107`).
* **Но:** целевой reload после удаления сессии (P1-01) не покрыт; F6 «no data loss» верен
  только для in-flight окна, не для истории после `deleteSession`.

### F7A / WebKit (независимый прогон)

```
E2EE_BROWSER_MATRIX=1 npx playwright test --config playwright.e2ee.config.ts
# 11 passed, 1 failed
# chromium 4/4, firefox 4/4, webkit 3/4
# webkit KAT: A2-Ed25519 got 0b15c5ca… != e5564300…; B3-SPK got 25951167… != c23934f4…
# support/tamper/diagnostic — green
# vectors: sha256 65aaac48b7a8ebd276ad66f689a1693ab869627c89cae134993f01c46da661f6,
#          118817 B — совпал во всех трёх
```

Это подтверждает F7A: Chromium/Firefox — floor; WebKit BLOCKED, но **гейт только тестовый**
(см. P1-04). `detectE2eeSupport` принимает WebKit, потому что проверяет наличие/self-verify,
а не RFC 8032-детерминизм.

### F7B (независимый прогон)

```
cd frontend
E2EE_REAL=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
  TMPDIR=/tmp/... CFFIXED_USER_HOME=/tmp/... \
  MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 \
  npx playwright test --config playwright.e2ee-real.config.ts
# 2 passed (23.2s): chromium 10.2s, firefox 11.3s
```

Сценарий реально выполнил: keyed registration + prekeys, `GET /devices` `e2ee_capable`,
DIRECT E2EE workspace/chat, A↔B send/decrypt, reload обеих сторон, R-15
(`NO_SESSION`→`SESSION_RESET`→re-encrypt→decrypt), safety number 60 цифр, envelopes-only DB,
no plaintext в WS/логах. Это сильное evidence, но с ограничениями P2-01/P2-02/P2-07/P2-10:
два контекста на одной машине, не два физических устройства; второй пользователь не
засеян; negative key-change не форсировался; контейнер собран в 12:24 MSK, а последние
правки source — 13:20–13:22 MSK, поэтому это не доказательство финального артефакта.

### Server/DB/logs (живая тестовая БД)

| Проверка | Результат |
|---|---|
| `message.messages` E2EE | **551**, из них с `body_ciphertext`/`content_meta≠{}`/`reply_to_id`/`sticker_id` — **0** |
| `message.message_envelopes` | **553**, вне 272..33040 — **0**; у каждого E2EE-сообщения ≥1 конверт (0 без envelope) |
| quarantine | **0** строк; `V19` применён |
| `ck_envelopes_ciphertext_min` | `convalidated=t` (parent+partitions) |
| RLS | `relforcerowsecurity=t` parent+partitions; `krug_app` не имеет `SELECT` на quarantine |
| роли | `DB_USER=krug_app` ≠ `FLYWAY_USER=krug_migrator` |
| backend logs 2 ч / 4802 строки | `ciphertext` — 0, `prekey` — 0; только `ws.session_id`/ids |
| E2EE workspaces | **39** `E2EE F7B` (accumulation, P2-03) |
| base flags | `.env`/compose — `false`; overlay — `true`; **running stack — true** |

Backend targeted: `E2eeMessageIT,E2eeMessageRealtimeIT,E2eeMessageFlagOffIT,
E2eeLegacyEnvelopeIT,E2eeEnvelopeValidatorTest` — **Tests run: 25, Failures: 0, Errors: 0**
(включая 16/16 `E2eeMessageIT`, 4/4 realtime). Полный `mvn test` в этом ревью не повторялся;
G4c 332/0 остаётся базой, targeted подтверждает отсутствие регрессии в E2EE-срезе.

Frontend full: `npm run check` — **EXIT 0**, 71 файл / **733 теста**, lint/format/contract/
stickers/security/session-writers ok, `tsc` clean, build 415 modules.

### Repro P1-01 (вне репо)

`/tmp/e2ee-g4-review/harness/repro2.test.ts` (vitest + fake-indexeddb, production-модули):
принять m1/m2, `deleteSession`, `lookupIncomingLocalCopy` → `available=true`; повторный
`receiveE2eeMessage` m2 (не-prekey) → **`NO_SESSION`**. Для prekey — `KEY_HANDSHAKE_INVALID`
(OPK не переиспользован). Это доказывает: copy есть, но receive-путь её не использует, а
`chatStore` вызывает lookup только на `none`.

### Ограничения доказательств

* Нет Git/one-PR; проверялось дерево, не diff.
* Нет внешнего третьего crypto-аудита; этот документ — G4-ревью проекта, не заменяет
  независимую сертификацию.
* F7B — один повторный прогон (2/2), не 10/10+5/5 из отчёта; стабильность подтверждена
  отчётом, но не стресс-прогоном.
* F7B — один host/два контекста; не два физических устройства и не shipping Safari.
* Backend полный suite не перепрогонялся; targeted 25/25 + G4c 332/0.
* SQL/log-проверки — текущая одноразовая БД; production-данные не проверялись.
* Дерево не заморожено: E2EE-файлы F6/F7B имеют mtime 13:20–13:22, ревью начато 13:23
  (т.е. снимок актуален на старт), но параллельные сессии после старта меняли
  `README.md`, `docs/TASKS*.md`, `design/dashboard/**`; повторный прогон на другом дереве
  может отличаться. Это ещё один аргумент за git/tag/patch-bundle.

## Browser floor

**ADR-26 корректен по факту, но неполон как политика включения.**

* Playwright WebKit 27.2 действительно не проходит A2 (empty message) и B3 (hedged/
  недетерминированная подпись); это подтверждено независимым прогоном, а не только отчётом.
  Chromium 159 / Firefox 159 проходят 22/22 KAT и 10/10 tamper.
* Исключить WebKit из **сертифицированного floor** и делать F7B только в Chromium/Firefox —
  приемлемо для включения E2EE **при условии**, что WebKit в runtime блокируется или явно
  помечается «не поддерживается». Сейчас этого нет: `detectE2eeSupport` даёт 8/8, gate —
  только CI. Поэтому Safari-пользователь получит E2EE без предупреждения (P1-04).
* `E2EE_UNSUPPORTED_BROWSER` должен проверяться в runtime (determinism/RFC-вектор), а не
  только в Playwright; `requireE2eeSupport` уже есть, но не вызывается.
* Матрица F7A должна быть в release-CI. Сейчас `E2EE_BROWSER_MATRIX=1` — ручной гейт;
  `npm run test:e2e:e2ee` на WebKit завершается exit 1 by design. Нужна явная политика:
  Chromium/Firefox — blocking; WebKit — expected-fail/отдельный gate, а не «красный job».
* Shipping Safari/iOS этой матрицей не проверялся; перед объявлением Safari во floor нужен
  стабильный Safari/iOS-прогон. Пока продукт должен честно писать «Safari не поддерживается».

## R-15/key-change gaps

| Gap | Статус | Severity / blocker |
|---|---|---|
| R-15 sender-окно, anchor, fallback `(dh,n)`, batch 20, невидимость control | Работает; F5F/F6 + targeted; F7B прошёл | нет |
| Receiver-дедуп переотправленных TEXT (`retry_of_client_message_id` в inner payload) | **v1.1**, в v1 не реализован; спека §5.5 честно пишет | P2; не блокер, если продукт не обещает «0 дублей» |
| R-15 reset, пропущенный по WS, но добранный `sync`/`resume.gap` | **Не обрабатывается** (P1-03) | **P1** |
| R-15 completed + reload: сообщения до якоря на удалённой сессии | **Ошибка вместо копии** (P1-01) | **P1** |
| §5.7 winner/loser, in-flight, reload, pending outbox | Реализовано, 5/5 + targeted; но history после loser-delete — P1-01 | **P1** (через P1-01) |
| Dedupe/rate-limit reset in-memory, не durable | P2-29 CR1d, остаётся | P2; после reload dedupe теряется, но invalid_session обычно ловит |
| Negative key-change/TOFU (same device_id, новые ключи) | Не форсировался live; unit/UI есть | **P2-evidence**; для E2EE-AC-04 нужен live-тест (P2-07) |
| `verified`/safety-number attestation, verified reset | **Не реализовано в клиенте** | **P1-02** |
| SPK_DELETED / KEY_HANDSHAKE_INVALID / DECRYPT_FAILED reset | Код есть, F7B форсирует только `NO_SESSION` | P2-evidence |
| Multi-device/self-envelope (AC-07) | Backend G4b покрыл; F7B — 1 устройство на пользователя | P2-evidence |

## Условия включения

Ни одно из условий не является «пожеланием»: каждое проверяемо и должно быть закрыто до
`KRUG_E2EE_ENABLED=true`. Флаг остаётся `false`, пока условия не выполнены.

1. **P1-01 (history/copies).** Исправить `decryptE2eeSlice`/`lookupIncomingLocalCopy`:
   восстанавливать sealed incoming copy на `NO_SESSION`/`KEY_HANDSHAKE_INVALID`/`SPK_DELETED`/
   `DECRYPT_FAILED`; не отправлять reset по уже принятому; сохранять/восстанавливать
   `superseded` для R-15-замен. Тесты: §5.7 loser delete + reload; R-15 L3b
   (`delivered_before_reset>0`) + reload; 0 error/control-bubble, 0 дублей, 0 лишних reset.
2. **P1-02 (verification).** Реализовать `verifyDevice` (`PUT …/verification`, VH v2, MANUAL/QR),
   читать `verified/verified_at/method` из `DeviceKeyInfo`, отображать per verifier-device,
   сбрасывать при key change/revoke; E2E: verify → verified; второе устройство верификатора
   видит `verified=null`; key change → reset + re-verify. Если PM решает descope — убрать
   обещание из UI/AC-04/спеки и записать это как продуктовое ограничение (не рекомендуется
   для G4).
3. **P1-03 (catch-up).** После `runSync().catchUp` и `resume.gap` вызывать
   `decryptE2eeSlice`/обрабатывать control; E2E: WS off → message + SESSION_RESET → reconnect
   → decrypt/reset без reload; повторный sync не даёт дублей.
4. **P1-04 (WebKit/runtime floor).** Runtime self-test Ed25519 (determinism/RFC-вектор) и
   `E2EE_UNSUPPORTED_BROWSER` для WebKit, либо отдельное решение crypto-review о hedged
   Ed25519 + новый ADR. F7A-матрица в release-CI с явной политикой (Chromium/Firefox blocking,
   WebKit expected-fail/отдельный gate). Safari/iOS — отдельный gate, не «молча поддерживается».
5. **Negative key-change/TOFU + verified reset.** Test-only fixture легитимной ротации
   identity (валидная binding-подпись) или контролируемая SQL-мутация на одноразовом стенде:
   `KEY_CHANGE_DETECTED`, send blocked до accept, OPK не расходуется, сессия не
   перезаписывается, `verified` сброшен, после accept — re-verify; плюс L3b/multi-device E2E.
6. **Векторы.** Исправить `normative_invariants` (272..33040, v1.1-статус dedupe), bump
   `vector_set_version`; `vectors.test.ts`/conformance не принимают 271 B и не считают
   receiver-дедуп v1 реализованным. Пересчитать/перепроверить KAT; зафиксировать hash.
7. **F7B воспроизводимость/безопасность fixture.** Чистый стек (`down -v` → overlay → up)
   проходит F7B 2/2; B регистрируется fixture'ом (уникальные email/пароль), а не берётся из
   leftover; SQL-reset требует явного destructive-opt-in и проверки контейнера/БД; убрать
   захардкоженные креды; cleanup/reset БД в CI; после прогона вернуть base-compose.
8. **V19/production preflight.** На целевой БД: `ck_envelopes_ciphertext_min.convalidated=t`
   (parent+partitions), `relforcerowsecurity=t`, live только 272..33040, quarantine содержит
   ровно удалённые строки, `krug_app` не читает quarantine, `DB_USER != FLYWAY_USER`,
   backup/maintenance-window, forward-only. Прогнать `E2eeLegacyEnvelopeIT`/`E2eeMigrationIT`
   на release-candidate.
9. **Production checklist/flag discipline.** `deploy/E2EE-ENABLE-CHECKLIST.md`: base
   `.env`/compose `false`; overlay не используется; SPA собран с `VITE_E2EE_ENABLED=true`
   только после backend-флага; `docker inspect`/asset проверены; demo/test users
   (`test@krug.local`, `pickle-*`, F7B-креды) удалены; dev-session отключён; rate limits
   (claim/send/reset) включены; retention envelopes/quarantine определён; kill-switch
   (flag off → REST/WS/replay 409, `server_last_seq` не теряет seq) проверен; rollback —
   вернуть base-compose + restore V19 backup, данные не откатывать.
10. **Наблюдаемость/тесты/артефакт.** `log-capture` тест на отсутствие ciphertext/plaintext
    (backend + frontend), метрики `e2ee_prekey_undecrypted_24h`, `e2ee_reset_batch_size`,
    `e2ee_reset_duplicates` (v1.1), алерты key change/revoke; полный `npm run check`,
    backend full suite, F7A/F7B на финальном дереве; **чистый rebuild** с фиксацией image
    ID/digest и SHA-256 собранного asset в CI-артефакте (P2-10); git/tag/patch-bundle
    (one-PR).
11. **Поэтапность.** Сначала E2EE-workspace pilot на Chromium/Firefox с ограниченным
    кругом; общий flag-on — после пилота без инцидентов; Safari — отдельно; никаких
    «шифрование на диске»/backup-обещаний (§9.3).

## Остаточные риски

* **No PCS/backup:** потеря ключей = потеря истории; backup v1 вне E7; SESSION_IDLE_TTL/GC не
  заменяет backup. После P1-01 fix copies спасают только локально.
* **TOFU-окно:** первый контакт уязвим; malicious server может подменить ключи до сверки;
  safety number — единственный независимый канал, а attested `verified` пока не работает
  (P1-02).
* **Malicious server replay:** P2-04 (старый `client_message_id` под новым `message.id`);
  ratchet не даёт повторно расшифровать, но local-copy fallback может показать старый текст
  как новый.
* **R-15 v1:** receiver-дедуп переотправленных TEXT не гарантирован; batch/durable dedupe
  in-memory; L3b-маркер — v1.1.
* **Session/history GC:** §5.7 loser deletion и R-15 failed-session deletion уже сейчас
  удаляют сессии; без P1-01 fix любая такая сессия делает историю невидимой после reload.
  `pruneIdleSessions` пока не вызывается в production, но при включении GC риск станет шире.
* **Multi-account (P1-04 CR1d):** single-slot identity/K_storage/prekeys/pins; account switch
  без logout → `DEVICE_IDENTITY_MISMATCH`; реальные два аккаунта требуют per-user DB.
* **Safari/WebKit:** не сертифицирован; runtime gate отсутствует; shipping Safari/iOS не
  проверялся.
* **Single-node:** in-process WS hub/rate limiter; `chat.keys.changed`/`device.list.changed`
  не durable; multi-node fan-out отсутствует.
* **Retention/privacy:** envelope/quarantine retention не реализован; quarantine owner-only,
  RLS не FORCE (grant закрывает runtime, но конфигурация хрупкая); ciphertext/метаданные
  хранятся бессрочно.
* **Testing:** F7B — один host/два контекста, не два устройства; SQL reset обходит API
  revoke; нет git/one-PR; нет внешнего третьего crypto-аудита; тестовые workspace'ы
  накапливаются; flag-on тестовый стек оставлен запущенным; F7B-evidence снято с образа,
  который старше последних правок source (P2-10).
* **Pre-existing, не E2EE:** `server_last_seq` при flag-off; demo/test users; proxy
  double-decode `%2563`; `client_message_id` per-partition uniqueness; SPK/OPK retention;
  admin suspend не отзывает E2EE keys; QR UI не рендерится.

## Вопросы

1. **P1-02:** verification ceremony входит в v1 flag-on, или PM явно descope'ит её и убирает
   E2EE-AC-04/§7.4-обещания? Кто владелец `PUT …/verification` + E2E?
2. **P1-04:** WebKit блокируем в runtime (self-test) или принимаем hedged Ed25519 отдельным
   ADR/crypto-review? Кто владелец shipping-Safari gate?
3. **P1-01:** принимаем ли fix «copy-first on error» как release-blocking; кто владелец
   store/E2E тестов §5.7 + L3b + reload?
4. **F7B:** можно ли добавить регистрацию B через BFF/Mailpit и destructive-opt-in для SQL,
   чтобы F7B шёл на чистом стеке в CI? Кто владелец одноразовой БД/cleanup?
5. **Векторы:** исправляем `normative_invariants` с bump `vector_set_version` или
   отдельным erratum без изменения байтовых KAT? Кто перепроверит hash/24+3 KAT?
6. **V19/prod:** когда maintenance-window/backup и кто подтверждает `convalidated=t`/
   `FORCE=t`/quarantine на целевой БД? Кто гарантирует `DB_USER != FLYWAY_USER`?
7. **Kill-switch:** нужно ли исключать скрытые E2EE-seq из `server_last_seq`/слать
   `resume.gap`, чтобы после re-enable не терять сообщения? Это решение PM/ops.
8. **Rollout:** общий flag-on или сначала E2EE-workspace pilot? Кто владелец мониторинга
   `e2ee_prekey_undecrypted_24h`/reset-метрик и on-call runbook?
9. **One-PR/tag:** когда git/patch-bundle и финальный прогон full backend + F7A/F7B на
   release-candidate? Без этого G4-подпись неполная.

---

**Статус G4: DONE.** P0 нет. Подтверждены ядро E2EE, серверная граница, RLS, per-device
выдача, KAT/tamper, F7B 2/2, backend targeted 25/25, frontend 733/733; открытые P1 — history
после удаления сессии, verification, sync-catch-up reset, WebKit runtime floor. Итог:
**GO WITH CONDITIONS; в текущем дереве flag-on — NO-GO** до закрытия P1-01…P1-04 и условий
включения. Код/контракты/спека/векторы/`docs/TASKS*` не изменялись; создан только этот файл.

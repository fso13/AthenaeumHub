# E7-F8 — закрытие P1-01…P1-04 G4 final + rebuild/F7B re-evidence

> **Зона:** только `frontend/**`. Не изменялись `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `src/api/schema.d.ts`, base-флаги и Docker-файлы. Base
> `VITE_E2EE_ENABLED=false`; тестовый overlay — только для проверки.
>
> **Вход:** `docs/E2EE-REVIEW-09.md` (P1-01…P1-04, P2-04/P2-10, условия),
> `docs/E2EE-SPEC.md` §4/§5/§7, `contracts/openapi.yaml` (`GET /chats/{id}/keys`,
> `PUT /chats/{id}/keys/verification`, `DeviceKeyInfo`, `VerificationRequest/Response`),
> `frontend/E7-F6-REPORT.md`, `E7-F7A-REPORT.md`, `E7-F7B-REPORT.md`.
>
> **Итог:** P1-01…P1-04 закрыты кодом и тестами; P2-10 пере-подтверждён чистым
> rebuild'ом финального дерева и F7B Chromium/Firefox. **DONE** в пределах E7-F8;
> условия flag-on, не входящие в эту задачу (live negative key-change, v1.1
> receiver-дедуп), остаются явными condition/risk.

## 1. Вердикт и базовая линия

| Проверка             | Результат                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base E2EE flag       | `deploy/.env` — `KRUG_E2EE_ENABLED=false`; base compose — `${KRUG_E2EE_ENABLED:-false}` / `VITE_E2EE_ENABLED=${KRUG_E2EE_ENABLED:-false}`; **не менялись** |
| Running stack        | только тестовый overlay: backend `KRUG_E2EE_ENABLED=true`, SPA собран с `VITE_E2EE_ENABLED=true`                                                           |
| Crypto/KAT           | ratchet, X3DH/DR, envelope/AAD, KAT и векторы не менялись; KAT **27/27**                                                                                   |
| `npm run check`      | **EXIT 0**, 72 файла / **755 тестов**, lint/format/contract/stickers/security/writers, tsc, build                                                          |
| F7B Chromium/Firefox | **2 passed (26.6 s)** на финальном образе                                                                                                                  |

## 2. P1-01 — история после `deleteSession` / R-15

**Было:** `decryptE2eeSlice` читал sealed incoming copy только на `kind:'none'`; при
`NO_SESSION`/`KEY_HANDSHAKE_INVALID`/`SPK_DELETED`/`DECRYPT_FAILED` показывался error
bubble и отправлялся `SESSION_RESET`, хотя копия уже расшифрованного сообщения лежала
в `localMessages`.

**Сделано:**

- `src/store/chatStore.ts`
  - `E2EE_COPY_RESTORE_CODES` = `NO_SESSION`, `KEY_HANDSHAKE_INVALID`, `SPK_DELETED`,
    `DECRYPT_FAILED`; на error-пути сначала читается sealed incoming copy, только потом
    error/reset. `KEY_CHANGE_DETECTED` намеренно **не** восстанавливается из копии —
    реальный key change остаётся блокирующим до явного accept.
  - `lookupIncomingCopy()` передаёт `message.id` (P2-04); `copyView()` маппит
    `superseded` → `superseded`, `contentType=2` → `control` (никогда не bubble),
    иначе `decrypted`.
  - Sender-side: `lookupLocalCopy` теперь отдаёт `status`; после R-15 замены
    оригинал после reload остаётся `superseded` (не рендерится как новый).
- `src/e2ee/outbox/outboxStore.ts` — `lookupIncomingLocalCopy(..., expectedServerMessageId)`:
  если у копии сохранён `serverMessageId` и он не равен серверному `message.id`,
  копия не резолвится (P2-04 replay старым `client_message_id` под новым id).
  Для legacy-копий с `serverMessageId=null` сохранено прежнее поведение.
- `src/e2ee/app/chatBridge.ts` / `app/types.ts` — проброс `status`, `serverMessageId`.

**Тесты:**

- `src/store/e2eeChat.test.ts` (+5): `NO_SESSION` + copy → decrypted, **0 reset,
  0 POST**; prekey `KEY_HANDSHAKE_INVALID` + copy → decrypted, 0 reset; control-copy
  на error-пути → `control`, 0 reset; copy с другим `serverMessageId` → `unavailable`;
  `superseded` outgoing copy после reload → `superseded`.
- `src/e2ee/sessionSendReceive.test.ts` (+2): реальный `deleteSession` после
  prekey-приёма → повторный `receive` = `KEY_HANDSHAKE_INVALID`, копия доступна;
  normal-envelope после `deleteSession` → `NO_SESSION`, копия доступна;
  тот же copy с чужим `serverMessageId` → `available:false`.
- F7B: после очистки `sessions` и reload история B восстанавливается из copies,
  0 error-bubble и **0 POST** до появления нового недоступного сообщения.

**Ограничение (явно):** receiver-side `superseded` для уже заменённых R-15 сообщений
без v1.1-маркера (`retry_of_client_message_id` в inner payload) невозможен: v1 не
передаёт соответствие «старый client id → новый». После reload получатель может
увидеть и старый исходник (из incoming copy), и замену. Sender-side restore закрыт;
receiver-side дедуп — условие v1.1 (P2-05/P2-27 CR1d), не расширялось в E7-F8.

## 3. P1-02 — verification / safety number до сервера

**Было:** `verified` жёстко `false`, `PUT` не вызывался, `verificationHash` не
использовался, `DeviceKeyInfo.verified` не читался, «Сверить» отсутствовала.

**Сделано:**

- Контракт: `PUT /chats/{chatId}/keys/verification` с `VerificationRequest`
  (`device_id`, `method`, `vh_version=2`, `safety_number_hash`, optional
  `expected_key_generation`), `Idempotency-Key`; ответ `VerificationResponse`.
  `src/api/http.ts` — JSON-PUT (`putJson`), `src/api/e2eeDeviceApi.ts` — `verifyDevice`.
- `src/e2ee/device/binding.ts` / `device/types.ts` — `DeviceKeyInfo.verified`,
  `verified_at`, `verification_method` читаются и валидируются в
  `VerifiedDeviceKeyInfo`. Это attestation per `(verifier X-Device-Id, target, chat)`,
  не локальный источник доверия.
- `src/e2ee/app/chatBridge.ts` — `verifyDevice(chatId, targetDeviceId, method)`:
  свежие chat keys, запрет при unaccepted key change, VH v2 через
  `computeVerificationHash` (те же 60 цифр, что в диалоге), `PUT` с
  `Idempotency-Key`, проверка эха `chat_id/verifier_device_id/device_id/
key_generation/method/verified`, `409 KEY_CHANGED` → `KEY_CHANGE_DETECTED`,
  прочие ошибки → `VERIFICATION_FAILED`. Кэш ключей инвалидируется.
- `src/store/chatStore.ts` — `verifyE2eeDevice()`; `verificationHashes`
  (`Record<deviceId, b64u>`), `verifyingDeviceId`, `verificationError`;
  `loadE2eeChat` читает `verified/verifiedAt/verificationMethod` и **принудительно
  гасит `verified`**, если по устройству есть unaccepted key change.
- `src/components/SafetyNumberDialog.tsx` — per-device «Сверено»/«Не сверено»,
  кнопка «Сверить» (disabled на время запроса), VH-хеш, дата сверки,
  «Нужна повторная сверка» при key change (кнопка скрыта), ошибки без raw-кодов.
- i18n/CSS: `e2ee.safetyVerify/safetyVerifying/safetyReverify/safetyHash/
safetyVerifiedAt/verifyFailed/verifyKeyChanged`, стили хеша.

**Тесты:**

- `src/api/e2eeDeviceApi.test.ts` (+2, MSW): точный PUT path/body/`Idempotency-Key`/
  `X-Device-Id`/`content-type=application/json`; `409 KEY_CHANGED` → `key_changed`.
- `src/e2ee/app/chatBridge.test.ts` (+2): VH v2 32 B, `expected_key_generation`,
  `verified` читается обратно из `DeviceKeyInfo`; 409 → `KEY_CHANGE_DETECTED`;
  unaccepted key change блокирует и verify, а stale `verified=true` от сервера
  локально гасится.
- `src/store/e2eeChat.test.ts` (+3): успешная сверка → device verified; ошибка не
  даёт fake verified; при key change verify не вызывается.
- `src/components/E2ee.test.tsx` (+2): диалог показывает hash, «Сверить» → «Сверено»
  и bridge-запрос; key change → «Нужна повторная сверка» без кнопки.
- F7B (реальный стек): A нажимает «Сверить» → `PUT …/keys/verification` **201**,
  body `method=MANUAL`, `vh_version=2`, `safety_number_hash` 43 b64u,
  `expected_key_generation>=1`; A видит «Сверено» после полного reload, B —
  «Не сверено» (scope verifier-device). Fake verified отсутствует.

## 4. P1-03 — sync/resume-gap catch-up

**Сделано:** `src/store/chatStore.ts` — `catchUp()` отслеживает, что страницы
реально смержились, и после цикла вызывает `decryptE2eeSlice(chatId)`. Через
`catchUp` проходят оба штатных пути: `runSync()` и `resume.gap`
(`handleResumeGap`). Это идемпотентно (`e2eeDecrypting` guard); control
`SESSION_RESET` обрабатывается тем же путём, plaintext-fallback отсутствует.

**Тесты:**

- `src/store/e2eeChat.test.ts` (+2): `/sync` добирает E2EE-сообщение и encrypted
  `SESSION_RESET` → сообщение расшифровано, reset обработан без reload, control
  скрыт; повторный sync не дублирует сообщение/вью.
- `src/store/realtimeStore.test.ts` (+1): `resume.gap` добирает E2EE-сообщение →
  `decrypted` в slice без live-кадра.
- F7B: live control может быть пропущен; reset теперь обрабатывается sync/catch-up,
  reload остаётся последним fallback (аннотация `R15_CATCH_UP_RELOAD` больше не
  обязательна).

## 5. P1-04 — WebKit runtime floor (ADR-26)

**Сделано:**

- `src/e2ee/crypto/ed25519Kat.ts` — RFC 8032 §7.1 TEST 1: seed
  `9d61b19d…`, empty message, public key `d75a9801…`, signature `e5564300…`.
  Проверяются: байт-в-байт `sign`, `verify` нормативной подписи, отказ
  tampered-подписи. Модуль без сети/storage/fallback.
- `src/e2ee/crypto/ed25519Pkcs8.ts` — общий RFC 8410 PKCS#8 wrapper (вынесен из
  `ed25519.ts`, без дублирования DER).
- `src/e2ee/crypto/support.ts` — `primitives.ed25519` теперь true только если
  проходит и self-consistent sign/verify, и KAT; иначе `available=false`,
  `missing` содержит `ed25519`, `requireE2eeSupport()` бросает
  `E2EE_UNSUPPORTED_BROWSER`.
- `src/e2ee/app/chatBridge.ts` — `initialize()` первым делом вызывает
  `requireE2eeSupport()`; keyed registration/prekeys не выполняются.
- `src/store/chatStore.ts` — `E2eeState.browserUnsupported`; ошибка
  `E2EE_UNSUPPORTED_BROWSER` даёт status error + флаг; `E2eeBanner` показывает
  честный текст «Этот браузер не прошёл проверку Ed25519 (RFC 8032)… используйте
  Chromium или Firefox» и не предлагает plaintext.
- i18n `e2ee.unsupportedBrowser`.

**Тесты:**

- `src/e2ee/support.test.ts` (+1): подмена `sign` только для empty message →
  self-consistency зелёная, KAT красный → `available=false`,
  `missing=['ed25519']`, `require` → `E2EE_UNSUPPORTED_BROWSER`.
- `src/e2ee/app/chatBridgeSupport.test.ts` (+2): `requireE2eeSupport` reject →
  `initialize` fail closed, `registerDevice` не вызван; при pass — bootstrap
  продолжается (floor не блокирует).
- `src/components/E2ee.test.tsx` (+1): `E2EE_UNSUPPORTED_BROWSER` → баннер,
  `browserUnsupported=true`, composer disabled, send не уходит.
- F7A-матрица (12 тестов, 3 движка): Chromium/Firefox — 8/8 и 22/22 KAT +
  10/10 tamper; WebKit — `available=false`, `missing=['ed25519']`,
  `requireE2eeSupport` → `E2EE_UNSUPPORTED_BROWSER`, KAT-фейлы A2/B3 записаны
  аннотацией. WebKit — **expected unsupported**, не «молчаливый pass» и не
  игнорируемый красный job.

## 6. P2-10 — rebuild и F7B re-evidence

Финальный overlay rebuild сделал **после** последних правок source, влияющих на SPA (no-cache; этот отчёт — документация и в runtime-asset не входит):

```bash
cd deploy
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml build --no-cache frontend
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --no-deps --force-recreate frontend
```

| Артефакт                    | Значение                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| image                       | `sha256:5eaa2ed747d1b6cd8ddc6c21f561bb6719ae772ea6bddf25ab4adbf40619225a`                             |
| image created               | `2026-11-18T11:02:24Z` (14:02 MSK)                                                                    |
| container image             | тот же digest; started `2026-11-18T11:02:25Z`                                                         |
| SPA asset                   | `assets/index-D7gHmGcS.js`, sha256 `bf82d7bfd439f1d5d2cfb8efd5ecf9e62e82e185ddd5c4b43f56b76c5c75f061` |
| `index.html` sha256         | `9b26a99724f6590152e6ecd0acff6c22b76772fda675df16324f6d2f5b2076bd`                                    |
| asset mtime в контейнере    | `2026-11-18T11:02:22Z` (14:02:22 MSK) — позже последней правки source                                 |
| `VITE_E2EE_ENABLED` в asset | `"true"`                                                                                              |
| backend flag                | `KRUG_E2EE_ENABLED=true` (только overlay)                                                             |
| base `.env`/compose         | `false`; не менялись                                                                                  |

Локальная overlay-сборка того же дерева (те же build args) воспроизвела **тот же**
asset hash `bf82d7bf…` и `index.html` `9b26a997…`; base-сборка `npm run check`
даёт другой (`index-C3-c8cMS.js`), как и ожидается при flag=false.

Финальный F7B (Chromium 159 / Firefox 159) на этом образе:

```bash
cd frontend
E2EE_REAL=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
  TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home \
  MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 \
  npx playwright test --config playwright.e2ee-real.config.ts
# 2 passed (26.6s): chromium 11.8s, firefox 13.0s
```

F7B проверил на финальном образе: keyed registration/prekeys, DIRECT E2EE,
A↔B send/decrypt, reload из local copies, P1-01 (copies, 0 лишних POST),
P1-02 (`PUT` 201, A «Сверено», B «Не сверено», persistence после reload),
новое сообщение → `SESSION_RESET` → re-encrypt → decrypt, safety number,
envelopes-only DB, 0 plaintext в DB/WS/backend-логах.

> F7B §5.1 старого отчёта («reload истории → NO_SESSION → reset») **уточнён**:
> после P1-01 история после потери сессии читается из copies и не должна давать
> reset. Reset теперь проверяется на **новом** сообщении без копии; это и есть
> продуктовое поведение после фикса.

## 7. Полный прогон

```
npm run check
# EXIT 0
# lint: 0 errors (2 pre-existing warnings CreateChatDialog)
# format:check ok
# contract:check ok
# stickers:check ok
# security:check ok
# session-writers:check ok (164 production files)
# vitest: 72 files / 755 tests passed
# tsc --noEmit clean
# vite build: 418 modules
```

KAT:

```
npx vitest run src/e2ee/vectors.test.ts src/e2ee/kStorageKAT.test.ts
# 2 files / 27 tests passed (24 KAT + 3 O)
```

F7A-матрица:

```
E2EE_BROWSER_MATRIX=1 npx playwright test --config playwright.e2ee.config.ts
# 12 passed: chromium 4/4, firefox 4/4, webkit 4/4 (ожидаемо unsupported)
```

## 8. Файлы

Новые:

- `src/e2ee/crypto/ed25519Kat.ts`
- `src/e2ee/crypto/ed25519Pkcs8.ts`
- `src/e2ee/app/chatBridgeSupport.test.ts`
- `frontend/E7-F8-REPORT.md` (этот файл)

Изменены (только `frontend/**`):

- store/UI: `src/store/chatStore.ts`, `src/store/e2eeChat.test.ts`,
  `src/store/realtimeStore.test.ts`, `src/components/SafetyNumberDialog.tsx`,
  `src/components/E2eeBanner.tsx`, `src/components/E2ee.test.tsx`,
  `src/i18n/ru.ts`, `src/styles/app.css`;
- E2EE core/bridge: `src/e2ee/app/chatBridge.ts`, `src/e2ee/app/chatBridge.test.ts`,
  `src/e2ee/app/types.ts`, `src/e2ee/device/binding.ts`,
  `src/e2ee/device/types.ts`, `src/e2ee/outbox/outboxStore.ts`,
  `src/e2ee/sessionSendReceive.test.ts`, `src/e2ee/crypto/support.ts`,
  `src/e2ee/crypto/ed25519.ts`, `src/e2ee/support.test.ts`,
  `src/e2ee/errors.ts`, `src/e2ee/api/deviceKeys.ts`,
  `src/e2ee/account/switch.test.ts`, `src/test/e2eeBridgeFake.ts`;
- API: `src/api/http.ts`, `src/api/e2eeDeviceApi.ts`,
  `src/api/e2eeDeviceApi.test.ts`;
- e2e/docs: `e2e/e2ee-browser.spec.ts`, `e2e/e2ee.real.spec.ts`, `README.md`.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, base-флаги, векторы/KAT, crypto-примитивы (кроме добавленной
runtime-пробы).

## 9. Risks / conditions (flag-on)

1. **Receiver-side R-15 duplicates** (v1.1): sender-side `superseded` restore
   закрыт; получатель без `retry_of_client_message_id` в inner payload не может
   сопоставить старый и новый client id. Это остаётся условием v1.1, не регрессией
   E7-F8.
2. **Live negative key-change** (same `device_id`, новые identity keys) по-прежнему
   не форсировался в реальном браузере: нужен test-only fixture легитимной ротации
   / контролируемая SQL-мутация на одноразовом стенде. P1-02 attestation при этом
   реально проверен; unaccepted key change блокирует и send, и verify, а stale
   `verified=true` локально гасится.
3. **Safari/iOS**: runtime floor теперь блокирует WebKit, но shipping Safari/iOS
   этой матрицей не сертифицирован. Это осознанный expected-unsupported, не
   «молчаливая поддержка».
4. **Legacy copies без `serverMessageId`**: P2-04 replay-binding применяется только
   к копиям, где серверный id сохранён; старые копии (до F7B) остаются legacy.
   Base-флаг false, production-копий нет; при включении нужна миграция или явное
   принятие (как и в F7B §8.10).
5. **F7B fixture/P2-01/P2-02/P2-03** (второй пользователь, destructive SQL,
   накопление workspace'ов) не входили в E7-F8 и остаются P2 из G4. Фиксированный
   прогон выполнен на текущем одноразовом стенде.
6. **P1-03 catch-up** вызывает decrypt после merge; если E2EE state ещё не ready,
   decrypt откладывается до следующего live/load. Это согласуется с прежним
   поведением и не даёт plaintext-fallback.
7. **P1-04 probe** добавляет RFC 8032 KAT в `detectE2eeSupport`, то есть в каждый
   старт bridge (кэш per `crypto`). Стоимость — один KAT на страницу/профиль;
   crypto/KAT не ослаблены.

## E7-F8 status

**DONE (P1-01…P1-04 + P2-10 re-evidence в пределах frontend).**
P1-01/P1-02/P1-03/P1-04 закрыты кодом и тестами; финальный образ
`sha256:5eaa2ed7…` собран после последних правок, asset hash зафиксирован;
F7B Chromium/Firefox — **2 passed**. Base E2EE flag остаётся **false**;
flag-on по-прежнему требует закрытия оставшихся условий раздела 9 и условий
`docs/E2EE-REVIEW-09.md`.

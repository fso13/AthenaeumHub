# E7-F3 — device registration, prekeys, binding и TOFU pinning

> Зона: `frontend/**`. `docs/**`, `backend/**`, `contracts/**`, `design/**`,
> `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts` не изменялись.
> Feature flag E2EE не включался; UI, store-интеграция и network E2E не
> добавлялись. CR1 (client crypto review F1/F2) условия **P1-03/P1-04/P1-05
> закрыты в этом срезе** — статус ниже.

## Статус

**DONE в границах E7-F3.** Реализованы регистрация identity-ключей устройства,
SPK/OPK provisioning и upload, все-or-none контракт `POST /devices`,
legacy-регистрация, retry-идемпотентность, `key_generation`, независимая проверка
SPK/binding-подписей, TOFU-пиннинг по `(user_id, device_id)` с key-change state,
P0-2b-сверка prekey↔bundle↔pin, fresh-device mode pin и типизированный API-адаптер
с маппингом `409/410/422`.

Вне среза, как и требовалось: X3DH/DR handshake/send/receive (E7-F4), UI (F5/F6),
браузерный/Tamper E2E (E7-F7), включение флага. **Нет `[BLOCKED]`**: контракт
I-01 уже содержит `DeviceRegistration`/`SignedPrekey`/`KeyClaim`/`ChatKeys`, спека
и контракт не противоречат реализации. Остаются `[OPEN]`-вопросы к crypto review
(ниже).

## P1 (CR1 conditions)

| ID        | Статус      | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-05** | DONE        | TOFU-пин, key-change state и chat-mode pin **запечатаны** `K_storage` (AES-256-GCM), plaintext в `pins` больше нет. `RECORD_TYPES` расширены `pin/keyChange/modePin`; AAD (без изменения 50-байтовой раскладки F2) привязывает запись к `(owner device, user, target device)` или `(owner device, chat)`. Пропавший/подменённый `K_storage`, ciphertext или scope → `KEY_STORAGE_UNAVAILABLE`, никогда «первый контакт». Старые plaintext-записи (если бы существовали) фейлятся, а не доверяются. Покрыто тестами sealed/scope/tamper/missing-key. |
| **P1-03** | DONE        | `SessionState`/`StoredSessionRecord` получили `spkId` (публичный, но продублирован в sealed secrets и сверяется при загрузке — правило F2). `collectActiveSessionSpkIds()` собирает ids из session state; `preparePrekeyUpload()`/`prepareDeviceRegistration()` передают их в `rotateSignedPrekey` автоматически. Сессии без `spkId` (созданные до F3/F4) дают `undefined`, а не пустой set: ротация сохраняет полный `current + 2 / 90 дней`, offline prekey не теряется молча. F4 обязан заполнять `spkId` при создании prekey-сессии.            |
| **P1-04** | DONE        | Account/device scope пинов — в AAD (`user_id` + target `device_id`), mode pin — chat scope. `destroyDeviceIdentity()`/`clearDeviceE2eeAccountState()` (logout hook) удаляют identity, `K_storage`, pending registration/upload, prekeys и pins одной транзакцией; следующий аккаунт не наследует trust. Смена владельца identity отклоняется `DEVICE_IDENTITY_MISMATCH`.                                                                                                                                                                            |
| **P1-…**  | NOT TOUCHED | Outbox, local copy, 50-байтовая AAD-раскладка `K_storage`, locks и session-outbox транзакции не менялись (кроме добавления `spkId` и новых `record_type`). Это остаётся F2F/CR1-скоупом.                                                                                                                                                                                                                                                                                                                                                            |

## Сделано

### 1. Identity устройства

`src/e2ee/device/identity.ts`, `types.ts`.

- Генерация IK_sig (Ed25519), IK_dh (X25519), `identity_binding_signature`
  (`D_IKBIND || u8(1) || IK_dh || IK_sig`) и fingerprint
  `SHA-256(D_FP || IK_sig || IK_dh)`.
- Обе приватные половины — `extractable:false`; при загрузке проверяется
  binding-подпись, fingerprint и **соответствие приватного ключа публичному**
  (Ed25519 challenge; X25519 — DH-симметрия `DH(priv, E) == DH(Epriv, pub)`).
  Подменённый/битый record → `KEY_STORAGE_UNAVAILABLE`, без «тихой» регенерации.
- Создание идемпотентно: гонка двух табов сходится на одном identity в одной
  транзакции; проигравший выбрасывает свои ключи.
- `key_generation` хранится локально (1 при регистрации, значение из ответа
  сервера), состояние identity: `unregistered/registered/revoked/conflict/legacy/invalid`.

### 2. Регистрация устройства

`src/e2ee/device/registration.ts`.

- `buildDeviceRegistrationBody()` — все пять ключевых полей + SPK + до 200 OPK;
  `assertRegistrationAllOrNone()` отклоняет частичный набор и OPK без ключей
  (`INVALID_KEY`), legacy-body — только name/platform/app_version.
- `prepareDeviceRegistration()` сначала персистит приватные prekeys, затем
  создаёт/переиспользует pending body. Повтор после crash возвращает **те же**
  ключи, SPK/OPK ids и `Idempotency-Key`; чужие/устаревшие pending
  отбрасываются, если referenced private key исчез.
- `registerDevice()` ретраит только transient-ошибки (network/timeout/429/5xx/
  `IDEMPOTENCY_IN_PROGRESS`) с тем же телом и ключом; 409/410/422 не ретраятся.
  `409 IDENTITY_KEY_CONFLICT` → state `conflict`, `410 DEVICE_REVOKED` →
  `revoked`, невалидные подписи → `invalid`; автоматической регенерации ключей
  нет.
- `completeDeviceRegistration()` проверяет `e2ee_capable=true`,
  `identity_key_alg=Ed25519+X25519`, побайтовое совпадение identity-ключей,
  fingerprint и SPK, `key_generation`; legacy-ответ на keyed-запрос —
  `INVALID_RESPONSE` + state `legacy`.
- `registerLegacyDevice()` — rollout-путь без ключей; legacy-ответ обязателен,
  keyed-ответ отклоняется. `verifyOwnDeviceRecord()` — P0-2b п. 3a: `GET /devices`
  сверяется с локальной identity, расхождение ключей → `KEY_CHANGE_DETECTED`,
  generation → `KEY_GENERATION_STALE`.

### 3. Prekeys и SPK retention

`src/e2ee/device/prekeys.ts`, `sessionSpk.ts`.

- SPK: X25519-пара, подпись `IK_sig` по `D_SPKSIG || u8(1) || u16(L) || spk_id ||
spk_pub`; ротация при отсутствии/истечении/возрасте ≥30 дней. Используется
  F2 `rotateSignedPrekey`: `current + 2 previous`, 90-дневное окно, 30-дневный
  TTL для неиспользуемых записей; `activeSessionSpkIds` передаётся автоматически
  (P1-03).
- OPK: batch provisioning; low-water `<20 → target 100`, hard cap 200; expired
  OPK prune; `key_id` не перезаписывается и не переиспользуется (коллизия
  пропускается); повторный consume — `KEY_HANDSHAKE_INVALID` (F2).
- `preparePrekeyUpload()` отдаёт точный `SignedPrekeyUpload` + `Idempotency-Key`
  и pending record; `uploadPrekeys()` ретраит те же bytes, `completePrekeyUpload()`
  проверяет `device_id`, `key_generation`, `signed_prekey_id`, counts/limit и
  удаляет pending только при совпадении токена (multi-tab safe).
- Гонка двух репленей: count перепроверяется внутри write-транзакции, поэтому
  второй таб не переполняет cap и не дублирует ids; pending с исчезнувшим OPK
  не отправляется на сервер.

### 4. Binding / claim / chat keys

`src/e2ee/device/binding.ts`.

- `verifyClaimedBundle()`: независимо проверяет `identity_binding_signature` и
  SPK-подпись, key-id формат, expiry, consistency `otp_exhausted`; fingerprint
  пересчитывает клиент.
- `validateClaimResponse()`: ровно один исход на запрошенное устройство, без
  duplicates/unknown/omitted, user_id совпадает, `NO_SPK/NO_KEYS` только для
  запрошенных.
- `validateChatKeysResponse()`: `security_mode=E2EE`, `verifier == my_device`,
  только ACTIVE, один self, binding+fingerprint каждого устройства; серверный
  `verified` не является источником локального trust.
- `verifyPrekeySenderIdentity()` — P0-2b: `prekey.sender_identity_*` == bundle ==
  TOFU pin; bundle-расхождение → `KEY_HANDSHAKE_INVALID`, pin-расхождение →
  `KEY_CHANGE_DETECTED`. Готово для F4 (сам X3DH не реализуется).

### 5. TOFU pinning и key change

`src/e2ee/device/pins.ts`, `pinStore.ts`.

- Пин по `(user_id, device_id)`, не по user; создаётся **после** проверки
  binding/SPK и до создания сессии/показа сообщения; `verified=false`.
- Любое отличие (IK_sig/IK_dh/binding/fingerprint/key_generation) →
  `KEY_CHANGE_DETECTED`, persisted key-change record, pin не перезаписывается,
  отправка блокируется `assertDeviceNotBlocked()`.
- `acceptKeyChange()` — только явное действие UI: перезаписывает pin,
  `verified=false`, `acceptedAt`, удаляет key-change state. Claim/keys никогда не
  вызывают его автоматически.
- `evaluateClaimPins()` / `evaluateChatKeysPins()` пиннят peer-устройства и
  проверяют self против локальной identity; возвращают `blocked` и статусы
  `first_contact/unchanged/key_change`. TTL пинов нет — только явное «забыть
  устройство».
- Sealed storage: см. P1-05; `mutateSealed*` — optimistic compare-and-retry, чтобы
  два таба не перетёрли security-решение.

### 6. Fresh-device mode pin

`src/e2ee/device/modePin.ts`.

- `chat_id → {mode, pinnedAt, source, confirmedByUser}` sealed.
- Сервер `E2EE` → pin E2EE, `allow_e2ee`.
- Сервер `MANAGED` + любой E2EE-признак (`local_e2ee_mode_pin`,
  `workspace_e2ee`, `peer_has_e2ee_capable_devices`, history marker) →
  `block_security_alert`, allowed outcomes ровно `E2EE_ONLY`/`NEW_MANAGED_CHAT`;
  in-place downgrade запрещён.
- Сервер `MANAGED` без признаков → `confirm_mode_required`, plaintext запрещён до
  явного `confirmManagedChatMode()`; подтверждение при наличии E2EE-признаков
  невозможно (`SECURITY_MODE_MISMATCH`).
- UI не добавлен; F5/F6 используют результат политики.

### 7. API adapter

`src/api/e2eeDeviceApi.ts` (вне `src/e2ee/**`, чтобы security guard не запрещал
network в крипто-модулях).

- `registerDevice`, `uploadPrekeys`, `listDevices`, `claimPrekeys` (без
  `Idempotency-Key`), `getChatKeys`; generated contract types.
- `DeviceApiError { kind, status, code, retryable, retryAfterSeconds, field,
deviceId, devices, requestId }`; маппинг всех `409/410/422` из §4.8, 401/403/
  404/429/5xx/network/timeout. Сообщения — только локальные тексты по `kind`,
  тело запроса и ключи не логируются и не попадают в `message`. Детали
  allow-list (`field`, `device_id`, `devices`).
- `onUnauthorized` hook позволяет F5 переиспользовать существующий reauth без
  копирования auth-flow.

## Контракт

| Что                                 | Изменение | Зачем                                                             |
| ----------------------------------- | --------- | ----------------------------------------------------------------- |
| `contracts/openapi.yaml`            | **нет**   | I-01 уже содержит все E2EE-схемы; F3 только типизирует/валидирует |
| `contracts/ws-protocol.md`          | **нет**   | вне среза                                                         |
| `frontend/src/api/schema.d.ts`      | **нет**   | не редактировался; `contract:check` in sync                       |
| `frontend/src/api/e2eeDeviceApi.ts` | новый     | типизированные вызовы и маппинг ошибок, без UI                    |

## Файлы

Новые production-модули:

- `src/e2ee/device/types.ts`, `identity.ts`, `registration.ts`, `prekeys.ts`,
  `binding.ts`, `pins.ts`, `pinStore.ts`, `modePin.ts`, `sessionSpk.ts`;
- `src/api/e2eeDeviceApi.ts`;
- test-only `src/e2ee/test/deviceFixtures.ts`.

Изменены:

- `src/e2ee/errors.ts` — client-local device/mode коды
  (`DEVICE_NOT_REGISTERED`, `DEVICE_IDENTITY_*`, `SECURITY_MODE_MISMATCH`,
  `MODE_CONFIRMATION_REQUIRED`; на wire не уходят);
- `src/e2ee/api/deviceKeys.ts` — экспорт wire-типов prekey upload/claim/device list;
- `src/e2ee/session/prekeyStore.ts` — `putOneTimePrekeyInTransaction`,
  `countAvailableOneTimePrekeysInTransaction` для атомарного replenish;
- `src/e2ee/session/types.ts`, `sessionStore.ts` — `spkId` в session state,
  plaintext+sealed cross-check (P1-03);
- `src/e2ee/storage/kStorage.ts` — `RECORD_TYPES.pin/keyChange/modePin` (AAD
  layout не менялся);
- `src/e2ee/test/fixtures.ts` — `spkId` в session fixture;
- `frontend/README.md` — раздел E7-F3.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, feature flag,
outbox/local copy/locks.

## Tests

`npm run check` (EXIT 0, финальный прогон после CR1-правок):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           168 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   46 files / 471 tests passed
tsc --noEmit             clean
vite build               331 modules
```

E2EE: **22 files / 263 tests**; KAT **24/24** (векторы v4 не менялись), прежние
F1/F2 тесты зелёные. Новые F3-тесты — **109**: 81 в `src/e2ee/device`, 28 в
`src/api/e2eeDeviceApi.test.ts`.

| Файл                          | Тестов | Покрытие                                                                                                                                                                                                  |
| ----------------------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device/identity.test.ts`     |     12 | генерация/загрузка, non-extractable private, binding/fingerprint, сходимость двух табов, user mismatch, подмена public/private, уничтожение identity+K_storage+pins                                       |
| `device/registration.test.ts` |     12 | full/legacy/partial body, same body+key на retry, complete-проверки echo/e2ee_capable/SPK/generation, legacy-ответ, 409/410/422 без регенерации, already_registered, own-device P0-2b                     |
| `device/prekeys.test.ts`      |     16 | SPK first/rotate/current+2, OPK fill/low-water/cap/no-duplicate/prune, pending upload reuse/invalid, SPK-only/OPK-only, complete-валидация, retry, legacy, concurrent replenish, active `spkId`           |
| `device/binding.test.ts`      |     16 | valid/bad SPK, bad binding, expiry/key-id/otp, claim duplicates/unknown/omitted/mismatch, chat-keys ACTIVE/self/fingerprint, P0-2b prekey↔bundle↔pin                                                      |
| `device/pins.test.ts`         |     15 | first/unchanged/key-change по всем полям, pin не перезаписывается, detectedAt, explicit accept, no auto-accept, per-device, sealed raw, scope mismatch, missing/tampered K_storage, claim/chat-keys flows |
| `device/modePin.test.ts`      |     10 | E2EE pin, MANAGED confirm flow, plaintext только после confirm, peer/workspace/history evidence, block + allowed outcomes, in-place downgrade запрещён, upgrade, delete                                   |
| `api/e2eeDeviceApi.test.ts`   |     28 | точные path/headers/body, claim без Idempotency-Key, все 409/410/422 коды, 429/5xx/400, details allow-list, отсутствие секретов в сообщении, 401 reauth один раз                                          |

Ключевые негативные проверки: частичный key set; legacy-ответ на keyed-запрос;
подмена identity-ключа/fingerprint/SPK; истёкший SPK; `otp_exhausted` mismatch;
повторный OPK id; pending с исчезнувшим private key; 409/410 не ретраятся и не
регенерируют ключи; pin mismatch → block, pin не перезаписан; scope swap
запечатанного пина → decrypt fail; missing K_storage → fail closed; mode
downgrade при E2EE-признаках запрещён; plaintext не отправляется до confirm.

## Risks / `[OPEN]`

- **`[OPEN]` AAD-слоты для пинов.** 50-байтовая раскладка `K_storage` не
  менялась. Для `pin/keyChange` слот `session_id` несёт b64u16 target device,
  `client_message_id` — user UUID; для `modePin` — b64u16 chat, второй слот
  `0×16`. Это использует существующие поля как opaque scope; crypto review должен
  подтвердить такую трактовку (P1-05). Смена трактовки — версия формата записей,
  не wire.
- **`K_storage` не at-rest.** Pins sealed защищают от plaintext-дампа IndexedDB,
  но не от JS в origin/кражи профиля; passphrase/unlock в v1 нет (P1-11/F2).
- **Потеря `K_storage` = потеря пинов.** Это осознанный fail-closed: запись не
  считается «первым контактом», требуется новое устройство/явное восстановление
  (UI — F5). Восстановления пинов из ничего нет.
- **`collectActiveSessionSpkIds` и legacy-сессии.** Сессии без `spkId` дают
  `undefined`, поэтому ротация консервативно сохраняет все `current+2/90d`.
  F4 обязан писать `spkId`; до этого 30-дневный unused-TTL не применяется к
  legacy-сессиям (это безопаснее, но менее строго).
- **`spkId` — новый optional-поле session record.** Старые записи читаются
  (`null`), новые пишутся и в plaintext, и в sealed secrets с cross-check; это
  расширение F2-формата, а не wire.
- **F3 не подключён к store/UI.** `chatStore.ensureDevice()` по-прежнему
  регистрирует legacy-body без ключей; переключение на `registerDevice()`/
  `registerLegacyDevice()` и `onUnauthorized`-hook — F5 (под флагом). Поэтому
  текущий UI-флоу не меняет поведение и не шлёт ключи.
- **Fresh-device mode policy не отрисован.** `evaluateChatMode()` возвращает
  action/allowedOutcomes; F5/F6 обязаны блокировать отправку и показывать alert/
  confirmation, иначе политика не действует.
- **Нет challenge-response при `POST /devices`.** Глобальная уникальность IK не
  доказывает владение; squatting/DoS остаётся принятым остаточным риском v1
  (§2.5/P2-6), TOFU/safety number его не устраняют.
- **Восстановление после 409/410.** Identity помечается `conflict`/`revoked`/
  `invalid`, повторная регистрация теми же ключами запрещена; F5 должен
  предложить новое устройство. Автоматического удаления/регенерации ключей нет.
- **`K_storage` удаляется при logout/reset**, session ciphertext остаётся
  нечитаемым; очистка sessions/outbox/local copy — F2F, не F3.
- **Нет внешнего crypto-review (G4).** KAT/негативные тесты ловят регрессии, но
  не ошибки дизайна; до G4 E2EE нельзя включать.
- **`fake-indexeddb`/jsdom, не реальный браузер.** Sealed pins и structured
  clone проверены в Node 24 + fake-indexeddb; реальная матрица — E7-F7 (G2).

## Что дальше

1. **E7-F4:** X3DH/DR handshake/send/receive на этих ключах; заполнять `spkId` в
   session state, вызывать `verifyPrekeySenderIdentity()` до создания сессии/
   расхода OPK, `evaluateClaimPins()`/`acceptKeyChange()` — только по политике F5.
2. **E7-F5:** подключить `createE2eeDeviceApi()` к bootstrap/re-auth, перевести
   регистрацию на keyed/legacy helper, logout → `clearDeviceE2eeAccountState()`,
   отрисовать mode confirm/key-change/blocked состояния; флаг не включать до G4.
3. **E7-F7:** реальные браузеры, kill-вкладки, vectors в CI, E2E двух устройств;
   закрыть `[OPEN]` AAD-слоты пинов на crypto review.

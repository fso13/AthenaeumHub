# E7-CR1c — независимый client crypto review после E7-F4 / E7-F2G

> **Рецензент:** независимый crypto/security-ревьюер; в подготовке E7-F1/F2/F3/F2F/
> F4/F2G не участвовал. **Дата:** 2026-11-17.
> **Вход:** `docs/E2EE-CLIENT-REVIEW-02.md` (CR1b, P1-04/P1-07/P2-17/18),
> `frontend/E7-F4-REPORT.md`, `frontend/E7-F2G-REPORT.md`, `frontend/src/e2ee/**`,
> `frontend/src/auth/{storage,runtime,MockOidcProvider,RealOidcProvider}.ts(x)`,
> `frontend/src/store/chatStore.ts` (только на границе снимка),
> `docs/E2EE-SPEC.md` §1.3/§2.3.1/§2.3.2/§3/§5, `docs/E2EE-TEST-VECTORS.json`,
> `docs/TASKS-E7.md`, `frontend/scripts/check-security.mjs`.
> **Зона:** этим ревью создан только этот файл; код, контракты, спека, векторы,
> `docs/TASKS*` не изменялись. Все probe/верификаторы — вне workspace (`/tmp`), в
> репозиторий не добавлялись.
> **Метод:** чтение production-кода и тестов; полный `npm run check`; независимый
> пересчёт нормативных векторов на Python `cryptography` 49.0.0 **прямо из JSON**
> (без `src/e2ee/test/vectors.ts` и без production-кода); независимые probe на
> production-модулях (storage/identity/kStorage/sessionStore/outbox/ratchet).

> **Граница снимка (важно).** Полный `npm run check` и все line-reference ниже —
> для **F4/F2G-снимка**: последняя правка `src/e2ee/**` — 12:37:59
> (`device/pins.ts`), `npm run check` запущен 12:41:17 и закончился 12:44
> (**50 файлов / 538 тестов, EXIT 0**). После 12:44:50 в дереве **параллельно
> появился E7-F5 WIP**: `src/e2ee/app/{flag,types,resetRetry,chatBridge}.ts` и
> изменённый `src/store/chatStore.ts` (12:47:55). Эти файлы **вне scope CR1c**,
> не проверялись как F5 и не учитываются в вердикте; отмечено только то, что
> меняет трактовку границы «production-вызовов нет» (см. «Проверки» →
> «Граница production-путей»). На 12:48 production-инъекции `e2eeDevice` нет,
> `e2eeEnabled` по умолчанию `false`, т.е. E2EE в сборке выключен.

## Вердикт

**GO WITH CONDITIONS — только на начало E7-F5 в коде при выключенном
`VITE_E2EE_ENABLED`.**

**NO-GO для включения E2EE, E7-F7 (реальные браузеры) и внешнего G4** до закрытия:

1. **P1-01R-R** — латентный nonce reuse через «DH-ratchet»-перезапись счётчика
   сессии (`sessionStore.writeSessionRecord`: `ns=0` принимается без смены
   `DHs/DHr/CKs`; probe `NONCE_REUSE=true`). Это остаток того же класса, что
   P1-01/P1-01R, и он станет активным на первом F5-вызове `saveSession`.
2. **P1-04** — закрыт **в коде**, но изоляция держится на том, что **каждый**
   F5-вызов передаст `userId`; `pinStore`/`session`/`outbox` API вообще не имеют
   понятия «текущий пользователь». Плюс: общая БД `krug-e2ee` + полный wipe на
   logout = logout одного аккаунта уничтожает живое состояние другого таба.
3. **P1-03** — закрыт **в коде** (retention 3/90, тесты 31/60/89/91), но **спека
   всё ещё нормативно требует удалять «unused» SPK по TTL 30 дней** (§1.3,
   §3.4.5.1) — расхождение спеки и кода надо снять до G4.
4. **R-15 / §5.7** — корректно отложены на F5 **как объём**, но:
   `cleanupUntouchedSessions` в F4 фактически недостижим (сессия с `ns=nr=0`
   никогда не персистится) — §5.7 «удаление проигравшей» не реализовано вообще, а
   не «консервативно»; для L3b-дедупа в v1 **негде передать**
   `retry_of_client_message_id` в перешифрованном TEXT (схема inner payload v1 не
   содержит поля) — это решение уровня спеки/контракта, а не «остаток F4».
5. **P2-25** (outbox: `superseded → failed → pending`) — прямая угроза L3b: R-15
   сможет воскресить уже заменённое сообщение; должна быть закрыта **до** R-15.

Что подтверждено независимо:

- **P1-07 закрыт нормативно и в коде.** §2.3.1 (50 B, offsets, sentinel,
  record types 1–6, `LOCAL_RECORD_VERSION=1`, nil-reject, инъективность) и
  §2.3.2 (слоты пинов) опубликованы; KAT O1/O2/O3 пересчитаны независимо из
  JSON — **AAD hex, AES-256-GCM `ct`+`tag`, injectivity, pin/keyChange/modePin
  совпали побайтово**.
- **P2-17 закрыт:** `acceptKeyChange` требует persisted `key-change`, равенства
  переданного bundle persisted `observed` и пина `observed.pinned`; пишется
  ровно `observed`; `acceptObservedKeyChange` — F5-путь без сети.
- **P2-18 закрыт:** `pinAad`/`modeAad` + §2.3.2 + O3 + интеграционный тест
  sealed pin; кросс-доменной коллизии AAD нет (record_type + фиксированные слоты).
- **P1-03 в коде:** `rotateSignedPrekey` больше не удаляет SPK по 30-дневному
  «unused»; retention `current + 2` в окне 90 дней; тест 31/60/89 retained, 91 —
  destroyed, 4-я ротация — destroyed.
- **P1-04 в коде:** production-hook на logout доведён до
  `clearAuthStorage()`/`clearRuntimeAuth()`; wipe одной транзакцией по всем 6
  сторам; owner-scoped `k-storage:v1` (`{v,userId,deviceId,createdAt,key}`),
  `loadDeviceIdentity(storage,{userId})`, fail-closed на legacy bare-key;
  тест двух аккаунтов есть. Probes подтверждают.
- **F4-интеграция состоятельна:** X3DH initiator/responder с полным §3.3.1
  чек-листом, Double Ratchet с DH-ratchet/skipped keys/лимитами, OPK только
  после AEAD в одной транзакции, scope/revision/counters/wire-envelope
  валидация, атомарный fan-out; CR1b P1-01R (stale/forged revision), P2-02
  (envelope scope), P2-16 (additional sessions) закрыты.
- **Прогон:** EXIT 0, **50 файлов / 538 тестов**, E2EE **26/330**, KAT
  **24/24** + O **3/3**, tsc clean, vite 350 модулей, `security:check` 181 файл.
- **Независимый KAT:** 78 проверок, 0 расхождений (O1–O3 полностью;
  B1/B3/B5/C1–C3/D1/D2/F1/F2/G1/G2/G4 — выборочно).

## P0

**Открытых P0 в поставляемом дереве нет.**

Обоснование:

- `VITE_E2EE_ENABLED` по умолчанию `false`; production-инъекции `e2eeDevice` в
  `chatStore` нет (на 12:48), `E2eeBridge` в production не создаётся; сетевого
  адаптера `createE2eeDeviceApi` в production-путях нет.
- Единственный production-путь, трогающий E2EE, — logout-hook
  (`clearAuthStorage` → `clearE2eeAccountStateOnLogout`); он только удаляет.
- Приватные ключи и `K_storage` — non-extractable; в `src/e2ee/**` нет
  `console`/`Math.random`/сети/`localStorage` (`security:check`, 181 файл).
- Ни один независимый KAT/probe не выявил расхождения байтов.

**Латентный P0 (становится P0 с первым F5-вызовом, который пишет состояние
сессии):**

- **P1-01R-R — nonce reuse через перезапись `ns` без DH-ratchet.**
  `sessionStore.writeSessionRecord` (`sessionStore.ts:588-630`) требует
  `record.revision === mode.ifRevision` (P1-01R закрыт), затем
  `assertCountersMonotonic` (`sessionStore.ts:562-582`) разрешает откат
  `ns → 0`, если `pn >= existing.ns`, **не требуя** смены `dhPublicKey`,
  `dhRemote` или `chainSend`. Состояние `{ns:0, pn:<old ns>, chainSend:<старый
  CKs>, dhPublicKey:<тот же>}` принимается, и следующий `ratchetSend` снова
  выдаёт `header.n=0` под тем же `DHs` и тем же `MK`.

  Probe (`/tmp/cr1c_probe2.ts`, production-модули):

  ```
  send#1 n=0 ns=1 revision=2 MK=3d8b2fa2a2537fdc
  forged ns=0 (same DHs/CKs) accepted=true
  send#2 n=0 same_header_dh=true
  NONCE_REUSE=true
  stored revision=3
  ```

  Тот же `MK` + тот же детерминированный nonce (§3.5.2: `N=HKDF(MK,...)`) =
  повтор AES-GCM nonce (XOR plaintext, forgery); AD отличается только `pn`,
  поэтому tag формально не совпадёт, но криптостойкость GCM уже потеряна.
  Достижимо только через `saveSession`/`writeSessionRecord` с
  сконструированным состоянием (F4 `send`/`receive` всегда меняют `DHs` на
  DH-ratchet и `ns` не откатывают), поэтому это латентный P0, а не активный.
  Это ровно тот класс, который CR1b просил закрыть; F4 закрыл stale/forged
  **revision**, но не «невозможный» откат счётчика.

  Fix (до первого F5-писателя состояния): для `record.ns === 0` при
  `existing.ns > 0` требовать `record.dhPublicKey !== existing.dhPublicKey`
  (или смену `chainSend`) — т.е. настоящий DH-ratchet; симметрично для
  `nr → 0` (`sessionStore.ts:573-581`) убрать `record.pn > existing.pn` как
  достаточное условие, требовать смену `DHr/DHs`. Тесты: forged rewind →
  `SESSION_STATE_STALE`; «MK после rewind не совпадает» (property/KAT).

- **P1-04-R (условный).** Если F5 где-либо вызовет `loadDeviceIdentity(storage)`
  или `loadOrCreateKStorage(storage, deviceId)` **без** `{userId}` (оба
  параметра опциональны и по умолчанию не проверяют user), второй аккаунт в том
  же профиле получит identity/`K_storage`/sessions предыдущего — это P0 по
  последствиям (чтение старых секретов). Сейчас это не активно только потому,
  что production-вызовов нет. Условие GO для F5 — п.2 ниже.

## P1 closure

| ID | Требование CR1 | Статус CR1c | Доказательство / остаток |
|---|---|---|---|
| **P1-01R** | Forged/stale prepared record не коммитится; counters монотонны; envelope ↔ state | **PARTIAL** (было OPEN) | `record.revision === ifRevision` (`sessionStore.ts:615-620`), `assertSessionScopeUnchanged`, `assertCountersMonotonic`, `assertEnvelopeChainStep` (`outboxStore.ts:499-529`, `header.n = ns-1`, `dh`, `pn`, chat/peer/sender). Probes: stale+свежий `ifRevision` → `SESSION_STATE_STALE`; повторный commit того же prepared → `SESSION_STATE_STALE`; `ns` rewind → `SESSION_STATE_STALE`. **Остаток P1-01R-R:** откат `ns→0` без DH-ratchet (см. P0) и «unadvanced state» коммитится (revision растёт, `ns` нет) — само по себе не даёт reuse, но store не требует строгого роста `ns` на send-пути. |
| **P1-03** | SPK TTL не должен уничтожать SPK, нужный в 90-дневном окне | **CLOSED в коде / OPEN в спеке** | `rotateSignedPrekey` (`prekeyStore.ts:327-400`) — retention `current+2` в окне 90 дней, `activeSessionSpkIds` больше не сокращает; тесты 31/60/89 retained, 91 destroyed, 4-я ротация destroyed. **Спека:** §1.3 (`SPK_TTL 30 дней`) и §3.4.5.1 («запись без сессий — по TTL 30 дней») остались — нормативное расхождение с кодом; §5.5 (90 дней) согласуется с кодом. Остаток P2-26: retention счётный, >3 ротаций внутри 90 дней уничтожают SPK моложе 90 дней. |
| **P1-04** | Account/device scope + wipe на logout/switch/revoke | **CLOSED в коде, с F5-условиями** | Hook: `account/logout.ts` ← `clearAuthStorage` (`auth/storage.ts:162-179`) ← `clearRuntimeAuth` ← Mock/Real providers (wipe awaited до redirect). Wipe одной транзакцией по `E2EE_STORE_NAMES` (`identity.ts:528-536`). Owner-scoped `k-storage:v1`, `loadDeviceIdentity(storage,{userId})`, legacy bare-key fail-closed (`kStorage.ts:270-275,361-405`). Тесты `account.test.ts` (5), probe: A→B identity/K_storage → `DEVICE_IDENTITY_MISMATCH`; wipe 6 сторов = 0. **Остатки:** (a) `userId` — opt-in у всех loader'ов, F5 обязан передавать; (b) `pinStore`/`session`/`outbox` не знают «текущего пользователя» (`pinStore.loadScope` берёт `identity.userId`), изоляция = только wipe; (c) mock-provider не await'ит wipe; (d) общая БД + полный wipe — logout одного таба убивает E2EE другого аккаунта (P2-24). |
| **P1-07** | Нормативная 50-байтовая AAD + KAT + инъективность | **CLOSED** | §2.3.1/§2.3.2; O1/O2/O3 в `docs/E2EE-TEST-VECTORS.json`; `kStorageKAT.test.ts` (3) читает только JSON; независимый пересчёт: AAD 50 B, `ct`+`tag`, offsets, nil/zero reject, pin/keyChange/modePin — совпало. Инъективность: фиксированные ширины + nil/zero reject + `record_type`/`LOCAL_RECORD_VERSION`; `local_message_id` вне AAD, но связан storage-ключом и sealed-payload cross-check (проверено в `decryptLocalCopy`). |
| **P1-02** (регресс) | Namespace локальной копии | **CLOSED** | `localCopyStorageKey` (`outboxStore.ts:169-181`) + `lookupLocalCopy` только outgoing/owner; тесты `outbox.test.ts:588-700`. |
| **P1-05** (регресс) | Sealed TOFU, key-change, пин до сессии | **CLOSED** | `pins.ts`/`pinStore.ts`; key-change persisted, пин не перезаписывается; F4 пишет пин после §3.3.1 проверок и до создания сессии (известный риск «пин до AEAD» — принят, не security downgrade). |
| **P1-06** (регресс) | Tab fencing | **CLOSED** | `locks.ts`; `drainOutbox` fail-closed при потере lease; F4 вызывает `fence.assertValid()` перед commit (`send.ts:469`, `receive.ts:359`), внутри lock — F5. |
| **P2-17** | `acceptKeyChange` связан с `observed` | **CLOSED** | `acceptObservedKeys` (`pins.ts:391-448`): нет warning → отказ; `expectedObserved ≠ observed` → отказ; пин ≠ `observed.pinned` → отказ; пишется `observed`. Тесты 183-235. |
| **P2-18** | AAD-слоты пинов нормативны | **CLOSED** | §2.3.2 + `pinAad`/`modeAad` (`pinStore.ts:85-112`) + O3 + `pins.test.ts:79`. Кросс-типовых коллизий нет: `record_type` 1–6 различает домены. |

### P1-01R-R. Откат `ns → 0` без DH-ratchet — латентный nonce reuse

**Файл:** `frontend/src/e2ee/session/sessionStore.ts` (`assertCountersMonotonic`
562-582, `writeSessionRecord` 588-630).

**Дефект.** Для DH-ratchet приёмник/отправитель сбрасывает `ns`/`nr` в 0,
поэтому store не может просто требовать `ns >= existing.ns`. Текущее исключение
— `record.ns === 0 && record.pn >= existing.ns` — принимает состояние, в котором
`DHs/DHr/CKs` не менялись, т.е. «ratchet» только по счётчику. После такого
коммита `ratchetSend` с прежним `chainSend` и `DHs` выдаёт тот же `MK` и `n=0`
(probe: `NONCE_REUSE=true`).

**Почему это не активный P0.** F4-пути (`ratchetReceive`) всегда генерируют
новую пару и меняют `DHs`, а `commitOutgoingMessage` дополнительно требует
`header.n === ns-1` и `ns >= 1`; `saveSession` — единственный путь, через
который сконструированное состояние попадает в БД, и в production его пока
никто не вызывает. Но F5 (R-15 reset/repair, «пересоздание» состояния) — именно
писатель.

**Fix.** Требовать реальный DH-ratchet (смена `dhPublicKey` **и**
`dhRemote`/`DHr`, либо смена `chainSend`) для отката `ns→0`, и смену DH для
`nr→0`; добавить тесты: forged rewind → `SESSION_STATE_STALE`; property-тест
«после принятого отката следующий send не повторяет ни один прежний `MK`»
(через KAT-движок).

### P1-03. Код закрыт, спека — нет

- Код: `SPK_RETAIN_PRIVATE=3`, `SPK_RETAIN_WINDOW=90d`, «unused»-удаление
  удалено; `activeSessionSpkIds` — advisory.
- Спека: §1.3 «`SPK_TTL` 30 дней» и §3.4.5.1, строка «SPK private … запись
  без сессий — по TTL 30 дней». (§2.3/§5.5 говорят про окно 90 дней и с кодом
  согласуются.) Это прямое нормативное
  требование уничтожать SPK, которое код сознательно не выполняет. Направление
  безопасное (код хранит дольше), но G4 не может подтвердить соответствие
  спеке; строка «запись без сессий — по TTL 30 дней» должна быть переписана в
  «не уничтожать до 90 дней / до подтверждения, что prekey не в полёте».
- Остаток P2-26: retention счётный — при ротации чаще 30 дней SPK может быть
  уничтожен раньше 90 дней; «каждый ≥30 дней» не гарантируется. Клиент
  ротирует по 30 дням, но защита от частой ротации (ручной re-register,
  несколько вкладок) отсутствует.

### P1-04. Что именно закрыто и что осталось на F5

Закрыто (проверено кодом и probe):

1. Production-hook есть и вызывается единственным путём logout
   (`clearRuntimeAuth` → `clearAuthStorage` → `clearE2eeAccountStateOnLogout`);
   в Real-провайдере wipe awaited **до** `signoutRedirect`.
2. Wipe удаляет **все** 6 сторов одной транзакцией; probe: `keys=0 prekeys=0
   sessions=0 outbox=0 localMessages=0 pins=0`.
3. `K_storage` owner-scoped: чужой user/device → `DEVICE_IDENTITY_MISMATCH`;
   unbound ключ привязывается один раз; legacy bare-key → `KEY_STORAGE_UNAVAILABLE`
   и не перезаписывается (probe).
4. `loadDeviceIdentity(storage,{userId})` отвергает identity другого аккаунта
   **до** загрузки приватных ключей; `createDeviceIdentity` — тоже.
5. Тест двух аккаунтов + reload + «старый ciphertext не расшифровывается».

Остатки (условия, не «done»):

- **Scope — opt-in.** `loadDeviceIdentity`/`loadOrCreateKStorage` без `userId`
  не проверяют user; `K_storageScope.userId?` и `LoadDeviceIdentityOptions.userId?`
  опциональны. Инвариант P1-04 существует только если F5 передаёт `userId`
  всегда. Рекомендация: в F5-обёртке сделать `userId` обязательным (или
  отдельный `loadScopedIdentity(storage, userId)`), а «без userId» оставить
  только тестам.
- **pinStore не имеет user-скоупа.** `loadScope` (`pinStore.ts:132-156`) берёт
  `identity.userId` и грузит `K_storage` по нему; `listSealedPins` перечисляет
  **все** пины и расшифровывает их. Пока identity принадлежит A, любой вызов в
  сессии B (если wipe не отработал) вернёт A-пины (peer user/device/fingerprint
  — метаданные, не текст). Нужен `userId` в API или fail-closed по текущему
  пользователю.
- **Mock-провайдер не await'ит wipe** (`void clearRuntimeAuth()` после
  `clearMockUser()`): закрытие вкладки сразу после logout может прервать
  IndexedDB-транзакцию. Fail-closed сохраняется только за счёт owner-проверок
  (см. первый пункт). Real-провайдер — awaited.
- **Общая БД + полный wipe.** `DEFAULT_DATABASE_NAME='krug-e2ee'` и
  `k-storage:v1` единые; sessionStorage — per-tab, значит два аккаунта в двух
  вкладках одного профиля возможны. Logout B удаляет identity/`K_storage`/
  sessions A в живой вкладке A → потеря состояния и невозможность расшифровать
  уже полученное (не cross-read, но data loss). Нужно решение: per-user имя БД
  (`deleteDatabase` при logout) или явный запрет второго аккаунта в профиле.
- **`listPins`/`evaluate*` без user-скоупа** — см. выше; F5-настройки
  «устройства/пины» должны фильтровать по текущему пользователю.

## P2

Статусы CR1b сохранены; ниже — остатки, новые пункты и то, что F4/F2G закрыли.
P2 не блокируют старт F5, но пункты с пометкой **F5** должны быть закрыты до
включения E2EE, а с пометкой **G4** — до внешнего review.

| ID | Тема | Статус CR1c | Комментарий |
|---|---|---|---|
| P2-01 | nil/absent AAD и `local_message_id` | **частично** | nil/zero reject есть; `local_message_id` по-прежнему не в AAD, но `decryptLocalCopy` сверяет `payload.localMessageId/clientMessageId/direction/chat/session/sender` со storage-записью (`outboxStore.ts:1216-1230`) — трансплантация внутри одного `session_id` ловится payload-ом, не AAD. Для AAD-only доверия остаётся P2. |
| P2-02 | Duplicate/чужие envelopes до commit | **CLOSED** | `normalizeEnvelopes` (`outboxStore.ts:230-269`): chat/sender/session-set, duplicate recipient/session; `assertEnvelopeChainStep` (dh/pn/n/recipient). Probe: чужой chat → `INVALID_ENVELOPE_FORMAT`; чужая сессия → `SESSION_STATE_STALE`; дубль recipient → `INVALID_ENVELOPE_FORMAT`. |
| P2-03 | Incoming commit без state; OPK delete до expiry | **частично (F5)** | `prepareIncomingMessage` по-прежнему допускает `sessionState=null`/`sessionMode=null`; production `receive` всегда передаёт state. `consumeOneTimePrekeyInTransaction` удаляет OPK до проверки `expiresAt`, но throw отменяет всю транзакцию — практической дыры нет, API приглашает к misuse. |
| P2-04 | `loadSession` не сверяет requested id; plaintext peer-поля | **OPEN** | `loadSession` берёт запись по key и не сверяет `record.sessionId === sessionId`; F4 смягчает `assertSessionMatchesIdentity` (peer keys/chat) на каждом send/receive, но store-level проверки нет. |
| P2-05 | `decodeHeader`/`parseAd` без range-check | **частично** | JSON-путь теперь строгий: `readInt(...,0,MAX_HEADER_COUNTER)`, `key_generation 1..2^31-1` (`envelope.ts:145-160,268-288`); `decodeHeader`/`parseAd` остались без range-check, но `parseAd` в production не вызывается. |
| P2-06 | `assertPrivateKey`/`assertSecretKey` без algorithm/usages | **OPEN** | Проверяются type/extractable; Ed25519-ключ можно сохранить как session DH (упадёт позже в WebCrypto). |
| P2-07 | Outbox lifecycle | **OPEN (F5)** | См. P2-25: `markOutboxFailed` переводит `superseded → failed`, `retryOutboxEntry` — `failed → pending`; одна corrupt pending-запись рушит весь `drainOutbox`; нет TTL/attempt cap; local copy `serverMessageId` не обновляется при `markOutboxSent`. |
| P2-09 | Тестовые пробелы | **частично** | F4 добавил out-of-order/replay/gap, OPK race, TOFU, fan-out rollback, AD tamper, SPK 31/60/89, envelope scope, forged/stale. Нет: low-order X25519, forged **counter rewind** (P1-01R-R), real-browser/kill-tab, двухаккаунтный **E2E send** (есть только storage-level). |
| P2-10 | Нижняя граница ciphertext в векторах | **OPEN (G4)** | `docs/E2EE-TEST-VECTORS.json:202` — «decoded 16..33040»; спека/клиент — 272..33040. Conformance может принять 16..271. |
| P2-11 | `ciphertexts[]` ≠ `envelopes` | **OPEN** | `prepareOutgoingMessage` берёт `draft.ciphertexts ?? envelopes.map(...)` без сверки; `send.ts` не передаёт `ciphertexts`, поэтому production-путь согласован; при прямом вызове — расхождение. |
| P2-12 | Канонический lower-case UUID | **OPEN** | `isUuid` только lower-case (`bytes.ts:126-136`); upper-case от сервера отвергается (fail-closed interop-nit). |
| P2-13 | Zeroization | **OPEN** | Best-effort; F4 обнуляет производные буферы в KDF/AEAD-путях, но seed/JWK/raw остаются в JS-памяти; не логируются. |
| P2-14 | `security:check` pattern-based | **OPEN** | Не ловит `globalThis['console']`, Worker/importScripts; `src/api/e2eeDeviceApi.ts` вне `src/e2ee/` (сети там by design, логов нет). |
| P2-15 | `drainOutbox` держит lock на время сети | **OPEN (F5)** | `send` внутри `withLock`; медленный send блокирует outbox других табов. |
| P2-16 | F2F pairwise-only | **CLOSED** | `additionalSessionStates` + `assertAdditionalSessionDraft`; revision каждого additional проверяется в `writeSessionRecord` (`record.revision === mode.ifRevision`). |
| P2-19 | `collectActiveSessionSpkIds` fallback | **CLOSED по дизайну** | Retention больше не зависит от advisory-множества; «undefined = не удалять» больше не маскирует TTL. |
| P2-20 | `ensureOneTimePrekeys` stale `available` | **OPEN** | Возвращает `available + created.length` из дотранзакционного счёта; не security, F5-метрики. |
| P2-21 | `pinChatMode` можно обойти | **OPEN (F5)** | `pinChatMode` публично пишет `MANAGED` с `confirmedByUser:true` без evidence; политика держится на `evaluateChatMode`/`confirmManagedChatMode`. F5-контракт + тест. |
| **P2-22** | §5.7 cleanup недостижим | **NEW (F5)** | `cleanupUntouchedSessions` (`receive.ts:379-397`) удаляет сессии с `ns=0 && nr=0 && skipped=[]`. Такие сессии **не персистятся**: send коммитит `ns>=1`, receive — `nr>=1` (DH-ratchet + gap/step). Тест `sessionSendReceive.test.ts:577-596` прямо ожидает 2 живые сессии. Т.е. §5.7-удаление не реализовано, а не «консервативно»; параллельные сессии копятся (их root keys/состояние живут до F5-GC). Нужно решение: детерминированный winner с обеих сторон + окно доставки, либо явно «не удалять» + TTL/GC и запись в спеке. |
| **P2-23** | pinStore/session/outbox без user-скоупа | **NEW (F5)** | См. P1-04 остатки: `loadScope` берёт `identity.userId`; `listSealedPins` возвращает все пины. API не знает текущего пользователя; изоляция = только logout wipe. |
| **P2-24** | Общая БД + полный wipe | **NEW (F5)** | `krug-e2ee`/`k-storage:v1` единые на origin; logout одного аккаунта во второй вкладке удаляет состояние другого (data loss, не cross-read). Per-user DB или запрет второго аккаунта — решение PM. |
| **P2-25** | `superseded` можно воскресить | **NEW (F5, до R-15)** | `markOutboxFailed` (`outboxStore.ts:1058-1078`) не защищает `superseded`; `retryOutboxEntry` переводит `failed → pending`. После R-15 «superseded» сообщение можно переотправить как новое → дубли/нарушение L3b. Плюс `drainOutbox` падает целиком на одной corrupt pending-записи. |
| **P2-26** | SPK retention счётный, не временной | **NEW** | `current+2` в окне 90 дней: >3 ротаций внутри 90 дней уничтожают SPK моложе 90 дней. Клиент ротирует по 30 дней, но защита от частой ротации отсутствует; «каждый ≥30 дней» не гарантируется. |
| **P2-27** | re-encrypted TEXT не может нести `retry_of_client_message_id` | **NEW (F5/spec)** | §3.5.1/§5.5 требуют класть `retry_of_client_message_id` в inner payload перешифрованного сообщения и дедуплицировать по нему; `serializeTextBody`/`parseTextBody` v1 (`payload.ts:128-179`) содержат только `{text, reply_to_id}` (+ reserved `mentions`), поля нет. Нужно либо расширить TEXT-схему (L-вектор/спека), либо перенести дедуп на локальный индекс (session+n) и переписать §3.5.1. |
| **P2-28** | `verifyOwnDeviceRecord`/`localIdentity` не вызываются F4 | **NEW (F5)** | Self-check «свои ключи = серверная запись» есть только в claim/chat-keys (`evaluateClaimPins`/`evaluateChatKeysPins`, `pins.ts:518-600`), а `createInitiatorSession` берёт свои ключи локально (крипто-безопасно). F5 обязан передавать `localIdentity`, иначе `selfVerified=false` и P0-2b self-проверка не выполнена. |

## Проверки

### Полный прогон (F4/F2G-снимок, 12:37)

```bash
cd frontend && npm run check
# EXIT 0
# lint                     ok
# format:check             ok
# contract:check           33 operations, 58 schemas (51 checked), types in sync
# stickers:check           ok
# security:check           181 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
# vitest                   50 files / 538 tests passed
# tsc --noEmit             clean
# vite build               350 modules
```

```bash
cd frontend && npx vitest run src/e2ee
# 26 files / 330 tests passed

cd frontend && npx vitest run src/e2ee/vectors.test.ts src/e2ee/kStorageKAT.test.ts
# 2 files / 27 tests passed  (KAT 24/24 + O 3/3)
```

Артефакт `frontend/dist/` пересобран штатным build; исходники не менялись.

### Независимый KAT (Python, прямо из JSON)

Верификаторы `/tmp/cr1c_verify.py` (Python 3, `cryptography` 49.0.0) читают
`docs/E2EE-TEST-VECTORS.json` напрямую; `src/e2ee/test/vectors.ts` и
production-код не импортировались. В репозиторий не добавлялись.

| Секция | Что сверено независимо | Результат |
|---|---|---|
| **O-kstorage-aad** | O1: 50-байтовый AAD (offsets 0/16/32/48/49), `ct`+`tag` при фиксированных key/nonce, decrypt round-trip, смена любого слота меняет AAD; O2: absent = `0×16`, nil UUID/zero session reject-правила, `null_and_nil_share_aad=false`; O3: `pin`/`keyChange`/`modePin` AAD, 50 B, различие по user/device/chat/типу | **совпало** |
| B-x3dh | B1: `DH1=DH(IK_A,SPK_B)`, `DH2=DH(EK_A,IK_B)`, `DH3=DH(EK_A,SPK_B)`, `DH4=DH(EK_A,OPK_B)`, `IKM` = `F` + `DH1..DH4`, `SK`, `SID`; B3: Ed25519 SPK-подпись; B5: 88-байтовый binding + verify | 3/3 |
| C-kdf | C1 HKDF session-id; C2 `KDF_RK` (RK'/CKs); C3 три шага `KDF_CK` | 3/3 |
| D-aead | D1 framing 26+body → padded 256; D2 `K_enc`/`N` из MK, AD 163 B, `ct` 272 B, decrypt | 2/2 |
| F-envelope | F1/F2 canonical JSON (1310/756 B), AD 163 B, PREKEY flag, preamble-hash slot, session_id slot, нулевой preamble-hash у F2 | 2/2 |
| G-verification | G1 fingerprint (SHA-256 domain‖IK_sig‖IK_dh); G2 safety number (entry 64 B, сортировка, SHA-512, digits mod 10^60, display, QR fp); G4 VH v2 | 3/3 |

**Итог: `checks=78 ok=78 fail=0`.** Отдельно отмечу: первая независимая попытка
посчитать `DH1 = DH(IK_A, IK_B)` **не сошлась** с вектором — и это ожидаемо,
потому что §3.3 определяет `DH1 = DH(IK_A, SPK_B)`, а `DH2 = DH(EK_A, IK_B)`;
после приведения к спеке всё сошлось побайтово. Верификатор не «подгонялся» под
код. Stateful E1/E2 независимо не переписывались (см. ограничения).

### Независимые probe (вне workspace)

`/tmp/cr1c_probe.ts` (vite-node, production-модули, memory storage):

```
P1-04 identity loaded for owner A: deviceId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
P1-04 loadDeviceIdentity(userId=B): DEVICE_IDENTITY_MISMATCH
P1-04 K_storage(userId=B, same device): DEVICE_IDENTITY_MISMATCH
P1-04 K_storage(other device, userId=A): DEVICE_IDENTITY_MISMATCH
P1-04 legacy bare K_storage: KEY_STORAGE_UNAVAILABLE
P1-04 legacy key untouched after failed read: true
P1-07 nil owner device: KEY_STORAGE_UNAVAILABLE
P1-07 zero session id: KEY_STORAGE_UNAVAILABLE
P1-07 nil client id: KEY_STORAGE_UNAVAILABLE
P1-07 absent AAD len=50 zeroSlots=true
P1-01R create -> revision=1
P1-01R stale prepared record + fresh ifRevision: SESSION_STATE_STALE
P1-01R second commit of same prepared object: SESSION_STATE_STALE
P1-01R ns rewind: SESSION_STATE_STALE
P1-01R unadvanced-state commit accepted=true ns=2
P2-02 envelope in another chat: INVALID_ENVELOPE_FORMAT
P2-02 envelope with foreign session: SESSION_STATE_STALE
P2-02 duplicate recipient envelope: INVALID_ENVELOPE_FORMAT
P2-02 scoped envelope accepted: true
P1-04 wipe stores: keys=0 prekeys=0 sessions=0 outbox=0 localMessages=0 pins=0
```

`/tmp/cr1c_probe2.ts` (production `sessionStore`+`ratchet`): `NONCE_REUSE=true`
для сконструированного `ns=0` без смены DH — P1-01R-R.

### Граница production-путей

- Единственный production-вызов E2EE-модуля — logout-hook
  (`src/auth/storage.ts:2,178`). `createE2eeDeviceApi` не инстанцируется.
- На момент 12:48 E7-F5 WIP (`src/e2ee/app/**`, `src/store/chatStore.ts`) уже
  импортирует bridge статически, но `e2eeEnabled` по умолчанию
  `deps.e2eeDevice !== undefined && isE2eeEnabled()`, а `e2eeDevice` в
  production не передаётся. **F5-WIP не проверялся** (вне scope) — его владелец
  обязан повторить полный прогон и запросить CR1d перед включением флага.

### Негативные проверки, покрытые тестами

Проверено авторскими тестами (выборочно подтверждено чтением): non-canonical
b64u/неизвестные поля/`v=2`/self-envelope; границы ciphertext 272/33040/form
guard; AD/header/preamble tamper; padding/content-type/bidi/C0/C1/
`attachment_refs`; `KEY_STORAGE_UNAVAILABLE` при отсутствии WebCrypto/
extractable key/битым sealed record; stale/forged session revision и counter
rewind; повторный OPK и OPK-race; повторный commit; corrupt session/outbox;
multi-tab CAS и потеря lease; sessionless prepare/commit; cross-wired state;
local-copy direction/scope/transplant; duplicate `tabId`; nil/zero AAD;
sealed pin scope/tamper/missing-key; `spkId` retention;
TOFU first-contact/key-change без перезаписи; `SPK_DELETED`; out-of-order/
replay/gap>MAX_SKIP; fan-out rollback; «нет plaintext/keys в текстах ошибок».

**Чего нет:** forged counter rewind (P1-01R-R), low-order X25519, logout в
процессе send, реальный браузер/kill-tab, двухаккаунтный E2E-send, re-encrypt
window/R-15.

### Ограничения ревью

- Нет реальных браузеров: jsdom/fake-indexeddb, Node 24. IndexedDB-адаптер
  ставит записи в staging и flush'ит их в конце тела транзакции
  (`indexedDb.ts:286-330`) с fail-closed, если тело успело await'нуть
  non-storage работу, — на реальных движках (Safari) это надо подтверждать в F7.
- E1/E2 (stateful Double Ratchet) независимо не переписывались; они покрыты
  авторским `ratchet.test.ts` + engine-KAT `sessionKAT.test.ts` (9) и моими
  проверками B1/C2/C3/D2/F1/F2, из которых следует совместимость KDF/AD.
- F5-WIP появился после снимка и не проверялся.
- Внешний crypto-review G4 не проводился; этот документ — client review.

## Условия GO для F5/F7

### F5 (код можно начинать сейчас; DONE — только при выполнении)

1. **P1-01R-R.** Ужесточить `assertCountersMonotonic`: откат `ns→0`/`nr→0`
   только при реальной смене `DHs`/`DHr` (или `chainSend`); тесты на forged
   rewind и на отсутствие повтора `MK`; property-тест в CI.
2. **P1-04 scope.** Любой production-вызов `loadDeviceIdentity`/
   `loadOrCreateKStorage` — с текущим `userId`; при mismatch — fail-closed
   (не «тихо» создавать новый identity), плюс явный flow «wipe + re-register».
   `userId` в `pinStore` API (или fail-closed по текущему пользователю).
   Await wipe и в mock-провайдере. Решить multi-account/общую БД (P2-24).
3. **R-15.** Persisted `lastResetAt` на сессию; reset только для failing
   peer/session; окно от якоря (`retry_of_client_message_id` /
   `failed_chain_dh`+`failed_n`), `MAX_RESET_BATCH=20`, новые
   `client_message_id`/`Idempotency-Key`, никакого plaintext-downgrade;
   **L3b-дедуп** (и решить P2-27: как передаётся `retry_of_client_message_id`);
   тесты L3/L3b/rate-limit/пустой набор.
4. **§5.7.** Решить: (а) детерминированный winner с обеих сторон + окно
   доставки, или (б) явно «не удалять» + TTL-GC и правка спеки; убрать
   недостижимый cleanup (P2-22) или починить условие; тест crossed sends.
5. **Outbox.** P2-25 (superseded нельзя `failed`/`pending`), per-entry
   изоляция ошибок в `drainOutbox`, attempts cap/TTL, `serverMessageId` в
   local copy после `markOutboxSent` (P2-07); lock ordering для multi-session
   send и timeout вокруг сети (P2-15); `fence.assertValid()` внутри lock.
6. **Ключи/поколения.** Перед send обновлять `key_generation` получателя из
   verified identity (иначе `KEY_GENERATION_STALE` на каждой ротации);
   `localIdentity` в claim/chat-keys (P2-28); `verifyOwnDeviceRecord` перед
   первым prekey-block.
7. **Никакого plaintext/ключей** в логах/ошибках/метриках; `security:check`
   обязателен; raw error не рендерить.
8. **Тесты:** forged rewind; stale prepared; двухаккаунтный logout/switch;
   logout во время send; crash после send до `markOutboxSent`;
   reset L3/L3b/rate-limit; 9-конвертный fan-out; два таба/expired lease.
   Не допускать падения 538+ тестов; KAT 24+3 — в CI.
9. **Спека (владельцу):** P1-03 (TTL 30 vs retention 90), P2-27
   (retry id в TEXT), P2-10 (нижняя граница ciphertext), §5.7 (winning/cleanup).
10. **Флаг** `VITE_E2EE_ENABLED` остаётся `false`; UI/F6 не включает E2EE без
    отдельного решения и закрытых P1/P0.

### F7/G4 (до включения)

- Внешний crypto-review: §2.3.1/§2.3.2 + O1–O3 + этот документ + stateful
  E1/E2; отдельно — пересчёт `K_storage` AAD/KAT и pin-AAD.
- Реальные браузеры Chrome/Firefox/Safari: X25519/Ed25519 WebCrypto
  feature-detect, non-extractable CryptoKey в IndexedDB, durability/`close`,
  write-staging/flush, Web Locks в фоне, kill-tab, IndexedDB quota.
- Двухбраузерный E2E двух устройств: prekey → DR → out-of-order → replay →
  key-change warning → reset.
- Векторы (24+3) в CI; `npm run check` на финальном дереве (не на движущемся).
- Только после этого — включение флага и продуктовые обещания (никакого
  «шифрования на диске», §2.3/§9.3).

## Вопросы

1. **P1-01R-R:** принимаем более строгий store-инвариант («откат `ns` только
   при смене `DHs`/`DHr`/`CKs»), даже если он запретит какой-то будущий
   «repair/reset»-путь F5? Кто владелец теста и KAT-property?
2. **§5.7:** удаляем проигравшую сессию (детерминированный winner + окно
   доставки) или официально «не удаляем» и добавляем TTL-GC? Сейчас
   `cleanupUntouchedSessions` — недостижимый код; это надо либо убрать, либо
   починить, но не оставлять «как будто реализовано».
3. **P2-27 (L3b):** как перешифрованное TEXT-сообщение несёт
   `retry_of_client_message_id`? Расширяем inner payload TEXT (новая ревизия
   схемы/вектор) или меняем §3.5.1/§5.5 на дедуп по локальному индексу? Без
   этого L3b-дедуп из спеки нереализуем.
4. **P2-24 (multi-account):** per-user имя БД `krug-e2ee:<userId>` +
   `deleteDatabase` на logout, или явно запрещаем второй аккаунт в одном
   профиле (и как это показывать)? От этого зависит P1-04 «account switch».
5. **P1-04 scope:** делаем `userId` обязательным параметром loader'ов (breaking
   для тестов/фикстур) или оставляем opt-in и полагаемся на F5-дисциплину?
   Кто владелец теста «второй аккаунт не читает A» на уровне send/receive?
6. **P1-03/P2-26:** оставляем счётный retention `current+2` (и правим спеку на
   «до 90 дней или до подтверждения, что prekey не в полёте») или вводим
   временной guard/`claimed_spk` состояние? Кто владелец правки §1.3/
   §3.4.5.1?
7. **P2-25:** до R-15 фиксируем инвариант «`superseded` терминален»
   (markOutboxFailed/retry не трогают) — согласовано?
8. **P2-28:** F5 передаёт `localIdentity` в claim/chat-keys и вызывает
   `verifyOwnDeviceRecord` перед первым prekey-block — или считаем, что
   локальные ключи самодостаточны (recipient всё равно проверит binding/
   preamble)? Нужно решение, иначе P0-2b-3a формально не выполнено.
9. **G4 scope:** достаточно ли client KAT + этот review, или нужен отдельный
   pentest WebCrypto/IndexedDB/Safari до включения флага?

---

**Итог.** F4/F2G существенно продвинули ядро: P1-07, P2-17, P2-18 закрыты
нормативно и подтверждены независимым KAT; P1-03 закрыт в коде; P1-04 закрыт в
коде (hook + полный wipe + owner scope) с чёткими F5-условиями; P1-01R
закрыт для stale/forged revision и envelope scope, но **не** для
сконструированного отката счётчика — это латентный P0, который станет активным
на первом F5-писателе состояния. R-15/§5.7 корректно вынесены в F5 как объём, но
§5.7-удаление фактически отсутствует, а L3b-дедуп невыразим в текущей схеме
inner payload. E2EE включать нельзя; F5 можно начинать в коде при `false`-флаге
с условиями выше.

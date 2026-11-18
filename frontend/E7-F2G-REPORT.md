# E7-F2G — P1-04, P1-07, P2-17, P2-18 closure

> **Зона:** только `frontend/**` + аддитивные правки `docs/E2EE-SPEC.md`
> (§2.3.1/§2.3.2, KAT-счётчики) и `docs/E2EE-TEST-VECTORS.json` (секция
> `O-kstorage-aad`). `docs/TASKS*`, `backend/**`, `contracts/**`, `design/**`,
> `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts` не изменялись.
> Feature flag E2EE не включался; UI, сеть, E2E и F5-оркестрация не добавлялись.
> R-15 auto-reset и §5.7 winner-deletion остаются F5.

## Статус

**DONE в границах E7-F2G.** P1-04, P1-07 (нормативно), P2-17 и P2-18 закрыты.
F4-API сохранены; изменения аддитивные (`loadDeviceIdentity(storage, {userId})`,
`loadOrCreateKStorage(storage, deviceId, {userId})`, `acceptObservedKeyChange`,
`pinAad`/`modeAad`, `readKStorageRecord`). P1-01R/P1-03/P2-02 остаются
закрытыми в F4 и не переоткрывались.

`npm run check` — **EXIT 0, 50 файлов / 538 тестов**; E2EE **26 / 330**;
KAT **24/24** (8 крипто-секций) + O-секция **3/3**; `security:check` 181 файл;
`vite build` 350 модулей.

## P1/P2 closure

| ID        | Статус                | Что закрыто                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Доказательство                                                                                                                                                                                                   |
| --------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-04** | **CLOSED**            | (1) Production logout hook: `clearAuthStorage()` (единственный путь logout — `clearRuntimeAuth()` real/mock OIDC) вызывает `clearDeviceE2eeAccountState()`; wipe удаляет **все** сторы одной транзакцией: `keys` (identity, `K_storage`, pending registration/upload), `prekeys`, `pins`, `sessions`, `outbox`, `localMessages`. (2) `K_storage` хранится owner-scoped записью `{v, userId, deviceId, createdAt, key}`; `loadOrCreateKStorage` отвергает чужой device/user (`DEVICE_IDENTITY_MISMATCH`), одноразово привязывает ранее unbound ключ к первому аутентифицированному user и больше не даёт его сменить; `loadDeviceIdentity(storage, {userId})` отвергает identity другого аккаунта. (3) Тест двух аккаунтов: A identity/`K_storage`/sealed secrets не читаются B; logout → все сторы пусты; reload → identity/K_storage отсутствуют, старый ciphertext не расшифровывается. | `src/e2ee/account.test.ts` (5), `src/e2ee/device/identity.test.ts` (12), `src/e2ee/kStorage.test.ts` (13), `src/e2ee/account/logout.ts`, `src/auth/{storage,runtime}.ts`, `src/auth/{Mock,Real}OidcProvider.tsx` |
| **P1-07** | **CLOSED нормативно** | В `docs/E2EE-SPEC.md` §2.3.1 опубликована точная 50-байтовая AAD-раскладка: offsets 0/16/32/48/49, RFC 4122 UUID bytes, `0×16` sentinel, record types 1–6, `LOCAL_RECORD_VERSION=1`, запрет nil UUID/zero session, инъективность, привязка `local_message_id` через storage key + sealed payload. KAT в `docs/E2EE-TEST-VECTORS.json` секция `O-kstorage-aad`: O1 (AAD hex + offsets + AES-256-GCM `ct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |                                                                                                                                                                                                                  | tag` при фиксированных key/nonce/plaintext), O2 (nil/zero инъективность). | `docs/E2EE-SPEC.md` §2.3.1, `docs/E2EE-TEST-VECTORS.json` O1/O2, `src/e2ee/kStorageKAT.test.ts` (3), `src/e2ee/kStorage.test.ts` |
| **P2-17** | **CLOSED**            | `acceptKeyChange(bundle)` больше не перезаписывает пин произвольным bundle: он обязан совпасть с сохранённым `key-change.observed`, пин — с `observed.pinned`; иначе `KEY_CHANGE_DETECTED` и транзакция отменяется (пин/warning не меняются). Добавлен безопасный F5-entry `acceptObservedKeyChange(userId, deviceId)`, принимающий ровно persisted `observed` без сети.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `src/e2ee/device/pins.ts`, `src/e2ee/device/pins.test.ts` (substituted bundle, no-warning accept)                                                                                                                |
| **P2-18** | **CLOSED**            | AAD-слоты пинов нормативны: `pin`/`keyChange` → `session_id` = target `device_id`, `client_message_id` = target `user_id`; `modePin` → `session_id` = `chat_id`, `client_message_id` = `0×16`; owner account/device — offset 0. Опубликовано в §2.3.2, KAT O3; интеграционный тест читает sealed pin и расшифровывает его именно нормативными слотами.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `docs/E2EE-SPEC.md` §2.3.2, `docs/E2EE-TEST-VECTORS.json` O3, `src/e2ee/device/pinStore.ts`, `src/e2ee/device/pins.test.ts`                                                                                      |

## P1-04: account/device scope и logout

### Что было

`destroyDeviceIdentity()` чистил только `keys`/`prekeys`/`pins`, production-вызова
не было, `clearAuthStorage()` чистил только `sessionStorage`, `K_storage` был
единым безымянным ключом, `loadDeviceIdentity()`/`loadOrCreateKStorage()` не
сверяли `userId`, теста двух аккаунтов не было.

### Что сделано

1. **Owner-scoped `K_storage`** (`src/e2ee/storage/kStorage.ts`).
   - Запись `K_STORAGE_RECORD_KEY='k-storage:v1'` теперь
     `StoredKStorageRecord { v, userId, deviceId, createdAt, key }`; ключ
     по-прежнему non-extractable AES-256-GCM.
   - `readKStorageRecord()` — fail-closed: отсутствие owner-маркера/битый
     record/старый bare-key не считаются «ключа нет» и не перезаписываются.
   - `loadOrCreateKStorage(storage, ownerDeviceId, { userId })`:
     чужой device/user → `DEVICE_IDENTITY_MISMATCH`; `userId:null` (создан до
     аутентификации) одноразово привязывается к первому scoped user внутри
     транзакции; после привязки смена user невозможна.
2. **Identity user scope** (`src/e2ee/device/identity.ts`).
   `loadDeviceIdentity(storage, { userId })` отвергает identity, привязанную к
   другому user, **до** загрузки приватных ключей. `pinStore` передаёт
   `identity.userId` в `loadOrCreateKStorage`.
3. **Полный wipe** (`destroyDeviceIdentity`/`clearDeviceE2eeAccountState`).
   Одна read-write транзакция по `E2EE_STORE_NAMES` (`keys`, `prekeys`,
   `sessions`, `outbox`, `localMessages`, `pins`) удаляет все ключи каждого
   стора. Это устраняет остаточные sealed session/outbox/local copy записи,
   а не только ключевой материал.
4. **Production hook** (`src/e2ee/account/logout.ts`,
   `src/auth/storage.ts`, `src/auth/runtime.ts`,
   `src/auth/{Mock,Real}OidcProvider.tsx`).
   - `clearAuthStorage()` очищает `sessionStorage` и **await**-ит
     `clearE2eeAccountStateOnLogout()`; `clearRuntimeAuth()` стал async и
     вызывает его.
   - Mock-провайдер: `clearRuntimeAuth()` запускается на logout; real-провайдер:
     wipe awaited **до** `signoutRedirect` (и перед fallback-навигацией).
   - Hook fail-closed: при недоступном/сломанном IndexedDB logout не
     блокируется; cross-account чтение всё равно отвергается owner-проверками.
5. **Тесты** (`src/e2ee/account.test.ts`):
   - A не отдаёт B identity/`K_storage` (чужой device и чужой user);
   - unbound `K_storage` привязывается один раз;
   - wipe очищает все 6 сторов;
   - `clearAuthStorage()` + reopen той же IndexedDB → все сторы пусты,
     identity/K_storage отсутствуют;
   - residual ciphertext после потери `K_storage` не расшифровывается.

### Совместимость

Изменение формата записи `k-storage:v1` — local record, не wire. Production
записей E2EE нет (флаг `false`); старый bare-key/запись без owner-маркера
фейлится `KEY_STORAGE_UNAVAILABLE`, а не принимается молча. F4-фикстуры,
создававшие `K_storage` до identity, продолжили работать через одноразовую
привязку user (проверено `sessionStore.test.ts`/`sessionSendReceive.test.ts`).

## P1-07: нормативная AAD и KAT

- `docs/E2EE-SPEC.md` §2.3.1 — таблица offsets/полей/кодировки, record types,
  версия, nil/zero-инъективность, `local_message_id`-граница.
- `docs/E2EE-TEST-VECTORS.json`:
  - `O1-kstorage-aad-kat`: AAD hex, offsets, фиксированные key/nonce/plaintext
    → `ciphertext||tag`;
  - `O2-kstorage-aad-injectivity`: absent = `0×16`, nil UUID/zero session
    отвергаются, `null` и nil не дают один AAD;
  - `O3-pin-aad-scope`: нормативные слоты пинов (P2-18).
- `src/e2ee/kStorageKAT.test.ts` читает **только** JSON (значения не
  дублируются): O1 пересчитывает AAD/шифртекст, O2 — sentinel/reject, O3 —
  pin/keyChange/modePin.
- Независимая проверка (Python `cryptography`): O1 AAD/ciphertext, O2 absent,
  O3 pin/keyChange/modePin — совпали байт-в-байт.

## P2-17: accept привязан к observed

`acceptKeyChange` теперь:

1. требует persisted `key-change` (иначе `KEY_CHANGE_DETECTED` — нельзя
   перезаписать «первый контакт»);
2. требует `observed` == переданному bundle (иначе отказ, warning и пин
   сохраняются);
3. требует, чтобы текущий пин совпадал с `observed.pinned`;
4. пишет пин **из `observed`**, очищает key-change, `verified=false`.

`acceptObservedKeyChange(storage, userId, deviceId)` — F5-путь, который вообще
не принимает bundle из сети, а читает ровно persisted `observed`.

## P2-18: AAD-слоты пинов

`pinStore` экспортирует `pinAad(userId, deviceId, recordType)` и
`modeAad(chatId)`. Раскладка — те же 50 байт, без нового префикса; слоты
задокументированы в §2.3.2 и закреплены O3 + интеграционным тестом sealed pin
(чужой user-слот → `DECRYPT_FAILED`).

## Файлы

Новые:

- `src/e2ee/account/logout.ts` — production logout hook;
- `src/e2ee/storage/runtime.ts` — singleton/инъекция `E2eeStorage` для logout;
- `src/e2ee/account.test.ts`, `src/e2ee/kStorageKAT.test.ts`.

Изменены:

- `src/e2ee/storage/kStorage.ts` — owner record, `readKStorageRecord`, scope;
- `src/e2ee/device/identity.ts` — `{userId}`, полный wipe;
- `src/e2ee/device/pinStore.ts` — `pinAad`/`modeAad`, scoped K_storage;
- `src/e2ee/device/pins.ts` — observed-bound accept + `acceptObservedKeyChange`;
- `src/auth/storage.ts`, `src/auth/runtime.ts`,
  `src/auth/MockOidcProvider.tsx`, `src/auth/RealOidcProvider.tsx` — hook;
- тесты `kStorage.test.ts`, `pins.test.ts`, `sessionStore.test.ts`,
  `vectors.test.ts`;
- `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json` — только AAD/KAT.

Не изменялись: `backend/**`, `contracts/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, feature flag,
UI, wire-формат.

## Tests

`npm run check` (EXIT 0):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           181 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   50 files / 538 tests passed
tsc --noEmit             clean
vite build               350 modules, built
```

- E2EE: **26 файлов / 330 тестов** (было 24/319 в F4).
- KAT: **24/24** (8 нормативных крипто-секций, v4 не менялся) +
  **O-секция 3/3**.
- Новых тестов — **11**: 5 account isolation/wipe/reload, 3 KAT O1–O3,
  3 pin policy (substituted bundle, no-warning accept, normative pin AAD).
- `sessionStore.test.ts` адаптирован: тест «чужой device» теперь проверяет и
  невозможность загрузить второй owner-scoped `K_storage` (P1-04), и
  store-level device check через тестовый facade.

## Risks / `[OPEN]`

- **F5 должен передавать `userId`** в `loadDeviceIdentity`/`loadOrCreateKStorage`.
  Helper это поддерживает и `pinStore` уже делает; без `userId` owner-user
  проверка не выполняется (device/AAD-проверки остаются). Это осознанный
  backward-compatible API, а не разрешение cross-account: production-путь F5
  обязан использовать scope.
- **`clearAuthStorage` стал async.** Все production-вызовы (`clearRuntimeAuth`)
  обновлены; внешним потребителям нужно `await`. В mock-провайдере wipe
  запускается без блокировки SPA-навигации; в real-провайдере — awaited до
  redirect.
- **Wipe best-effort.** При сломанном IndexedDB logout не падает; owner-проверки
  и отсутствие `K_storage` не дают читать старые секреты, но физическая запись
  может остаться. Полное `deleteDatabase` не делается, чтобы не ломать другие
  вкладки/открытые соединения; очистка сторов атомарна и достаточна для
  контракта «следующий аккаунт не наследует».
- **Формат `k-storage:v1` изменён** (owner wrapper). Production-записей нет;
  legacy bare-key/запись без owner-маркера fail-closed. Если появятся
  когда-либо старые профили — нужна явная миграция/wipe, не «тихое» принятие.
- **`acceptKeyChange` больше не работает без warning** (это и есть P2-17).
  F5 должен вызывать `acceptObservedKeyChange` после показа persisted warning;
  bundle-вариант оставлен для совместимости и проверяет equality.
- **R-15 auto-reset и §5.7 winner-deletion** не входят в F2G и остаются F5;
  F4-поведение не менялось.
- **G4/реальные браузеры** — по-прежнему E7-F7; O-векторы этого среза не
  заменяют внешний crypto-review.

## Что дальше

1. **E7-F5:** передавать `userId` во все scoped загрузки, использовать
   `acceptObservedKeyChange`, await `clearRuntimeAuth`, R-15/§5.7.
2. **E7-F7/G4:** внешний review, реальные браузеры, kill-tab, vectors в CI.

# E7-F2 — session storage, K_storage, outbox/local copy, Web Locks, OPK/SPK destruction

> Зона: `frontend/**`. `docs/**`, `backend/**`, `contracts/**`, `design/**`,
> `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts` не изменялись.
> Feature flag E2EE не включался; UI, сетевые вызовы и E2E не добавлялись.

## Статус

**DONE в границах E7-F2.** Реализованы:

- атомарные multi-store транзакции поверх IndexedDB и in-memory адаптера;
- `K_storage` (non-extractable AES-256-GCM) и шифрование записей сессий,
  outbox и локальной копии;
- версионированное хранилище ratchet-состояния на `(chat, device, peer_device)`
  с optimistic revision, индексом сессий и уничтожением прежних `DHs_priv`;
- OPK consume-once, SPK retention `current + 2 previous` / 90 дней /
  30 дней для неиспользуемых записей, уничтожение prekey-материала;
- outbox + локальная копия по P0-4: одна транзакция
  `state + exact envelopes + Idempotency-Key + client_message_id + copy`
  **до** сети, crash/replay-матрица, идемпотентный restore/markSent;
- Web Locks `krug-session:<session_id>` / `krug-outbox`, BroadcastChannel
  lease-fallback и локальный queue;
- тесты multi-tab: сериализация записи, stale-tab, отсутствие дублей отправки,
  отсутствие потери ключей.

`[BLOCKED]` нет. Есть `[OPEN]`-вопросы к crypto review (ниже), они не мешают
срезу, но должны быть закрыты до G4.

## Сделано

### 1. Атомарные транзакции

`src/e2ee/storage/types.ts`, `memory.ts`, `indexedDb.ts`.

- `E2eeStorage.transact(stores, mode, body)` — один атомарный unit для
  `sessions` + `outbox` + `localMessages` (§3.4.6).
- IndexedDB: все чтения выполняются на одной IDB-транзакции; записи
  стейджатся и выдаются в неё только после успешного завершения body.
  Исключение body / `abort` откатывает транзакцию — «полу-сдвинутое»
  состояние невозможно.
- In-memory адаптер: транзакции сериализуются, коммит — подмена карт стора,
  ошибка body не оставляет ни одной записи.
- Тело транзакции не должно ждать ничего, кроме storage-операций; WebCrypto
  (K_storage, prepare состояния) выполняется **до** открытия транзакции.
  Нарушение (запись после auto-commit) даёт `KEY_STORAGE_UNAVAILABLE`, а не
  молчаливую потерю.

### 2. `K_storage`

`src/e2ee/storage/kStorage.ts`.

- 32 случайных байта → `AES-GCM` `CryptoKey` с `extractable=false`, хранится
  в `keys/k-storage:v1`; raw-буфер обнуляется после импорта.
- Гонка первого запуска двух табов разрешается двойной проверкой внутри
  транзакции: оба таба сходятся на одном ключе.
- Шифруются `RK/CKs/CKr/MKSKIPPED` сессий, payload outbox и payload локальной
  копии. Nonce — 12 случайных байт на запись.
- AAD (спека задаёт список полей, но не байтовую раскладку):

  ```
  device_id(16) || session_id(16|0×16) || client_message_id(16|0×16)
    || record_type(u8) || version(u8)          // ровно 50 байт
  ```

  `record_type`: `1=session`, `2=outbox`, `3=localCopy`; `session_id` —
  16-байтовое значение протокола, UUID — RFC 4122 bytes, отсутствующий id —
  `0×16`.

- Честная граница P1-11: `K_storage` **не** at-rest-шифрование, passphrase/
  WebAuthn-unlock в v1 нет, `STORAGE_LOCKED` не используется. Потеря записи
  ключа делает старые записи нечитаемыми (`DECRYPT_FAILED`), восстановления нет.
- `localStorage`/`sessionStorage`/логи не используются; security guard
  запрещает `console.*`, `Math.random`, `localStorage`, `sessionStorage`,
  `fetch`/`XHR`/`WebSocket`/`sendBeacon` в `src/e2ee/**`.

### 3. Session store

`src/e2ee/session/types.ts`, `sessionStore.ts`.

- Запись на `session_id`; поля §3.4.5: `peer_user_id`, `peer_device_id`,
  `peer_ik_sig`, `peer_ik_dh`, `RK`, `DHs_priv/pub`, `DHr`, `CKs/CKr`,
  `Ns/Nr/PN`, `MKSKIPPED`, `version`, `created_at`, `last_used_at`,
  `local_copy_ref`. Дополнительно: локальный `device_id`, `revision`.
- Секреты (`RK/CKs/CKr/skipped MK`) лежат только в `K_storage`-sealed JSON;
  `DHs_priv` — non-extractable `CryptoKey` (structured clone IndexedDB).
  Публичные/routing-поля и счётчики продублированы в plaintext для индексов,
  но при загрузке сверяются с запечатанной копией; расхождение →
  `KEY_STORAGE_UNAVAILABLE`.
- Один `DHs` на запись: сохранение нового состояния перезаписывает запись и
  удаляет прежний private key; отдельного стора «исторических DHs» нет.
- Индекс `peer:<device>:<chat>:<peer_device> → sessionIds[]`; несколько сессий
  на пару разрешены (§5.7), создание/удаление обновляет индекс в той же
  транзакции.
- Optimistic concurrency: `saveSession` требует `{create:true}` или
  `{ifRevision:N}`. Stale tab получает `SESSION_STATE_STALE`; повтор после
  перечитывания под локом успешен. `revision` увеличивается на каждой записи.
- Retention: `MAX_SKIP=1000` (guard), `MAX_SKIPPED_TOTAL=2000`,
  `MAX_SKIPPED_PER_CHAIN=1000`, `MAX_SKIPPED_AGE=30 дней`, eviction старых;
  `SESSION_IDLE_TTL=90 дней` и `pruneIdleSessions()`.

### 4. OPK/SPK destruction

`src/e2ee/session/prekeyStore.ts`.

- OPK: `consumeOneTimePrekey()` — read+delete в одной транзакции; повторный
  consume → `KEY_HANDSHAKE_INVALID`. `consumeOneTimePrekeyInTransaction()`
  используется при приёме: AEAD выполняется **до** транзакции, поэтому
  неуспешная расшифровка не уничтожает OPK; откат транзакции возвращает ключ.
- SPK: `rotateSignedPrekey()` делает новый текущим, помечает предыдущий
  `retired_at`, оставляет ровно `current + 2 previous` (`SPK_RETAIN_PRIVATE=3`),
  уничтожает всё старше `SPK_RETAIN_WINDOW=90 дней` и (при переданном
  `activeSessionSpkIds`) неиспользуемые записи старше `SPK_TTL=30 дней`.
  `deleteSignedPrekey()` чинит указатель current.
- `destroyPrekeyMaterial()` — revoke/reset: удаляет все приватные prekey.
- Все приватные prekey — non-extractable `CryptoKey`; публичные значения и
  подписи — canonical b64u, без raw private bytes.

### 5. Outbox и локальная копия

`src/e2ee/outbox/types.ts`, `outboxStore.ts`.

- `prepareOutgoingMessage()` шифрует outbox payload и локальную копию
  **до** транзакции; `commitOutgoingMessage()` одной транзакцией пишет:
  новое состояние сессии (с CAS), точные `envelopes` (+header/ids),
  `Idempotency-Key`, `client_message_id`, `local_message_id`, локальную копию
  plaintext/ciphertext со `status='pending'`. Только после commit — сеть.
- Повторный commit того же `client_message_id` → `OUTBOX_CONFLICT`; состояние
  не двигается второй раз.
- `restorePendingOutbox()` только читает/расшифровывает, не перешифровывает.
  `markOutboxSent()` идемпотентен при тех же `server_message_id`/`seq` и
  конфликтует при других; обновляет локальную копию в той же транзакции.
- `drainOutbox()` — worker без сети: под `krug-outbox` перечитывает pending,
  отправляет сохранённые bytes, помечает sent; ошибка отправки сохраняет
  только код (`NETWORK`/`E2eeError.code`), не текст ошибки.
- `lookupLocalCopy()` возвращает `{available:false, clientMessageId}` при
  потерянной копии (честное «недоступно на этом устройстве»), а не пустое
  сообщение.
- `prepareIncomingMessage()` + `commitIncomingMessage()`: состояние + OPK +
  plaintext copy одной транзакцией; дубликат копии откатывает всё.

### 6. Web Locks и multi-tab

`src/e2ee/locks/locks.ts`.

- Primary: `navigator.locks.request("krug-session:"+session_id)` вокруг
  send/receive и `"krug-outbox"` вокруг outbox. Таймаут действует только на
  acquisition; уже начавшаяся критическая секция не прерывается.
- Fallback: BroadcastChannel lease-мутикс. Каждое взятие локально
  сериализуется, затем табы обмениваются `acquire`/`held`/`release`;
  победитель — минимальный `(at, tabId, token)`, lease продлевается и
  истекает при падении таба. Это best-effort координация, не security boundary.
- Last resort: внутриреалмовый queue (честная деградация без Web Locks/BC).
- Тесты multi-tab используют два IndexedDB-адаптера на одной БД и общий fake
  `LockManager`, то есть проверяют именно cross-tab семантику, а не только
  внутритабовую очередь.

## Соответствие §3.4.6 (crash/replay)

| Точка падения             | Что проверено                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| до commit                 | `prepare` без commit → outbox пуст, сессия не сдвинута                                        |
| после commit, до сети     | restore возвращает тот же `client_message_id`, bytes, `Idempotency-Key`                       |
| после сети, до `sent`     | повторный drain шлёт те же bytes; fake-server дедуплицирует по ключу, `markSent` идемпотентен |
| после `sent`              | restore пуст; локальная копия — источник отображения                                          |
| кэш очищен                | `lookupLocalCopy` → `available:false`, outbox-факт и id сохранены                             |
| конфликт/abort транзакции | состояние и outbox не пишутся частично; OPK не теряется                                       |

## Файлы

Новые production-модули:

- `src/e2ee/storage/kStorage.ts`;
- `src/e2ee/session/types.ts`, `sessionStore.ts`, `prekeyStore.ts`;
- `src/e2ee/outbox/types.ts`, `outboxStore.ts`;
- `src/e2ee/locks/locks.ts`;
- `src/e2ee/test/fixtures.ts` (test-only).

Изменены:

- `storage/types.ts`, `storage/memory.ts`, `storage/indexedDb.ts` — `transact`,
  secret-key guards, атомарность;
- `crypto/aead.ts` — AES-GCM с long-lived non-extractable `CryptoKey`;
- `crypto/keyGuards.ts` — `assertSecretKey` для `K_storage`;
- `constants.ts` — `MAX_SKIP`, `MAX_SKIPPED_*`, `SPK_RETAIN_*`, TTL;
- `errors.ts` — spec-коды §3.6 для F2/F4 (`NO_SESSION`, `SPK_DELETED`,
  `KEY_GENERATION_STALE`, …) и клиент-локальные `SESSION_STATE_STALE`,
  `OUTBOX_CONFLICT`, `LOCK_TIMEOUT` (никогда не уходят на wire);
- `scripts/check-security.mjs` — запрет сети в `src/e2ee/**`;
- `README.md` — раздел E7-F2.

Тесты: `storageTransactions.test.ts`, `kStorage.test.ts`,
`sessionStore.test.ts`, `prekeyStore.test.ts`, `outbox.test.ts`,
`locks.test.ts`, `multiTab.test.ts`.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, feature flag.

## Tests

`npm run check` (EXIT 0):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           150 files, no XSS/localStorage/token logs/E2EE console, Math.random, network
vitest                   39 files / 362 tests passed
tsc --noEmit             clean
vite build               331 modules
```

E2EE: **16 files / 182 tests**, из них **KAT 24/24** (векторы v4 из
`docs/E2EE-TEST-VECTORS.json`, секции A–G/E2 не менялись).

Новые тесты (88):

| Файл                          | Тестов | Покрытие                                                                                                                                                                 |
| ----------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storageTransactions.test.ts` |     11 | multi-store commit, abort без частичных записей, read-your-writes, сериализация RMW, IndexedDB и memory                                                                  |
| `kStorage.test.ts`            |     10 | non-extractable AES-256-GCM, переиспользование ключа, random nonce, AAD-привязка (device/session/client/type), corruption, гонка первого запуска, потеря ключа           |
| `sessionStore.test.ts`        |     16 | round-trip, `DHs_priv` usable/non-extractable, устройство-scope, revision/CAS, stale tab, индексы, corruption/tamper, удаление старых `DHs`, skipped limits/TTL, idle GC |
| `prekeyStore.test.ts`         |     12 | OPK consume-once и concurrent consume, сохранение OPK при abort, expired/prune, SPK 3/90/30, current pointer, destroy-all, IndexedDB                                     |
| `outbox.test.ts`              |     16 | атомарный commit, crash/replay-матрица, idempotent markSent, failed/retry/superseded, «недоступно», tamper, outbox worker без дублей, incoming+OPK                       |
| `locks.test.ts`               |     14 | точные имена локов, Web Locks сериализация/timeout, local fallback, BroadcastChannel-элекция/lease/истечение/таймаут                                                     |
| `multiTab.test.ts`            |      9 | два IndexedDB-адаптера: нет потерянных обновлений, stale tab, одна сессия/один OPK/одна отправка, ключи переживают reload                                                |

Ключевые негативные проверки: extractable private key отклоняется; подмена
ciphertext/счётчиков сессии и outbox → `KEY_STORAGE_UNAVAILABLE`; повторный
consume OPK → `KEY_HANDSHAKE_INVALID`; повторный commit → `OUTBOX_CONFLICT`;
stale writer → `SESSION_STATE_STALE`; текст ошибки отправки не попадает в
storage dump; plaintext/root/chain bytes не встречаются в dump.

KAT и прежние F1-тесты не менялись: `npx vitest run src/e2ee/vectors.test.ts`
— 24/24; полный e2ee — 182/182.

## Risks

- **[OPEN] Байтовая раскладка AAD `K_storage`.** Спека §2.3 перечисляет поля
  `device_id || session_id || client_message_id || record_type || version`, но
  не фиксирует кодирование `record_type`/`version` и отсутствующих id. Выбрана
  фиксированная 50-байтовая раскладка (UUID bytes, `u8` type/version,
  `0×16` для отсутствующего id). Нужно подтверждение crypto review до G4;
  смена раскладки — версия формата записей, не wire-протокола.
- **[OPEN] Локальная копия при fan-out.** Спека говорит «plaintext/ciphertext»
  в единственном числе, но у сообщения до 10 конвертов. F2 хранит
  `ciphertexts[]` — по одному на конверт (плюс plaintext один раз). Если
  продукту нужен только «свой» ciphertext, это уточнение F5/UI, не wire.
- **[OPEN] SPK «без сессий» TTL.** §3.4.5.1 говорит «запись без сессий — по
  TTL 30 дней», но §3.4.5 не хранит `spk_id` в состоянии сессии. F2 принимает
  `activeSessionSpkIds` снаружи; F4/F3 обязаны передавать его при ротации.
  Без этого применяются только правила `current + 2` и 90 дней.
- **BroadcastChannel fallback не является security boundary.** При потере
  сообщений/разделении event loop два таба теоретически могут войти в
  критическую секцию; revision-CAS и idempotency key остаются второй линией
  (проигравший writer получает `SESSION_STATE_STALE`, повторная отправка
  идемпотентна). Primary-путь — Web Locks; fallback нужен для сред без него.
- **`K_storage` не at-rest.** Это прямое требование P1-11: stolen profile/JS
  в origin может использовать ключ без пароля. UI/DPA не должны обещать
  «шифрование на диске».
- **Тело `transact` ограничено storage-операциями.** WebCrypto внутри
  IndexedDB-транзакции может привести к auto-commit; API это ловит
  (`KEY_STORAGE_UNAVAILABLE`), но F4/F5 должны соблюдать контракт
  «prepare → encrypt → transact».
- **`fake-indexeddb`/jsdom, не реальный браузер.** Структурное клонирование
  `CryptoKey` и поведение транзакций проверены в Node 24 + fake-indexeddb;
  реальная матрица движков и kill-вкладки — E7-F7 (G2).
- **Нет внешнего crypto-review (G4).** KAT и негативные тесты ловят регрессии,
  но не ошибки дизайна; до G4 E2EE нельзя включать.
- **SPK retention при частой ротации.** Нормативно enforced `current + 2`;
  если ротация происходит чаще 30 дней, предыдущий SPK может быть уничтожен
  раньше 30-дневного минимума. Это следствие правила «3 total», а не
  самостоятельное решение; при необходимости — уточнение спеки.
- **Размер запечатанного outbox.** Худший fan-out (~405 KB JSON) даёт
  ~540 KB b64u после шифрования; IndexedDB это выдерживает, но лимиты
  квоты/производительности должны войти в F7.
- **`markOutboxSent` не валидирует ответ сервера по контракту** (coverage,
  warning): это F5. F2 проверяет только `server_message_id`/`seq` и
  идемпотентность.
- **`drainOutbox` держит `krug-outbox` на время `send`.** Это соответствует
  §3.4.6 (один outbox-writer), но F5 должен держать сетевой вызов коротким и
  не блокировать очередь бесконечным retry; иначе второй таб ждёт весь lease.
- **`SESSION_IDLE_TTL` — GC, не FS-граница** (как и в §3.4.5.1); не обещать
  пользователю большего.

## Что дальше

1. **E7-F3:** регистрация устройства/`identity_binding_signature`, prekey
   upload/replenish поверх `prekeyStore`, `activeSessionSpkIds` для ротации.
2. **E7-F4:** X3DH/DR handshake/send/receive; использовать
   `prepareSessionRecord` + `saveSession` под `withSessionLock`, OPK consume в
   одной транзакции с первым успешным AEAD, `commitIncomingMessage`.
3. **E7-F5:** send worker поверх `prepareOutgoingMessage` →
   `commitOutgoingMessage` → `drainOutbox`; `client_message_id` reconcile,
   R-15 reset, coverage UI.
4. **E7-F7:** реальные браузеры, kill-вкладки, vectors в CI, E2E двух устройств;
   закрыть `[OPEN]` AAD-раскладку на crypto review до G4.

# E7-F2F — закрытие P1-01/02/06/07 CR1 (outbox, local copy, locks, AAD KAT)

> Зона: только `frontend/**`. `docs/**`, `backend/**`, `contracts/**`, `design/**`,
> `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts` не изменялись.
> Feature flag E2EE не включался; UI, сетевые вызовы и E2E не добавлялись.
> Outbox semantics (persist-before-send, exact bytes, idempotency) не менялись —
> только safety-инварианты поверх них.

## Статус

**DONE.** CR1-условия **P1-01, P1-02, P1-06, P1-07 закрыты** в F2-слое.
P1-03/04/05 (F3) регрессий не имеют: полный прогон и целевые F3-файлы зелёные.
`[BLOCKED]` нет: спека не противоречит решениям, все спорные места закрыты
fail-closed без изменения wire-формата. Внешние `[OPEN]`-вопросы к G4 остаются
только там, где они были и раньше (K_storage не at-rest; fallback не security
boundary; нет внешнего crypto-review).

## P1 closure

| ID        | Статус | Что изменилось                                                                                                                                                                                                                                                                                                                                                                                                            | Доказательство                                                                                                                                                                                                                             |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1-01** | CLOSED | `commitOutgoingMessage` больше не существует без session state. `prepareOutgoingMessage` требует `sessionState` (тип + runtime guard) и сверяет `session_id`/`chat_id`; commit дополнительно сверяет `session_id`, `chat_id`, `local_message_id` и owner device между state, outbox и local copy. Нарушение — `SESSION_STATE_MISSING`/`SESSION_STATE_STALE` **до** любой записи, nonce-сдвиг не сохраняется.              | `outbox.test.ts` → `P1-01 sessionful commit`: `sessionless_commit_accepted=false` (prepare), `sessionless_commit_accepted=false` (forged commit), cross-wire state, «ровно одна revision на outbox-строку + replay fail-closed» (4 теста). |
| **P1-02** | CLOSED | Ключ локальной копии — `local:<chat_id>:<direction>:<sender_device_id>:c:<client_message_id>` либо `...:l:<local_message_id>`. `chat`, `direction`, sender device и вид id обязательны; `lookupLocalCopy(chatId, clientMessageId)` ищет **только** `outgoing` + свой device и проверяет scope. Входящая peer-controlled копия не может ни выдать себя за исходящую, ни перезаписать её.                                   | `outbox.test.ts` → `P1-02 local copy scope`: collision в одном чате, независимость в разных чатах, tamper scope/direction (3 теста).                                                                                                       |
| **P1-06** | CLOSED | `tabId` — RFC 4122 v4 из `crypto.getRandomValues`; добавлен `instanceId`, и совпадение `tabId` при разных instance даёт `LOCK_TAB_ID_COLLISION` (fail-closed, body не запускается). Каждое взятие отдаёт `LockFence` (token + epoch + expiry); `drainOutbox` проверяет fence до/после `send`; поздно сработавший renewal не «воскрешает» истёкший lease. Fallback помечен `isSecurityBoundary=false`, Web Locks — `true`. | `locks.test.ts` → `P1-06`: v4-id/uniqueness, boundary flags, duplicate tabId, expired fence, late renewal, takeover вторым табом, web-locks fence (7 тестов); `outbox.test.ts` → drain при истёкшем lease.                                 |
| **P1-07** | CLOSED | 50-байтовая раскладка AAD зафиксирована нормативно в коде (`K_STORAGE_AAD_OFFSETS`, offsets в комментарии) и в этом отчёте; nil UUID и нулевой `session_id` отвергаются, поэтому `0×16` — однозначный sentinel. Добавлен KAT с фиксированными key/nonce/AAD/plaintext/ciphertext; transplant ciphertext между local copy отвергается.                                                                                     | `kStorage.test.ts` → `AAD KAT and injectivity`: byte-layout KAT, decrypt фиксированного ciphertext, nil/zero injectivity (3 теста); `outbox.test.ts` → `P1-06 outbox fence and P1-07 transplant`.                                          |

## Сделано

### 1. P1-01 — sessionless send невозможен

`src/e2ee/outbox/outboxStore.ts`.

- `OutgoingMessageDraft.sessionState` — обязательное поле; runtime-guard ловит
  `null`/`undefined` от JS-вызывающих (`SESSION_STATE_MISSING`).
- `PreparedOutgoingMessage.session` — не-null; `commitOutgoingMessage` всё равно
  проверяет его наличие (defence-in-depth для forge/старых объектов).
- Перед транзакцией: `session.record.sessionId === outbox.sessionId`,
  `session.record.chatId === outbox.chatId`.
- В транзакции: `localCopy.chatId/sessionId/localMessageId === outbox/state`,
  `localCopy.direction === 'outgoing'`,
  `localCopy.senderDeviceId === session.record.deviceId`; иначе
  `SESSION_STATE_STALE`, транзакция откатывается.
- `commitOutgoingMessage` теперь всегда пишет `sessions` (никакой ветки «без
  state») и возвращает `SessionState` (не `null`).
- Новый клиент-локальный код `SESSION_STATE_MISSING` в `errors.ts`; на wire не
  уходит, raw не рендерится.

Инвариант: **каждый outbox-row имеет ровно один persisted session revision**, а
повторный commit уже зафиксированного MK-сдвига даёт `OUTBOX_CONFLICT` (или
`SESSION_STATE_STALE` при старом revision) и не двигает цепочку.

### 2. P1-02 — namespace локальной копии

`src/e2ee/outbox/outboxStore.ts`, `src/e2ee/outbox/types.ts`.

Нормативная грамматика ключа:

```
local:<chat_id>:<outgoing|incoming>:<sender_device_id>:c:<client_message_id>
local:<chat_id>:<outgoing|incoming>:<sender_device_id>:l:<local_message_id>
```

- `sender_device_id` для исходящей копии всегда `K_storage.ownerDeviceId`
  (переданное draft-поле игнорируется — нельзя подделать автора); для входящей
  обязателен и в `prepareIncomingMessage` сверяется с `session.peerDeviceId`.
- `c:`/`l:` разделяет peer-controlled id и локальный id: даже совпадение строки
  не даёт коллизии между разными видами записей.
- `direction` и `senderDeviceId` продублированы в plaintext-заголовке записи и
  cross-checked с sealed payload при чтении; расхождение/подмена →
  `KEY_STORAGE_UNAVAILABLE`.
- `lookupLocalCopy(storage, kStorage, chatId, clientMessageId)` собирает ключ
  только из `outgoing` + owner device. Входящая копия с тем же
  `client_message_id` физически лежит в другом namespace и не возвращается.
- `prepareIncomingMessage` и `commitIncomingMessage` требуют
  `direction='incoming'`; подложенный prepared-объект с `outgoing` отвергается
  (`KEY_STORAGE_UNAVAILABLE`), поэтому receive-путь не может писать в
  namespace исходящих.
- `readLocalMessageCopy` принимает полный `LocalCopyKeyParts`; `mark*` строят
  ключ из сохранённого outbox (`chat`, sender, client/local id).

### 3. P1-06 — identity, fencing и граница fallback

`src/e2ee/locks/locks.ts`, `src/e2ee/outbox/outboxStore.ts`.

- `createTabId()` — v4 UUID из `crypto.getRandomValues` (не `Date.now`,
  не `Math.random`); 64 итерации в тесте уникальны и соответствуют regex v4.
- Каждый provider имеет `instanceId`; в сообщениях `acquire/held/release`
  передаются `tabId + instanceId`. Если `tabId` совпал, а instance — нет,
  оба таба получают `LOCK_TAB_ID_COLLISION` и **не входят** в критическую
  секцию (fail-closed), вместо прежнего «оба игнорируют друг друга».
- `LockFence { token, epoch, securityBoundary, valid(), assertValid() }`:
  - Broadcast: `valid()` = тот же token в `selfHeld` **и** `expiresAt > now`;
    истечение → `LOCK_LEASE_EXPIRED`. Поздний renewal при `expiresAt <= now`
    освобождает лок и не продлевает его (иначе fence «воскресал» бы).
  - Web Locks: fence всегда валиден (`securityBoundary=true`), потому что это
    реальный браузерный mutex.
  - Local queue: fence валиден в пределах realm, `isSecurityBoundary=false`.
- `drainOutbox` проверяет fence перед чтением/мутацией, после `send` и перед
  `markOutboxSent`; при потере lease ничего не помечается `sent` (запись
  остаётся `pending`, повтор идёт с тем же `Idempotency-Key`).
- `E2eeLockManager.isSecurityBoundary` документирует, что BroadcastChannel/
  local fallback — best-effort координация; durable fencing остаётся
  `revision`-CAS сессий и статусы outbox.

### 4. P1-07 — нормативная AAD-раскладка и KAT

`src/e2ee/storage/kStorage.ts`, `src/e2ee/kStorage.test.ts`.

Раскладка (ровно 50 байт, без length-prefix/presence-битов):

| offset | size | field                                                               |
| ------ | ---- | ------------------------------------------------------------------- |
| 0      | 16   | owner `device_id`, RFC 4122 bytes                                   |
| 16     | 16   | `session_id` (16-byte protocol value) или `0×16`                    |
| 32     | 16   | `client_message_id` (RFC 4122) или `0×16`                           |
| 48     | 1    | `record_type` u8 (`RECORD_TYPES`: session/outbox/localCopy/pin/...) |
| 49     | 1    | `LOCAL_RECORD_VERSION` (=1)                                         |

Инъективность: `null`/отсутствие кодируется `0×16`, а present-значение никогда
не ноль — `buildKStorageAad` отвергает nil UUID и all-zero `session_id`
(`assertNonNil`, `KEY_STORAGE_UNAVAILABLE`). Поэтому `null` и
`00000000-0000-0000-0000-000000000000` не могут дать одинаковый AAD.

KAT (test-only, `frontend/src/e2ee/kStorage.test.ts`):

```
owner device : 11111111-1111-4111-8111-111111111111
session_id   : 0x22 × 16
client id    : 33333333-3333-4333-8333-333333333333
record_type  : 01 (session), version: 01
AAD (50 B)   : 11111111111141118111111111111111
               22222222222222222222222222222222
               33333333333343338333333333333333 0101
key          : 000102...1f (32 B)
nonce        : 000102030405060708090a0b (12 B)
plaintext    : "K_storage KAT v1"
ciphertext   : 0c5da56faa97a37ce861dccae5c90e5c
               c22c1e5e0c3e4e636599666700217eae   (ct||tag)
```

Тест проверяет байтовый AAD, offsets, расшифровку фиксированного ciphertext
(через `loadOrCreateKStorage` с записанным фиксированным non-extractable key) и
отказ при неверном слоте AAD. Дополнительно transplant `content` между двумя
local-copy с разными `local_message_id` отвергается: AAD может совпасть (оба
`client_message_id=null` в одной сессии), но key-реконструкция и sealed
`localMessageId` cross-check дают `KEY_STORAGE_UNAVAILABLE`.

## Изменённые файлы

Production:

- `src/e2ee/outbox/outboxStore.ts` — session-mandatory commit, cross-checks,
  новый ключ/скоуп local copy, sender device, fence в drain;
- `src/e2ee/outbox/types.ts` — `senderDeviceId`/`direction` в outbox/local copy,
  `OutgoingMessageDraft.sessionState` обязателен;
- `src/e2ee/locks/locks.ts` — v4 `tabId`, `instanceId`, collision fail-closed,
  `LockFence`, `isSecurityBoundary`, запрет позднего renewal;
- `src/e2ee/storage/kStorage.ts` — нормативная 50-байтовая раскладка, offsets,
  запрет nil sentinel;
- `src/e2ee/errors.ts` — client-local `SESSION_STATE_MISSING`,
  `LOCK_LEASE_EXPIRED`, `LOCK_TAB_ID_COLLISION`.

Tests/test-only:

- `src/e2ee/outbox.test.ts` (+9);
- `src/e2ee/locks.test.ts` (+7);
- `src/e2ee/kStorage.test.ts` (+3);
- `src/e2ee/test/fixtures.ts` — `senderDeviceId` в local-copy draft,
  `createManualScheduler` (управляемые часы для lease-тестов);
- `src/e2ee/multiTab.test.ts` — сигнатура `lookupLocalCopy(chatId, ...)`.

Документация: `frontend/README.md` — раздел E7-F2F; этот отчёт.

Не изменялись: `docs/**`, `backend/**`, `contracts/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, feature flag,
wire-формат, `docs/E2EE-TEST-VECTORS.json` (KAT не тронут).

## Tests

`npm run check` (EXIT 0, финальный прогон):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           168 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   46 files / 490 tests passed
tsc --noEmit             clean
vite build               331 modules
```

- E2EE: **22 files / 282 tests**, из них **KAT 24/24** — `docs/E2EE-TEST-VECTORS.json`
  v4 не менялся, `vectors.test.ts` 24/24.
- F3-регрессия: `src/e2ee/device` + `prekeyStore` + `sessionStore` +
  `storageTransactions` — **9 files / 120 tests** зелёные (sealed pins, `spkId`,
  account cleanup не затронуты).
- Новых тестов — **19**: 9 outbox, 7 locks, 3 kStorage.

Ключевые негативные проверки F2F: sessionless prepare/commit → отказ и пустые
outbox/local copy; cross-wired state → `SESSION_STATE_STALE`; повторный commit
MK-сдвига → `OUTBOX_CONFLICT`/`SESSION_STATE_STALE`; peer `client_message_id`
не даёт ни lookup, ни перезаписи исходящей копии; direction/sender tamper →
`KEY_STORAGE_UNAVAILABLE`; duplicate `tabId` → `LOCK_TAB_ID_COLLISION` без
входа в body; expired lease → `LOCK_LEASE_EXPIRED`, drain не помечает `sent`;
nil UUID/zero session → отказ AAD; transplant local-copy ciphertext → отказ.

## Риски / что осталось

- **Fallback не security boundary.** Это не изменилось и не может измениться:
  `isSecurityBoundary=false` для BroadcastChannel/local. Durable-защита —
  revision-CAS сессий и статусы outbox; F4/F5 обязаны вызывать
  `fence.assertValid()` внутри `withSessionLock`/`withOutboxLock` перед
  мутациями, иначе fence останется неиспользованным в новых путях.
- **`LockFence.epoch` — счётчик взятий у конкретного provider**, не глобально
  сравнимый токен. Он фиксирует потерю lease в рамках таба; межтабовый fencing
  обеспечивают CAS/idempotency. Это осознанно, чтобы не выдумывать
  storage-протокол вне спеки.
- **Локальный формат записей расширен** (`senderDeviceId`, `direction` в
  plaintext-заголовке local copy; `senderDeviceId` в outbox). Это local record
  v1, не wire. Production-записей нет (E2EE flag не включался, G4 не пройден),
  поэтому миграция не пишется; dev-профиль с F2-снимком получит
  `KEY_STORAGE_UNAVAILABLE`/`available:false`, а не «тихую» подмену.
- **KAT живёт в тесте, а не в `docs/E2EE-TEST-VECTORS.json`**, потому что
  `docs/**` вне зоны F2F. При следующем doc-срезе вектор нужно перенести в
  нормативный JSON (значения выше стабильны; менять раскладку — только с новым
  `LOCAL_RECORD_VERSION`).
- **Смена AAD-раскладки = новая версия локальных записей**, не wire. Текущая
  версия зафиксирована `LOCAL_RECORD_VERSION=1`; offsets и KAT не дадут
  изменить её молча.
- **`K_storage` по-прежнему не at-rest** (P1-11/F2): nil-sentinel и KAT
  защищают целостность/домен-сепарацию, но не кражу профиля/JS в origin.
- **Нет внешнего crypto-review (G4)** и реальных браузеров (E7-F7): тесты
  F2F выполнены в Node 24 + fake-indexeddb/jsdom; kill-вкладки и throttling
  эмулируются `createManualScheduler`, а не реальным browser timer throttling.

## Что дальше

1. **E7-F4:** при send/receive вызывать `fence.assertValid()` до сохранения
   состояния; заполнять `spkId`; при приёме передавать `senderDeviceId` из
   проверенного конверта и `prepareIncomingMessage` с `direction='incoming'`.
2. **E7-F5:** send worker — `prepareOutgoingMessage` (state обязателен) →
   `commitOutgoingMessage` → `drainOutbox`; использовать `lookupLocalCopy(chatId,
clientMessageId)` и `readLocalMessageCopy(parts)`.
3. **G4/E7-F7:** перенести F2F KAT в `docs/E2EE-TEST-VECTORS.json`, проверить
   ровно один writer на реальных браузерах, закрыть оставшиеся `[OPEN]` CR1.

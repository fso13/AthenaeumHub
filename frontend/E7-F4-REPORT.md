# E7-F4 — X3DH + Double Ratchet session, TOFU, send/receive

> Зона: только `frontend/**`. `docs/**`, `backend/**`, `contracts/**`, `design/**`,
> `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts` не изменялись.
> Feature flag E2EE не включался; UI/picker (F5/F6), сетевые вызовы, groups/files
> и браузерный E2E не добавлялись. CR1b-пункты P1-01R/P1-03/P2-02 закрыты в этом
> срезе (статус — ниже).

## Статус

**DONE в границах E7-F4** по §3.3–§3.6, §4.1, §5.1–§5.7: X3DH initiator/responder,
Double Ratchet с DH ratchet и skipped keys, TOFU/первый контакт/key change,
prekey vs normal envelope, атомарный send/receive с outbox и локальной копией,
fan-out на устройства получателя и другие свои устройства, multi-device,
session restore. **Нет `[BLOCKED]`**: спека и код не противоречат друг другу в
проверенных местах.

Явно **не входит** и отмечено как `[PARTIAL]`/F5:

- **R-15 auto-reset:** `session/reset.ts` кодирует/валидирует `SESSION_RESET`
  body (content_type=2) и rate-limit helper; F4 умеет **принять** reset и
  **отправить** его как prekey-конверт (через `type: 'SESSION_RESET'`), но
  автоматическое построение reset получателем при `DECRYPT_FAILED` и
  перешифрование окна после reset (P1-C/L3b, `MAX_RESET_BATCH`) — orchestration
  F5, т.к. требует истории отправленных и повторного send.
- **§5.7 winner-session deletion:** реализован детерминированный выбор сессии
  для send (last received → locally initiated → меньший `session_id`) и удаление
  только «нетронутых» параллельных handshake-сессий (`ns=nr=0`, нет skipped).
  Полное «удалить проигравшую сразу после первого приёма» сознательно не
  делается: при одновременном инициировании это удаляет сессию, по которой ещё
  летят сообщения, — потеря вместо dedup. Обоснование и риск — в Risks.
- **`acceptKeyChange`/UI key-change policy** — F5; F4 только fail-closed
  (`KEY_CHANGE_DETECTED`) и не перезаписывает пин.
- **`LockFence`:** F4 принимает `fence` в `commitE2eeSend`/`receiveE2eeMessage` и
  вызывает `assertValid()` перед мутацией, но сам не берёт `withSessionLock`:
  один send двигает N сессий, порядок блокировок — решение F5 (см. P2-15 в CR1).
- **Нет сети/E2E/реальных браузеров** — E7-F7/G4.

## CR1b (итог по пунктам родительского запроса)

| ID                   | Статус      | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1-01R**           | DONE        | `writeSessionRecord` требует `record.revision === mode.ifRevision` (forged/stale `PreparedSessionRecord` → `SESSION_STATE_STALE`); chat/peer/`peerIk*`/`spkId` неизменяемы после создания; `pn` не убывает, `ns`/`nr` не откатываются кроме DH-ratchet (`pn >= старый ns`, изменился `dhRemote`/`dhPublicKey`); `prepareOutgoingMessage` проверяет envelope ↔ primary session (`session_id`, `recipient`, `chat`, `sender`, `header.dh`, `header.pn`, **`header.n = ns - 1`**). Тесты: `stale_prepared_commit_accepted=false`, `second_unadvanced_commit_accepted=false`, forged prepared record, header/dh/pn mismatch, counter rewind, scope change. |
| **P1-03**            | DONE        | `rotateSignedPrekey` больше **не** удаляет «unused» SPK через 30 дней: retention ровно `current + 2` в окне 90 дней, включая claimed-but-undelivered (локально невидимый) prekey. `activeSessionSpkIds` остаётся в API как advisory/telemetry и не сокращает retention. Тесты 31/60/89 дней retained, 91 день destroyed, 4-я ротация destroyed; тест, закреплявший баг (`prekeyStore.test.ts`), переписан.                                                                                                                                                                                                                                             |
| **P2-02**            | DONE        | `normalizeEnvelopes` отвергает duplicate `recipient_device_id`, duplicate `session_id`, чужой `chat_id`, чужой `sender_device_id` и envelope с session, которой нет в draft (primary+additional). Плюс `header.dh/pn/n`-сверка с сессией. Тесты в `outbox.test.ts` (`CR1b P1-01R/P2-02`).                                                                                                                                                                                                                                                                                                                                                              |
| P1-04/P1-07/P2-17/18 | NOT TOUCHED | Account cleanup, `K_storage` AAD/KAT, outbox lifecycle не менялись; публичный API outbox расширен только аддитивно (`additionalSessionStates`, `additionalSessionIds` параметр), чтобы F5 не переделывал вызовы. Закроет F2G.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Сделано

### 1. Double Ratchet (`session/ratchet.ts`)

- `KDF_RK`/`KDF_CK` через F1-примитивы; `ratchetSend` требует `CKs`, выдаёт
  header `(DHs, pn, n)`, шифрует с AD, возвращает сдвинутое состояние.
- `ratchetReceive`: при смене `header.dh` — `skip_message_keys(header.pn)` по
  предыдущей цепочке, `pn = ns; ns = 0; nr = 0`, `KDF_RK(RK, DH(DHs_priv, DHr))`,
  **свежая `DHs`**, вторая `KDF_RK` для sending-цепочки; старая приватная половина
  больше не хранится (в state только текущая пара).
- Out-of-order: `MKSKIPPED[(dh,n)]`, ключ забирается и удаляется; повтор/старое —
  `DUPLICATE_OR_OLD_MESSAGE`; гэп `> MAX_SKIP` — `SESSION_TOO_FAR_BEHIND`;
  retention (`MAX_SKIPPED_TOTAL/PER_CHAIN/AGE`) применяется через
  `pruneSkippedKeys`; `ns = 2^31-1` — `CHAIN_EXHAUSTED`.
- Сообщение из уже заменённой цепочки не вызывает ложный DH-ratchet: сначала
  ищется skipped key по `(header.dh, header.n)`; иначе — отказ. Дешифровка только
  на копии, ошибка не сохраняется.

### 2. X3DH (`session/handshake.ts`)

- Initiator: повторная проверка binding-подписи и SPK-подписи (даже если F3 уже
  проверял), `EK` и отдельная свежая `DHs_A` (P1-9, `assertFreshRatchetKey`),
  `IKM/SK/SID`, preamble (313+L+M), подпись `D_PRESIG||preamble`, первый root step.
- Responder: preamble signature; `verifyPrekeySenderIdentity` (P0-2b prekey ↔
  bundle ↔ TOFU pin); binding + fingerprint; собственные `IK_dh`/`IK_sig`;
  `spk_id`/`spk_pub`, `opk_id`/`opk_pub` против сохранённых prekeys; `chat_id`,
  оба device id, `key_generation`; `SK/SID` с проверкой `session_id`; состояние
  B (`RK=SK`, `DHs=SPK`, `DHr=null`).
- OPK не расходуется в handshake: только после успешного AEAD, в одной транзакции
  с state+copy (`commitIncomingMessage`).

### 3. Send (`session/send.ts`)

- `prepareE2eeSend`: payload (TEXT_JSON или SESSION_RESET) → для каждого
  устройства свой конверт; новая сессия — через verified claim bundle и
  `createInitiatorSession`, существующая — после сверки `peerIk*`/TOFU pin и
  `assertDeviceNotBlocked`; pin для нового контакта пишется `checkBundlePin`
  после проверок.
- Fan-out: получатель + **другие** свои устройства, self-envelope запрещён;
  `coverage` считает peer/self candidates и covered, uncovered ids; нет ни одного
  peer-конверта → `PEER_UNCOVERED` до записи; warnings
  `PEER_DEVICE_UNCOVERED`/`SELF_DEVICE_UNCOVERED`; `otp_exhausted` пробрасывается.
- `commitE2eeSend`: одна транзакция — **все** сдвинутые сессии fan-out + точные
  bytes конвертов + `Idempotency-Key` + `client_message_id` + локальная копия.
  Ошибка любой сессии откатывает всё (тест со stale additional session).

### 4. Receive (`session/receive.ts`)

- `openIncomingE2eeMessage` (без записи): chat/recipient/`recipient_key_generation`
  /sender device; `assertVerifiedIdentity`; `assertDeviceNotBlocked`; prekey →
  preamble signature + P0-2b + binding; normal → существующая сессия; неизвестная
  сессия без prekey → `NO_SESSION`; SPK удалён → `SPK_DELETED`; OPK
  неизвестен/просрочен → `KEY_HANDSHAKE_INVALID`; pin mismatch →
  `KEY_CHANGE_DETECTED` (state/OPK/пин не меняются).
- Первый контакт: pin пишется после всех §3.3.1 проверок и до создания
  сессии/показа (spec-совместимо; AEAD ещё впереди — см. Risks).
- `receiveE2eeMessage`: открытие → `prepareIncomingMessage`/`commitIncomingMessage`
  (state + OPK + sealed copy) → удаление нетронутых параллельных handshake-сессий.
  `content_type=2` не показывается: `text=null`, `reset` body возвращается
  вызывающему, локальная копия помечена как control.

### 5. Изменения F2/F3 API (аддитивные)

- `OutgoingMessageDraft.additionalSessionStates` / `PreparedOutgoingMessage.additionalSessions`
  — атомарный fan-out commit (P1-01 сохранён: `sessionState` по-прежнему обязателен).
- `VerifiedClaimedBundle.oneTimePrekey` — проверенные OPK bytes для DH4/prekey
  block (F3 API `oneTimePrekeyId` сохранён).
- `SessionState.spkId/initiatedBy/lastReceivedAt` (sealed + plaintext cross-check,
  как `spkId` в F3).
- `checkVerifiedIdentityPin` — F4 receive пишет TOFU pin из уже проверенной
  identity; pin creation остаётся у F3-модуля.
- `verifyPrekeySenderIdentity` принимает структурный
  `PrekeySenderIdentitySource` (bundle или chat-keys info).
- `utf8()` копирует bytes в текущий realm: в vitest/jsdom `TextEncoder#encode`
  возвращал `Uint8Array` другого realm, из-за чего `instanceof Uint8Array` guard
  `buildInnerPayload` ложно срабатывал. Wire/байты не меняются.

### 6. Клиентские коды ошибок

Добавлены `UNKNOWN_SPK`, `CHAIN_EXHAUSTED`, `PEER_UNCOVERED` (client-local,
на wire не уходят, raw не рендерятся).

## Файлы

Новые production-модули:

- `src/e2ee/session/ratchet.ts` — Double Ratchet;
- `src/e2ee/session/handshake.ts` — X3DH initiator/responder;
- `src/e2ee/session/send.ts` — fan-out prepare/commit;
- `src/e2ee/session/receive.ts` — open/commit receive;
- `src/e2ee/session/reset.ts` — SESSION_RESET body v1;
- `src/e2ee/session/trust.ts` — binding/pin/session peer-keys проверки.

Новые тесты / test-only:

- `src/e2ee/sessionKAT.test.ts` (9) — KAT через production-движок;
- `src/e2ee/sessionSendReceive.test.ts` (20) — интеграция;
- `src/e2ee/test/sessionFixtures.ts` — registered device worlds, claim bundles.

Изменены:

- `src/e2ee/protocol/x3dh.ts` — responder-деривация;
- `src/e2ee/session/types.ts`, `sessionStore.ts` — новые поля, P1-01R инварианты;
- `src/e2ee/session/prekeyStore.ts` — P1-03 retention;
- `src/e2ee/outbox/outboxStore.ts` — additional sessions, envelope scope,
  chain-step, P1-01R;
- `src/e2ee/device/types.ts`, `binding.ts`, `pins.ts` — verified OPK bytes,
  `checkVerifiedIdentityPin`, структурный source;
- `src/e2ee/errors.ts` — новые коды;
- `src/e2ee/encoding/bytes.ts` — realm-safe `utf8`;
- `src/e2ee/test/fixtures.ts`, `outbox.test.ts`, `sessionStore.test.ts`,
  `prekeyStore.test.ts` — scoped envelopes/CR1b-тесты;
- `frontend/README.md` — раздел E7-F4.

Не изменялись: `docs/**`, `backend/**`, `contracts/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, feature flag,
wire-формат, `docs/E2EE-TEST-VECTORS.json` (KAT v4 не тронут).

## Tests

`npm run check` (EXIT 0, финальный прогон после всех правок):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           177 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   48 files / 527 tests passed
tsc --noEmit             clean
vite build               331 modules, built
```

- E2EE: **24 files / 319 tests** (было 22/282 в F2F), **KAT 24/24**
  (`vectors.test.ts`, векторы v4 не менялись) + **9 engine-KAT** в
  `sessionKAT.test.ts`.
- Новых тестов — **37**: 9 KAT + 20 send/receive + 7 CR1b + 1 SPK
  retention (31/60/89 дней).

| Файл                         | Тестов | Покрытие                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionKAT.test.ts`         |      9 | B1 4-DH (SK/SID/root/`DHs`), B2 3-DH (`otp_exhausted`), P1-9 `DHs`≠`EK`/`IK`/`SPK`, E1 m1/r1/m2/r2 (MK/header/AD/ciphertext), C2/C3, E2 доставка 0,2,1 + skipped key + replay + gap>1000, F1 (все поля кроме недоступной подписи), F2 byte-exact.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sessionSendReceive.test.ts` |     20 | двухсторонний диалог, prekey→normal, `reply_to`, OPK consume-once, OPK при неудачном AEAD не сгорает, stale OPK → отказ, SPK deleted → `SPK_DELETED`, TOFU first contact + подмена identity (receive и send), out-of-order/replay/gap, AD tamper, restore после reload + отсутствие старого `DHs` в storage, multi-device fan-out B1+B2+A2 с coverage/без self, атомарный rollback fan-out, self-envelope/`PEER_UNCOVERED`, §5.7 выбор сессии + одновременное инициирование, preamble/identity/generation/recipient tamper, `NO_SESSION`, гонка одинакового prekey-конверта (OPK ровно один раз), SESSION_RESET frame/decrypt, отсутствие plaintext/keys в ошибках. |
| `outbox.test.ts` (+4)        |     29 | CR1b P1-01R (`stale_prepared_commit_accepted=false`, `second_unadvanced_commit_accepted=false`, forged prepared, counter/scope), P2-02 (duplicate recipient/session, mixed chat/sender, foreign session, `header.n`/`dh` mismatch).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sessionStore.test.ts` (+3)  |     19 | forged record revision, rewind `ns`/`nr`, scope/`peerIk*` change, разрешённый DH-ratchet reset (`pn` сворачивает старый `ns`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `prekeyStore.test.ts` (+1)   |     13 | SPK 31/60/89 дней retained, 4-я ротация destroyed; тест 30-дневного удаления переписан на 90-дневное окно.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Ключевые негативные проверки F4: preamble signature/identity mismatch; P0-2b
prekey↔bundle↔pin; TOFU key change без перезаписи пина и без расхода OPK;
повтор/gap; AD/header tamper; SPK/OPK deleted/expired/reused; `recipient`
device/generation tamper; self-envelope; stale/forged session revision; envelope
scope; отсутствие plaintext в IndexedDB и в текстах ошибок.

## Risks / `[OPEN]`

- **§5.7 удаление проигравшей сессии — консервативно.** Полное удаление после
  первого успешного приёма может выбросить in-flight сообщения другой стороны
  при одновременном инициировании (обе стороны удаляют «свою» проигравшую и
  расходятся). F4 выбирает сессию по спеке, но удаляет только нетронутые
  (`ns=0`, `nr=0`, нет skipped). Нужно решение крипто-ревью: либо детерминированный
  winner по `session_id` с обеих сторон + окно доставки, либо L3b-подобный dedup.
- **Pin пишется до AEAD первого prekey-сообщения.** Это соответствует §3.3.1
  («после проверок 1–6, до отображения/создания сессии»), но при битом ciphertext
  остаётся валидный пин проверенной identity. Сессия/OPK/сообщение при этом не
  создаются. Если ревью потребует «пин только после AEAD» — это атомарный
  pin+state+copy commit, отдельный срез.
- **R-15 не автоматизирован.** Receiver не строит и не отправляет reset сам
  (нет сети в `src/e2ee/**`), а sender-side окно перешифрования (P1-C/L3b,
  `MAX_RESET_BATCH=20`, `superseded`, dedup по `retry_of_client_message_id`) — F5.
  Сейчас есть body codec, rate-limit helper, приём reset и отправка
  `type='SESSION_RESET'` через общий prekey-путь; тест покрывает frame/decrypt,
  не покрывает retry-window.
- **`LockFence` используется, но не берётся.** F4 принимает fence и проверяет его
  перед commit/receive; acquisition и порядок блокировок (несколько сессий на
  один send) — F5. Durable-защита остаётся revision-CAS + idempotency.
- **Локальный формат сессии расширен** (`initiatedBy`, `lastReceivedAt`) — это
  local record v1, не wire; старые записи читаются как `null`. Production-записей
  нет (флаг не включался). Смена scope-инвариантов — только с новой версией
  локальных записей.
- **`oneTimePrekey` добавлен в `VerifiedClaimedBundle`.** F3-код и тесты
  обновлены аддитивно; если внешний потребитель конструировал bundle вручную без
  OPK bytes, компилятор это поймает.
- **`utf8()` теперь копирует bytes.** Это меняет только идентичность
  `Uint8Array` (realm), не содержимое; нужно для `instanceof`-guard в vitest/jsdom.
- **Нет внешнего crypto-review (G4) и реальных браузеров (E7-F7).** Тесты — Node
  24 + jsdom/fake-indexeddb; kill-tab/throttling и двухбраузерный E2E не
  проверялись. Флаг `e2ee.enabled` остаётся `false`.
- **`crypto.getRandomValues`/non-extractable keys** — без изменений; zeroization
  по-прежнему best-effort (§9.3), не обещание стойкости к дампу памяти.
- **Coverage numbers.** Клиентский pre-check считает только устройства, для
  которых есть verified identity; отсутствующие в плане peer/self ids попадают в
  `uncoveredDeviceIds`. Если F5 не передаст `expected*DeviceIds`, счётчики
  строятся по плану — это ослабляет «честность» coverage, но не security.

## Что дальше

1. **E7-F5:** send worker (`prepareE2eeSend` → `commitE2eeSend` → `drainOutbox`),
   `fence.assertValid()` внутри `withSessionLock`/`withOutboxLock`, R-15 auto-reset
   и retry-window, `acceptKeyChange`/key-change UI, coverage UI, передача
   `expected*DeviceIds` из `GET /chats/{id}/keys`.
2. **E7-F2G:** P1-04/P1-07/P2-17/18, outbox lifecycle, перенос F2F KAT в
   `docs/E2EE-TEST-VECTORS.json` (вне зоны F4).
3. **G4/E7-F7:** внешний crypto-review, реальные браузеры, kill-tab, vectors в CI,
   двухбраузерный E2E; только после этого — включение флага.

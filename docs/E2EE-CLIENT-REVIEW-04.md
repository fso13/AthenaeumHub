# E7-CR1d — независимый client crypto review после E7-F5 / E7-F5F

> **Рецензент:** независимый crypto/security-ревьюер; в подготовке E7-F1/F2/F3/F2F/
> F4/F2G/F5/F5F не участвовал. **Дата:** 2026-11-17.
> **Вход:** `docs/E2EE-CLIENT-REVIEW-03.md` (CR1c), `frontend/E7-F5-REPORT.md`,
> `frontend/E7-F5F-REPORT.md`, `frontend/src/e2ee/**`, `src/store/chatStore.ts`,
> UI-компоненты, `docs/E2EE-SPEC.md` §1.3/§3.4.5.1/§3.5.1/§5.5/§5.7,
> `docs/E2EE-TEST-VECTORS.json`.
> **Зона:** этим ревью создан только этот файл; код, контракты, спека, векторы и
> `docs/TASKS*` не изменялись. Все probe — вне workspace (`/tmp`), в репозиторий
> не добавлялись.

> **Граница снимка.** Основной вход — **F5** (12:58, 55 файлов / **570 тестов**).
> Во время ревью (13:03–13:16) параллельно шёл **E7-F5F**, закрывавший пункты
> CR1c/CR1d: per-account wipe, `ResetDeduplicator`, envelope-фильтр R-15,
> `e2eeChat` plaintext guard, удаление dead-code §5.7, test-only
> `saveSession`/`createSession`, SPK 90d spec, v1.1-формулировки R-15/§5.7.
> Дерево **заморожено** (F5F report 13:16), мой полный прогон 13:18:
> **EXIT 0, 55 файлов / 582 теста**, `security:check` 195 файлов, build 390
> модулей. F5F проверен по ключевым дельтам (код + probe + targeted tests +
> полный прогон), но не является отдельным построчным внешним review; ниже
> явно помечено, что относится к F5, а что закрыто F5F.

## Вердикт

**GO WITH CONDITIONS — на продолжение F6 в коде при выключенном
`VITE_E2EE_ENABLED`.**

**NO-GO для включения E2EE, E7-F7 (реальные браузеры) и внешнего G4** до
закрытия:

1. **P1-01R-R: production-путь закрыт, store-level инвариант — нет.** F5
   разрешал `ns→0`/`ns+1` с произвольным `chainSend`; probe дал
   `NONCE_REUSE=true`. F5F убрал `saveSession`/`createSession` из production
   (test-only) — активного production-писателя больше нет. Но
   `prepareSessionRecord`/`writeSessionRecord` остаются экспортированы, и probe
   с test-only writer **всё ещё** принимает `{ns:0, new DHs, старый CK0}` и
   повторяет MK/nonce. Их тест «old sending chain» использует **текущий** CK
   (commitment совпадает), а не реально старый CK0, поэтому он не ловит этот
   случай. Это **P2-инвариант**, а не P1 production-уязвимость, но для
   flag/G4 нужен CI-guard или forward-KDF-проверка.
2. **R-15 v1: sender-окно теперь корректно, но L3b-дедуп получателя в v1
   отсутствует.** F5F исправил secondary-сессию, null anchor и fallback
   `(failed_chain_dh, failed_n)`; тесты 6/6. Маркер
   `retry_of_client_message_id` в inner `TEXT_JSON` — **v1.1**, спека это
   честно фиксирует. Значит, в v1 нельзя обещать «0 дублей при переотправке»;
   F5F in-memory `ResetDeduplicator` защищает только повтор самого reset и не
   переживает reload/другое устройство. Для flag/G4 нужно либо v1.1, либо
   продуктовое ограничение.
3. **§5.7 winner deletion не реализовано, а отложено.** F5F удалил
   недостижимый `cleanupUntouchedSessions` и зафиксировал в §5.7: v1 хранит обе
   живые сессии, полный winner-deletion — F6/CR1d. Это корректная
   document-честность, но не реализация; до flag/G4 нужно решение A (winner +
   delivery window) или B (навсегда «не удалять» + TTL/GC).
4. **P1-04: per-account wipe сделан, multi-account остаётся ограничением.**
   Scope loaders (`userId` обязателен), owner-scoped `K_storage`, logout A не
   удаляет B — проверено тестами 7/7. Но identity/`K_storage`/prekeys/pins —
   single-slot на origin; реальные два аккаунта требуют per-user DB; account
   switch без logout по-прежнему упирается в `DEVICE_IDENTITY_MISMATCH` без
   flow «wipe + re-register»; `pinStore` без user-скоупа.
5. **SPK 90d — закрыто.** Спека §1.3/§3.4.5.1 приведена к коду (`90d retained`,
   current+2, 30d — только rotation interval), тесты 31/60/89/90/91.
   Остаток P2-26: retention счётный, 4-я частая ротация может уничтожить SPK
   моложе 90 дней.
6. **UI plaintext spoof — закрыто в F5F.** `e2eeChat` guard в
   `MessageList`/`MessageRow`/`ChatScreen`; probe `e2eeChat=true` не рендерит
   серверный `message.text`; тесты flag-off/init-error. Остаток — тесты
   reply-quote/sticker/attachment и `isE2eeChat` при серверном downgrade.

**Что подтверждено независимо:**

- **F5F API:** `sessionStore` не экспортирует `saveSession`/`createSession`; они
  только в `test/sessionTestWrites.ts`; production-записи идут через ratchet-
  commit.
- **R-15:** A→B1+B2 reset по envelope-сессии — `pending` для обеих; null
  `client_message_id` даёт reset; fallback `(dh,n)` реализован; duplicate reset
  дедуплицируется.
- **UI:** non-null серверный `text` не рендерится при flag-off/init-error;
  reply/attachment/sticker скрыты в `e2eeChat`.
- **P1-04:** logout A сохраняет B identity/K_storage/prekeys/pins и B-сессии/
  outbox/local copies; production hook с IndexedDB проверен.
- **SPK:** 90/91-граница, 4-я ротация; spec/code согласованы.
- **§5.7:** dead-code удалён, deferral записан в спеке; тест «две сессии»
  зелёный.
- **P2-25/P2-28:** `superseded` терминален; self-keys проверяются
  `validateChatKeysResponse` + `localIdentity`.
- **Полный прогон:** 13:18 **EXIT 0, 55/582**, security 195, contract 33/58,
  stickers ok, tsc clean, vite 390; KAT 27/27.

## P0

**Открытых P0 в замороженном F5F-дереве нет.**

- `VITE_E2EE_ENABLED` default `false`; backend `krug.e2ee.enabled=false`;
  bridge создаётся только при флаге; production E2EE-сети нет.
- Единственный production-путь, трогающий E2EE, — logout-hook; он только
  удаляет.
- Приватные ключи и `K_storage` — non-extractable; в `src/e2ee/**` нет
  `console`/`Math.random`/сети/`localStorage` (`security:check`, 195 файлов).
- Независимые KAT/probe не нашли расхождения байтов.

**Латентный P0-класс, если F6 нарушит архитектуру:**

- **P1-01R-R store-level.** `writeSessionRecord` принимает состояние
  `{ns:0, новый DHs, старый CK0}` (и `{ns+1, старый CK0}`); MK/nonce
  повторяются. Сейчас это достижимо только через test-only writer/прямой вызов
  низкоуровневых функций; production-путь закрыт. Любой F6-писатель, который
  вызовет `prepareSessionRecord`+`writeSessionRecord` вне ratchet-шага, снова
  сделает это P0. Условие GO для F6 — CI-guard/forward-KDF.
- **UI plaintext spoof** закрыт F5F; при откате `e2eeChat`-guard станет P0.

## P1 closure

| ID              | Требование CR1c                                          | Статус CR1d                            | Доказательство / остаток                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1-01R-R**    | Откат `ns→0` только при реальном ratchet; нет повтора MK | **CLOSED production / P2 store-level** | F5: probe `NONCE_REUSE=true`. F5F 13:12 убрал `saveSession`/`createSession` из production; все production-записи — ratchet-derived. Store-level probe с test-only writer всё ещё `NONCE_REUSE=true`; тест «old chain» использует текущий CK, а не CK0. Нужен CI-guard/forward-KDF (P2/G4). |
| **P1-04**       | Per-account wipe/scoping; нет multi-account data loss    | **PARTIAL**                            | Scope loaders — DONE; per-account wipe `account/scope.ts` — DONE, logout A сохраняет B (7/7); mock/real await. Остаются: single-slot identity/K_storage/prekeys/pins → реальные два аккаунта требуют per-user DB; account switch без logout; `pinStore` userId.                            |
| **P1-03**       | SPK TTL 30d vs retention 90d                             | **CLOSED**                             | Код: `current+2` в окне 90 дней, «unused»-удаления нет; спека §1.3/§3.4.5.1 исправлена (90d retained, 30d — rotation); тесты 31/60/89/90/91. P2-26 — count-based.                                                                                                                          |
| **P1-07**       | 50-байтовый AAD + KAT + инъективность                    | **CLOSED**                             | O1/O2/O3 + KAT 3/3; `kStorageKAT.test.ts` читает только JSON; без изменений в F5/F5F.                                                                                                                                                                                                      |
| **P2-17/P2-18** | Пины/ключи/AAD                                           | **CLOSED**                             | `acceptObservedKeyChange`, `pinAad`/`modeAad`; регрессий нет.                                                                                                                                                                                                                              |
| **R-15**        | Reset, окно от якоря, дедуп, rate limit, невидимость     | **PARTIAL**                            | F5: secondary/null/fallback ломались. F5F 13:12: envelope-фильтр, null-anchor, fallback `(dh,n)`, `ResetDeduplicator`; re-probe `secondary=pending`; тесты 6/6. Остатки: L3b-маркер в TEXT — v1.1; dedupe in-memory/до retry; batch failure; rate limit in-memory.                         |
| **§5.7**        | Удаление проигравшей сессии                              | **DEFERRED/DOCUMENTED (v1)**           | F5: dead code; F5F удалил его и записал в §5.7: v1 хранит обе сессии, winner deletion — F6/CR1d. Код/спека согласованы; реализации winner-a нет.                                                                                                                                           |
| **UI-P1 (new)** | Серверный plaintext не рендерится в E2EE                 | **CLOSED (F5F)**                       | F5: fallback `message.text`; probe. F5F `e2eeChat`; probe 13:09/13:15; тесты flag-off/init-error. Остаток — reply/sticker/attachment тесты.                                                                                                                                                |
| **P2-25**       | `superseded` терминален                                  | **CLOSED**                             | `markOutboxFailed`/`retryOutboxEntry` не трогают; тест.                                                                                                                                                                                                                                    |
| **P2-24**       | Общая БД + глобальный wipe                               | **PARTIAL**                            | F5F scope-wipe удаляет только attributable; реальный параллельный E2EE двух аккаунтов требует per-user DB (P2-24/F6).                                                                                                                                                                      |
| **P2-28**       | Self-verify своих ключей                                 | **CLOSED**                             | `chatBridge.loadChat` передаёт `localIdentity` в `validateChatKeysResponse`; self keys/generation сверяются.                                                                                                                                                                               |

### P1-01R-R. Production закрыт, store-level probe — нет

**F5-дефект.** `assertCountersMonotonic` разрешал `ns→0` при смене
`dhPublicKey`, не проверяя forward-смену `chainSend`; probe:

```
send#1 n=0 ns-after=1 revision=2 MK=264d01c8241392e7
forged ns=0 (same CKs, new DHs) accepted=true revision=3
send#2 n=0 same_header_dh_as_send1=false
same_MK=true same_AEAD_key=true same_nonce=true
NONCE_REUSE=true
control forged ns=0 same DH: SESSION_STATE_STALE
```

MK берётся из `chainSend`, nonce — только из MK (`deriveMessageAeadParams`),
поэтому повтор CK = повтор key+nonce; AD-различие не спасает GCM.

**F5F-закрытие.** `saveSession`/`createSession` удалены из production
`session/sessionStore.ts`; живут только в `test/sessionTestWrites.ts`;
production пишет через `commitOutgoingMessage`/`commitIncomingMessage` из
`ratchetSend`/`ratchetReceive`. `chainSendCommitment` оставлен как
tamper-detection (plaintext SHA-256 sealed chain), не как fix. Проверка
production-модуля:

```
'saveSession' in sessionStore -> false
'createSession' in sessionStore -> false
```

**Остаток (P2, не production P1).** `prepareSessionRecord`/`writeSessionRecord`
остаются экспортированы; probe с test-only writer:

```
forged ns=0 (same CKs, new DHs) accepted=true revision=3
same_AEAD_key=true same_nonce=true NONCE_REUSE=true
advanced-n chain rewind {ns:n+1, CK0} accepted=true, NONCE_REUSE=true
```

Тест F5F «rejects ns=0 with a new DH but the old sending chain» передаёт
`chainSend: created.chainSend` — это **текущий** CK (commitment совпадает →
reject), а не реально старый CK0 из предыдущего состояния (другой commitment →
accept). Так что тест не покрывает исходный forged-кейс CR1c.

**Fix/condition.** Оставить архитектуру (production только ratchet) + добавить
CI-guard/линт, запрещающий `prepareSessionRecord`/`writeSessionRecord` вне
commit-функций; либо проверять forward-KDF (`KDF_CK(existing.chainSend).next`
для `ns+1`/`chainRecv` для `nr+1`). Тест с CK0 из состояния **до** send должен
падать; property «нет повтора MK/nonce». Без этого P1-01R-R нельзя закрывать
на store-level, но production-путь F5F закрыт.

### P1-04. Per-account wipe — да; multi-account — ограничение

**Закрыто в F5/F5F:**

- `LoadDeviceIdentityOptions.userId`/`KStorageScope.userId` — required; runtime
  guard; production-вызовы передают scope.
- `loadDeviceIdentity` отвергает identity другого аккаунта до чтения приватных
  ключей; `loadOrCreateKStorage` owner-scoped; legacy bare-key fail-closed.
- `account/scope.ts`: logout удаляет только attributable `(userId, deviceId)` —
  sessions/peer index, outbox, localMessages; `keys`/`prekeys`/`pins` — только
  если identity принадлежит scope. Logout A не удаляет B; тесты 7/7 (включая
  production IndexedDB hook).
- Mock/Real провайдеры передают `userId` и await wipe; `clearAuthStorage`
  захватывает device id до удаления.

**Остатки (P1-04 PARTIAL):**

- **Single-slot на origin.** identity/`K_storage`/prekeys/pins — один набор;
  реальные два аккаунта с параллельным E2EE требуют per-user DB (P2-24/F6).
  Scope-wipe сохраняет B, но B не может инициализироваться, пока A владеет
  identity, без logout A.
- **Account switch без logout.** `initializeE2ee(B)` при identity A →
  `DEVICE_IDENTITY_MISMATCH` → `e2ee.status='error'`; flow «wipe + re-register»
  не реализован. Fail-closed, но без восстановления.
- **`pinStore` без user-скоупа.** `loadScope` берёт `identity.userId`;
  `listSealedPins` перечисляет все пины. Пока identity одна — defense-in-depth,
  не cross-read; CR1c condition не выполнен.

### R-15. v1 sender-окно — да; v1.1 receiver-дедуп — нет

**Работает (F5/F5F, проверено):**

- Receiver: `SPK_DELETED`/`UNKNOWN_SPK`/`DECRYPT_FAILED`/`NO_SESSION`/
  `KEY_HANDSHAKE_INVALID` → `SESSION_RESET` (`content_type=2`) в новом
  prekey-конверте; reset body строгий; control не виден; нет plaintext в
  запросе (`envelopes` only).
- F5F: `selectRetryWindow` фильтрует по наличию envelope с `session_id`
  failed-сессии (а не по primary `entry.sessionId`) — A→B1+B2 работает;
  re-probe: `window(primary): pending 1`, `window(secondary): pending 1`.
- Null anchor: `buildReceiverReset` отправляет reset с
  `retry_of_client_message_id=null`; `matchesFailedChain` находит окно по
  `header.dh === failed_chain_dh && header.n >= failed_n`.
- Дубль reset: `ResetDeduplicator` по четвёрке (`failed_session_id`,
  `failed_chain_dh`, `failed_n`, `anchor`); повтор → `ignored/duplicate`; после
  reload — `invalid_session`.
- Rate limit 1/300 с на failed session; batch 20; `remaining` в
  `retryPendingCount`; `anchor_unknown` fail-safe.

**Остатки:**

1. **L3b-маркер в TEXT — v1.1.** `serializeTextBody` v1 — `{text, reply_to_id}`;
   `retryOfClientMessageId` в inner payload не попадает. Спека §3.5.1/§5.5
   теперь честно пишет: v1 receiver-дедуп переотправленных TEXT **не
   обещается**, полный L3b — v1.1. Это не скрытый дефект, но продуктовое
   ограничение и условие flag/G4; в v1 нельзя обещать «0 дублей».
2. **Dedupe in-memory и до retry.** `ResetDeduplicator` помечает fingerprint
   **до** перешифрования/отправки; если batch упал, повторный reset с тем же
   телом игнорируется, failed-сессия уже удалена → сообщения не переотправятся
   без ручного вмешательства. Нужно помечать после успеха или очищать при
   неудаче; durable-счётчик — P2/G4.
3. **Batch/fresh session.** После первого retry `sendText` вызывает
   `selectSendingSession`, который может выбрать старую живую сессию, а не
   fresh-prekey; «остальные переиспользуют её» не гарантировано. Падение
   первого send оставляет `retry_pending` без ручного retry.
4. **Corrupt local copy.** `lookupLocalCopy` throw на одной corrupt-копии
   срывает весь reset, а не пропускает один кандидат.
5. **Rate limit in-memory.** После reload счётчик теряется; дубликат reset
   обычно упирается в удалённую сессию, но durable-счётчик нужен для G4.

**Visibility/plaintext.** Reset скрыт после расшифровки; F5F `e2eeChat`
скрывает серверный текст и в pending; control-фильтр всё ещё зависит от
наличия view (P2 UX).

### §5.7. Dead code убран, winner deletion отложен документированно

- F5 `cleanupUntouchedSessions` удалял только `ns=0 && nr=0`; такие сессии не
  персистятся (send `ns>=1`, receive `nr>=1`), т.е. dead code. F5F удалил его.
- Спека §5.7 теперь: v1 **сохраняет обе живые сессии**, удаление проигравшей
  без deterministic winner + окна доставки опасно; winner-deletion — F6/CR1d;
  `SESSION_IDLE_TTL` — GC, не замена. Тест «две сессии» зелёный.
- Это **DEFERRED/DOCUMENTED**, а не реализация. Для flag/G4 нужно решение:
  A (winner + delivery window + crossed-sends test) или B (навсегда «не
  удалять» + TTL/GC, без обещания §5.7-удаления).

### F5 UI. Key-change/mode/flag-off/safety number

- **Key-change:** persisted warning, explicit accept (`acceptObservedKeyChange`,
  ровно `observed`), send block до accept; mode-downgrade с evidence не
  подтверждается.
- **Mode:** `evaluateChatMode` + sealed pin; E2EE→MANAGED in-place запрещён;
  `confirmManagedMode` для genuinely managed без evidence.
- **Flag-off:** E2EE-чат блокируется (`flag_disabled`), plaintext fallback нет;
  F5F `e2eeChat` не рендерит серверный `text`/reply/sticker/attachment.
- **Safety number:** per-device 60-значный код; verified не выставляется
  автоматически; QR payload считается, но UI — F6.
- **Coverage:** warning в banner, но списка uncovered-устройств/причин нет;
  `unavailableDeviceIds` в `loadChat` всегда `[]` — F6.
- **Plaintext:** F5F guard проверен probe; `E2ee.test` flag-off/init-error.
  Остатки: reply-quote/sticker/attachment тесты; `isE2eeChat` из
  `chatSummary`/state — при серверном downgrade MANAGED + flag-off контекст
  теряется (P2-33).
- **Key-change pending decrypt:** `acceptKeyChange` → только `loadE2eeChat`, не
  `decryptE2eeSlice`; сообщения, пришедшие во время блокировки, останутся
  error/unavailable до refresh (P2-31).

## P2

| ID        | Тема                                            | Статус CR1d | Комментарий                                                                                                                                               |
| --------- | ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01     | `local_message_id` вне AAD                      | частично    | `decryptLocalCopy` сверяет payload-поля; AAD-only доверия нет.                                                                                            |
| P2-03     | Incoming commit без state; OPK delete до expiry | частично    | production receive всегда передаёт state; API приглашает к misuse.                                                                                        |
| P2-04     | `loadSession` id check                          | **CLOSED**  | F5 добавил `record.sessionId === sessionId` → `KEY_STORAGE_UNAVAILABLE`.                                                                                  |
| P2-06     | `assertPrivateKey` без algorithm/usages         | OPEN        | Ed25519 можно сохранить как session DH; упадёт позже.                                                                                                     |
| P2-07     | Outbox lifecycle                                | частично    | `serverMessageId` local copy не обновляется; attempts cap/TTL; corrupt pending рушит drain.                                                               |
| P2-09     | Тестовые пробелы                                | частично    | Нет: store-level old-CK forged test (реально CK0), reply/sticker/attachment UI, real browsers, 2-account E2E send, durable reset dedupe.                  |
| P2-10     | Нижняя граница ciphertext в векторах            | OPEN (G4)   | 16..33040 vs 272..33040; conformance может принять 16..271.                                                                                               |
| P2-11     | `ciphertexts[]` ≠ `envelopes`                   | OPEN        | `prepareOutgoingMessage` берёт `draft.ciphertexts ?? …` без сверки; production send не передаёт.                                                          |
| P2-12     | Канонический lower-case UUID                    | OPEN        | upper-case от сервера отвергается.                                                                                                                        |
| P2-13     | Zeroization                                     | частично    | Best-effort; JS-память; не логируется.                                                                                                                    |
| P2-14     | `security:check` pattern-based                  | OPEN        | Не ловит `globalThis['console']`, Worker/importScripts.                                                                                                   |
| P2-15     | `drainOutbox` держит lock на время сети         | OPEN (F6)   | Медленный send блокирует другие табы.                                                                                                                     |
| P2-20     | `ensureOneTimePrekeys` stale `available`        | OPEN        | Метрики/точность, не security.                                                                                                                            |
| P2-21     | `pinChatMode` можно обойти                      | OPEN (F6)   | Публично пишет MANAGED с `confirmedByUser:true` без evidence; политика держится на `evaluateChatMode`.                                                    |
| P2-23     | `pinStore` без user-скоупа                      | OPEN        | `loadScope` берёт `identity.userId`; `listSealedPins` — все пины. Нужен `userId`/fail-closed.                                                             |
| P2-24     | Общая БД + single-slot identity                 | PARTIAL     | F5F per-account wipe сохраняет B; реальные два аккаунта требуют per-user DB; account switch.                                                              |
| P2-26     | SPK retention счётный                           | OPEN        | `current+2`; 4-я частая ротация уничтожает SPK моложе 90 дней; спека признаёт.                                                                            |
| P2-27     | `retry_of_client_message_id` в TEXT             | v1.1        | v1 wire не менялся; receiver-дедуп переотправленных TEXT не обещается; нужен v1.1 spec+vector.                                                            |
| P2-28     | self-verify                                     | **CLOSED**  | `validateChatKeysResponse` + `localIdentity`.                                                                                                             |
| **P2-29** | R-15 dedupe/rate-limit in-memory                | OPEN (F6)   | F5F дедуп помечает до retry; после reload/другого устройства не работает; Set/Map не чищаются.                                                            |
| **P2-30** | R-15 batch/fresh session                        | OPEN (F6)   | После первого retry `selectSendingSession` может выбрать старую сессию; падение batch оставляет `retry_pending`.                                          |
| **P2-31** | Key-change accept не расшифровывает pending     | OPEN (F6)   | `acceptKeyChange` → только `loadE2eeChat`; нужен `decryptE2eeSlice`.                                                                                      |
| **P2-32** | E2EE init error блокирует все чаты              | OPEN (F6)   | `e2eeBlockReason` возвращает `not_ready` для MANAGED-чатов при `status==='error'`; fail-closed, но доступность.                                           |
| **P2-33** | Flag-off/ server downgrade                      | OPEN (G4)   | При flag-off mode-pin не читается; сервер может объявить E2EE-чат MANAGED → plaintext. Нужен запрет отката флага у E2EE-чатов или чтение пина без bridge. |
| **P2-34** | Reset anchor — plaintext metadata               | OPEN (F6)   | `retry_of_client_message_id` из серверного `Message.client_message_id`; сервер может сдвинуть окно (v1.1 marker → дубли).                                 |
| **P2-35** | Local copy errors срывают reset                 | OPEN (F6)   | `lookupLocalCopy` throw на одной corrupt-копии; нет per-entry изоляции/счётчика skipped.                                                                  |
| **P2-36** | Store-level chain invariant/test misnamed       | OPEN (G4)   | F5F-тест «old chain» использует текущий CK; реальный CK0 из прошлого состояния принимается; нужен forward-KDF/CI-guard.                                   |

## Проверки

### Полный прогон (F5F, 13:18)

```bash
cd frontend && npm run check
# EXIT 0
# lint                     ok
# format:check             ok
# contract:check           33 operations, 58 schemas (51 checked), types in sync
# stickers:check           ok
# security:check           195 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
# vitest                   55 files / 582 tests passed
# tsc --noEmit             clean
# vite build               390 modules
```

F5 (12:58) заявлял 55/570; F5F report — 55/582. Targeted:

```bash
npx vitest run src/e2ee/prekeyStore.test.ts src/e2ee/account.test.ts \
  src/e2ee/app/chatBridge.test.ts src/e2ee/app/resetRetry.test.ts \
  src/e2ee/sessionStore.test.ts src/e2ee/sessionSendReceive.test.ts
# 6 files / 78 tests passed
npx vitest run src/e2ee/vectors.test.ts src/e2ee/kStorageKAT.test.ts
# 27/27 (KAT 24/24 + O 3/3)
```

### Независимые probe (вне workspace)

`/tmp/cr1d_probe.ts` (production modules + test-only writer):

```
send#1 n=0 ns-after=1 revision=2 MK=264d01c8241392e7
forged ns=0 (same CKs, new DHs) accepted=true revision=3
send#2 n=0 same_header_dh_as_send1=false
same_MK=true same_AEAD_key=true same_nonce=true
NONCE_REUSE=true
control forged ns=0 same DH: SESSION_STATE_STALE
window(primary): status=pending candidates=1
window(secondary): status=pending candidates=1
SECONDARY_RESET_DROPPED=false
```

`/tmp/cr1d_probe2.ts`:

```
advanced-n chain rewind accepted=true revision=4
same_AEAD_key=true same_nonce=true header_n=3 NONCE_REUSE=true
```

`/tmp/cr1d_ui.tsx` (F5 MessageRow) / `/tmp/cr1d_ui2.tsx` (F5F):

```
F5:  pending view (undefined) renders server text: true
F5F: e2eeChat=false pending renders server text=true
     e2eeChat=true  pending renders server text=false
```

### Что проверено чтением кода

- `chatBridge.initialize/loadChat/prepareSend/receive/handleReset`;
  `prepareE2eeSend`/`commitE2eeSend`; `selectSendingSession`; `resetRetry`
  (envelope-фильтр, `matchesFailedChain`, `ResetDeduplicator`).
- `sessionStore` (counters, commitment, `loadSession`), `ratchet`, `reset.ts`,
  test-only writers.
- `outboxStore` (`markOutbox*`, `lookupLocalCopy`); `identity`/`kStorage`/
  `pinStore`/`modePin` scoping; `account/scope.ts`/logout.
- `chatStore` E2EE state/send/receive/reset/realtime; `MessageRow/List`,
  `E2eeBanner`, `SafetyNumberDialog`, `ChatHeader`, `ChatScreen`.
- `docs/E2EE-SPEC.md` §1.3/§3.4.5.1/§3.5.1/§5.5/§5.7; `E2EE-TEST-VECTORS.json`
  L3b/O/S1.

### Ограничения

- Нет реальных браузеров: jsdom/fake-indexeddb/memory; IndexedDB durability,
  Safari flush, Web Locks в фоне — F7.
- E1/E2 stateful Double Ratchet независимо не переписывались; KAT/engine-тесты
  авторские, но KDF/AD-совместимость подтверждена CR1c/KAT.
- F5F — post-snapshot; проверены ключевые дельты, полный прогон и targeted
  тесты, но не построчный внешний review.
- Внешний crypto-review G4 не проводился.

## Условия GO для F6/F7/флага

### F6 (код, флаг `false`; DONE — при выполнении)

1. **P1-01R-R.** Сохранить ratchet-only production-путь (F5F) и добавить
   **CI-guard** на `prepareSessionRecord`/`writeSessionRecord` вне commit-
   функций; желательно forward-KDF-проверка. Добавить тест с реальным CK0 из
   состояния **до** send (сейчас принимается) и property «нет повтора
   MK/nonce»; симметрично `nr`/`chainRecv`.
2. **R-15.** Решить v1.1 vs v1: если v1 — зафиксировать продуктовое
   ограничение (нет receiver-дедупа переотправленных TEXT) и не заявлять L3b;
   если v1.1 — spec+vector+codec. Исправить dedupe-before-retry, batch fresh
   session, per-entry local-copy изоляцию; тесты A→B1+B2, null-anchor,
   retry-failure, duplicate reset.
3. **§5.7.** Выбрать A (winner + delivery window + crossed-sends test) или B
   (spec: v1 не удаляет + TTL/GC); если B — убрать из спеки остатки обещания
   удаления и не считать §5.7 реализованным.
4. **P1-04.** Принять F5F per-account wipe (A/B, legacy rows, K_storage
   fail-closed); решить multi-account (per-user DB или запрет второго аккаунта);
   account-switch flow «wipe + re-register»; `pinStore` userId/fail-closed.
5. **SPK.** Зафиксировать 90d retained/current+2; P2-26 (count-based) — решение
   и тест 4-й ротации; не обещать «каждый SPK ≥90 дней».
6. **UI.** Регрессии: non-null `text`/reply/sticker/attachment + flag-off/
   init-error/pending; `isE2eeChat` при серверном downgrade; `plaintextAlert`.
7. **Флаг/UI.** `VITE_E2EE_ENABLED=false`, backend false; никакого plaintext
   fallback; `security:check`; raw error не рендерить; control/reset невидимы.
8. **Прогон.** Freeze; `npm run check` 582+; KAT 24+3; probes P1-01R-R/R-15/UI;
   обновить F5F report.

### F7/G4 (до включения флага)

- Внешний crypto-review: P1-01R-R store-level/CI-guard, R-15 v1.1,
  §5.7, P1-04 multi-account, UI plaintext, P2-10/P2-26/P2-27.
- Замороженный vector-set (hash), KAT 24+3 в CI; `npm run check` на финальном
  дереве.
- Реальные Chrome/Firefox/Safari: X25519/Ed25519 WebCrypto, non-extractable
  CryptoKey в IndexedDB, durability/close, write-staging/flush, Web Locks в
  фоне, kill-tab, quota.
- Двухбраузерный E2E: два устройства, prekey → DR → out-of-order → replay →
  key-change → reset → L3b (если v1.1); два аккаунта в одном профиле.
- Только после этого — включение флага и продуктовые обещания (никакого
  «шифрования на диске», §2.3/§9.3).

## Вопросы

1. **P1-01R-R:** принимаем архитектурное закрытие (production only ratchet) +
   CI-guard, или требуем forward-KDF в store? Кто владелец теста с реальным
   CK0 и property «нет повтора MK/nonce»?
2. **R-15 v1/v1.1:** когда v1.1-маркер в TEXT? Если v1 — какие продуктовые
   ограничения фиксируем (не обещать L3b/0 дублей)?
3. **§5.7:** A (winner deletion) или B (навсегда не удалять + TTL/GC)? Кто
   владелец state-machine/crossed-sends теста?
4. **P1-04:** per-user DB или запрет второго аккаунта? Нужен ли account-switch
   flow в F6 и `userId` в `pinStore`?
5. **P2-26:** оставляем счётный retention (и признаём в спеке), или вводим
   временной guard/`claimed_spk`?
6. **UI:** достаточно ли `e2eeChat` из summary/state, или нужен mode-pin и при
   flag-off? Кто владелец reply/sticker/attachment тестов?
7. **P2-29:** нужен ли durable reset-счётчик/дедуп (новый sealed record type)
   или принимаем in-memory риск и документируем?
8. **Freeze:** кто владелец заморозки спеки/векторов для G4 и какой hash
   нормативен? F5F уже трогал S1 аддитивно — это допустимо?

---

**Итог.** F5 дал wire-up/UI, но имел P1-дефекты; F5F закрыл production-путь
P1-01R-R, R-15 secondary/null/fallback, UI plaintext, per-account wipe и SPK
90d, полный прогон **582 EXIT 0**. Остаются: **store-level P1-01R-R (P2)**,
**L3b v1.1**, **§5.7 winner deletion**, **P1-04 multi-account/switch/pinStore**,
**P2-26**, **real browsers/G4**. Поэтому: **GO WITH CONDITIONS для F6 в коде
при выключенном флаге; NO-GO для включения E2EE/F7/G4.**

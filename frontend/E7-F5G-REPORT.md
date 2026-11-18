# E7-F5G — P2-36, R-15 residuals, P1-04 multi-account, P2-33 downgrade

> **Зона:** только `frontend/**` (код, тесты, `scripts/check-session-writers.mjs`,
> этот отчёт). `docs/**`, `backend/**`, `contracts/**`, `design/**`,
> `schema.d.ts`, `env.ts` не изменялись; wire v1 не менялся. Feature flag
> `VITE_E2EE_ENABLED`/backend `krug.e2ee.enabled` **не включался**, нового
> UI/флага не добавлено. Существующие E2EE-guard'ы и reply-бар только
> исправлены по P2-33.
>
> **Вход:** `docs/E2EE-CLIENT-REVIEW-04.md` (P1-01R-R/P2-36, R-15, §5.7,
> P1-04, P2-29/30/33/35), `frontend/E7-F5F-REPORT.md`, `src/e2ee/**`.
>
> **Итог:** **DONE** для P2-36, R-15-остатков, P1-04-scoping/switch и P2-33
> (клиентская часть). §5.7 winner-deletion остаётся документированным
> deferral'ом; durable-dedupe/rate-limit и v1.1 L3b — вне F5G (G4).

## 1. P2-36 — store-level chain invariant

### Что было

`writeSessionRecord` принимал `{ns:0, новый DHs, старый CK0}` и `{ns+1, старый
CK0}`: MK/nonce могли повториться. F5F убрал `saveSession`/`createSession` из
production-модуля, но `prepareSessionRecord`/`writeSessionRecord` оставались
экспортированы, а тест «old chain» использовал **текущий** CK, не реальный CK0.

### Что сделано

1. **Forward-KDF proof при подготовке** (`session/sessionStore.ts`).
   `prepareSessionRecord(kStorage, state, { previous })` для любого update
   (state.revision > 0) обязан получить точное persisted-состояние и проверяет:
   - send: `new.chainSend === KDF_CK(existing.chainSend).nextChainKey`,
     `ns = existing.ns + 1`, DH/`pn`/`chainRecv` не меняются;
   - receive в той же цепочке: `chainRecv` — это persisted-цепочка, продвинутая
     ровно на `Δnr` шагов `KDF_CK`; `ns/chainSend` не меняются;
   - DH ratchet: `rootKey/chainRecv/chainSend` пересчитываются из
     `KDF_RK(existing.rootKey, DH(existing.DHs, new.dhRemote))` и
     `KDF_RK(root1, DH(new.DHs, new.dhRemote))`, `ns=0`, `pn=existing.ns`,
     `nr>=1`, DH-пара свежая;
   - skipped-key hit: меняется только `MKSKIPPED`/`lastUsedAt`, цепи и счётчики
     не двигаются.
     Любой jump/rewind/repair без выводимой KDF-траектории → `SESSION_STATE_STALE`.
2. **Привязка к фактической записи** (`writeSessionRecord`). Подготовленная
   запись несёт `previousStateFingerprint` (revision + счётчики + commitments
   send/recv). В транзакции fingerprint пересчитывается из **прочитанной**
   записи; несовпадение → `SESSION_STATE_STALE`. Это не даёт переиспользовать
   подготовленный переход против другого/уже продвинутого состояния.
3. **Структурная вторая линия** (`assertTransitionShape`): свежие
   `chainSend`/`chainRecv` commitments на ratchet, запрет `ns+1` без новой
   send-цепи, запрет `nr`-движения без receive и т.п.
4. **CI-guard** (`scripts/check-session-writers.mjs`, в `npm run check`):
   `prepareSessionRecord`/`writeSessionRecord`/`saveSession`/`createSession`
   разрешены только в `session/sessionStore.ts` и `outbox/outboxStore.ts`
   (production), тесты и `test/sessionTestWrites.ts` исключены; отдельно
   проверяется, что production-модуль не экспортирует `saveSession`/
   `createSession`.
5. **Тестовый writer** `test/sessionTestWrites.ts` теперь тоже загружает
   persisted previous-state и идёт через тот же proof: probe с реальным CK0
   больше не проходит.

### Доказательства (тесты)

Новые в `src/e2ee/sessionStore.test.ts`:

- `rejects a forged ns=0 with the real pre-send CK0` — реальный CK0 из
  состояния **до** send, новый DHs/remote → `SESSION_STATE_STALE`; проверяется,
  что persisted `ns/chainSend` не изменились и следующий MK/nonce не повторяют
  старые;
- `rejects an advanced-n chain rewind to the real CK0` — `{ns+1, CK0}` →
  reject;
- `allows a DH-ratchet counter reset` — теперь **реальный** `ratchetReceive`,
  не синтетические байты;
- «drops the previous DH private key» / «destroys every superseded DH key» —
  переведены на настоящие ratchet-переходы.

Легитимный ratchet остаётся зелёным: `sessionSendReceive`, `sessionKAT`,
`multiTab`, `outbox` — 68/68 targeted, полный прогон ниже.

### Остаток/миграция

Записи, созданные до E7-F5G (без `chainRecvCommitment`/
`previousStateFingerprint`), не могут быть обновлены этим writer'ом: нужен
re-key/re-register. Флаг выключен, production E2EE-пользователей нет; это
осознанный fail-closed, а не тихая миграция с ослаблением инварианта.

## 2. R-15 — dedupe, batch, local copies, «не терять reset»

### Dedupe и failed batch

- `ResetDeduplicator` (`app/resetRetry.ts`): bounded (256), добавлен
  `forget(reset)`; `ResetRateLimiter.clearAll()`.
- `chatBridge.handleReset` больше не удаляет failed-сессию до retry:
  - reset помечается после успешного выбора окна;
  - pending-сессия попадает в `resettingSessions` и **исключается** из
    обычного `selectSendingSession`;
  - `anchor_unknown`/`empty`/`invalid_session` снимают пометку (reset не
    «съедается»), failed-сессия удаляется как непригодная.
- Новый `finishReset({status})`:
  - `completed` — удаляет failed-сессию, dedupe остаётся;
  - `failed` — `forget(reset)`, failed-сессия сохраняется (сломанная, но
    повторный reset сможет пере-drive'нуть окно).
- `chatStore.handleIncomingReset` всегда вызывает `finishReset` в `finally`;
  частичный/упавший batch → `failed`, `retryPendingCount` отражает остаток.
- Очистка in-memory состояния при `initialize`/`invalidateChat()`/account
  switch: dedupe, rate limit, `resettingSessions`.

### Batch/fresh session (P2-30)

- `E2eeSendTextInput.reuseSessionIds`; bridge при повторных кандидатах
  переиспользует **точные** fresh-сессии первого retry. Если сессии нет —
  создаётся fresh-prekey, а не выбирается старая живая сессия.
- `E2eePreparedSend.sessionIds` отдаёт все session id fan-out'а;
  `chatStore` передаёт их в следующие send'ы batch'а.
- `E2eeRecipientPlan.sessionId` — точная сессия; `excludeSessionIds`
  отсекает resetting/сломанные.

### Local-copy isolation (P2-35)

`selectRetryWindow` читает каждую local copy в `try/catch`; corrupt/tampered
копия не срывает reset, а увеличивает `skipped`; остальные кандидаты
возвращаются. `RetryWindowResult.skipped` и `E2eeResetOutcome.pending.skipped`.

### Тесты

- `app/resetRetry.test.ts`: `forget`/bounded, corrupt copy → `skipped=1`,
  второй кандидат остаётся;
- `app/chatBridge.test.ts`: failed batch → повторный reset снова `pending`;
  `finishReset completed` удаляет сессию и оставляет `duplicate`; exact
  reuse session для второго сообщения; неизвестный reuse-id → fresh prekey;
- `store/e2eeChat.test.ts`: успешный batch → `finishReset completed`, второй
  send получает `reuseSessionIds`; упавший batch → `finishReset failed`,
  `retryPendingCount=1`, reset не потерян.

### Остаток (G4/v1.1)

Durable dedupe/rate-limit после reload/другого устройства требует нового
sealed record type (P2-29) — не выдумывали в F5G; v1.1 L3b-маркер в TEXT
(P2-27) и anchor из server metadata (P2-34) остаются. Это документированные
ограничения, не скрытые дефекты.

## 3. P1-04 — pinStore scoping и account switch

### pinStore

- `listSealedPins(storage, scope)` теперь требует **локальный** аккаунт:
  `userId` обязателен, `deviceId` опционален; несовпадение с persisted
  identity → `KEY_STORAGE_UNAVAILABLE` (fail-closed, без cross-account read).
  Опциональные `peerUserId`/`peerDeviceId` сужают выборку.
- `listPins(storage, scope)` — scope обязателен; все вызовы/тесты обновлены.
- Sealed AAD остался прежним (KAT P1-07 не менялся).

### Account switch A↔B

- Новый `account/switch.ts` — `switchE2eeAccountIfNeeded(storage,{userId})`:
  если persisted identity принадлежит другому пользователю, выполняется
  per-account scope wipe (тот же conservative `account/scope.ts`) и
  возвращается `switched`; иначе `none`.
- `chatBridge.initialize` вызывает switch **до** регистрации, сбрасывает
  identity/K_storage/cache и in-memory reset-state. Дальше новый аккаунт
  регистрируется штатно; возврат A→B→A — тот же flow, без
  `DEVICE_IDENTITY_MISMATCH`-тупика.
- Тесты `account/switch.test.ts`: no-op для того же/отсутствующего identity;
  A→B wipe A-сессии/identity, B регистрируется; B→A снова работает.

### Остаток

Single-slot identity/`K_storage`/prekeys/pins на origin остаётся. Switch — это
«wipe + re-register»: sealed-история предыдущего аккаунта после switch
недоступна. Реальные два параллельных аккаунта требуют per-user DB (P2-24/F7),
не изобретали её здесь.

## 4. P2-33 — reply/sticker/attachment и server downgrade

- `chatStore.isE2eeChat(chatId)` — единый предикат: server `E2EE`, sealed
  mode-pin, `block_security_alert`, **или** наличие crypto-envelope в истории.
  Поэтому downgrade сервера в `MANAGED` и flag-off не превращают чат в
  plaintext-контекст.
- `loadPersistedE2eeMarker` читает sealed `mode:` pin **без bridge/флага**
  (read-only metadata; отсутствие IndexedDB/identity → «маркера нет», без
  падения). `loadE2eeChat` использует маркер для `e2eeHistoryMarker`.
- `e2eeBlockReason` при flag-off блокирует отправку (`flag_disabled`), если чат
  E2EE по server/pin/crypto; plaintext fallback отсутствует.
- `ChatScreen` использует `store.isE2eeChat`; `Composer` получил
  `e2eeChat`/`replyText` и **не рендерит** серверный reply quote в E2EE —
  только расшифрованный текст/`unavailable`. Серверные sticker/attachments/
  text по-прежнему скрыты `MessageRow`.
- Тесты `components/E2ee.test.tsx`: reply-to + sticker + attachment +
  server text spoof скрыты; чат с crypto-envelope, объявленный сервером
  `MANAGED` при flag-off, остаётся E2EE, send блокируется; reply-бар не
  показывает серверный текст.

### Остаток (G4)

Если сервер одновременно объявит чат `MANAGED`, **удалит** все crypto-envelope
и на этом устройстве нет sealed mode-pin (например, чистый профиль), у клиента
нет сигнала об истории — это внешний G4-вопрос (server downgrade policy).
Клиентская часть (pin/crypto/alert) закрыта.

## 5. §5.7 — без изменений, deferral сохранён

Winner-deletion не реализовывался: v1 хранит обе живые сессии, удаление
проигравшей без deterministic winner + окна доставки по-прежнему опасно.
`receive.ts`/спека уже фиксируют deferral (F5F); F5G его не расширял и не
выдаёт §5.7 за реализованный. Решение A/B остаётся за F6/CR1d/G4.

## 6. Файлы

Новые:

- `src/e2ee/account/switch.ts`, `src/e2ee/account/switch.test.ts`;
- `scripts/check-session-writers.mjs`;
- `E7-F5G-REPORT.md`.

Изменены (основное):

- `src/e2ee/session/{types,sessionStore,send,receive}.ts`;
- `src/e2ee/outbox/outboxStore.ts`; `src/e2ee/test/{sessionTestWrites,fixtures}.ts`;
- `src/e2ee/app/{resetRetry,chatBridge,types}.ts`;
- `src/e2ee/device/{pinStore,pins}.ts`; `src/store/chatStore.ts`;
- `src/components/{ChatScreen,Composer}.tsx`;
- тесты: `sessionStore`, `outbox`, `multiTab`, `resetRetry`, `chatBridge`,
  `store/e2eeChat`, `components/E2ee`, `device/pins`,
  `test/e2eeBridgeFake.ts`; `package.json` (`session-writers:check` в `check`).

Не изменялись: `backend/**`, `contracts/**`, `design/**`, `docs/**`,
`schema.d.ts`, `env.ts`, default флага, envelope wire format v1.

## 7. Проверки

Финальный `cd frontend && npm run check` — **EXIT 0**:

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas (51 checked), types in sync
stickers:check           ok
security:check           197 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
session-writers:check    ok (135 production files; writers restricted to session store + outbox commit)
vitest                   56 files / 596 tests passed
tsc --noEmit             clean
vite build               391 modules, built
```

KAT: `npx vitest run src/e2ee/vectors.test.ts src/e2ee/kStorageKAT.test.ts` —
**27/27**. Targeted ratchet/outbox: `sessionSendReceive + sessionKAT +
multiTab + outbox` — **68/68**.

Прирост к F5F: 55/582 → **56/596** (+1 файл, +14 тестов). В `src/e2ee/**`
по-прежнему нет `console`/`localStorage`/`fetch`/`Math.random`.

## 8. Open / deferred (не выдаётся за закрытое)

- **§5.7 winner deletion** — DEFERRED/DOCUMENTED (v1 хранит обе сессии; TTL/GC
  не замена). Решение A/B — F6/CR1d/G4.
- **P2-29 durable reset dedupe/rate-limit** — in-memory; новый sealed record
  type не вводился (G4).
- **v1.1 L3b** (`retry_of_client_message_id` в inner TEXT, receiver-дедуп
  переотправленных TEXT) — wire v1 не менялся.
- **P2-26** (count-based SPK retention), **P2-10** (нижняя граница
  ciphertext), **P2-24** (per-user DB) и реальные браузеры/внешний
  crypto-review — F7/G4.
- **P2-33 server-strip** без pin/crypto — только server policy (G4).
- Pre-F5G session records требуют re-key/re-register (см. §1).

## Closure

| #   | Пункт F5G                                      | Статус   | Доказательство                                                                                                                              |
| --- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **P2-36** forward-KDF store invariant          | DONE     | KDF proof в `prepareSessionRecord`, fingerprint-binding в `writeSessionRecord`, shape-check, CI-guard; real-CK0 probe reject; ratchet green |
| 2   | **R-15** dedupe после retry / failed batch     | DONE     | `finishReset`, `forget`, `resettingSessions`; bridge/store tests failed+completed batch                                                     |
| 3   | **R-15** local-copy isolation (P2-35)          | DONE     | per-entry `try/catch` + `skipped`; corrupt-copy test                                                                                        |
| 4   | **R-15** batch fresh-session (P2-30)           | DONE     | `reuseSessionIds`/`sessionIds`; exact-reuse + fresh-prekey fallback tests                                                                   |
| 5   | **P1-04** pinStore user/device scoping         | DONE     | обязательный local scope, fail-closed, peer-фильтры, тест                                                                                   |
| 6   | **P1-04** account switch A↔B                   | DONE     | `account/switch.ts` + bridge init; A→B→A тест                                                                                               |
| 7   | **P2-33** reply/sticker/attachment + downgrade | DONE     | `isE2eeChat` marker/crypto/pin, composer reply guard, flag-off downgrade tests                                                              |
| 8   | **§5.7** winner deletion                       | DEFERRED | не реализовывалось; документированный deferral сохранён                                                                                     |
| 9   | **Full check / KAT / no plaintext**            | DONE     | 56/596 EXIT 0; KAT 27/27; security 197; build 391; writers guard 135                                                                        |

> **Итог:** E7-F5G **DONE** в коде при выключенном флаге. P2-36 закрыт на
> store-level (forward-KDF + CI-guard), R-15-остатки и P1-04/P2-33 закрыты;
> §5.7, durable dedupe, v1.1 и real-browser/G4 явно остаются вне F5G. Флаг
> включать по-прежнему нельзя до F7/G4.

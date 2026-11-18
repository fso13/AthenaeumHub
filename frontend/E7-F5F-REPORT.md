# E7-F5F — закрытие открытых пунктов F5 и CR1d interim

> **Зона:** `frontend/**`, точечно `docs/E2EE-SPEC.md` (SPK TTL, R-15 anchor,
> §5.7) и аддитивно `docs/E2EE-TEST-VECTORS.json`. `backend/**`,
> `contracts/**`, `design/**`, `schema.d.ts`, `env.ts` не изменялись.
> Feature flag `VITE_E2EE_ENABLED`/backend `krug.e2ee.enabled` **не включался**;
> wire v1 не менялся. Итог: **DONE**, включать флаг по-прежнему нельзя до F6/F7/G4.

## Что закрыто

### 1. SPK TTL: 90 дней retained, current + 2

- Спека §1.3/§3.4.5.1 приведена к коду: `SPK_TTL = 90 дней` (**retained**,
  `current + 2`), `SPK_RETAIN_WINDOW = 90 дней`; `30 дней` — это только
  `SPK_ROTATION_INTERVAL` (плановая ротация current SPK), **не** TTL удаления
  private SPK. Удалена нормативная формулировка «запись без сессий — по TTL
  30 дней».
- Константа кода переименована в `SPK_ROTATION_INTERVAL_MS` (поведение не
  менялось); `SPK_RETAIN_WINDOW_MS`/`SPK_RETAIN_PRIVATE` остались нормативными.
- В `docs/E2EE-TEST-VECTORS.json` S1 дополнен аддитивными полями
  `spk_retention_ttl_days: 90` и `spk_ttl_field_semantics` (legacy
  `spk_ttl_days: 30` — rotation cadence). Существующие поля/векторы не менялись.
- Тесты: `prekeyStore.test.ts` — 31/60/89/90 retained, 91 destroyed, 4-я
  ротация удаляет oldest; 31/60/89 проверялись и ранее, добавлена явная
  граница 90/91.

### 2. R-15 marker: v1 wire не менялся

- **Wire v1 не менялся.** Inner `TEXT_JSON` v1 остаётся
  `{text, reply_to_id, mentions}`; `retry_of_client_message_id` в
  переотправленном TEXT — нормативно **v1.1** (потребует новой ревизии TEXT и
  вектора). В v1 якорь передаётся только в теле `SESSION_RESET`.
- Вместо поля в TEXT:
  - **receiver-of-reset dedupe** по ключу
    `(failed_session_id, failed_chain_dh, failed_n, retry_of_client_message_id)`
    — `ResetDeduplicator` в `resetRetry.ts` + `resetDeduplicator` в
    `chatBridge.handleReset`. Повтор возвращает
    `{status:'ignored', reason:'duplicate'}` и не перешифровывает окно; после
    reload/удаления failed-сессии — `invalid_session`.
  - **sender retry window** фильтруется по наличию envelope нужной сессии, а
    не по primary `OutboxEntry.sessionId` (additional/secondary session).
  - **fallback `(failed_chain_dh, failed_n)`** работает, если сервер не прислал
    `client_message_id`: `buildReceiverReset` больше не отбрасывает reset с
    `null`, а `selectRetryWindow` ищет окно по header из outbox bytes.
- Тесты: duplicate reset не дублирует retry (bridge + store), reset с
  `clientMessageId:null` строится и даёт `DECRYPT_FAILED` + reset, окно для
  secondary-сессии B2 (A→B1+B2) находится и по anchor, и по fallback.
- Спека §3.5.1/§5.5 переписана честно: v1 не обещает receiver-дедуп
  переотправленных TEXT; v1.1 — отдельная ревизия.

### 3. Per-account wipe

- Новый `src/e2ee/account/scope.ts`: удаляет только записи, атрибутируемые
  `(userId, deviceId)`:
  - `sessions`/peer index — по локальному `deviceId`;
  - `outbox` — по `senderDeviceId`;
  - `localMessages` — по session id, входящим в удаляемые сессии/outbox, или
    по `direction='outgoing'` + `deviceId`;
  - `keys`/`prekeys`/`pins` — только если persisted identity принадлежит этому
    scope; иначе не трогаются (чужой аккаунт не теряет K_storage/identity).
- `account/logout.ts` принимает `{userId, deviceId}`; провайдеры передают
  `userId` (mock/real), `clearAuthStorage` захватывает `krug.device.id` до
  удаления. Fallback — persisted identity (только активный аккаунт).
- Тесты: `account.test.ts` — logout A оставляет identity/K_storage/prekeys/pins
  B и B-сессии/outbox/local copies; production hook с IndexedDB тоже сохраняет
  B. Полный wipe (`destroyDeviceIdentity`) сохранён для явного reset/тестов.

### 4. §5.7 cleanup

- Недостижимый `cleanupUntouchedSessions` удалён из `receive.ts`: каждая
  персистентная сессия имеет `ns>=1` или `nr>=1` (send/receive коммитятся
  только после AEAD), поэтому `ns=nr=0` сессии не существует.
- Спеке §5.7 явно зафиксировано: v1 сохраняет обе живые сессии; удаление
  живой проигравшей без deterministic winner и окна доставки опасно. Полный
  winner-deletion — F6/CR1d; `SESSION_IDLE_TTL` — GC, не замена.
- Тест `sessionSendReceive` «две сессии» остаётся зелёным.

### 5. CR1d P1-01R-R — robust (a): arbitrary writers removed from production API

- `saveSession`/`createSession` **удалены из production-модуля**
  `session/sessionStore.ts`; они живут только в
  `src/e2ee/test/sessionTestWrites.ts` и импортируются только тестами.
  Production-записи идут только из `ratchetSend`/`ratchetReceive` через
  `prepareSessionRecord` + `writeSessionRecord` в atomic commit
  `commitOutgoingMessage`/`commitIncomingMessage`.
- `chainSendCommitment` оставлен **только как tamper detection** (сверка
  plaintext-метаданных с sealed chain); он не описывается как fix P1-01R-R.
- Тесты: production-модуль не экспортирует `saveSession`/`createSession`;
  forged `ns=0` с новым DH и старым CKs → `SESSION_STATE_STALE`; forged
  forward `ns` без смены chain → reject; легитимный DH-ratchet и multi-tab
  advances обновляют и `chainSend`.

### 6. E2EE plaintext spoof

- `MessageList`/`MessageRow` получили `e2eeChat`; `ChatScreen` передаёт
  `isE2eeChat`. В E2EE-чате **никогда** не рендерятся `message.text`,
  серверный reply preview, sticker/attachments из серверных полей; текст —
  только `e2ee.text`/sealed local copy, иначе пусто/`unavailable`.
- Тесты UI: non-null серверный `text` + flag off, и non-null `text` + ошибка
  E2EE init — строка сообщения существует, spoof-текст отсутствует.

## Файлы

Новые:

- `src/e2ee/account/scope.ts` — account/device-scoped wipe;
- `src/e2ee/test/sessionTestWrites.ts` — test-only `saveSession`/`createSession`.

Изменены (основное):

- `src/e2ee/account/logout.ts`, `src/auth/{storage,runtime,MockOidcProvider,RealOidcProvider}.ts`;
- `src/e2ee/app/{resetRetry,chatBridge}.ts`, `src/e2ee/app/{resetRetry,chatBridge}.test.ts`;
- `src/e2ee/session/{sessionStore,receive,types}.ts`, `src/e2ee/session/prekeyStore.ts`,
  `src/e2ee/device/prekeys.ts`, `src/e2ee/constants.ts`;
- `src/e2ee/outbox`/session tests, `src/e2ee/sessionStore.test.ts`,
  `src/e2ee/multiTab.test.ts`, `src/e2ee/sessionSendReceive.test.ts`;
- `src/components/{ChatScreen,MessageList,MessageRow}.tsx`, `src/components/E2ee.test.tsx`;
- `src/test/{fixtures,e2eeBridgeFake}.ts`, `src/store/e2eeChat.test.ts`;
- `docs/E2EE-SPEC.md` §1.3/§3.4.5.1/§3.5.1/§5.5/§5.7 + ADR-07;
- `docs/E2EE-TEST-VECTORS.json` (только аддитивные поля S1).

Не изменялись: `backend/**`, `contracts/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`, default флага,
envelope wire format v1.

## Tests

`cd frontend && npm run check` (финальный прогон, EXIT 0):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           195 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   55 files / 582 tests passed
tsc --noEmit             clean
vite build               390 modules, built
```

E2EE: 29 файлов / 355 тестов (в F5 — 29/346). Новые/расширенные:
scope multi-account, duplicate/secondary/null-anchor reset, SPK 90/91,
production-API guard, forged chain, plaintext-spoof UI (flag off/init error).

## Open / отложено

- **F6/CR1d:** полный §5.7 winner-deletion (deterministic winner + окно
  доставки, crossed sends) — код и спека честно фиксируют deferral.
- **v1.1:** `retry_of_client_message_id` в inner `TEXT_JSON` и receiver-дедуп
  переотправленных сообщений (сейчас — точное окно отправителя и dedupe
  самого reset).
- **P2-26:** retention SPK счётный (`current+2`); частая ротация может
  уничтожить SPK моложе 90 дней — отдельное решение F6/CR1d.
- **Multi-account ограничение:** identity/K_storage/prekeys/pins — single-slot
  на origin; новый scope-wipe не удаляет чужой активный аккаунт, но реальное
  параллельное E2EE-состояние двух аккаунтов по-прежнему требует per-user DB
  (P2-24/F6).
- **Test-only writers** (`sessionTestWrites.ts`) остаются в дереве тестов; в
  production bundle не импортируются.
- **No real E2E/browsers** и внешний crypto-review — F7/G4; флаг не включён.

## Open closure

| #   | F5/CR1d open item                           | Было                           | Closure                                                                                                                                                              |
| --- | ------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SPK TTL 30d vs 90d                          | `[BLOCKED]` (docs вне зоны F5) | **DONE:** спека §1.3/§3.4.5.1 = 90d retained/current+2; 30d — rotation; тест 31/60/89/90/91; S1 additive note                                                        |
| 2   | R-15 `retry_of_client_message_id` в v1 TEXT | `[BLOCKED]` wire               | **DONE:** wire v1 не изменён; receiver dedupe reset по `(session, chain, n, anchor)`; marker в TEXT — v1.1; тесты duplicate reset                                    |
| 3   | Per-account wipe                            | OPEN (full wipe)               | **DONE:** `account/scope.ts`; logout A не удаляет B; multi-account + production-hook tests                                                                           |
| 4   | §5.7 cleanup                                | OPEN (dead code)               | **DONE:** недостижимый cleanup удалён, conservative deferral задокументирован; winner-deletion → F6/CR1d                                                             |
| 5   | CR1d P1-01R-R                               | probe accepted                 | **DONE (variant a):** `saveSession`/`createSession` только в test helper; production — ratchetSend/ratchetReceive; commitment = tamper detection; forged chain tests |
| 6   | CR1d R-15 secondary reset                   | `anchor_unknown`               | **DONE:** фильтр по envelope session + fallback `(failed_chain_dh, failed_n)`; A→B1+B2 tests; null clientMessageId reset                                             |
| 7   | CR1d E2EE plaintext spoof                   | server `message.text` fallback | **DONE:** `e2eeChat` guard в MessageList/MessageRow/ChatScreen; flag-off/init-error tests                                                                            |
| 8   | Полный `npm run check`                      | —                              | **DONE:** 55 files / 582 tests, security 195 files, build 390 modules; флаг не включён                                                                               |

> **Итог:** DONE при выключенном флаге. Незакрытых пунктов F5F нет; остатки
> v1.1/F6/CR1d перечислены выше и не включают plaintext fallback.

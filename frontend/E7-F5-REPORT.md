# E7-F5 — E2EE wire-up, R-15 orchestration, key-change/mode UI, safety number

> **Зона:** только `frontend/**`. `docs/**`, `backend/**`, `contracts/**`,
> `design/**`, `frontend/src/api/schema.d.ts` и `frontend/src/config/env.ts`
> не изменялись. Feature flag `VITE_E2EE_ENABLED` / runtime не включён
> (default **false**, backend `krug.e2ee.enabled=false`). Goал — wire-up F3/F4
> в приложение без включения E2EE.
>
> **Статус: PARTIAL.** Функциональный wire-up, R-15 orchestration, UI-состояния
> и тесты сделаны; четыре пункта явно открыты:
> (1) R-15 `retry_of_client_message_id` внутри v1 TEXT body — `[BLOCKED]` до
> изменения wire-формата/векторов; (2) §5.7 winner-deletion остаётся
> консервативной (F4) и cleanup недостижим; (3) нормативное противоречие SPK
> TTL 30d/90d — `[BLOCKED]` (docs вне зоны); (4) выборочный per-account wipe
> при multi-account профиле — CR1d. Ни один из них не включает plaintext
> fallback и не требует включения флага.

## Что сделано

### 1. Flag и границы

- `src/e2ee/app/flag.ts`: `VITE_E2EE_ENABLED` + in-memory runtime override.
  Truthy только `1/true/yes/on`, всё остальное (включая опечатки) — `false`.
  Флаг не хранится в localStorage/sessionStorage и не меняет backend.
- `src/main.tsx` передаёт `createE2eeDeviceApi(client)` в store; bridge
  создаётся **только** при включённом флаге. При `false` весь E2EE-слой
  остаётся нетронутым (legacy managed path, 538 старых тестов зелёные).
- Если сервер объявил чат `E2EE`, а флаг выключен, отправка **блокируется**
  (`flag_disabled`); plaintext fallback отсутствует.

### 2. Wire-up (`src/e2ee/app/chatBridge.ts`, `src/store/chatStore.ts`)

- **Device registration with keys (F3) вместо legacy.** При флаге
  keycloak/dev bootstrap сначала получает `userId` (`GET /me` /
  dev-session), затем `registerDevice` с IK/IKB/SPK/OPK и `Idempotency-Key`;
  legacy `POST /devices` без ключей не вызывается. Устройство из
  `kDeviceId` (E2EE identity) становится `X-Device-Id`; dev-session
  обновляется в памяти. `already_registered` переиспользуется по
  `identity.deviceId`. Prekey top-up (`uploadPrekeys`) — best effort.
- **Scoped F2G loads.** `loadDeviceIdentity`/`loadOrCreateKStorage` теперь
  требуют явный `{ userId }` (не opt-in): identity другого аккаунта
  отвергается до чтения приватных ключей, `K_storage` owner-scoped.
  Bridge передаёт `userId` во все вызовы. Тестовые фикстуры обновлены.
- **E2EE chat selection.** `loadE2eeChat` вызывает F3 `evaluateChatMode`
  (mode pin), затем `GET /chats/{id}/keys`, binding/TOFU-пины, fingerprint и
  safety numbers. Результат — `E2eeChatState` в `AppState.e2ee.chats`.
- **Send.** `send` в E2EE-чате: `GET /chats/{id}/keys` → claim только для
  устройств без сессии → `prepareE2eeSend` → `commitE2eeSend` (state +
  exact bytes + Idempotency-Key + sealed local copy одной транзакцией) →
  `POST /messages` с `envelopes` и без `text`. Optimistic row живёт в
  outbox, `confirmSent`/`markFailed` пишут статус в F4 outbox; `retry`
  переотправляет **те же** envelopes из F4 outbox (crash recovery), не
  перешифровывает.
- **Receive.** `message.created`/history сообщения с `crypto` расшифровываются
  через `receiveE2eeMessage` (F4). Plaintext берётся только из расшифровки или
  из sealed local copy для своих сообщений; `Message.text` в E2EE никогда не
  рендерится (P2-13) — при непустом серверном plaintext поднимается
  `plaintextAlert`, текст не показывается. `crypto:null` → «недоступно на
  этом устройстве».
- **Key claim/pinning.** Claim bundle проходит `validateClaimResponse`,
  binding/SPK-подписи и `checkBundlePin` до создания сессии; chat keys —
  `validateChatKeysResponse` + `checkDeviceInfoPin`. `chat.keys.changed` и
  `device.list.changed` инвалидируют кэш и перечитывают состояние.
- **Mode pin.** `block_security_alert` (MANAGED + E2EE evidence) блокирует
  отправку без возможности подтверждения; `confirm_mode_required` требует
  явного `confirmManagedChatMode` (fresh-device flow). In-place downgrade
  E2EE→MANAGED запрещён и на уровне bridge.
- **Локальная копия.** Своё сообщение после reload читается по
  `client_message_id` из sealed copy; при потере копии — честный
  `unavailable`, а не пустой текст.

### 3. R-15 orchestration (`src/e2ee/app/resetRetry.ts` + store/bridge)

| Требование                               | Статус              | Реализация                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receiver auto-build/send `SESSION_RESET` | DONE                | При `SPK_DELETED`/`UNKNOWN_SPK`/`DECRYPT_FAILED`/`NO_SESSION`/`KEY_HANDSHAKE_INVALID` bridge строит body из `failed session_id/header.dh/header.n` и `Message.client_message_id`; store отправляет его **новым prekey-конвертом** через общий send path.                                                                                                                                    |
| Reset не виден и не дублируется          | DONE                | `content_type=2` маркируется `control`, фильтруется из `MessageList`, не попадает в outbox UI/уведомления; `ResetRateLimiter` 1/300 s на failed session, `e2eeResetInFlight` запрещает параллельный reset.                                                                                                                                                                                  |
| Sender retry window                      | DONE (partial wire) | `selectRetryWindow` берёт **только** сообщения failed-сессии начиная с якоря `retry_of_client_message_id`, сортируя по `header.n` (не по `createdAt`, который может совпасть). Сессия удаляется, первое сообщение создаёт новую prekey-сессию, остальные переиспользуют её.                                                                                                                 |
| `MAX_RESET_BATCH=20`                     | DONE                | Окно режется до 20; `remaining` уходит в `retryPendingCount` и в banner «часть не отправлена». Молчаливого отбрасывания нет.                                                                                                                                                                                                                                                                |
| Anchor неизвестен                        | DONE (fail-safe)    | `anchor_unknown` → reset игнорируется, failed-сессия удаляется, широкое «перешифровать всё» не делается.                                                                                                                                                                                                                                                                                    |
| `retry_of_client_message_id` в v1 TEXT   | `[BLOCKED]`         | F1/F2 v1 inner payload — ровно `{text, reply_to_id}`; поля нет в wire-формате/векторах, а `docs/**` и wire в F5 не меняются. Без него получатель не может дедуплицировать переотправленные сообщения (L3b) — это зафиксировано в Risks и вынесено в CR1d/F6. Store передаёт `retryOfClientMessageId` в outbox/local copy, так что после появления поля в спеке/векторах нужен только codec. |
| §5.7 cleanup                             | `[OPEN]`            | F4 `cleanupUntouchedSessions` удаляет только `ns=nr=0` сессии, но responder-сессия персистится уже после AEAD (nr>0), т.е. путь недостижим. Winner-deletion оставлен консервативным; нужно решение crypto-review (CR1c/CR1d).                                                                                                                                                               |

### 4. UI

- `E2eeBanner`: key-change alert с кнопкой **«Принять новый ключ»**
  (`acceptObservedKeyChange`, ровно persisted `observed`), mode-attack alert,
  fresh-device confirmation, flag-off/error/unavailable, coverage warnings,
  retry-pending.
- `SafetyNumberDialog`: per-device 60-значный код из локально посчитанных
  safety numbers, кнопка «Безопасность» в шапке E2EE-чата; verified-статус не
  выставляется автоматически.
- `MessageList`/`MessageRow`: E2EE-текст из decrypted view, `unavailable`,
  «не удалось расшифровать»; control/superseded строки скрыты; reply-цитата
  берёт расшифрованный текст. Composer/StickerPicker блокируются на E2EE
  (v1 — только текст), attachments/stickers в E2EE не отправляются.
- Никакого plaintext в E2EE: тело запроса — только `envelopes`, `text` не
  передаётся (тест `mockDb.sendBodies`), серверный plaintext игнорируется.

## CR1c (ответ на условия родительского ревью)

| Пункт                                                       | Статус                          | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. P1-01R-R** `ns/nr` rollback без реального ratchet      | **DONE**                        | `assertCountersMonotonic`: `ns→0` разрешён только при `pn === existing.ns` **и** смене `dhPublicKey`; `nr→0` — только при смене `dhRemote` (не по `pn >`). Добавлены regression-тесты: forged `ns=0` и forged `nr=0` → `SESSION_STATE_STALE`; легитимный ratchet-тест F4 остался зелёным. Дополнительно `loadSession` сверяет `record.sessionId` с ключом (P2-04).                                                                                                                                              |
| **2. P1-04 userId обязателен**                              | **DONE (API) / PARTIAL (wipe)** | `LoadDeviceIdentityOptions.userId` и `KStorageScope.userId` — required, runtime guard при `undefined`; все production-вызовы (bridge, pinStore, registration) передают scope; dev/test фикстуры обновлены. Mock OIDC logout теперь **await**-ит `clearRuntimeAuth` (как real), `signOut` допускает Promise. **Не сделано:** выборочный wipe только текущего аккаунта при multi-account профиле — F2G wipe чистит все сторы; это осознанно оставлено CR1d (риск data loss для второго аккаунта в одном профиле). |
| **3. SPK TTL 30d/90d**                                      | `[BLOCKED]`                     | Код F4 — 90-дневное окно (`current+2`), спека §1.3/§3.4.5.1 всё ещё говорит 30d. `docs/**` вне зоны F5, менять норматив нельзя. Отмечено в Risks; нужен spec-PR.                                                                                                                                                                                                                                                                                                                                                |
| **4. §5.7 cleanup / R-15 marker / superseded resurrection** | **PARTIAL**                     | `markOutboxFailed` больше не переводит `superseded`→`failed`; `retryOutboxEntry` не воскрешает `sent/superseded`; regression-тест в `outbox.test.ts`. §5.7 cleanup и `retry_of_client_message_id` — см. таблицу R-15 выше (CR1d/F6).                                                                                                                                                                                                                                                                            |
| **5. Полный `npm run check`**                               | **DONE**                        | См. Tests: 55 файлов / **570** тестов, tsc/vite build чистые. Запрошен **CR1d** до включения флага; флаг/backend не включались.                                                                                                                                                                                                                                                                                                                                                                                 |

## Файлы

Новые production-модули:

- `src/e2ee/app/flag.ts` — `VITE_E2EE_ENABLED` + runtime override;
- `src/e2ee/app/types.ts` — публичные E2EE-состояния store/UI;
- `src/e2ee/app/chatBridge.ts` — F3+F4 composition, device keys, keys/claim,
  send/receive/reset, pins/mode/safety, scoped transport;
- `src/e2ee/app/resetRetry.ts` — R-15 receiver body/rate limit, retry window.

Новые UI:

- `src/components/E2eeBanner.tsx`, `src/components/SafetyNumberDialog.tsx`.

Новые тесты/фикстуры:

- `src/e2ee/app/{flag,resetRetry,chatBridge}.test.ts`;
- `src/test/e2eeBridgeFake.ts`;
- `src/store/e2eeChat.test.ts`, `src/components/E2ee.test.tsx`.

Изменены:

- `src/store/chatStore.ts` — E2EE state/methods, bootstrap, send/receive,
  retry, reset, realtime key events;
- `src/components/{ChatScreen,ChatHeader,MessageList,MessageRow,Composer,StickerPicker}.tsx`,
  `src/i18n/ru.ts`, `src/styles/app.css`;
- `src/main.tsx`, `src/test/renderApp.tsx` — transport wiring;
- `src/auth/{AuthContext.ts,MockOidcProvider.tsx}`, `src/App.tsx` — await wipe;
- `src/mocks/handlers.ts` — E2EE envelope-only `POST /messages` (mock), echo
  `client_message_id`;
- `src/e2ee/session/sessionStore.ts` — CR1c P1-01R-R, `loadSession` id check;
- `src/e2ee/outbox/outboxStore.ts` — superseded terminal;
- `src/e2ee/device/identity.ts`, `src/e2ee/storage/kStorage.ts`,
  `src/e2ee/device/registration.ts` — required account scope;
- `src/e2ee/test/sessionFixtures.ts` + F2/F3/F4 тесты — scope args;
- `src/vite-env.d.ts` — тип `VITE_E2EE_ENABLED` (не `env.ts`).

Не изменялись: `docs/**`, `backend/**`, `contracts/**`, `design/**`,
`schema.d.ts`, `env.ts`, feature flag default, wire-формат.

## Tests

`npm run check` (EXIT 0, финальный прогон после всех правок):

```
lint                     ok
format:check             ok
contract:check           33 operations, 58 schemas, types in sync
stickers:check           ok
security:check           193 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
vitest                   55 files / 570 tests passed
tsc --noEmit             clean
vite build               389 modules, built
```

- E2EE: **29 файлов / 346 тестов** (было 26/330 в F2G).
- Новых тестов — **32** (538 → 570):
  - `chatBridge.test.ts` (6): регистрация, chat keys/safety number, send→receive
    с sealed copy, TOFU key change → accept → send, mode alert/confirm/allow,
    reset window по `header.n`, `MAX_RESET_BATCH=20` + `remaining`, anchor
    unknown, повторный reset игнорируется;
  - `flag.test.ts` (3): default false, truthy/falsy, runtime override;
  - `resetRetry.test.ts` (4): reason mapping, body из header,
    1/300 s limiter, batch=20;
  - `e2eeChat.test.ts` (11): flag-off legacy, E2EE send без plaintext,
    decrypt + server-plaintext ignore, unavailable copy, key-change block/accept,
    MANAGED alert/confirm, auto SESSION_RESET (невидимый, envelopes-only),
    incoming reset → retry window, anchor unknown;
  - `E2ee.test.tsx` (5): key-change banner + explicit accept, mode alert,
    safety number dialog/Escape, decrypted incoming vs server text, axe
    (serious/critical = 0);
  - CR1c: `sessionStore.test.ts` +2 (forged `ns/nr`), `outbox.test.ts` +1
    (superseded не воскресает).

Ключевые негативные проверки F5: plaintext не уходит в E2EE (`sendBodies.text`
undefined), серверный plaintext не рендерится, key change блокирует отправку до
`acceptObservedKeyChange`, MANAGED-downgrade нельзя подтвердить при evidence,
reset не добавляется в UI и не дублируется, retry window не расширяется при
неизвестном якоре, OPK/claim ошибки не приводят к сессии.

## Risks / `[OPEN]`

- **R-15 marker `[BLOCKED]`.** `retry_of_client_message_id` некуда положить в v1
  TEXT body (wire/KAT заморожены, docs вне зоны). Следствие: получатель не
  дедуплицирует переотправленные сообщения; sender-side окно/батч/новый
  `client_message_id` реализованы. Нужен spec+vector PR (CR1d/F6) и только
  затем codec.
- **§5.7 winner-deletion.** Оставлено консервативным (F4): удаляются только
  нетронутые сессии; `cleanupUntouchedSessions` фактически недостижим. Решение
  (детерминированный winner + окно доставки) — crypto-review/CR1d.
- **SPK TTL 30d/90d `[BLOCKED]`.** Код 90d, спека §1.3/§3.4.5.1 — 30d.
  Нормативная правка docs запрещена зоной F5.
- **Multi-account wipe.** Logout чистит все E2EE-сторы; при двух аккаунтах в
  одном профиле второй теряет локальные E2EE-данные. Owner-scoped identity/
  K_storage не дают читать чужие секреты, но data loss возможен. Нужен
  per-account wipe (CR1d).
- **Reset rate limit in-memory.** 1/300 s на failed session живёт в памяти
  вкладки; после reload счётчик теряется (дубликат reset возможен, но reset
  невидим и ограничен failed session). Durable-счётчик потребовал бы новый
  sealed record type.
- **Retry batch partial failure.** Успешные сообщения батча остаются `sent`,
  неуспешные — `retry_pending`; повтор возможен только следующим reset
  (ручного «повторить batch» в UI v1 нет). `retryPendingCount` показывает
  честно.
- **No real E2E / browsers.** Тесты — Node + jsdom/fake-indexeddb/memory
  storage; kill-tab, background throttling, IndexedDB durability,
  двухбраузерный E2E — E7-F7. Плюс нет внешнего crypto-review (G4/CR1d).
- **Mock `POST /messages` расширен** (envelopes-only body, echo
  `client_message_id`) — только тестовая инфраструктура, не production API.
- **Флаг не включён.** `VITE_E2EE_ENABLED` default false, backend
  `krug.e2ee.enabled=false`; включать только после CR1d/G4/F7.

## Что дальше

1. **CR1d:** P1-01R-R (fixed) + §5.7 решение + R-15 marker spec/vector +
   per-account wipe + SPK TTL норматив.
2. **F6:** визуальная полировка, verification flow (PUT `/keys/verification`,
   QR), coverage/retry UX.
3. **F7/G4:** реальные браузеры, двухбраузерный E2E, kill-tab, включение флага
   только после CR1d и внешнего review.

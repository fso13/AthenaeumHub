# E7-F6 — §5.7 winner deletion, R-15/UI polish, E2EE chat guard

> **Зона:** только `frontend/**` (код, тесты, `E7-F6-REPORT.md`).
> `backend/**`, `contracts/**`, `docs/**`, `design/**`, `src/api/schema.d.ts`,
> `src/config/env.ts` не изменялись; wire v1 не менялся. Feature flag
> `VITE_E2EE_ENABLED` остаётся **false**, backend `krug.e2ee.enabled=false`;
> production E2EE-сети/E2E не добавлено.
>
> **Вход:** `docs/E2EE-SPEC.md` §5.7/§5.4/§4.8,
> `docs/E2EE-CLIENT-REVIEW-04.md` (F6 conditions), `frontend/E7-F5G-REPORT.md`,
> `frontend/E7-F4-REPORT.md` §5.7, `src/e2ee/session/**`, `app/**`,
> `src/store/chatStore.ts`, `components/E2ee.test.tsx`, `chatBridge`.
>
> **Итог:** §5.7 winner-deletion реализован по варианту **A** (детерминированный
> winner + delivery window + crossed-sends/state-machine тесты). R-15 UX
> получил progress/failed/retry-состояния и список uncovered-устройств;
> `acceptKeyChange` теперь расшифровывает pending-сообщения. Флаг не включён.

## 1. §5.7 — deterministic winner для simultaneous init

### 1.1. Модель

При одновременном инициировании на каждом устройстве остаются две сессии на
пару `(chat, peer_device)`:

- `initiatedBy='local'` — сессия, которую устройство само инициировало;
- `initiatedBy='peer'` — responder-сессия, созданная из первого prekey-конверта
  собеседника.

Обе стороны видят **одни и те же два `session_id`**, поэтому winner
детерминирован: **меньший канонический b64u `session_id`** (побайтовое
сравнение ASCII, не locale-dependent). Проигравший помечается, но не удаляется
сразу.

### 1.2. Persisted winner/superseded metadata

В `SessionState`/`StoredSessionRecord`/`StoredSessionSecrets` добавлены
несекретные метаданные:

| Поле                | Где    | Смысл                                                                 |
| ------------------- | ------ | --------------------------------------------------------------------- |
| `supersededBy`      | loser  | `session_id` детерминированного winner                                |
| `supersededAt`      | loser  | когда решение стало durable                                           |
| `winnerConfirmedAt` | winner | первый успешный receive на winner после того, как пара стала известна |

- Поля пишутся и в plaintext-запись, и в `K_storage`-sealed secrets; при
  загрузке выполняется cross-check (tamper → `KEY_STORAGE_UNAVAILABLE`).
- Метаданные входят в `previousStateFingerprint`, поэтому prepared
  send/receive, сделанный до пометки, не может «откатить» её в `null`.
- `assertForwardTransition` разрешает только монотонные переходы:
  `null → winner` / `winner → null` (promotion при потере winner), добавление
  `winnerConfirmedAt`, но не его удаление/откат; `supersededBy` не может
  смениться на другого winner; сессия не может supersede сама себя.
- Запись идёт через тот же `prepareSessionRecord`/`writeSessionRecord`
  (forward-KDF proof + fingerprint binding), что и ratchet-коммиты. CI-guard
  `session-writers:check` не ослаблен: новые функции находятся в
  `session/sessionStore.ts`, а не в UI/app-модулях.

### 1.3. Выбор сессии для отправки

`selectSendingSession`:

1. исключает `supersededBy !== null`;
2. если в пуле ровно одна local + одна peer-сессия — возвращает
   детерминированного winner **независимо от `lastReceivedAt`**;
3. иначе сохраняет прежнее правило §5.7: last received → locally initiated →
   меньший id.

`resolveRecipient` также отбрасывает superseded-сессии и отклоняет явный
`sessionId`/`reuseSessionIds`, указывающий на проигравшего (`NO_SESSION`), а не
молча переключается на другую живую цепочку.

### 1.4. Удаление только после первого успешного receive/confirm

- `receiveE2eeMessage` **до** атомарного commit определяет пару; если
  принимаемая сессия — winner, в её новое состояние добавляется
  `winnerConfirmedAt = createdAt` и сохраняется **в той же транзакции**, что
  сообщение/OPK/локальная копия.
- После commit вызывается идемпотентный `reconcileParallelSessions`:
  - loser помечается `supersededBy`/`supersededAt`;
  - удаление возможно только если `winnerConfirmedAt != null`;
  - окно доставки — `SUPERSEDED_DELIVERY_WINDOW_MS = 5 минут` от более
    позднего из `(winnerConfirmedAt, supersededAt)`;
  - удаление дополнительно откладывается, если в outbox есть `pending`-запись с
    envelope проигравшей сессии (in-flight send не теряется);
  - сессии с активным R-15 reset защищены `protectedSessionIds`.
- Пока loser не удалён, его ключи читают in-flight конверты; отправлять через
  него нельзя. Это и есть «no in-flight message loss» в пределах перехода.
- `deleteSession` идемпотентен; повторный reconcile ничего не ломает.

### 1.5. Восстановление после reload

`bridge.initialize` вызывает `recoverParallelSessions`, `loadChat` —
`reconcileParallelSessions(chatId)`. Восстановление:

- находит уже помеченного loser по `supersededBy`;
- если winner исчез (ручное удаление/TTL), **promotes** оставшуюся сессию:
  снимает stale-маркер, чтобы не остаться без рабочей цепи;
- если winner жив и `winnerConfirmedAt` уже есть, досрочно завершает удаление
  после окна;
- повторный вызов — no-op (`deleted=[]`, `superseded=[]`).

Отдельно: `receiveE2eeMessage` не падает, если sibling peer-index повреждён —
сообщение всё равно расшифровывается, winner-confirmation просто пропускается
до следующего receive.

## 2. R-15 / UX polish

### 2.1. Reset progress и retry

`E2eeChatState` получил `resetProgress`:

```ts
interface E2eeResetProgress {
  status: 'running' | 'completed' | 'failed';
  total: number;
  done: number;
  failed: number;
  remaining: number;
  skipped: number; // P2-35 corrupt local copies
}
```

- `handleIncomingReset` выставляет `running` до batch, обновляет `done` после
  каждого успешного сообщения, затем `completed`/`failed`.
- `retryPendingReset(chatId)` — явный retry упавшего/частичного batch. Reset
  body хранится в памяти только после `failed`; при `completed` запись
  удаляется, поэтому кнопка не может повторно отправить уже заменённые
  сообщения.
- `finishReset('failed')` по-прежнему делает `forget(reset)`, поэтому повторный
  control/reset может снова прогнать окно; `finishReset('completed')` удаляет
  failed-сессию и оставляет dedupe.
- **No duplicate visible reset:** один progress-banner на чат; in-flight guard
  `e2eeResetInFlight` блокирует параллельный запуск; control-строка не
  рендерится; при `duplicate` существующий pending-window не затирается.
- Баннеры `running/failed/completed` имеют `role=status`/`role=alert`,
  `aria-live`; failed содержит кнопку «Повторить переотправку».

### 2.2. Coverage / unavailable devices

- После send (`sendText` и каждый retry-кандидат) `coverageWarning` и
  `unavailableDeviceIds` берутся из `prepared.coverage.uncoveredDeviceIds`.
- `E2eeBanner` показывает не только предупреждение, но и **список**
  uncovered-устройств (short device id).
- `loadE2eeChat` не затирает уже известный список пустым snapshot.

### 2.3. Key-change pending decrypt (P2-31)

`acceptKeyChange` после `acceptObservedKeyChange` + `loadE2eeChat` удаляет
только error-view с `code='KEY_CHANGE_DETECTED'` и повторно запускает
`decryptE2eeSlice`. Сообщения, пришедшие во время блокировки, расшифровываются
без ручного refresh; прочие error-views (например `DECRYPT_FAILED`) сохраняют
R-15 семантику.

## 3. Plaintext / mode / key-change regression

Не менялись и подтверждены тестами:

- E2EE-чат не рендерит серверный `text`, reply quote, sticker, attachment и в
  E2EE-composer; `e2eeChat` guard остаётся.
- Key-change warning + explicit accept + блокировка отправки; mode-alert/
  confirm-managed; flag-off блокирует E2EE-чат без plaintext fallback.
- Server downgrade в `MANAGED` при наличии crypto-envelope/sealed pin остаётся
  E2EE (`isE2eeChat`), send блокируется (`flag_disabled`).
- Server plaintext alert теперь **не скрывает** reset progress/retry и coverage:
  plaintext/error-ветки включают те же auxiliary-баннеры.
- Axe: новый failed-reset banner (с progress/plaintext alert) проверен
  `axe.run`; существующий key-change/safety-dialog audit зелёный.

## 4. Файлы

Новые:

- `src/e2ee/session/parallel.ts` — §5.7 state machine (winner, confirm, reconcile,
  recovery);
- `src/e2ee/parallelSessions.test.ts` — 5 тестов §5.7;
- `frontend/E7-F6-REPORT.md`.

Изменены (основное):

- `src/e2ee/session/{types,sessionStore,send,receive}.ts`;
- `src/e2ee/constants.ts` (`SUPERSEDED_DELIVERY_WINDOW_MS`);
- `src/e2ee/app/{chatBridge,types}.ts`;
- `src/store/chatStore.ts` — progress/retry, coverage ids, P2-31;
- `src/components/{E2eeBanner,ChatScreen,E2ee.test}.tsx`;
- `src/store/e2eeChat.test.ts`, `src/test/e2eeBridgeFake.ts`,
  `src/e2ee/sessionSendReceive.test.ts`;
- `src/i18n/ru.ts`, `src/styles/app.css`.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, `env.ts`, default флага, wire v1, `docs/E2EE-TEST-VECTORS.json`.

## 5. Проверки

Финальный `cd frontend && npm run check` — **EXIT 0**:

```
lint                     ok (0 errors; 2 pre-existing warnings in CreateChatDialog)
format:check             ok
contract:check          52 operations, 85 contract schemas (71 checked), types in sync
stickers:check           ok
security:check          236 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
session-writers:check   ok (161 production files; writers restricted to session store + outbox commit)
vitest                  69 files / 716 tests passed
tsc --noEmit            clean
vite build              414 modules, built
```

KAT: `vectors.test.ts + kStorageKAT.test.ts` — **27/27** (24 KAT + 3
`K_storage` O1/O2/O3). Векторы и `kStorage` AAD не менялись.

Targeted §5.7: `parallelSessions.test.ts` — **5/5**; UI E2EE —
`components/E2ee.test.tsx` **12/12**; store E2EE — `e2eeChat.test.ts` **15/15**.

Прирост к F5G: 56/596 → **69/716** (+13 файлов, +120 тестов; включая
`parallelSessions` 5 и UI/store-регрессии). `src/e2ee/**` по-прежнему без
`console`/`localStorage`/`fetch`/`Math.random`.

## 6. Risks / deferred

1. **Late loser envelope после окна.** Loser удаляется через 5 минут после
   confirmation (и при отсутствии pending outbox). Конверт, пришедший позже,
   даёт `NO_SESSION` → R-15 `SESSION_RESET`; если отправитель к этому моменту
   тоже удалил loser, reset может стать `invalid_session`. На нормальном
   серверном `seq`-порядке более ранний loser-envelope обрабатывается до
   winner-сообщения; сценарий с длительной задержкой/дырой в истории требует
   real-browser/F7 проверки. Это осознанный компромисс против «держать loser
   вечно»; TTL/GC не является заменой, но страхует.
2. **Только точная пара `1 local + 1 peer`.** При >2 сессиях на пару автоудаление
   не выполняется (консервативно, чтобы не удалить цепь после reset);
   такие сессии остаются до `SESSION_IDLE_TTL`/GC. Winner-выбор для отправки
   всё равно детерминирован для пары.
3. **Pending outbox блокирует удаление.** Если отправка навсегда осталась
   `pending`, loser сохраняется до TTL; это защита от потери in-flight send,
   а не утечка ключей (non-extractable, sealed).
4. **R-15 v1.1 не реализован.** `retry_of_client_message_id` в inner `TEXT` и
   receiver-дедуп переотправленных TEXT — по-прежнему v1.1 (P2-27); «0 дублей»
   не обещается. Durable dedupe/rate-limit (P2-29) остаётся in-memory;
   `pendingResets` после reload восстанавливается через повторный разбор
   control-сообщений из истории, а не отдельным sealed record.
5. **Docs §5.7.** `docs/**` по зоне не менялись; текст §5.7 всё ещё описывает
   F5F-состояние и делегирует winner-deletion в F6/CR1d. Код F6 теперь
   реализует вариант A; финальную формулировку спеки должен обновить
   владелец docs (не блокер кода, но обязательное условие G4).
6. **QR UI.** Safety number показывает 60-значный код и `qrPayload` считается,
   но QR-изображение в диалоге не рендерится (нет QR-энкодера в зависимостях);
   это остаётся F7 UI-условием. Цифровой код — основной канал сверки.
7. **P1-01R-R/P2-36.** Архитектура F5G сохранена: production-записи только через
   ratchet/commit; metadata-writer использует тот же forward-KDF/fingerprint
   proof. CI-guard `session-writers:check` зелёный; store-level property
   «нет повтора MK/nonce» остаётся G4-условием.
8. **Нет backend/network E2E, реальных браузеров и внешнего crypto-review.**
   jsdom/fake-indexeddb/memory; IndexedDB durability, Safari flush, Web Locks в
   фоне, kill-tab — F7. `VITE_E2EE_ENABLED` не включался.

## F6 status

**DONE (код, флаг `false`).** §5.7 variant A реализован и покрыт state-machine
тестами: simultaneous init, in-flight loser message, pending outbox deferral,
reload recovery, winner keys. R-15 UX (progress/retry/no duplicate visible
reset), coverage-список и P2-31 закрыты. Полный `npm run check` — **EXIT 0,
69 файлов / 716 тестов**, KAT **27/27**, axe зелёный, security 236, writers 161,
build 414. `[BLOCKED]` нет: спека §5.7 неоднозначностей в реализованной части не
содержит; docs-формулировка — условие F7 для владельца docs.

## Оставшиеся условия F7 / G4 (до включения флага)

1. **Docs:** обновить §5.7 (winner + delivery window + `supersededBy`/
   `winnerConfirmedAt`), убрать остатки «deferred»; зафиксировать 5-минутное
   окно и поведение late-envelope.
2. **Real browsers:** Chrome/Firefox/Safari — X25519/Ed25519, non-extractable
   `CryptoKey` в IndexedDB, durability/close, write-staging/flush, Web Locks в
   фоне, kill-tab, quota; отдельный сценарий late loser envelope.
3. **External crypto review G4:** §5.7 proof, R-15 v1.1 (P2-27), P2-10/P2-26/
   P2-29/P2-34, store-level P1-01R-R property.
4. **R-15 v1.1:** `retry_of_client_message_id` в inner TEXT, receiver-дедуп,
   durable dedupe/rate-limit; продуктовое ограничение v1 «0 дублей не
   обещается» должно быть явно принято.
5. **Два браузера / два устройства:** crossed sends, simultaneous init,
   in-flight, reload, reset → L3b; два аккаунта в одном профиле (P2-24).
6. **UI:** QR-рендер safety number (если нужен продуктово); полный axe-прогон
   новых reset/coverage-состояний в реальном браузере.
7. **Только после этого** — включение `VITE_E2EE_ENABLED`/backend
   `krug.e2ee.enabled`; сейчас оба `false`, plaintext fallback отсутствует.

# E7-CR1b — независимый client crypto review после E7-F3 / E7-F2F

> **Рецензент:** независимый crypto/security-ревьюер; в подготовке E7-F1/F2/F3/F2F
> не участвовал. **Дата:** 2026-11-17.
> **Вход:** `docs/E2EE-CLIENT-REVIEW-01.md` (CR1), `frontend/E7-F3-REPORT.md`,
> `frontend/E7-F2F-REPORT.md`, `frontend/src/e2ee/**`, `frontend/src/api/e2eeDeviceApi.ts`,
> `docs/E2EE-SPEC.md` §2.3/§3/§5, `docs/E2EE-TEST-VECTORS.json` (v4),
> `frontend/scripts/check-security.mjs`, `docs/TASKS-E7.md`.
> **Зона:** этим ревью создан только этот файл; код, контракты, спека, векторы
> и `docs/TASKS*` ревьюером не изменялись.
> **Метод:** чтение production-кода и тестов; полный `npm run check`; независимый
> KAT на Python `cryptography` 49.0.0 **прямо из нормативного JSON**, без
> авторского `src/e2ee/test/vectors.ts` и без production-кода; независимый
> пересчёт `K_storage` KAT; временные probe вне workspace (`/tmp`, в репозиторий
> не добавлялись) для проверки API-инвариантов outbox.
>
> **Граница снимка (важно).** `npm run check` и все line-reference ниже — для
> **F3/F2F-снимка 12:11** (46 файлов / 490 тестов). Во время ревью, после 12:15,
> в дереве параллельно появились файлы **E7-F4 WIP** (`src/e2ee/session/send.ts`,
> `handshake.ts`, `ratchet.ts`, `reset.ts`, `trust.ts`, `src/e2ee/protocol/x3dh.ts`,
> изменены `outboxStore.ts`, `sessionStore.ts`, `device/pins.ts`, `device/binding.ts`).
> Они **вне scope CR1b**, не проверялись как F4 и не учитываются в вердикте; их
> наличие отмечено только там, где они меняют трактовку F2F (P1-01R, P2-16).
> Ключевые находки P1-01R/P1-03/P1-04 воспроизведены и в текущем дереве.
> `docs/TASKS.md`/`docs/TASKS-E7.md` также обновлены параллельным процессом
> (12:11), не этим ревью.

## Вердикт

**GO WITH CONDITIONS — только для начала E7-F4 в коде при выключенном
`krug.e2ee.enabled`.**

**NO-GO для включения E2EE, интеграции F5 и внешнего G4** до закрытия
**P1-01R** (латентный P0 nonce reuse), **P1-03** (30-дневное уничтожение SPK,
нужного в 90-дневном окне), **P1-04** (logout/account wipe не подключён и
неполон) и нормативного **P1-07** (раскладка AAD и KAT не опубликованы в
спеке/векторах).

Что подтверждено:

- F1/F2-криптоядро не деградировало: 24/24 авторских вектора, независимый
  KAT — **82/82** проверки без расхождений; AAD `K_storage` 50 B, nil-sentinel
  отвергается, KAT сходится побайтово.
- **P1-02** (namespace локальной копии), **P1-06** (locks/fencing) закрыты;
  **P1-05** (sealed TOFU-пины) закрыт в коде; **P1-07** закрыт в коде, но не
  нормативно; **P1-01** закрыт только в части «sessionless».
- Нет production-вызовов E2EE send/receive/registration; `security:check` —
  168 файлов, в `src/e2ee/**` нет `console`/`Math.random`/сети/localStorage;
  плейнтекста сообщений в дампах нет.
- Полный `npm run check` на снимке: **EXIT 0, 46 файлов / 490 тестов**,
  E2EE **22/282**, KAT **24/24**, tsc clean, vite build 331 модуль.

Почему не «просто GO»:

1. **P1-01R.** `commitOutgoingMessage` принимает forged/stale
   `PreparedSessionRecord`: `writeSessionRecord` сверяет только
   `existing.revision === mode.ifRevision`, но не `record.revision`; коммит
   prepared-состояния rev 0 после цепочки rev 3 **откатывает ratchet** (probe
   `PROBE-B`), а два коммита с одним и тем же неadvanced state дают одинаковый
   `header.n` (probe `PROBE-A`). Для F4 это тот же AES-GCM nonce reuse, от
   которого закрывали P1-01; в текущем (flag-off) дереве production-вызова нет,
   поэтому это латентный P0, а не активный.
2. **P1-03 не закрыт**, хотя F3-отчёт помечает его DONE. `rotateSignedPrekey`
   по-прежнему уничтожает unused SPK старше 30 дней, если его нет в
   `activeSessionSpkIds`; claimed-but-undelivered prekey не создаёт сессию,
   поэтому в день 31+ приватный SPK может быть удалён. 90-дневное окно §5.5 для
   prekey-сообщений не выполняется; тест `prekeyStore.test.ts:183-205`
   закрепляет удаление на 30-й день.
3. **P1-04 закрыт частично.** `destroyDeviceIdentity()`/`clearDeviceE2eeAccountState()`
   реализованы и запечатывают/чистят identity, `K_storage`, prekeys и pins, но:
   production-вызова нет (`clearAuthStorage` чистит только `sessionStorage`);
   `sessions`/`outbox`/`localMessages` не очищаются; БД `krug-e2ee` и ключ
   `k-storage:v1` не скоупятся по user/device; теста двух аккаунтов нет.
4. **P1-07 нормативно открыт:** 50-байтовая раскладка и KAT живут в коде/тесте,
   но не в `docs/E2EE-SPEC.md` и не в `docs/E2EE-TEST-VECTORS.json`; G4 не может
   подтвердить формат по нормативному документу.

## P0

**Открытых P0 в поставляемом дереве (flag `false`, production-вызовов E2EE нет)
не найдено.**

Обоснование:

- Приватные ключи создаются non-extractable (`generateX25519KeyPair`/
  `generateEd25519KeyPair`), `K_storage` — non-extractable AES-256-GCM; в
  `src/e2ee/**` нет сети/логов/`Math.random`/`localStorage` (`security:check`,
  168 файлов).
- Ни один production-путь не вызывает `prepareOutgoingMessage`/
  `commitOutgoingMessage`/`prepareIncomingMessage`/`drainOutbox`
  (`grep` по `src`, вне тестов — пусто). F3 не подключён к store/UI.
- Ни один тест/KAT не выявил расхождения байтов; независимый KAT — 82/82.

**Латентные P0 (становятся P0 при интеграции F4/F5):**

- **P1-01R** — nonce reuse при forged/stale prepared state (см. ниже). Как
  только F4 начнёт вызывать commit с состоянием, полученным не из
  зашифрованного шага, это прямая крипто-ошибка.
- **P1-03** — потеря prekey-сообщений после 30 дней (не крипто-взлом, но
  нарушение обещанного FS-окна и тихая потеря доставленного).
- **P1-04** — после logout/смены аккаунта без wipe остаются identity/
  `K_storage`/сессии/пины; второй аккаунт в том же профиле может читать старые
  секреты, если какой-либо код вызовет `loadDeviceIdentity()` +
  `loadOrCreateKStorage(record.deviceId)` (owner/user не проверяются).

## P1 closure matrix

| ID | Требование CR1 | Статус в F3/F2F-снимке | Доказательство / остаток |
|---|---|---|---|
| **P1-01** | Sessionless commit запрещён; не nonce reuse; forged commit отвергается | **PARTIAL** — sessionless закрыт, forged/stale commit — нет | `outboxStore.ts` `prepareOutgoingMessage`/`commitOutgoingMessage`: `sessionState` обязателен, `prepared.session === null` → `SESSION_STATE_MISSING`; сверяются sessionId/chatId/localMessageId/device. **Но** нет сверки `record.revision` с `mode.ifRevision`, нет связи `state.ns` ↔ `header.n`, нет монотонности counter'ов. Probe A/B ниже. Тесты `outbox.test.ts:480-578` покрывают только sessionless и stale `ifRevision`, не stale prepared record. |
| **P1-02** | Namespace локальной копии: chat+direction+sender+вид id; lookup только outgoing | **CLOSED** | Ключ `local:<chat>:<direction>:<sender>:c:<clientId>` / `...:l:<localId>` (`outboxStore.ts:149-161`); outgoing-sender всегда `K_storage.ownerDeviceId`; `lookupLocalCopy(chatId, clientId)` ищет только outgoing+owner (`:947-976`); входящая копия физически в другом namespace; direction/sender/chat cross-check с sealed payload. Тесты `outbox.test.ts:580-700` (collision в одном чате, другой чат, tamper direction/scope). Probe не required: код и тесты однозначны. |
| **P1-03** | SPK TTL не должен уничтожать SPK, нужный в 90-дневном окне; `spk_id` в session state | **OPEN** — `spk_id` добавлен, но 30-дневное удаление осталось | `SPK_TTL_MS=30d`, `SPK_RETAIN_WINDOW_MS=90d` (`constants.ts:59-61`); `rotateSignedPrekey` удаляет `!usedBySession && age > min(30d,90d)` (`prekeyStore.ts:374-378`); `activeSessionSpkIds` собирается только из существующих сессий (`sessionSpk.ts:19-35`), а prekey-сообщение до расшифровки сессии не создаёт. Сценарий CR1 (день 0 → офлайн → ротация день 31 → доставка день 31–89) не расшифровывается. `prekeyStore.test.ts:183-205` по-прежнему ожидает удаление на 30-й день; spec §3.4.5.1 строка 575 говорит «TTL 30 дней», §5.5 строка 1126 — «90 дней». F3 не разрешил противоречие, а обошёл его для сессий с `spkId`. |
| **P1-04** | Account/device scope + wipe на logout/account switch/revoke; K_storage/БД не наследуются | **PARTIAL** — helper есть, hook и полный wipe отсутствуют | `destroyDeviceIdentity`/`clearDeviceE2eeAccountState` (`identity.ts:510-521`) удаляют `keys`/`prekeys`/`pins` одной транзакцией; пины скоупятся AAD `(owner device, user, target device)` (`pinStore.ts:74-93`). **Но:** production-вызова нет — `clearRuntimeAuth`→`clearAuthStorage` чистит только `sessionStorage` (`auth/storage.ts:154-169`, `auth/runtime.ts:65-69`); `sessions`/`outbox`/`localMessages` не очищаются (комментарий `identity.ts:504-508` прямо оставляет их F2F, но F2F их не тронул); `DEFAULT_DATABASE_NAME='krug-e2ee'` и `k-storage:v1` единые, owner-маркера нет (`indexedDb.ts:26`, `kStorage.ts:55,214-284`); `loadDeviceIdentity`/`loadOrCreateKStorage` не сверяют `userId`. Тест `identity.test.ts:149-168` проверяет только keys/prekeys/pins/K_storage, не sessions/outbox/local copy и не два аккаунта. |
| **P1-05** | Sealed TOFU-пины, AAD scope, key-change, пин до сессии/display | **CLOSED** (в коде F3) | Пины/`keyChange`/`modePin` запечатаны `K_storage` (`pinStore.ts`), AAD — 50 B с target device/user/chat в слотах; `pin`/`keyChange`/`modePin` добавлены в `RECORD_TYPES`; `applyPinCheck` пишет пин только после проверенного bundle, при mismatch — persisted key-change и `blocked`, пин не перезаписывается; `acceptKeyChange` — только явный вызов; TTL пинов нет. Тесты `pins.test.ts`, `modePin.test.ts`, `pinStore` scope/tamper/missing-key. Остаток: `acceptKeyChange` не сверяет принимаемый bundle с сохранённым `observed` (P2-17), а `[OPEN]`-трактовка AAD-слотов не описана в спеке (P2-18). |
| **P1-06** | Уникальный tabId, fail-closed fallback или fencing для всех мутаций | **CLOSED** | `createTabId()` — RFC 4122 v4 из CSPRNG (`locks.ts:118-141`); `instanceId` + `LOCK_TAB_ID_COLLISION` при совпадении tabId у разных instance (`:288-317`); `LockFence` token/epoch/expiry, `valid()/assertValid()`, поздний renewal не воскрешает lease (`:426-454`); `drainOutbox` проверяет fence до/после `send` и перед `markOutboxSent` (`outboxStore.ts:1109-1142`). Тесты `locks.test.ts:343-520`, `outbox.test.ts:702-732`. Остаток: F4 обязан вызывать `fence.assertValid()` в новых путях (P1-06 residual), fallback остаётся `isSecurityBoundary=false`. |
| **P1-07** | Нормативная 50-байтовая AAD-раскладка + KAT + инъективность | **CLOSED в коде / OPEN нормативно** | `K_STORAGE_AAD_OFFSETS` и `K_STORAGE_AAD_BYTES=50` (`kStorage.ts:56-75`); `buildKStorageAad` отвергает nil UUID/zero session (`:121-165`), поэтому null-sentinel однозначен; KAT (AAD hex + ciphertext при фиксированных key/nonce) и transplant/tamper-тесты (`kStorage.test.ts:253-341`). **Но** раскладки и KAT нет в `docs/E2EE-SPEC.md` §2.3 (там только список полей, строка 257) и в `docs/E2EE-TEST-VECTORS.json`; `local_message_id` в AAD не входит (P2-01). Для G4 нормативная публикация обязательна. |

### P1-01R. Forged/stale prepared session commit — латентный nonce reuse (новый P1)

**Файл:** `frontend/src/e2ee/outbox/outboxStore.ts` (`prepareOutgoingMessage` →
`commitOutgoingMessage`), `frontend/src/e2ee/session/sessionStore.ts`
(`writeSessionRecord`).

**Дефект.** `writeSessionRecord` проверяет только
`existing.revision === mode.ifRevision` (`sessionStore.ts:529-533`), но не
`record.revision === mode.ifRevision`. `prepareSessionRecord` сохраняет
`revision` из переданного состояния (`:280-330`). Следовательно:

- prepared-запись, собранная из состояния rev 0, может быть закоммичена с
  `ifRevision` текущей ревизии 3 — CAS проходит, в `sessions` пишется
  **старое** состояние с rev 3 и counters из rev 0 (ratchet откатывается);
- два последовательных коммита с одним и тем же неadvanced state проходят,
  потому что outbox-ключи разные; одинаковый `header.n`/`DHs` при следующем
  send даст тот же `MK` → тот же AES-GCM nonce;
- `additionalSessions` (F4 WIP) также не сверяют `record.revision` с
  `extra.mode.ifRevision`; `commitOutgoingMessage` проверяет только
  chatId/deviceId/уникальность sessionId.

Дополнительно `commitOutgoingMessage` не сверяет `prepared.session.state.ns`
с `header.n` ни одного конверта, не требует монотонного роста counters и не
проверяет, что `envelope.session_id`/`sender_device_id`/`recipient_device_id`/
`chat_id` принадлежат этой сессии. `prepareOutboxEntry` проверяет только
количество конвертов (`outboxStore.ts:198-206`).

**Probe (вне репозитория, `/tmp/cr1b_probe.ts`, production-модули):**

```
PROBE-A first_commit: ns=0 header.n=0 revision=2
PROBE-A second_unadvanced_commit_accepted=true ns_after_second=0 outbox_rows=2 same_header=true
PROBE-B stale_prepared_commit_accepted=true ns_after_stale=0 revision=4 (was 3)
PROBE-C envelope_scope_check: envelope_sender=22222222-2222-4222-8222-222222222222
  session_device=99999999-9999-4999-8999-999999999999
  envelope_session=CQkJCQkJCQkJCQkJCQkJCQ session=AQEBAQEBAQEBAQEBAQEBAQ accepted_in_all_above=true
```

Probe A/B воспроизведены и на текущем дереве (после появления F4 WIP): проверка
`record.revision` в `writeSessionRecord` по-прежнему отсутствует.

**Риск.** Тот же класс, что P1-01 CR1: повтор nonce под одним `MK` (XOR
plaintext'ов, forgery) и/или откат ratchet-состояния с дублированием `MK`.
Требует ошибки/повторного использования prepared-объекта вызывающим, поэтому
это латентный P0, а не активный; но именно F4 будет вызывающим.

**Исправление (до F4 send):**

1. `writeSessionRecord`: для update требовать
   `record.revision === mode.ifRevision` (и `record.revision > 0`), иначе
   `SESSION_STATE_STALE`; для `create` — `record.revision === 0`.
2. `commitOutgoingMessage`: проверять `prepared.session.record.revision`/
   `prepared.session.state.revision` против `mode`; то же для каждого
   `additionalSessions[i]` против `extra.mode`.
3. Проверять, что для каждого конверта этой сессии `header.n === state.ns - 1`
   (send) и `state.ns` строго больше persisted `ns`; для receive — `nr`
   соответствует обработанному сообщению.
4. Проверять envelope scope: `session_id`, `chat_id`, `sender_device_id`,
   `recipient_device_id` против сессии/состояния; уникальность
   `recipient_device_id`; один `chat_id`/`sender_device_id` на сообщение.
5. Тесты: unadvanced state → отказ; stale prepared record с новым `ifRevision`
   → отказ; повторный commit того же prepared-объекта → отказ; additional
   session с чужим revision/envelope → отказ; `header.n` mismatch → отказ.

### P1-03. SPK TTL 30 дней vs 90-дневное окно — не закрыт

**Файлы:** `frontend/src/e2ee/constants.ts:59-61`,
`frontend/src/e2ee/session/prekeyStore.ts:317-398`,
`frontend/src/e2ee/device/prekeys.ts:160-187,392-398`,
`frontend/src/e2ee/device/sessionSpk.ts:19-35`,
`docs/E2EE-SPEC.md:569-581,1126`.

**Что сделано F3:** `spkId` добавлен в `SessionState`/`StoredSessionRecord`
(plaintext + sealed cross-check), `collectActiveSessionSpkIds()` собирает ids
существующих сессий, `preparePrekeyUpload`/`prepareDeviceRegistration`
передают их в `ensureSignedPrekey`. Для сессий без `spkId` возвращается
`undefined`, и ротация сохраняет полный `current + 2 / 90 дней`.

**Почему этого недостаточно:** `rotateSignedPrekey` удаляет запись, если
`!usedBySession && now - createdAt > min(SPK_TTL_MS, SPK_RETAIN_WINDOW_MS)`,
где `usedBySession` — только «есть сессия с этим `spk_id`». Prekey-сообщение
до успешной AEAD **сессии не создаёт** (§3.3.3: сессия/OPK сохраняются только
после AEAD). Значит, SPK, выданный в claim и использованный отправителем, но
ещё не доставленный/не расшифрованный, для ротации выглядит «unused» и
удаляется на 30-й день. Это ровно сценарий CR1: A получил SPK_B в день 0,
B офлайн, B открывает приложение в день 31 — `preparePrekeyUpload` может
ротировать SPK и удалить приватный ключ до обработки очереди; доставка в день
31–89 не расшифровывается (`SPK_DELETED`/reset), хотя §5.5 обещает 90 дней.

Дополнительно `candidateSet = [record, ...previous.slice(0, SPK_RETAIN_PRIVATE-1)]`
держит только 3 SPK; при ротации каждые ~30 дней SPK дня 0 уничтожается на
~60–62-й день, а не на 90-й. «Каждый ≥30 дней» тоже не гарантируется при
ручной ротации чаще 30 дней.

**Что нужно решить (spec + код):** либо (а) не удалять «unused» SPK раньше
90 дней, либо (б) хранить состояние «SPK выдан claim'ом и ещё может быть
нужен» (`claimed_spk_ids`/pending-prekey) и удалять только безопасные, либо
(в) увеличить `SPK_RETAIN_PRIVATE`/держать больше трёх при частой ротации.
`docs/E2EE-SPEC.md` строка 575 всё ещё говорит «TTL 30 дней», строка 1126 —
«90 дней»; это противоречие должно быть снято владельцем спеки до F4/G4.
Тест `prekeyStore.test.ts:183-205` нужно изменить вместе с решением; нужен
offline-тест 31/60/89 дней.

**Оценка:** P1-03 **не закрыт**; F3-отчёт («DONE») не подтверждается.

### P1-04. Account/device scope и logout cleanup — частично

**Файлы:** `frontend/src/e2ee/device/identity.ts:504-521`,
`frontend/src/e2ee/storage/kStorage.ts:55,214-284`,
`frontend/src/e2ee/storage/indexedDb.ts:26`,
`frontend/src/auth/storage.ts:154-169`, `frontend/src/auth/runtime.ts:65-69`.

**Что сделано:** `destroyDeviceIdentity()` одной транзакцией удаляет все
записи `keys` (identity + `K_storage` + pending registration/upload),
`prekeys` и `pins`; `clearDeviceE2eeAccountState` — алиас для logout-hook.
Пины запечатаны AAD с owner device/target user/target device; identity
привязывается к `userId` при создании (`assertIdentityUser`,
`identity.ts:349-358`), поэтому второй аккаунт не может молча
переиспользовать identity.

**Чего нет:**

1. **Production-вызова.** `clearRuntimeAuth()` → `clearAuthStorage()` чистит
   только `sessionStorage` (`krug.device.id`, OIDC-ключи), IndexedDB не
   трогает. `destroyDeviceIdentity`/`clearDeviceE2eeAccountState` в
   production-коде не вызываются (grep по `src`, вне тестов — пусто). F5
   обязан вызвать hook на logout/account switch/revoke; в текущем дереве
   P1-04-условие «на logout/account switch/revoke вызывать wipe» не выполнено.
2. **Неполный wipe.** `destroyDeviceIdentity` не очищает `sessions`, `outbox`,
   `localMessages` (комментарий `identity.ts:504-508` оставляет их F2F, но
   F2F их не очистил). После удаления `K_storage` старый ciphertext не
   расшифровывается, но остаётся в БД (bloat/остаточные метаданные) и
   `dhPrivateKey`-объекты в `sessions` живут до GC. Нет `deleteDatabase`/
   `clearAllE2eeState`; `destroyKStorage` удаляет только ключ.
3. **Нет user-scoped БД/ключа.** `DEFAULT_DATABASE_NAME='krug-e2ee'` и
   `k-storage:v1` единые; owner-маркера рядом с ключом нет; `loadOrCreateKStorage`
   принимает любой `ownerDeviceId`, `loadDeviceIdentity` не сверяет
   `identity.userId` с текущим аутентифицированным пользователем. Изоляция
   держится на AAD owner-device и на том, что F5 вызовет wipe; это не
   «скоупинг по user+device», которого требовал CR1.
4. **Нет теста двух аккаунтов** (и нет теста, что после wipe `sessions`/`outbox`/
   `localMessages` пусты или нечитаемы). `identity.test.ts:149-168` проверяет
   только keys/prekeys/pins/K_storage.

**Оценка:** P1-04 **частично**; F3-отчёт («DONE») не подтверждается.

### P1-02 / P1-05 / P1-06 / P1-07 — кратко

- **P1-02 CLOSED.** Ключ локальной копии включает chat/direction/sender и
  тег `c:`/`l:`; `lookupLocalCopy` возвращает только outgoing своего device;
  входящая peer-controlled копия не может ни выдать себя за исходящую, ни
  перезаписать её. Тесты `outbox.test.ts:580-700`.
- **P1-05 CLOSED (код).** Пины/`keyChange`/`modePin` запечатаны `K_storage`,
  AAD привязывает `(owner device, user, target device)` / `(owner device,
  chat)`; key-change persisted, пин не перезаписывается, `acceptKeyChange`
  только явный; TTL нет. Остаток — P2-17/P2-18.
- **P1-06 CLOSED.** v4 `tabId` + `instanceId` → `LOCK_TAB_ID_COLLISION`
  fail-closed; `LockFence` проверяет token/expiry; поздний renewal не
  воскрешает lease; `drainOutbox` fail-closed при потере lease. Тесты
  `locks.test.ts:343-520`, `outbox.test.ts:702-732`.
- **P1-07 CLOSED в коде / OPEN в нормативке.** 50 B, offsets, nil-reject,
  KAT + transplant-тест; независимый пересчёт AAD/ciphertext совпал
  (`aad match True`, `ct match True`). Но `docs/E2EE-SPEC.md` §2.3 не
  описывает байтовую раскладку (строка 257 — только список полей), а
  `docs/E2EE-TEST-VECTORS.json` не содержит KAT. `local_message_id` в AAD
  отсутствует (P2-01); для G4 это должно быть либо добавлено, либо явно
  объявлено связанным через storage key + sealed payload.

## P2

Статусы CR1-P2 сохранены; ниже — остатки и новые пункты. P2 не блокируют
начало F4, но перечисленные «F4/F5»-пункты должны быть закрыты до G4.

| ID | Тема | Статус | Комментарий |
|---|---|---|---|
| P2-01 | nil/absent AAD и `local_message_id` | **частично** | nil UUID/zero session теперь отвергаются, null-sentinel однозначен. `local_message_id` по-прежнему не в AAD; связывание — через storage key + sealed payload cross-check (`outboxStore.ts:978-1044`). Для AAD-only доверия остаётся gap. |
| P2-02 | Duplicate/чужие envelopes до commit | **OPEN** | `normalizeEnvelopes` проверяет только count (`outboxStore.ts:198-206`); `prepareOutboxEntry` не сверяет `session_id`/`chat_id`/`sender_device_id`/`recipient_device_id` с сессией и не отвергает дубли. Probe C: конверт с чужим session/sender принят. F4 WIP добавляет проверку для `additionalSessions`, но не для primary. |
| P2-03 | Incoming commit без session state; OPK delete до expiry-check | **OPEN** | `prepareIncomingMessage`/`commitIncomingMessage` допускают `sessionState = null` (`outboxStore.ts:506-587`); успешный AEAD без state сохранит copy/OPK, ratchet не сдвинется. `consumeOneTimePrekeyInTransaction` ставит delete до проверки `now > expiresAt` (`prekeyStore.ts:218-240`); в `commitIncomingMessage` throw отменяет транзакцию, но API допускает ловлю/commit. |
| P2-04 | `loadSession` не сверяет requested id; plaintext peer-поля не аутентифицированы | **OPEN** | `loadSession` берёт запись по ключу и не проверяет `record.sessionId === sessionId` (`sessionStore.ts:429-438`); peer/chat/routing-поля не входят в sealed secrets. F4 WIP `trust.ts` сверяет peer keys с bundle/pin, что смягчает, но store-level проверки id нет. |
| P2-05 | `decodeHeader`/`parseAd` без range-check | **OPEN** | `n`/`pn` читаются `readU32be` без `MAX_HEADER_COUNTER`; `sender/recipient_key_generation` — без `1..2^31-1` (`header.ts:44-58`, `ad.ts:99-110`). `encodeHeader`/`buildAd` такие значения отвергают. |
| P2-06 | `assertPrivateKey`/`assertSecretKey` без algorithm/usages | **OPEN** | Проверяются type/extractable, но не `algorithm.name`/`usages` (`keyGuards.ts`). OPK/SPK/session могут принять Ed25519/RSA/ECDSA private; F4 упадёт позже. |
| P2-07 | Outbox lifecycle | **OPEN** | `markOutboxFailed` переводит `superseded` в `failed` (`outboxStore.ts:861-881`), после чего `retryOutboxEntry` может переотправить superseded сообщение; local copy payload `serverMessageId` остаётся null после `markOutboxSent` (`:825-859`); одна corrupt pending-запись рушит `drainOutbox`; нет TTL/attempt cap. |
| P2-08 | Неполное уничтожение/wipe | **OPEN** | `destroyKStorage` — только ключ; `destroyDeviceIdentity` — keys/prekeys/pins; `sessions`/`outbox`/`localMessages` и `deleteDatabase` не затронуты; production-вызова нет. |
| P2-09 | Тестовые пробелы | **OPEN** | Нет: low-order X25519; forged/stale prepared commit (P1-01R); duplicate/mixed envelope (Probe C); logout/два аккаунта; offline SPK 31/60/89; `loadSession` id; реальный браузер/kill-tab. KAT `K_storage` живёт в тесте, не в нормативном JSON. |
| P2-10 | Документы/векторы: нижняя граница ciphertext | **OPEN** | `docs/E2EE-TEST-VECTORS.json:202` — «decoded 16..33040»; спека/клиент — 272..33040 (`E2EE-SPEC.md:744,934`, `outboxStore.ts:52-53`). Conformance может принять 16..271. |
| P2-11 | `ciphertexts[]` в local copy | **OPEN** | Массив до 9 конвертов, не сверяется с `envelopes`; вопрос UI/размера после `sent` (§3.4.6 говорит в единственном числе). F4 WIP может изменить; вне scope. |
| P2-12 | Канонический lower-case UUID / неполная bundle-валидация | **частично** | F3 усилил `decodePrekeyBundle`/claim validation; `isUuid` по-прежнему только lower-case (`bytes.ts:9-10,123-133`) — upper-case UUID от сервера будет отвергнут. |
| P2-13 | Zeroization | **OPEN** | Seed/JWK/AEAD-raw остаются в JS-памяти; нормативно best-effort; F4 должен обнулять производные буферы после AEAD и не логировать. |
| P2-14 | `security:check` pattern-based | **OPEN** | Не ловит `globalThis['console']`, Worker/importScripts, `postMessage` с секретами; `console.`-правило действует только в `src/e2ee/`, а новый `src/api/e2eeDeviceApi.ts` — вне него (сети там разрешены by design, логов нет). |
| P2-15 | `drainOutbox` держит `krug-outbox` на время сети | **OPEN** | `drainOutbox` вызывает `send` внутри `withLock` (`outboxStore.ts:1109-1142`); медленный/зависший send блокирует outbox другого таба. F5 — короткий timeout/abort, не держать lock на backoff. |
| **P2-16** | F2F outbox был pairwise-only при fan-out до 9 | **F4 WIP** | На снимке F2F `OutgoingMessageDraft.sessionState` — один state, commit пишет одну сессию, хотя envelopes до 10. F4 WIP добавил `additionalSessionStates` (`outboxStore.ts:452-600`); это изменение F2F-API после CR1b и **вне scope** этого ревью. Для F4: каждый additional session должен иметь свой `mode.ifRevision`/`record.revision` и envelope scope (сейчас `assertAdditionalSessionDraft` проверяет chat/device/session/recipient, но не revision). |
| **P2-17** | `acceptKeyChange` не связан с `observed` | **NEW** | `acceptKeyChange(bundle)` перезаписывает пин любым переданным `VerifiedClaimedBundle`, не сверяя его с сохранённым `key-change.observed` (`pins.ts:361-392` в F3-снимке). Если сервер сменит ключ ещё раз между warning и «Принять», UI примет новый ключ, которого пользователь не видел. Нужно принимать ровно `observed` (или требовать equality) и иначе сохранять/обновлять key-change. |
| **P2-18** | AAD-слоты пинов не нормативны | **NEW/`[OPEN]`** | `pinAad` кладёт target device в слот `session_id` и target user — в `client_message_id` (`pinStore.ts:74-93`); это использует 50-байтовую раскладку как opaque scope. Crypto-review должен подтвердить трактовку и зафиксировать её в спеке/local record version; иначе другой клиент прочитает иначе. |
| **P2-19** | `collectActiveSessionSpkIds` fallback `undefined` | **NEW** | При любой legacy-сессии без `spkId` ротация сохраняет полный `current+2/90d` для всех; безопасно, но скрывает, что 30-дневный TTL не работает, и маскирует P1-03. Нужен явный учёт claimed SPK, а не «undefined = не удалять». |
| **P2-20** | `ensureOneTimePrekeys` возвращает stale `available` | **NEW** | Возвращает `available + created.length`, где `available` посчитан до транзакции; при гонке двух табов метрика/план может завышать остаток (`prekeys.ts:207-252`). Не security; исправить при F5-метриках. |
| **P2-21** | `evaluateChatMode`/`pinChatMode` можно обойти при неверном F5-вызове | **NEW** | `pinChatMode` публично позволяет записать `MANAGED` с `confirmedByUser:true` без проверки evidence (`modePin.ts:100-130`); политика держится на том, что F5 использует `evaluateChatMode`/`confirmManagedChatMode` и гейтит по `action`, а не по наличию пина. Зафиксировать в F5-контракте и тесте. |

## Проверки

### Полный прогон (снимок 12:11, F3/F2F)

```bash
cd frontend && npm run check
# EXIT 0
# lint                     ok
# format:check             ok
# contract:check           33 operations, 58 schemas, types in sync
# stickers:check           ok
# security:check           168 files, no XSS/localStorage/token logs/E2EE console/Math.random/network
# vitest                   46 files / 490 tests passed
# tsc --noEmit             clean
# vite build               331 modules

cd frontend && npx vitest run src/e2ee
# 22 files / 282 tests passed
```

Артефакт `frontend/dist/` пересобран штатным build; исходники не менялись.
После 12:15 дерево изменилось (F4 WIP) — повторный полный прогон на движущемся
дереве не выполнялся и не может считаться CR1b-прогоном; его должен сделать
владелец F4 после завершения.

### Независимый KAT

Векторы читались напрямую из `docs/E2EE-TEST-VECTORS.json`; авторский
`src/e2ee/test/vectors.ts` и production-код не импортировались. Верификатор —
`/tmp/verify_e2ee_cr1b.py` (Python 3, `cryptography` 49.0.0), в репозиторий не
добавлялся.

| Секция | Векторы | Что сверено независимо | Результат |
|---|---|---|---|
| A-primitives | A1–A4 | RFC 7748 §6.1 X25519, RFC 8032 §7.1 Ed25519, RFC 5869 TC1 HKDF, NIST CAVP AES-256-GCM | 4/4 |
| B-x3dh | B1–B5 | DH1..DH4/IKM/SK/SID (4-DH и 3-DH), SPK-подпись, 323-байтовый preamble + SHA-256 + подпись, 88-байтовый IKB | 5/5 |
| C-kdf | C1–C3 | session-id HKDF, KDF_RK, три KDF_CK | 3/3 |
| D-aead | D1–D3 | framing/padding 256, `K_enc`/`N` из MK, ciphertext/decrypt | 3/3 |
| F-envelope | F1–F2 | canonical JSON байт-в-байт (1310/756 B), preamble/AD/header/ciphertext, prekey signature, F2 == E1 m2 AEAD | 2/2 |
| G-verification | G1–G4 | fingerprint G1 (Alice; Bob-ключей в inputs нет), safety number (D_SN/u8/u32/entries, SHA-512, mod 10^60), G3, VH v2 | 4/4 |

**Итог: `checks=82 ok=82 fail=0`.** E1/E2 (stateful Double Ratchet) независимо
не переписывались; они покрыты авторским `ratchet.test.ts` и KAT-сьютом 24/24.

`K_storage` KAT пересчитан независимо: AAD 50 B из
`device UUID || 0x22×16 || client UUID || 0x01 || 0x01` совпал с заявленным hex;
AES-256-GCM с фиксированными key/nonce/plaintext дал ровно заявленный
`ct||tag`, decrypt round-trip — true; nil UUID кодируется в 16 нулей, т.е.
zero-sentinel требует reject'а — код его делает.

### Независимые probe (вне workspace)

`/tmp/cr1b_probe.ts` (vite-node, production-модули, memory storage) — результаты
в P1-01R:

- `second_unadvanced_commit_accepted=true`, `ns=0`, два outbox-ряда с одинаковым
  `header` — store не требует сдвига counters;
- `stale_prepared_commit_accepted=true`: состояние перезаписано prepared-
  состоянием rev 0, `revision` вырос (3→4) — `record.revision` не сверяется
  с `ifRevision`;
- envelope с чужим `session_id`/`sender_device_id` принят — scope конвертов не
  проверяется (P2-02).

Probe воспроизведён на снимке и на текущем дереве (после F4 WIP).

### Негативные проверки, покрытые тестами

Проверено авторскими тестами: non-canonical b64u, неизвестные поля, `v=2`,
self-envelope, границы ciphertext 272/33040/form guard, partial prekey/OPK,
AD/ciphertext/preamble tamper, padding/body-length/content-type/bidi/C0/C1/
`attachment_refs`, `KEY_STORAGE_UNAVAILABLE`, отсутствие WebCrypto, extractable
private key, stale revision, повторный OPK, повторный commit, corrupt session/
outbox, отсутствие plaintext/root/chain в dump, multi-tab CAS, sessionless
prepare/commit, cross-wired state, local-copy direction/scope tamper, duplicate
`tabId`, expired lease, nil UUID/zero session AAD, transplant local-copy
ciphertext, sealed pin scope/tamper/missing-key, `spkId` retention, mode
downgrade.

**Чего нет:** см. P2-09 (low-order X25519, forged/stale prepared record,
duplicate/mixed envelopes, logout/два аккаунта, offline SPK 31/60/89,
`loadSession` id, реальный браузер/kill-tab).

### Ограничения ревью

- Нет реальных браузеров: `fake-indexeddb`/jsdom, Node 24; Safari/Firefox
  quirks, background timer throttling, IndexedDB durability — F7/G4.
- F4 WIP-файлы появились после снимка и **не** проверялись как F4; выводы по
  send/receive/TOFU-order/reset — из F2/F3 API и спеки.
- Внешний crypto-review G4 не проводился; этот документ — client review, не
  замена G4.
- Line-reference — по снимку 12:11; после F4 WIP нумерация в
  `outboxStore.ts`/`sessionStore.ts`/`pins.ts` сдвинулась, поэтому для этих
  файлов важнее имена функций, чем номера строк.

## Условия GO для F4

F4 можно **начинать в коде** при выключенном `krug.e2ee.enabled`, но F4 не
считается DONE, а E2EE не включается, пока не выполнены все пункты:

1. **P1-01R (nonce reuse).** `writeSessionRecord` требует
   `record.revision === mode.ifRevision` (update) / `record.revision === 0`
   (create); `commitOutgoingMessage` сверяет revision/mode для primary и
   каждого `additionalSession`; проверяет `header.n === state.ns - 1` для
   каждого конверта сессии и монотонный рост counters; отвергает envelope с
   чужим `session_id`/`chat_id`/`sender_device_id`/`recipient_device_id`.
   Тесты: unadvanced state, stale prepared record с новым `ifRevision`,
   повторный commit, additional session mismatch, header.n mismatch.
2. **P1-03 (SPK retention).** Решение спеки: 90-дневное окно для
   potentially-claimed SPK или явный учёт `claimed_spk`/pending-prekey;
   `rotateSignedPrekey` не удаляет SPK раньше 90 дней (или пока он может быть
   нужен); при ротации чаще 30 дней держать достаточно SPK, чтобы каждый жил
   ≥30 дней. Тесты: prekey-сообщение дня 31/60/89 расшифровывается, дня 90+
   — `SPK_DELETED`+reset; ни один SPK не удалён раньше 30 дней. Обновить
   `prekeyStore.test.ts:183-205` и spec §3.4.5.1/§5.5.
3. **P1-04 (logout/account).** F5 обязан вызывать
   `clearDeviceE2eeAccountState()` на logout/account switch/revoke; helper
   должен очищать **все** сторы (`sessions`, `outbox`, `localMessages`,
   `pins`, `prekeys`, `keys`) и/или удалять БД, а не только keys/prekeys/pins.
   F4-чтение должно принимать текущий `userId` и проверять
   `identity.userId`/owner до `loadSession`/`readPin`/outbox; при mismatch —
   fail closed, без «тихого» чтения. Тест: два аккаунта в одном профиле —
   записи A не читаются B, после wipe все сторы пусты/нечитаемы.
4. **P1-07 (нормативно).** Добавить в `docs/E2EE-SPEC.md` §2.3 точную
   50-байтовую раскладку (offsets, endianness, presence/`0×16`, record types,
   `LOCAL_RECORD_VERSION`) и KAT (AAD hex + ciphertext при фиксированном
   nonce) в `docs/E2EE-TEST-VECTORS.json`; либо принять v2 AAD с
   `local_message_id`/record key. До этого G4 не закрывать.
5. **P1-05 (TOFU order + accept).** F4 обязан: проверить preamble signature,
   `prekey.sender_identity_*` vs bundle/`auth.devices`, binding, собственные
   IK, `spk`/`opk`, `session_id`/chat/devices, TOFU pin — **до** создания
   сессии/расхода OPK/отображения; пин писать после проверок и до сессии;
   `acceptKeyChange` связывать с сохранённым `observed` (P2-17). Без
   `localIdentity` self-проверка не считается выполненной.
6. **F4 protocol checklist.** Свежий `DHs_A` (не EK/IK/SPK); собственные IK
   из локальной identity (P0-2b 3a); `key_generation`; OPK расходуется только
   после успешного AEAD в одной транзакции с state+copy; session_id/chat/
   devices; несколько сессий §5.7 (tie-break, удаление проигравшей после
   подтверждения); R-15 reset с `failed_chain_dh`/`failed_n`/
   `retry_of_client_message_id`; никакого self-envelope.
7. **F2 API-инварианты.** `prepareIncomingMessage`/`commitIncomingMessage`
   вызывать с `sessionState` (или сделать state обязательным для успешного
   decrypt); `prepareOutgoingMessage` — только с состоянием, полученным из
   зашифрованного шага; `fence.assertValid()` внутри session/outbox lock
   перед мутацией; `spkId` заполнять при создании prekey-сессии.
8. **Envelope validation до commit.** Уникальные `recipient_device_id`, один
   `chat_id`/`sender_device_id` на сообщение, `session_id` соответствует
   сессии, `ciphertexts` соответствуют `envelopes`; duplicate/mixed → типичная
   ошибка до записи (P2-02/P2-11).
9. **No plaintext.** Никаких plaintext/ключей в логах, ошибках, outbox
   metadata; local copy/пины только sealed; `security:check` остаётся
   обязательным; API-адаптер — единственное сетевое место, без тела/ключей в
   `message`/`cause`-логах.
10. **Tests.** F4: multi-device fan-out (9 конвертов) с атомарным commit всех
    сессий; crash/replay; два таба/expired lease; offline prekey 31/60/89;
    forged/stale prepared record; envelope scope; TOFU first/mismatch;
    reset L3/L3b; cross-account wipe. Не допускать падения 490+ тестов и
    KAT 24/24; KAT — в CI.
11. **Flag.** `krug.e2ee.enabled` остаётся `false` до закрытия P1 и внешнего
    G4; F4 не подключает UI/флаг и не меняет контракты без I-01.
12. **G4/F7.** Внешний crypto-review + реальные браузеры (Chrome/Firefox/
    Safari), kill-tab, IndexedDB durability, background locks, E2E двух
    устройств — до включения.

## Вопросы

1. **P1-03:** принимаем 90-дневное хранение potentially-claimed SPK или вводим
   `claimed_spk`/pending-prekey state? Кто владелец spec-правки §3.4.5.1/§5.5
   и теста 31/60/89? Без этого F4 receive будет периодически получать
   `SPK_DELETED` на легитимных сообщениях.
2. **P1-01R:** можно ли требовать `record.revision === mode.ifRevision` без
   ломки legitimate retry? Есть ли сценарий, где F4 намеренно переиспользует
   prepared-объект с более новым `ifRevision`? Если да — нужен явный
   `reprepare`, а не тихий CAS.
3. **Multi-session (P2-16):** F4 WIP добавил `additionalSessionStates` после
   CR1b-снимка. Это согласовано с PM? Какие инварианты (revision, envelope
   scope, rollback при ошибке одной сессии) обязательны, чтобы fan-out не
   стал новым nonce-reuse путём?
4. **P1-04:** кто вызывает `clearDeviceE2eeAccountState` — F5 на OIDC logout
   или store-level hook? Удаляем всю БД `krug-e2ee` или чистим сторы (другие
   табы/чужие данные)? Нужен ли owner-маркер рядом с `k-storage:v1`, или AAD
   owner-device считается достаточным?
5. **P1-07:** фиксируем 50 B + связывание `local_message_id` через key/sealed
   payload или переходим на AAD v2 (presence + `local_message_id`,
   `LOCAL_RECORD_VERSION=2`)? Когда KAT переезжает в
   `docs/E2EE-TEST-VECTORS.json`?
6. **P2-17:** `acceptKeyChange` должен принимать только `key-change.observed`
   или разрешать «свежий» bundle с повторным warning? Кто владелец UI-текста
   «ключ изменился ещё раз»?
7. **P2-18:** трактовка AAD-слотов пинов (target device в `session_id`,
   user в `client_message_id`) утверждается как local v1? Нужна ли отдельная
   версия записи/строка в спеке, чтобы G4 мог проверить формат?
8. **P2-04:** `loadSession` должен сверять `record.sessionId === sessionId` и
   включать peer/chat-поля в sealed secrets — в F4 или отдельным F2-фиксом?
   Сейчас безопасность держится на F4 `trust.ts`, а не на store.
9. **P2-02/P2-03:** делаем `sessionState` обязательным и для incoming, а
   duplicate/scope-envelope — ошибкой до commit? Это меняет F2 API; нужно
   согласование с F4/F5.
10. **G4 scope:** достаточно ли client KAT + этот review, или нужен отдельный
    pentest WebCrypto/IndexedDB/Safari quirks до включения флага?

---

**Итог.** F1/F2-ядро и F2F-инварианты в основном состоятельны: P1-02/P1-06
закрыты, P1-05/P1-07 закрыты в коде, KAT независимо сходится. Но F3-отчёт
преждевременно объявляет P1-03/P1-04 закрытыми, а F2F не закрывает
nonce-reuse-инвариант для forged/stale prepared state. E2EE включать нельзя;
F4 — только с условиями выше, флаг остаётся `false`.

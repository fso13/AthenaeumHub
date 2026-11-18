# E7-CR1 — независимый client crypto review E7-F1/F2

> **Рецензент:** независимый crypto/security-ревьюер; в подготовке E7-F1/F2 не участвовал.
> **Дата:** 2026-11-17. **Вход:** `frontend/E7-F1-REPORT.md`, `frontend/E7-F2-REPORT.md`,
> `frontend/src/e2ee/**`, `docs/E2EE-SPEC.md` §1–§5 (плюс §7–§8 для проверок),
> `docs/E2EE-TEST-VECTORS.json` (v4), `docs/E2EE-SPIKE-NOTES.md`,
> `frontend/scripts/check-security.mjs`.
> **Зона:** создан только этот файл. Код, контракты, спека, векторы и `docs/TASKS*`
> не изменялись. Git-репозитория в workspace нет; проверялось фактическое дерево.
> **Метод:** чтение production-кода и тестов; **два независимых верификатора**
> (Python `cryptography` и Node `node:crypto`), не использующие авторский
> `src/e2ee/test/vectors.ts`; полный `npm run check`; два временных probe вне
> workspace (`/tmp`, в репозиторий не добавлялись) для проверки API-инвариантов.
>
> **Граница снимка:** во время ревью в дереве параллельно появились файлы
> E7-F3 (`frontend/src/e2ee/device/**`, ~11:42–11:47). Они **вне scope**
> этого F1/F2-ревью и не проверялись как F3; их наличие учтено только там,
> где оно меняет вывод о F2 (P1-05). Все line-reference ниже — для F1/F2
> файлов; F3-файлы могут меняться независимо.

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**GO WITH CONDITIONS.**

F1 как крипто-ядро состоятелен: 24 нормативных вектора воспроизводятся побайтово
независимо от авторского loader'а; WebCrypto-примитивы, domain separation,
AD/preamble/envelope-кодеки и safety number реализованы аккуратно, негативные
проверки каноничности/длин/полей присутствуют. F2 даёт рабочую атомарную
multi-store модель, crash/replay-матрицу, OPK consume-once, CAS на сессиях и
Web Locks; на F1/F2-снимке полный `npm run check` зелёный (39 файлов /
362 теста; 16 файлов / 182 E2EE-теста).

При этом **в F2 есть несколько неблокирующих сейчас, но обязательных до G4
инвариантов**, которые нельзя оставлять на «F5/F4 потом»:

1. outbox API допускает commit **без session state** — латентный AES-GCM
   nonce reuse (P1-01);
2. локальная копия имеет общее пространство ключей для входящих/исходящих
   сообщений и не скоупится по чату — peer-controlled `client_message_id`
   может подменить/заблокировать свою копию (P1-02);
3. `SPK_TTL=30 дней` для «записи без сессий» противоречит обещанному
   `SPK_RETAIN_WINDOW=90 дней` для prekey-сообщений (P1-03);
4. `K_storage`/IndexedDB не скоупятся по аккаунту и не уничтожаются при
   logout/смене аккаунта; один браузерный профиль может сохранить доступ
   второго аккаунта к секретам первого (P1-04);
5. TOFU-пины в F2 не реализованы, а `pins` store не имеет ни sealed-типа,
   ни AAD-полей; F4 может реализовать их только с ad-hoc расширением (P1-05);
6. BroadcastChannel-fallback не является fencing-механизмом, а его
   `tabId` может совпасть у двух вкладок; F4/F5 не должны считать его
   гарантией одного writer'а (P1-06);
7. байтовая раскладка AAD `K_storage` не нормативна, не имеет KAT и имеет
   неинъективный zero-sentinel; до G4 нужна спека + вектор (P1-07).

**P0 нет.** P1-01 — «латентный P0»: как только F5/F4 начнут вызывать
`commitOutgoingMessage` без session state, это станет прямой крипто-ошибкой.
До включения E2EE (флаг остаётся `false`) и до закрытия условий G4 включать
E2EE нельзя.

## P0

**Открытых P0 нет.**

- Приватные ключи в production-пути создаются non-extractable
  (`generateX25519KeyPair`/`generateEd25519KeyPair`), `K_storage` — non-extractable
  AES-256-GCM; сетевых вызовов, `localStorage`, `console.*` и `Math.random`
  в `src/e2ee/**` нет на F1/F2-снимке (`security:check` — 150 файлов).
- Ни один текущий production-вызов не выполняет send/decrypt, поэтому
  sessionless-commit и local-copy collision пока не эксплуатируются. Это
  меняется в F4/F5; см. P1-01/P1-02.
- KAT и негативные тесты не выявили ни одного расхождения в байтах
  (см. «Проверки»).

## P1

### P1-01. Commit outbox без session state — латентный AES-GCM nonce reuse

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:81-87` (optional
`sessionState`), `:369-371` (prepare возвращает `session:null`), `:379-407`
(commit принимает `prepared.session === null`). Комментарий `:82-83` прямо
разрешает `null` «only for test/repair flows», но runtime-guard'а нет.

**Сценарий:** F5 (или F4 при первом send) вызывает
`prepareOutgoingMessage({sessionState: null, ...})` — например, в «repair»
ветке, после ошибки загрузки состояния или при неверном ветвлении. Сообщение
шифруется с `MK_n`, outbox + локальная копия коммитятся, но `writeSessionRecord`
не вызывается. Состояние сессии остаётся на `CKs/Ns`, из которых уже выведен
`MK_n`. Следующий send (после reload или из stale in-memory state) снова
выведет тот же `K_enc/N` и зашифрует другой plaintext. Для AES-GCM это
повтор nonce под тем же ключом: XOR двух plaintext'ов и возможность forgery.

**Риск:** катастрофическая потеря конфиденциальности/целостности AEAD
(латентный P0), а также тихая потеря сообщений.

**Исправление:** сделать `sessionState` обязательным для `TEXT_JSON`/
`SESSION_RESET` send; `commitOutgoingMessage` должен отвергать
`prepared.session === null` (отдельный `repair`-API без права send, либо
явный test-only флаг, который не компилируется в production-путь). Дополнительно
проверять `prepared.session.record.sessionId === prepared.outbox.sessionId`
и `chatId`, а также что `prepared.session.state.ns` соответствует
`header.n` хотя бы в F4-тесте.

**Тест:** `commitOutgoingMessage` с `sessionState:null` → типизированная
ошибка, outbox/local copy пусты; property-тест «каждая outbox-запись имеет
ровно один session revision»; попытка повторно закоммитить тот же
`MK`-сдвиг после abort — отвергается. Сейчас probe подтверждает обратное:
`PROBE1 sessionless_commit_accepted true`.

### P1-02. Локальная копия: коллизия ключей входящего/исходящего и отсутствие chat/direction scope

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:121-128`
(`localCopyStorageKey` = `local:<clientMessageId ?? localMessageId>`),
`:323-324` (prepare), `:832-844` (`lookupLocalCopy` проверяет только
`clientMessageId`); тип `LocalCopyPayloadV1`
(`frontend/src/e2ee/outbox/types.ts:69-83`) не содержит ограничения
направления/чата в ключе.

**Сценарий:** peer присылает сообщение с `client_message_id`, равным
`client_message_id` моего исходящего сообщения (значение приходит в
`Message.client_message_id` и видно участникам). Ключ входящей копии
`local:<id>` совпадает с ключом моей исходящей копии:
- если моя копия уже есть → `commitIncomingMessage` видит duplicate и
  отбрасывает входящее сообщение (тихая потеря/DoS);
- если входящая копия записалась первой → `lookupLocalCopy(id)` возвращает
  `{direction:'incoming', text:'...'}` как «свою» копию; UI, который доверяет
  результату lookup, покажет чужой текст под моим сообщением. Тот же эффект
  возможен между разными чатами: chat_id в ключе отсутствует.
- `commitOutgoingMessage` в такой ситуации получает `OUTBOX_CONFLICT` и
  блокирует отправку.

**Риск:** спуфинг авторства/подмена локальной истории, DoS собственных
отправок, кросс-чатовые коллизии.

**Исправление:** ключ локальной копии должен включать `chatId` и
`direction`, например `local:<chatId>:<direction>:<localMessageId>`; для
исходящих использовать сгенерированный `localMessageId`, а не
`clientMessageId`; `lookupLocalCopy` должен требовать `chatId`, проверять
`direction === 'outgoing'`, `stored.chatId` и `stored.sessionId`; входящая
копия не должна попадать в namespace исходящих.

**Тест:** создать входящую копию с тем же `client_message_id`, что и
исходящая (в том же и в другом чате), затем `lookupLocalCopy` → `available:false`
для исходящего lookup, обе записи независимы, commit исходящей не конфликтует;
повторный incoming с тем же id не теряется. Сейчас probe подтверждает
`PROBE2 lookup_available true direction incoming text attacker text`.

### P1-03. `SPK_TTL=30 дней` уничтожает prekey, который ещё нужен в 90-дневном окне

**Файл/строка:** `frontend/src/e2ee/constants.ts:58-62`
(`SPK_TTL_MS=30d`, `SPK_RETAIN_WINDOW_MS=90d`),
`frontend/src/e2ee/session/prekeyStore.ts:323-336` (TTL-опция),
`:366-378` (`unusedTooOld` → delete), `frontend/src/e2ee/session/types.ts:31-57`
(в session state нет `spk_id`); спека: `docs/E2EE-SPEC.md:569-575` (TTL 30 дней
для «записи без сессий»), `:1126` (prekey-сообщение расшифровывается в окне
90 дней), `:146` (`SPK_RETAIN_PRIVATE = 3`, каждый ≥30 дней).

**Сценарий:** A получает SPK_B, шифрует первое сообщение и уходит в офлайн.
У B ещё нет сессии — сессия создаётся только после успешного AEAD. B в день 31
ротирует SPK и передаёт `activeSessionSpkIds`, не содержащий этот SPK
(сессии-то нет). `rotateSignedPrekey` удаляет приватный SPK как
«неиспользуемый старше 30 дней». Сообщение доставляется в день 31–89:
расшифровка невозможна (`SPK_DELETED`/reset), хотя спека обещает 90-дневное
окно. При частой ротации (<30 дней) правило `current + 2` также удаляет SPK
раньше 30-дневного минимума.

**Риск:** потеря сообщений/истории, нарушение нормативного FS-окна P1-D;
R-15 reset не спасает, если отправитель уже не может перешифровать.

**Исправление:** не удалять «неиспользуемый» SPK раньше
`SPK_RETAIN_WINDOW` (90 дней); либо учитывать claim/pending-prekey состояние
(какие `spk_id` были выданы и для них ещё нет сессии) и удалять только
безопасные; при ротации чаще 30 дней временно держать больше трёх SPK, чтобы
каждый прожил ≥30 дней. Для корреляции нужен `spk_id` в session state
(local record v2) либо отдельный индекс «spk → sessions».

**Тест:** SPK создан в день 0, сессии нет, ротация в день 31 с пустым
`activeSessionSpkIds`; prekey-сообщение дня 60 должно расшифроваться,
дня 90+ — `SPK_DELETED`; проверить, что ни один SPK не удалён раньше 30 дней.
Существующий `frontend/src/e2ee/prekeyStore.test.ts:183-205` сейчас
закрепляет удаление на 30-й день — его нужно изменить вместе с решением.

### P1-04. `K_storage` и IndexedDB не изолированы по аккаунту и не уничтожаются при logout

**Файл/строка:** `frontend/src/e2ee/storage/indexedDb.ts:31` (единая БД
`krug-e2ee`), `frontend/src/e2ee/storage/kStorage.ts:45` (единый
`k-storage:v1`), `:171-241` (load/create не проверяет owner и не привязан к
профилю), `frontend/src/auth/storage.ts:140-169` (`clearAppStorage`/
`clearAuthStorage` чистит только `sessionStorage`, не IndexedDB),
`frontend/src/auth/runtime.ts:65-69` (logout → `clearAuthStorage`);
production-вызовов `destroyKStorage`/`destroyPrekeyMaterial` вне тестов нет.

**Сценарий:** пользователь A выходит, в том же браузерном профиле входит B.
База `krug-e2ee`, `K_storage`, сессии/outbox/local copy/pins остаются. В
`StoredSessionRecord` поля `deviceId`/`sessionId` лежат plaintext; B (или
любой same-origin JS после смены аккаунта) читает запись, вызывает
`loadOrCreateKStorage(storage, record.deviceId)` — ключ тот же, owner
подставлен из записи — и `loadSessionRecord` расшифровывает `RK/CK/skipped MK`
и локальные копии A. `clearAuthStorage` этого не предотвращает; удаление
`krug.device.id` из sessionStorage тоже, потому что deviceId есть в записи.

**Риск:** кросс-аккаунтная утечка секретов и истории; остаточные TOFU-пины
могут давать ложные key-change/DoS; нарушение ожидаемой приватности при
смене пользователя на общем устройстве.

**Исправление:** скоупить БД и ключ по `user_id` + `device_id` (например,
`krug-e2ee:<user_id>:<device_id>`, `k-storage:v1:<device_id>`), хранить
owner-маркер рядом с ключом и отвергать несовпадение; на logout/смене
аккаунта/revoke вызывать единый `destroyAllE2eeState()`: очистить все сторы,
удалить `K_storage`, закрыть БД (при необходимости `deleteDatabase`);
`loadOrCreateKStorage` не должен молча переиспользовать ключ другого
device/user.

**Тест:** два аккаунта в одном профиле: после switch записи A отсутствуют
или не расшифровываются новым `K_storage`; `destroyAll` даёт пустой dump всех
сторов и новый ключ при следующем `loadOrCreate`; ключ A не открывает
сессию B и наоборот.

### P1-05. TOFU/пины: в F2 нет реализации, а `pins` store не имеет sealed-типа и AAD

**Файл/строка:** `frontend/src/e2ee/storage/types.ts:17-24` (`pins` — только
имя стора), `frontend/src/e2ee/storage/kStorage.ts:48-54` (`RECORD_TYPES`:
session/outbox/localCopy; `pin` отсутствует), `:103-122` (AAD не содержит
`user_id`/`device_id` пина), `frontend/src/e2ee/session/sessionStore.ts:482-526`
(запись сессии не сверяет peer-ключи с пином), `frontend/src/e2ee/api/deviceKeys.ts:117-149`
(комментарий: проверка — F4).

**Сценарий:** F4 реализует TOFU. Если пин лежит в `pins` plaintext, локальный
writer/скрипт может удалить или подменить пин → следующий контакт становится
«первым», и подмена ключей проходит (`KEY_CHANGE_DETECTED` не срабатывает).
Если F4 захочет запечатать пин через `K_storage`, текущий `record_type` не
позволяет этого без ad-hoc кода: `pin` не входит в `RECORD_TYPES`, AAD не
содержит `user_id`/`fingerprint`/`key_generation` пина.

**Наблюдение по параллельному F3 (вне scope):** появившийся в дереве
`frontend/src/e2ee/device/pins.ts` пишет пины напрямую в `pins`
(`storage.transact(['pins'])`, `:269-328`, `:372-394`), без `K_storage` и без
sealed-типа. Это подтверждает риск, а не закрывает его; полноценная проверка
F3 — отдельная задача. F2-вывод не меняется: в F1/F2 TOFU-пути нет, а
хранилище для него не подготовлено.

**Риск:** обход TOFU (локальная запись/компрометация профиля), расхождение
pins между устройствами, невозможность корректно реализовать P0-2 в F4.

**Исправление:** до F4 добавить `pin` record type (и версию локального
формата), AAD-поля `verifier?`/`user_id`/`device_id`/`key_generation`/
fingerprint-hash, API `getPin`/`putPin`/`comparePin`; пин писать **после**
проверок preamble/binding/TOFU, но **до** создания сессии/отображения; не
удалять автоматически по TTL. Для F2-скоупа достаточно зафиксировать это в
спеке и тестах, но не оставлять «решим в F4».

**Тест:** tamper/swap sealed pin → `KEY_STORAGE_UNAVAILABLE`; отсутствие
пина → первый контакт с `verified=false`; mismatch → `KEY_CHANGE_DETECTED`,
сессия/OPK/display не создаются; `pruneIdleSessions` не удаляет пин.

### P1-06. BroadcastChannel-fallback: совпадающие `tabId`, истечение lease и отсутствие fencing

**Файл/строка:** `frontend/src/e2ee/locks/locks.ts:90-95` (`defaultTabId` =
`tab-<Date.now>-<counter>`; counter у каждой вкладки свой),
`:430-433` (сообщения с тем же `tabId` игнорируются), `:328-349` (renewal
раз в `leaseMs/2`), `:555-596` (выбор fallback), `docs/E2EE-SPEC.md:611`
(фолбэк — leader election, не security boundary).

**Сценарий:** две вкладки открыты в одну миллисекунду → одинаковый
`defaultTabId`; каждая игнорирует `acquire/held` другой, обе считают себя
победителем. Либо вкладка уходит в background, таймеры throttled, lease
(5 с) истекает, и вторая вкладка входит в критическую секцию, пока первая
ещё выполняет `send`/receive. F4/F5 могут считать `withLock` гарантией одного
writer'а, но fallback её не даёт.

**Риск:** конкурентное движение ratchet/outbox, дубли отправки, потеря
обновлений или `OUTBOX_CONFLICT`; для receive — повторная расшифровка/дубли
local copy. CAS/revision и idempotency — вторая линия, но не все будущие
мутации обязаны их иметь.

**Исправление:** генерировать `tabId` через `crypto.randomUUID()`; либо
использовать Web Locks только для E2EE-mutation и **fail closed** (не
включать send/receive), если доступен только BroadcastChannel/local fallback;
для всех мутаций ввести fencing (revision/CAS для сессий, CAS/статус для
outbox, dedupe для local copy). Определить порядок локов (session → outbox,
не наоборот) и не держать `krug-outbox` на время сети дольше необходимого.

**Тест:** две вкладки с искусственно одинаковым `tabId` не входят в
критическую секцию одновременно (или fallback отключён); истечение lease
во время долгого body не даёт второму writer'у пройти без CAS-ошибки;
параллельный receive/outbox не создаёт дублей.

### P1-07. AAD `K_storage` не нормативен и не покрыт KAT; 50-байтовая раскладка не утверждена

**Файл/строка:** `frontend/src/e2ee/storage/kStorage.ts:11-19` (комментарий
«spec fixes the field list, not their byte encoding»), `:46`
(`K_STORAGE_AAD_BYTES=50`), `:103-122` (раскладка),
`docs/E2EE-SPEC.md:257` (спека перечисляет поля, но не кодирование),
`frontend/src/e2ee/kStorage.test.ts:81-137` (только length/field-binding,
не байтовый KAT).

**Сценарий:** реализация выбирает `device(16) || session(16) || client(16) ||
type(u8) || version(u8)`. Другой клиент/следующая версия может выбрать иной
порядок/наличие; G4 не может проверить «правильность» раскладки, потому что
её нет в спеке. Zero-sentinel неинъективен (см. P2-01), а `local_message_id`
в AAD не входит.

**Риск:** at-rest integrity/record transplantation, расхождение реализаций
при миграции, невозможность внешнего crypto-review подтвердить формат;
блокирует G4.

**Исправление:** нормативно описать раскладку в `docs/E2EE-SPEC.md` §2.3
(порядок, endianness, presence-биты/`0×16`, version, record identity), добавить
**KAT** для `K_storage` (AAD hex + ciphertext при фиксированном nonce,
test-only) в `docs/E2EE-TEST-VECTORS.json`; при изменении раскладки — новый
local record version (не wire). Включить в AAD `local_message_id` или
record key и/или запретить nil UUID как sentinel.

**Тест:** точный 50-байтовый AAD hex для набора `(device, session, client,
type, version)`; ciphertext round-trip с детерминированным nonce; nil/absent
collision должна отвергаться; transplant ciphertext между записями с разными
`local_message_id` — отвергается.

## P2

### P2-01. Zero-sentinel AAD: `null` и nil UUID кодируются одинаково; `local_message_id` не связан

**Файл/строка:** `frontend/src/e2ee/storage/kStorage.ts:94-101` (`null` →
`0×16`), `:112-114` (nil UUID проходит `requireUuid`),
`frontend/src/e2ee/encoding/bytes.ts:123-133` (`isUuid` принимает nil).
**Сценарий:** локальная копия с `clientMessageId=null` и копия с
`clientMessageId=00000000-0000-0000-0000-000000000000` в одной сессии дают
одинаковый AAD; для `localCopy` с null id все входящие сообщения сессии
имеют одинаковый AAD (нет `localMessageId`). Текущий `decryptLocalCopy`
ловит подмену по sealed `localMessageId`, но AAD сам по себе не обеспечивает
domain separation.
**Риск:** при будущем чтении, доверяющем только AAD, — ciphertext transplant/
malleability; сейчас — defense-in-depth gap.
**Исправление:** presence-байт для каждого optional id (или TLV), включить
`local_message_id`; запретить nil UUID для `client_message_id`; версия
локального формата.
**Тест:** AAD для null и nil различаются; transplant между двумя incoming
local copy с null client id отвергается без опоры на plaintext-метаданные.

### P2-02. Дубли `recipient_device_id` и несогласованные конверты принимаются до commit

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:165-173`
(`normalizeEnvelopes` проверяет только count), `:234-238`
(`recipientDeviceIds` дедуплицирует, но `envelopes` остаются с дублями).
**Сценарий:** F5 строит fan-out с двумя конвертами одному устройству;
commit двигает сессию, сервер отвечает `422 DUPLICATE_ENVELOPE`; outbox
`failed` с уже сдвинутым ratchet — сообщение нельзя перешифровать теми же
байтами, повтор всегда 422. Аналогично смешанные `chat_id`/`sender_device_id`
в `envelopes`.
**Риск:** застревание сообщения/сессии, потеря отправки.
**Исправление:** отвергать дубли `recipient_device_id` и разные
`chat_id`/`sender_device_id` в `normalizeEnvelopes` до commit; сверять
`envelopes` с draft/session.
**Тест:** duplicate envelope → типизированная ошибка до записи; outbox/state
не изменены; mixed chat → ошибка.

### P2-03. Incoming commit без session state; OPK delete staged до expiry-check

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:414-437` (optional
`sessionState`), `:444-479` (commit без state), `frontend/src/e2ee/session/prekeyStore.ts:218-235`
(delete ставится в staging до проверки `now > expiresAt`).
**Сценарий:** успешный AEAD, но `prepareIncomingMessage` вызван без
`sessionState` (или с null) → plaintext copy + OPK consumed, ratchet state не
сохранён; следующее сообщение цепочки не расшифровывается/дублируется.
`consumeOneTimePrekeyInTransaction` при истёкшем OPK ставит delete, затем
бросает; если вызывающий body поймает ошибку и закоммитит транзакцию, OPK
исчезнет, хотя AEAD не прошёл.
**Риск:** потеря/дубли сообщений, нарушение «OPK не расходуется при ошибке»
в нестандартном caller'е.
**Исправление:** требовать `sessionState` для успешного decrypt; проверять
expiry **до** staging delete; документировать, что ошибка обязана abort'ить
транзакцию, или возвращать результат без throw.
**Тест:** incoming без state → ошибка до commit; expired OPK в body, который
ловит ошибку и коммитит, не удаляет OPK (или API не позволяет это);
successful decrypt всегда двигает revision.

### P2-04. `loadSession` не сверяет record с запрошенным `session_id`; plaintext peer-поля не аутентифицированы

**Файл/строка:** `frontend/src/e2ee/session/sessionStore.ts:402-411`
(`loadSession` берёт запись по ключу и не проверяет `record.sessionId`),
`:312-400` (сверяются только sessionId/deviceId/ns/nr/pn/dhPublicKey;
`peerIkSig/Dh`, `chatId`, `peerUserId`, `peerDeviceId`, `dhRemote`,
`localCopyRef`, timestamps не входят в sealed copy).
**Сценарий:** запись перемещена/подменена в IDB на другой ключ; F4 получает
state с чужим `sessionId`/peer; AEAD, скорее всего, упадёт (DoS), но код
может выбрать не ту сессию. Локальный writer может изменить peer-поля без
обнаружения на уровне store.
**Риск:** DoS/неверная сессия; TOFU-детект зависит от того, что F4 отдельно
сверит peer-ключи.
**Исправление:** проверять `record.sessionId === sessionId` в `loadSession`;
включить peer/chat/routing-поля в sealed-копию или подписывать их; F4 обязан
сверять `peerIkSig/Dh` с пином.
**Тест:** запись под чужим ключом → `KEY_STORAGE_UNAVAILABLE`; подмена
`peerDeviceId`/`chatId` обнаруживается.

### P2-05. `decodeHeader`/`parseAd` не проверяют диапазоны счётчиков/поколений

**Файл/строка:** `frontend/src/e2ee/protocol/header.ts:42-57`
(`readU32be`, нет `MAX_HEADER_COUNTER`), `frontend/src/e2ee/protocol/ad.ts:103-108`
(`readU32be`, нет `1..2^31-1`).
**Сценарий:** внутренний parser получает header/AD с `n=0x80000000` или
`key_generation=0`; `encodeHeader`/`buildAd` такие значения отвергают, но
`decodeHeader`/`parseAd` — нет. Если F4 использует parseAd для восстановления
AD/сравнения, оно примет вне-спечные значения.
**Риск:** расхождение с wire-валидацией, потенциальный обход инвариантов
счётчиков.
**Исправление:** добавить range-check в `decodeHeader`/`parseAd` (те же
константы), как в `encodeHeader`/`buildAd`.
**Тест:** header/AD с `2^31` и `0` → `INVALID_HEADER`/`INVALID_ENVELOPE_FORMAT`.

### P2-06. `assertPrivateKey`/`assertSecretKey` не проверяют алгоритм и usages

**Файл/строка:** `frontend/src/e2ee/crypto/keyGuards.ts:11-22,39-49`;
`frontend/src/e2ee/session/prekeyStore.ts:118-144`; `frontend/src/e2ee/session/sessionStore.ts:130-158`.
**Сценарий:** в `dhPrivateKey`/OPK/SPK можно положить non-extractable
Ed25519/RSA/ECDSA-ключ или X25519-ключ без `deriveBits`; store примет,
F4 упадёт при DH. `assertSecretKey` без `validateStorageKey` (kStorage
проверяет AES-GCM отдельно) может принять чужой secret key.
**Риск:** отказ/неверная криптооперация, трудная диагностика; не утечка.
**Исправление:** проверять `key.algorithm.name`/`length` и `key.usages`
(X25519: `deriveBits`; Ed25519: `sign`/`verify`; AES-GCM: encrypt/decrypt)
в соответствующих guard'ах/валидаторах.
**Тест:** Ed25519 private в OPK/DHs → `INVALID_KEY`; X25519 без `deriveBits`
→ `INVALID_KEY`; secret key не AES-GCM → `KEY_STORAGE_UNAVAILABLE`.

### P2-07. Outbox lifecycle: stale `serverMessageId` в local copy, `superseded`→`failed`, один corrupt entry рушит drain, нет TTL/attempt cap

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:702-736`
(`markOutboxSent` меняет только status копии, payload `serverMessageId`
остаётся null), `:738-758` (`markOutboxFailed` не отсекает `superseded`),
`:636-661`/`:958-984` (`restorePendingOutbox`/`drainOutbox` бросает на первом
corrupt entry), отсутствие TTL/лимита попыток.
**Сценарий:** после `sent` `lookupLocalCopy` возвращает `serverMessageId:null`;
F5 не может сопоставить копию без outbox row. `markOutboxFailed` после
`markOutboxSuperseded` меняет статус обратно на failed. Одна повреждённая
pending-запись блокирует отправку всех остальных. Pending может жить вечно.
**Риск:** рассинхронизация UI/сервера, застревание очереди, рост storage.
**Исправление:** обновлять/дублировать `serverMessageId` в local copy
(пере-запечатать payload или хранить отдельно), отсекать `superseded`/`sent`
в `markOutboxFailed`, пропускать corrupt entries с метрикой, добавить
TTL/attempt cap/backoff в F5.
**Тест:** sent → copy server id; superseded не меняется; одна corrupt entry
не мешает остальным; TTL-очистка.

### P2-08. Уничтожение ключей неполное: `destroyKStorage` не чистит записи, нет единого wipe

**Файл/строка:** `frontend/src/e2ee/storage/kStorage.ts:243-246`
(удаляется только ключ), `frontend/src/e2ee/session/prekeyStore.ts:399-402`
(только `prekeys`), `frontend/src/e2ee/session/sessionStore.ts:626-628`
(только `sessions`); production-вызовов нет.
**Сценарий:** revoke/logout вызывает один из этих API; ciphertext-записи,
outbox/local copy, pins остаются; старый DH private в IDB может физически
пережить overwrite до compaction.
**Риск:** storage bloat, остаточные метаданные, ложное чувство «всё удалено»;
физическое удаление DH — best-effort (спека это признаёт).
**Исправление:** единый `destroyAllE2eeState` (все сторы + K_storage +
закрытие/удаление БД) для revoke/logout; документировать best-effort
физического удаления; property-тест storage scan.
**Тест:** после wipe все сторы пусты, K_storage отсутствует, старый
ciphertext не расшифровывается; нет старых `DHs`/OPK/SPK в dump.

### P2-09. Тестовые пробелы

**Файл/строка:** `frontend/src/e2ee/*.test.ts`; `frontend/src/e2ee/vectors.test.ts`
(авторские KAT), `frontend/src/e2ee/kStorage.test.ts:81-137`.
**Сценарий:** нет тестов на all-zero X25519 shared secret (код
`x25519.ts:146-148` есть, тест отсутствует), на nil/absent AAD collision,
на duplicate envelopes, на logout/cross-account, на `lookupLocalCopy`
direction, на 31–89-дневный offline prekey, на `spk_id` в session,
на реальный браузер/IndexedDB durability/kill-tab.
**Риск:** авторские KAT используют
production-функции, поэтому общая ошибка теста и кода не ловится; независимый
KAT её компенсирует, property-тесты — нет.
**Исправление:** добавить перечисленные тесты; для K_storage — байтовый KAT;
для multi-tab — реальные браузеры в F7.
**Тест:** перечисленные сценарии.

### P2-10. Документы/векторы расходятся по нижней границе ciphertext

**Файл/строка:** `docs/E2EE-TEST-VECTORS.json:202`
(`normative_invariants.ciphertext_cap` — «decoded 16..33040»),
`docs/E2EE-SPEC.md:744` (272..33040), `docs/E2EE-SPEC.md:121`
(`vector_set_version: 3`, хотя файл v4), клиент
`frontend/src/e2ee/protocol/envelope.ts:260` (272..33040).
**Сценарий:** conformance-тест по meta может принять 16..271 B, которые
спека/V19/quarantine/client отвергают; ревьюер получает противоречивые
требования.
**Риск:** неверный accept/reject на границе, ложные тесты.
**Исправление:** привести `normative_invariants` к 272..33040 (или явно
описать legacy 16..271 как quarantine-only) и обновить
`vector_set_version`/S-ссылку.
**Тест:** conformance-тест 16/271/272 по спеке.

### P2-11. `ciphertexts[]` в локальной копии: открытый продуктовый вопрос и размер

**Файл/строка:** `frontend/src/e2ee/outbox/types.ts:69-83` (массив),
`frontend/src/e2ee/outbox/outboxStore.ts:296-299` (требуется ≥1),
`:344-345` (default — все конверты); спека §3.4.6 `docs/E2EE-SPEC.md:594`
(«plaintext и ciphertext» в единственном числе).
**Сценарий:** fan-out 9 конвертов → 9 ciphertext'ов в одной копии (до
~400 KB JSON / ~540 KB b64u по отчёту F2); не ясно, что показывать в UI и
что нужно хранить после `sent`. `prepareOutgoingMessage` принимает
произвольный `ciphertexts`, не сверяя с `envelopes`.
**Риск:** quota/performance, лишние копии ciphertext, неопределённый UI.
**Исправление:** решить в F5/UI: хранить только plaintext + один «свой»
ciphertext или все; сверять `ciphertexts.length`/элементы с envelopes;
добавить лимит/GC.
**Тест:** 9-envelope commit, размер dump, lookup после sent, quota-поведение.

### P2-12. Канонический lower-case UUID и неполная валидация prekey bundle

**Файл/строка:** `frontend/src/e2ee/encoding/bytes.ts:10,123-133`
(`UUID_PATTERN` только lower-case), `frontend/src/e2ee/api/deviceKeys.ts:99-149`
(нет проверки `key_id`/`created_at`/`expires_at`/согласованности
`otp_exhausted`).
**Сценарий:** сервер отдаёт UUID в upper-case (Review-08 P2-06 residual для
path/`X-Device-Id`) — клиент отвергает валидный id. `decodePrekeyBundle`
пропускает malformed key_id/даты до F4.
**Риск:** interoperability/DoS декодирования, поздние ошибки в F4.
**Исправление:** канонизировать UUID (lower-case) на границе API или
принимать обе формы и приводить к lower-case; валидировать key_id/даты/
`one_time_prekey`↔`otp_exhausted` в decoder'е.
**Тест:** upper-case UUID → decode; malformed key_id/date → `INVALID_RESPONSE`.

### P2-13. Zeroization: seed/JWK и AEAD-ключи остаются в JS-памяти

**Файл/строка:** `frontend/src/e2ee/crypto/x25519.ts:94-129`,
`frontend/src/e2ee/crypto/ed25519.ts:61-96` (временный extractable import,
JWK `d`/seed — immutable string; `zeroBytes(pkcs8)` только wrapper),
`frontend/src/e2ee/crypto/aead.ts:8-24` (raw key/nonce не обнуляются),
`frontend/src/e2ee/protocol/kdf.ts:46-51` (K_enc/N остаются у caller'а).
**Сценарий:** после provisioning из seed/для KAT приватный материал может
остаться в куче до GC; JS не даёт гарантированного zeroize.
**Риск:** memory-dump/компрометация процесса; спецификация честно называет
это best-effort.
**Исправление:** документировать; по возможности использовать
`generateKey` (production), не seed; обнулять производные буферы в F4 после
AEAD; не логировать.
**Тест:** статический запрет seed-import в production-пути; code review.

### P2-14. `check-security` — pattern-based, не доказывает отсутствие утечек

**Файл/строка:** `frontend/scripts/check-security.mjs:15-75,84,91-105`.
**Сценарий:** guard запрещает `console.`/`fetch`/`Math.random` в
`src/e2ee/**`, но не ловит `globalThis['console']`, `exportKey('raw', private)`,
`new Worker`/`importScripts`, `postMessage` с секретами, `.js/.mjs` вне
`src`, обфускацию. Он также не проверяет, что приватные ключи non-extractable
(это делают тесты).
**Риск:** ложное чувство безопасности; реальная утечка может пройти мимо.
**Исправление:** расширить правила (exportKey приватных, Worker/importScripts,
`console` через bracket, все расширения), оставить тесты non-extractable как
обязательные.
**Тест:** негативные fixture-файлы для каждого паттерна.

### P2-15. `drainOutbox` держит `krug-outbox` на время сети

**Файл/строка:** `frontend/src/e2ee/outbox/outboxStore.ts:958-984`.
**Сценарий:** медленный/зависший `send` блокирует outbox-лок другого таба
на весь lease/retry; при fallback — на неопределённое время.
**Риск:** застревание очереди, плохой UX; не security.
**Исправление:** F5 — короткий сетевой вызов с таймаутом/abort, не держать
лок на backoff; либо per-entry lock.
**Тест:** медленный send не блокирует второй таб дольше таймаута.

## Проверки (KAT/команды)

### Независимый KAT

Векторы читались напрямую из `docs/E2EE-TEST-VECTORS.json`; **авторский
`frontend/src/e2ee/test/vectors.ts` и production-код `src/e2ee/**` не
импортировались**. Временные верификаторы лежали в `/tmp`, в репозиторий не
добавлялись.

| Секция | Векторы | Что сверено независимо | Результат |
|---|---|---|---|
| A-primitives | A1–A4 | RFC 7748 §6.1 X25519, RFC 8032 §7.1 Ed25519, RFC 5869 TC1 HKDF, NIST CAVP AES-256-GCM | 4/4 |
| B-x3dh | B1–B5 | DH1..DH4/IKM/SK/SID (4-DH и 3-DH), SPK-подпись, preamble 323 B + SHA-256 + подпись, IKB 88 B | 5/5 |
| C-kdf | C1–C3 | session-id HKDF, KDF_RK, три KDF_CK | 3/3 |
| D-aead | D1–D3 | framing/padding 256, K_enc/N из MK, ciphertext m1/m2 + decrypt | 3/3 |
| E-double-ratchet | E1 | 4 сообщения, 2 DH-ratchet turn, AD/header/MK/ciphertext/decrypt | 1/1 |
| E2-skipped-keys | E2 | MK n=0..2, AD/ciphertext, delivery 0,2,1, skipped n=1, Nr | 1/1 |
| F-envelope | F1–F2 | canonical JSON байт-в-байт (1310/756 B), preamble/AD/header/ciphertext/session_id, prekey signature, F2==E1 m2 AEAD | 2/2 |
| G-verification | G1–G5 | fingerprint (Alice/Bob), safety number digest/digits/display/QR, G3, VH v2, per-device L1/L2 | 5/5 |

**Python** (`cryptography 49.0.0`; свой код, не генератор из
`E2EE-SPIKE-NOTES.md`): **124 проверки, 0 failures, 24/24 вектора**.
**Node** (`node:crypto`: X25519/Ed25519/HKDF/AES-GCM, независимо от Python):
**40 проверок, 0 failures** (A/B/C/D2/D3/G1/G2/G4). Дополнительно 15 b64u-полей
F1/F2/B3/B4 проверены на каноничность (decode→encode совпадает, длины 16/32/64);
расхождений нет.

### Команды и полный прогон

```bash
cd frontend && npm run check
# EXIT 0
# lint / format:check / contract:check (33 operations, 58 schemas, types in sync)
# stickers:check / security:check (150 files)
# vitest: 39 files / 362 tests passed
# tsc --noEmit: clean
# vite build: 331 modules

cd frontend && npx vitest run src/e2ee
# 16 files / 182 tests passed
```

`npm run check` выполнен на **F1/F2-снимке** (до появления параллельных
`frontend/src/e2ee/device/**`): EXIT 0, 39 файлов / 362 теста. Отдельно
прогнан `npx vitest run src/e2ee` (182/182) на том же снимке. Текущее дерево
с F3-файлами требует отдельного полного прогона; этот review его не заменяет.
Артефакт `frontend/dist/` пересобран штатным build, исходники не менялись.

### Негативные проверки

Покрыто авторскими тестами: non-canonical b64u (`=`, `+`, `/`, 4n+1,
trailing bits), неизвестные поля на всех уровнях, `v=2`, self-envelope,
границы ciphertext 272/33040/form guard, partial prekey/OPK, AD/ciphertext/
preamble tamper, padding/body-length/content-type/bidi/C0/C1/`attachment_refs`,
`KEY_STORAGE_UNAVAILABLE`, отсутствие WebCrypto, extractable private key,
stale revision, повторный OPK, повторный commit, corrupt session/outbox,
отсутствие plaintext/root/chain в dump, multi-tab CAS.

**Чего нет:** см. P2-09 (low-order X25519, nil/absent AAD, duplicate
envelopes, logout/cross-account, lookup direction, offline SPK 31–89 дней,
`spk_id`, реальный браузер/kill-tab). Векторы не покрывают WebCrypto
non-extractable/structured clone и crash-recovery — это F7.

### Ограничения ревью

- Нет реальных браузеров: `fake-indexeddb`/jsdom, Node 24; Safari/Firefox
  quirks, background timer throttling, IndexedDB durability — только F7.
- Нет F4/F5-кода: send/receive/handshake/TOFU/reset не проверялись в работе;
  выводы по ним — из API F2 и спеки. F3-файлы (`src/e2ee/device/**`) появились
  параллельно уже после старта ревью и **не** входят в этот F1/F2-снимок;
  их наличие отмечено только в P1-05 и не является F3-ревью.
- Внешний crypto-review G4 не проводился; этот документ — client review,
  не замена G4.

## AAD/storage

### `K_storage` AAD: 50-байтовая раскладка

Код: `frontend/src/e2ee/storage/kStorage.ts:11-19,46,94-122`.

| Смещение | Размер | Поле | Кодирование |
|---|---|---|---|
| 0 | 16 | `device_id` | UUID RFC 4122 bytes |
| 16 | 16 | `session_id` | 16 байт протокола; `0×16`, если нет |
| 32 | 16 | `client_message_id` | UUID bytes; `0×16`, если нет |
| 48 | 1 | `record_type` | `1=session`, `2=outbox`, `3=localCopy` |
| 49 | 1 | `version` | `LOCAL_RECORD_VERSION=1` |

Итого 50 байт, без длины/тегов.

**Однозначность.** Как **байтовая строка** раскладка однозначна: все поля
фиксированной ширины, порядок фиксирован, `u8` type/version не пересекаются
с id. Как **инъективное кодирование логического tuple** — нет: `0×16`
является допустимым UUID (nil) и теоретически допустимым `session_id`;
`client_message_id=null` и nil UUID дают одинаковые байты, а `local_message_id`
в AAD отсутствует. Для `localCopy` с null client id все входящие сообщения
одной сессии имеют одинаковый AAD.

**Связанность.** Все поля из списка спеки §2.3 (`device_id || session_id ||
client_message_id || record_type || version`) присутствуют; type/version
разделяют типы записей; `device_id` привязывает к локальному устройству.
**Не связаны:** `local_message_id`/record key, `chat_id`, peer/identity,
`user_id` (для будущих pins), presence optional-полей.

**Collision/malleability.** При одинаковом `K_storage` и одинаковом AAD
ciphertext (вместе с nonce) можно переставить между записями — GCM
расшифруется. Random nonce (12 байт на запись) предотвращает повтор nonce,
но **не** предотвращает transplant при совпадающем AAD. Сейчас
`decryptLocalCopy`/`decryptOutboxEntry`/`loadSessionRecord` дополнительно
сверяют sealed-метаданные (localMessageId/sessionId/counters), поэтому
практическая эксплуатация ограничена; но это defense-in-depth, а не
свойство AAD. Для G4 нужен либо presence-байт + `local_message_id`, либо
запрет nil UUID и явная нормативная раскладка.

**Вердикт по AAD:** раскладка **не противоречит** спеке (она её не
нарушает, а дополняет), но **не готова как нормативная**: нет описания,
нет KAT, есть zero-sentinel collision и отсутствует record identity. Это
P1-07 + P2-01; менять до G4, пока нет production-записей.

**Nonce/keys.** `K_storage` — 32 random bytes → non-extractable AES-256-GCM;
nonce 12 random bytes на запись; tag 128 бит; AAD проверяется WebCrypto.
Ключ один на профиль/устройство; ротации/версий ключа в v1 нет.

### Storage

- **IndexedDB:** `createIndexedDbStorage` создаёт все сторы, транзакции
  multi-store атомарны, read-your-writes, abort без частичных записей,
  auto-commit guard (`KEY_STORAGE_UNAVAILABLE`). `structuredClone` сохраняет
  non-extractable `CryptoKey`; тесты проходят в fake-indexeddb.
- **Multi-tab:** K_storage first-run race сходится на одном ключе; session
  revision/CAS; outbox/local copy дубликаты; тесты с двумя адаптерами/фейковым
  LockManager. См. P1-06 для fallback.
- **Key destruction:** `destroyKStorage` удаляет только ключ; записи остаются
  нечитаемыми; `destroyPrekeyMaterial` — только prekeys; единого wipe нет
  (P1-04/P2-08). Старый `DHs_priv` логически перезаписывается; физическое
  удаление — best-effort (спека §3.4.5.1).
- **No localStorage/logs/network:** `security:check` 150 файлов, в
  `src/e2ee/**` нет `console.*`, `Math.random`, `fetch`/XHR/WebSocket/
  sendBeacon, `localStorage`/`sessionStorage`; `BroadcastChannel` используется
  только для локов (same-origin), не для сети. E2EE-ошибки не содержат
  ключей/plaintext; outbox хранит только код ошибки.
- **Cross-account:** P1-04 — главный storage-риск; logout не чистит IDB.

## Outbox/locks

### Атомарность и crash/replay

Проверено тестами F2 (16 файлов/182 теста):

| Точка | Поведение | Оценка |
|---|---|---|
| до commit | prepare без commit → outbox пуст, сессия не сдвинута | PASS |
| commit | state + exact envelopes + idempotency key + client_message_id + local copy в одной транзакции | PASS (кроме P1-01 sessionless) |
| после commit, до сети | restore возвращает те же bytes/key | PASS |
| после сети, до `sent` | повтор тех же bytes; fake-server dedupe; markSent идемпотентен | PASS |
| после `sent` | restore пуст; local copy — источник отображения | PASS (P2-07 server id) |
| кэш очищен | `lookupLocalCopy` → `available:false` + clientMessageId | PASS (но P1-02 scope) |
| abort/конфликт | state/outbox/OPK не пишутся частично | PASS |
| дубли envelopes | commit проходит, сервер 422, state уже сдвинут | FAIL (P2-02) |

**Idempotency:** outbox хранит `Idempotency-Key` и точные `envelopes` в
запечатанном payload; `markOutboxSent` идемпотентен при том же
`server_message_id`/`seq` и конфликтует при других; повторный commit того же
`client_message_id` → `OUTBOX_CONFLICT`. Это соответствует §3.4.6/§4.6.
**Local copy:** plaintext + ciphertexts[] запечатаны; при отсутствии —
честный `available:false`. Проблемы namespace/direction — P1-02/P2-11.
**Stale tab:** CAS `revision`; stale writer → `SESSION_STATE_STALE`, повтор
после перечитывания под локом успешен. F4 обязан использовать возвращённый
`revision`; `saveSession` возвращает обновлённое состояние.
**Sessionless:** P1-01 — API разрешает commit без state; это ломает
«state+envelopes» инвариант.

### Locks

- **Web Locks:** `krug-session:<session_id>` / `krug-outbox`, exact names;
  timeout только на acquisition; уже начавшаяся секция не прерывается;
  release при ошибке body. Тесты PASS.
- **Fallback:** BroadcastChannel lease + local queue; **не security
  boundary**; `tabId` collision/background throttling могут дать двух
  writer'ов (P1-06). CAS/revision и idempotency — вторая линия, но F4/F5
  должны либо fail closed, либо обеспечить fencing для каждой мутации.
- **Lock ordering:** сейчас session и outbox не вложены; `drainOutbox`
  держит `krug-outbox` на время `send` (P2-15). F4/F5: не брать session lock
  внутри outbox lock без явного порядка; не держать outbox lock на backoff.
- **`STORAGE_LOCK`** объявлен (`locks.ts:26`), но нигде не используется;
  либо задействовать для K_storage provisioning/wipe, либо удалить.

### OPK/SPK

- **OPK consume-once:** read+delete в одной транзакции; concurrent consume —
  ровно один; abort возвращает OPK; тесты PASS. F4 обязан вызывать
  `consumeOneTimePrekeyInTransaction` **после** успешного AEAD и в той же
  транзакции, что state+copy; `prepareIncomingMessage`/`commitIncomingMessage`
  это поддерживают. Оговорка P2-03 (expiry после staging delete).
- **SPK:** `rotateSignedPrekey` держит current + 2 previous, 90-дневное окно,
  30-дневный TTL «без сессий», `deleteSignedPrekey` чинит pointer; private —
  non-extractable. **Дефект:** 30-дневный TTL противоречит 90-дневному окну
  (P1-03) и `spk_id` нет в session state. F3/F4 обязаны передавать
  `activeSessionSpkIds`, но его неоткуда надёжно взять; сначала нужно решение
  спеки/формата.

## Условия GO для F3/F4

До включения E2EE и до G4:

1. **P1-01:** `commitOutgoingMessage` не принимает `session === null` для
   send; отдельный repair-API без сети; тест на отказ и property
   «outbox ⇒ session revision».
2. **P1-02:** namespace локальной копии `(chatId, direction,
   localMessageId)`; `lookupLocalCopy(chatId, clientMessageId)` проверяет
   `direction='outgoing'`; тест коллизии incoming/outgoing и cross-chat.
3. **P1-03:** решение по SPK TTL (30 vs 90) и `spk_id`/active-session
   tracking; тест offline prekey 31–89 дней; не удалять SPK раньше 30 дней.
4. **P1-04:** user/device-scoped БД и K_storage; `destroyAllE2eeState()` на
   logout/account switch/revoke; тест двух аккаунтов в одном профиле.
5. **P1-05:** `pin` record type + sealed AAD; TOFU-модуль с проверками
   §3.3.1/§7.5; пин до session/display; тест tamper/mismatch.
6. **P1-06:** уникальный `tabId`, fail-closed fallback или fencing для всех
   мутаций; тест двух writer'ов/протухшего lease.
7. **P1-07:** нормативная AAD-раскладка + KAT `K_storage`; до этого G4 не
   закрывать.
8. **F4:** preamble signature + binding + sender identity vs
   registered/bundle/pin; собственные IK; `key_generation`; `DHs_A` fresh
   (не EK/IK/SPK); OPK после AEAD; session_id/chat/devices; несколько сессий
   §5.7; R-15 reset; никакого self-envelope.
9. **F5:** send worker `prepare → commit → drain`; не перешифровывать;
   duplicate envelopes отклонять до commit; server response валидировать;
   local copy direction; outbox lock короткий; `markSent` после 201;
   `client_message_id` reconcile; coverage UI.
10. **F7/G4:** реальные браузеры (Safari/Firefox/Chrome), kill-tab,
    IndexedDB durability, background locks, vectors в CI, cross-account
    logout, E2E двух устройств; флаг `e2ee.enabled` остаётся `false` до
    закрытия P1 и внешнего G4.

## Вопросы

1. **AAD layout:** утверждаем ли 50-байтовую раскладку как v1, или переходим
   на presence-байты + `local_message_id` (66/68 байт) до появления
   production-записей? Кто владелец spec-изменения и KAT?
2. **K_storage scope:** скоупить по `user_id`+`device_id` или достаточно
   wipe на logout? Что считается «logout» в OIDC-флоу и кто вызывает wipe?
3. **SPK TTL:** 30 дней для «без сессий» отменяем/расширяем до 90? Если
   оставляем 30, как объясняем 90-дневное окно в §5.5? Где хранить `spk_id`
   сессии?
4. **BroadcastChannel:** разрешён ли E2EE-send при отсутствии Web Locks
   (fallback) или только fail-closed? Если разрешён, какие fencing-поля
   обязательны для outbox/local copy?
5. **`ciphertexts[]`:** хранить все конверты или только «свой»? Что
   показывать в UI после `sent`? Какой budget/quota?
6. **`pins`:** record type/AAD/версия; кто реализует — F3 или F4? Нужен ли
   `pin_source`/`verified_at` в sealed-записи?
7. **Nil UUID/zero session:** запрещаем как protocol value или кодируем
   presence-байтом? Нужна ли канонизация UUID (upper→lower) на API-границе?
8. **`normative_invariants` 16..33040:** это ошибка документа или намеренное
   legacy-правило? Привести к 272..33040 (V19 quarantine) до conformance.
9. **Session record v2:** добавляем `spk_id`/peer-key hash/revision MAC или
   оставляем plaintext peer-поля и полагаемся на F4/TOFU?
10. **`markOutboxSent`/response:** кто валидирует `Message`/`envelope_coverage`
    по контракту (F5?) и что делать при replay с другим `seq`?
11. **`destroyKStorage`/`deleteDatabase`:** допустимо ли удалять всю БД при
    revoke/logout, или нужна частичная очистка с сохранением чужих данных?
12. **G4 scope:** достаточно ли client KAT + этот review, или нужен отдельный
    pentest WebCrypto/IndexedDB/Safari quirks до включения флага?

---

**Итог:** F1 — KAT-clean; F2 — хорошая атомарная база, но перечисленные P1
нужно закрыть до F4/F5 и G4. E2EE включать нельзя; флаг остаётся `false`.

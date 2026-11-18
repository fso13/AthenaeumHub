# E2EE-REVIEW-03 — G2 targeted re-review редакции S3

> **Статус ревью:** DONE (G2 targeted re-review). Вердикт: GO WITH CONDITIONS; E7-B1 — после P1-A-1.

> **Роль.** Независимый security/crypto-ревьюер «Круга». Спеку, векторы, notes и S3-changelog писал не я; production-код, контракты, миграции и `docs/TASKS*.md` не изменялись. Изменён только этот файл.
> **Объект.** [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) (S3, 3124 строки), [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) (v3, 43 вектора / 17 секций / 273 checks), [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §10, [`docs/E2EE-S3-CHANGELOG.md`](<E2EE-S3-CHANGELOG.md>), [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>), [`docs/TASKS-E7.md`](<TASKS-E7.md>).
> **Что проверено.** Заявления S3 о закрытии P0-2b, P0-3, P1-A…H, P1-5/6; DDL §6.5 против фактических V1–V15; grants/RLS/partitions/CHECK под `krug_app` на PostgreSQL 16; 16 нормативных секций + meta (собственный верификатор, 242 проверки, 0 failures; H-sender-key — informative, отдельно не проверялся); независимая расшифровка I1/I2/I3; tamper-набор; детерминизм генератора; handoff I-01 §6.3.1.
> **Границы.** Это design/conformance re-review, а не implementation-review. Реальный backend/frontend, браузерный WebCrypto, IndexedDB/crash-recovery, конкурентная гонка claim, Flyway/Testcontainers и G3/G4 не запускались. PG16 smoke — одноразовый Docker, не production-данные.

---

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**GO WITH CONDITIONS.**

Криптографическое ядро S3 осталось корректным и воспроизводимым, а главный дефект review-02 (P0-2b) действительно закрыт:

- envelope wire format не менялся (`envelope.v=1`, `header.v=1`, AD 163 B, преамбул 323 B для `spk-1`/`opk-1`);
- мой независимый верификатор по спеке: **242 checks, 0 failures** по 16 нормативным секциям + meta; авторский: **273/0**; генератор детерминирован (sha256 `1fa70ac1…1cd8`, `cmp` → IDENTICAL);
- P0-2b: серверная проверка `prekey.sender_identity_* == auth.devices.identity_*` и клиентская `prekey == bundle == TOFU pin` описаны нормативно; I3 — wire-валидный негативный вектор; я независимо проверил его подпись преамбула, binding, X3DH, AD и AEAD;
- P1-A в основной части исполнима: V1–V15 + §6.5 применились одной транзакцией на PG16; grants/RLS/partitions/`reply_to_id`/sender/`vh_version`/trigger работают под `krug_app`; self/claim не сломаны;
- P1-D/E/F/H, P1-2/3/8/9/10/11/12 закрыты в зоне спеки; I-01 остаётся внешним (PM).

**Почему не GO.** Четыре P1-остатка (A/B/C/G) плюс P1-1/5/7 (следствия B/C/5) и один контрактный гэп должны быть закрыты до соответствующих этапов:

1. **P1-B не закрыт полностью:** `peer_covered` считается по любому active-устройству peer, а не только по `e2ee_capable`. При 1 capable + 1 legacy у peer конверт только legacy-устройству даёт `peer_covered=1 == peer_devices=1` → `201` без warning, capable-устройство не получает ничего (P1-B-1).
2. **P1-C не закрыт для частичной доставки:** reset перешифровывает **все** pending-сообщения failed-сессии; уже расшифрованные получателем сообщения дублируются, нового ключа дедупликации нет. L3 проверяет только `delivered_before_reset=0` (P1-C-1).
3. **P1-A/P1-5 backfill не переносит вырожденные DIRECT-чаты:** `direct_key` заполняется только при ровно 2 ACTIVE, а `ck_chats_direct_key` добавляется сразу (без `NOT VALID`) → V16 падает на чате с удалённым участником. Воспроизведено: `V16_EXIT=3`, `ck_chats_direct_key ... violated by some row` (P1-A-1).
4. **P1-G/P0-3 текст противоречит J3:** §6.2.8 п. 3(б) предлагает «явно подтвердить MANAGED», не запрещая in-place downgrade; J3 требует `E2EE_ONLY (or a NEW managed chat; never an in-place downgrade)` (P1-G-1).
5. **I-01 handoff почти достаточен, но не без изобретений:** `Chat` в контракте отсутствует (а не «расширяется»), `ChatSummary.name` остаётся required string при nullable `Chat.name`, `DeviceRegistration` с обязательными ключами ломает старые клиенты; нужны 4 решения PM (P1-I01-1 / §«I-01 readiness»).

Это не NO-GO: P0 нет, криптоядро и DDL-каркас рабочие. Но **E7-B1 на реальных данных** блокируется backfill-дефектом, а E7-B4/B5/включение E2EE — P1-B/C/G и I-01.

| Метрика S3 | Заявлено | Фактически по review-03 |
|---|---|---|
| P0 closed | 4/4 | **4/4** (P0-3 — с текстовой оговоркой P1-G) |
| P1-1..12 | 12/12 | **9 closed, 3 partial** (P1-1, P1-5, P1-7) |
| P1-A..H | 8/8 | **4 closed** (D, E, F, H), **4 partial** (A, B, C, G) |
| Векторы | 43/17, 273/0 | **подтверждено**: 273/0; независимо 242/0; deterministic |
| DDL V16 | готов к E7-B1 | **не на всех реальных данных**: clean V1–V15 — да; вырожденный DIRECT — нет |
| I-01 | handoff §6.3.1 | **partial**: 4 решения PM, контракт не применён |
| Wire v1 | не изменён | **подтверждено** |

---

## P0

**Открытых P0 нет.** Ни один из дефектов review-02 не переоткрыт.

### P0-2b — CLOSED

**Где проверено.** §3.3.1:425–426 (п. 2 — равенство identity), §3.3.1:430–433 (п. 7 — TOFU), §3.3.2:443 (3a — собственные ключи), §3.3.3:457 (приём), §4.1:766 (связь prekey с `auth.devices`/bundle), §4.7:934 (п. 4a) и псевдокод §4.7:958–961.

**Сценарий, который был дефектом.** Кража bearer-токена A без приватных ключей: prekey-блок с `(IK_sig', IK_dh')` для существующего `device_id=011`, валидная подпись преамбула и валидный binding Mallory, bundle/`auth.devices` — честные. Раньше B проверял binding по bundle, а prekey-ключи — ни с чем не сравнивал.

**Что теперь.** Сервер обязан отвергнуть расхождение `prekey.sender_identity_*` с `auth.devices` (`422 INVALID_ENVELOPE_FORMAT`, `details.field`; при сдвиге generation — `409 KEY_CHANGED`). Клиент обязан проверить `prekey == bundle == TOFU pin` и проверять binding **над теми же** ключами; расхождение → `KEY_HANDSHAKE_INVALID`, без сессии/OPK/отображения.

**Evidence.**
- I3 `I3-prekey-sender-identity-mismatch`: `prekey_matches_registered_device=false`, `prekey_matches_bundle=false`, server `422`, client `KEY_HANDSHAKE_INVALID`, `session_created=false`, `opk_consumed=false`, `message_displayed=false`, `tofu_pin_written=false`.
- Мой верификатор независимо: подпись преамбула I3 валидна для подставленных ключей; binding Mallory валиден; X3DH → `session_id` сходится; AD 163 B; AEAD расшифровывается (то есть это действительно wire-валидный конверт, а ловит его только сравнение с registered/bundle).
- Псевдокод §4.7:958–961 выполняет обе проверки до `peer_covered`/insert.

**Остаточный риск (не P0).** TOFU-окно первого контакта; malicious server может подменить bundle до первого пина; token + новые ключи = новое устройство (не имперсонация). Это зафиксировано в §7.6:2479–2481 и §9.3.

### P0-3 — CLOSED (с текстовой оговоркой P1-G)

**Где.** §6.2.8:1470–1477 (bootstrap режима), §7.6:2485, §9.3:2720, J1/J2/J3; DB trigger `trg_chats_security_mode_immutable` проверен на PG16 (T23).

**Evidence.**
- J1: `409 MODE_CHANGE_FORBIDDEN`, `mode_changed=false`, `plaintext_messages_sent=0`, `requires_new_chat=true`.
- J2: flag off → `409 E2EE_DISABLED`, существующий E2EE не понижается, plaintext → `422`.
- J3: `client_has_pin=false`, `local_security_mode_pin=null`, `peer_has_e2ee_capable_device=true` → `BLOCK_SEND_SECURITY_ALERT`, `send_blocked=true`, `security_alert=true`, `server_request_sent=false`, `plaintext_messages_sent=0`, `fallback_to_managed_allowed=false`.
- PG16: `UPDATE chat.chats SET security_mode='MANAGED'` → `23514 MODE_CHANGE_FORBIDDEN` (T23); триггер также на `workspace.workspaces`.

**Оговорка.** Текст §6.2.8 п. 3(б) допускает «явно подтвердить MANAGED» без «нового чата»; J3 запрещает in-place downgrade. Это P1-G-1, а не переоткрытие P0-3: молчаливого plaintext нет, требуется явное действие пользователя.

---

## P1

Каждый пункт: где, сценарий, риск, исправление, тест/вектор.

### P1-B-1. `peer_covered` считает legacy-устройства peer покрытием

**Где.** §4.2:832 (определение `peer_covered` — «число разных `recipient_device_id`, принадлежащих peer»), §4.7:949 (`peer_devices` — только `e2ee_capable`), §4.7:962–972 (target проверяется только на `active`/membership, `peer_covered` — без capability), §5.2:1056.

**Сценарий.** У Bob 1 capable-устройство B1 и 1 legacy/active B2. Клиент с устаревшим/подменённым списком устройств (или malicious sender) отправляет **один** конверт на B2 (legacy, без ключей), не отправляет на B1. Server: `peer_devices=1`, `peer_covered=1`, `peer_covered < peer_devices` ложно → `201`, `warning=null`. B1 не получает ничего; B2 не может расшифровать. Отправитель уверен в доставке.

**Риск.** Это тот же класс, что review-01 P1-7/P1-B: ложная доставка и молчаливая потеря. Текущий M1 покрывает только `peer_covered=0`, M2 — partial; случая «покрыт только legacy» нет. Практический путь требует malformed/malicious sender или подменённого `/keys` (честный клиент с текущим `GET /keys` legacy-id не видит), но серверная гарантия coverage не должна зависеть от добросовестности клиента; проверка стоит одного условия.

**Исправление.** В §4.7: (1) `require(target.e2ee_capable)` для каждого E2EE-конверта (или `422 E2EE_LEGACY_DEVICE`/`INVALID_ENVELOPE_FORMAT`); (2) `peer_covered`/`self_covered` считать только по `e2ee_capable`-устройствам; (3) `uncovered_device_ids` включает capable-устройства без конверта. В §4.2 явно: «покрытие — только capable-устройства».

**Тест/вектор.** Новый **M3-peer-legacy-not-coverage**: peer = 1 capable + 1 legacy, envelope только legacy → `409 E2EE_NO_PEER_ENVELOPE` (или `422` на legacy-target), `message_created=false`, `seq_allocated=false`. Integration E7-B4: два устройства Bob, одно legacy.

### P1-C-1. Reset дублирует уже расшифрованные сообщения при частичной доставке

**Где.** §5.5:1087–1089 (перешифровать **все** pending/sent без подтверждения; UI схлопывает по `client_message_id`), §3.3.3:461, L2/L3.

**Сценарий.** A отправил m1…m5 в одной сессии; B расшифровал m1–m3, на m4 получил `DECRYPT_FAILED` и отправил reset с `failed_n=3`. A по §5.5 перешифровывает **все пять** сообщений с новыми `client_message_id`; B получает m1–m3 повторно. Новые id не связаны со старыми, поэтому B не может дедуплицировать; UI показывает дубли. L3 проверяет `delivered_before_reset=0`, т.е. ровно тот случай, где дублей нет.

**Риск.** R-15 «no silent loss» куплен ценой дублей; для пользователя это выглядит как повторные сообщения, для метрик — искажение. Это не утечка, но дефект корректности протокола.

**Исправление.** Определить окно повторной отправки: использовать `failed_n`/`(chain, n)` и/или список `retry_of_client_message_ids`, перешифровывать только сообщения с `n >= failed_n` (и prekey-сообщение, если оно не расшифровано). Либо включить в reset старые id и обязать получателя дедуплицировать по ним. Явно описать, что происходит с уже расшифрованными. L3b: `delivered_before_reset=2`, ожидание `duplicates_in_ui=0`, все 5 доставлены один раз.

**Тест/вектор.** L3b (partial delivery) + E2E «B расшифровал 2 из 5, reset → 0 дублей»; метрика `e2ee_reset_duplicates`.

### P1-A-1 / P1-5-1. Backfill `direct_key` не переносит вырожденные DIRECT-чаты, а CHECK добавляется сразу

**Где.** §6.5:2254–2265 (backfill только `HAVING count(*)=2` ACTIVE), §6.5:2267–2270 (`ck_chats_direct_key` — `NOT NULL` для **любого** DIRECT, без `NOT VALID`), §6.5.1:2354 (порядок миграции), P2-10 review-02.

**Сценарий.** В V1–V15 есть DIRECT-чат, у которого один участник `status='REMOVED'` (или чат удалён и участники removed). Backfill не заполняет `direct_key`; `ADD CONSTRAINT ck_chats_direct_key CHECK (... direct_key IS NOT NULL ...)` проверяет существующие строки и падает. Воспроизведено на PG16: V16 `EXIT=3`, `ERROR: check constraint "ck_chats_direct_key" of relation "chats" is violated by some row`; транзакция откатилась, constraint отсутствует.

**Риск.** E7-B1 не применится на реальной БД, где был обычный выход участника из DIRECT; это блокер миграции, а не «редкий случай». S3 проверил только «DIRECT ровно с 2 ACTIVE» (нормальный backfill у меня тоже проходит, `direct_key` заполнен, unique-индекс создан).

**Исправление.** Один из вариантов: (a) backfill для любого DIRECT из любых двух членов (не только ACTIVE) и/или `COALESCE` от `created_by`/второго участника; (b) `ADD CONSTRAINT ... NOT VALID`, repair-скрипт, затем `VALIDATE CONSTRAINT` отдельной миграцией; (c) fail-fast с явным diagnostic-скриптом до V16. В любом случае — repair для `type='DIRECT' AND direct_key IS NULL` и для дублей пары (`ux_chats_direct_pair` тоже упадёт, если два DIRECT-чата одной пары).

**Тест/вектор.** Миграционный тест V1–V15 + данные: DIRECT с 1 ACTIVE, DIRECT с 3 участниками (1 REMOVED), deleted DIRECT, два DIRECT одной пары → V16 либо чинит, либо даёт понятную ошибку до изменения схемы. Сейчас — P1 для E7-B1.

### P1-G-1. §6.2.8 п. 3(б) допускает in-place MANAGED, J3 — запрещает

**Где.** §6.2.8:1474 («предложено … (б) явно подтвердить MANAGED с предупреждением»), J3 (`allow_after_user_confirmation = "E2EE_ONLY (or a NEW managed chat; never an in-place downgrade)"`), §7.6:2485, §9.3:2720.

**Сценарий.** Fresh device/cleared profile, признак E2EE есть, сервер говорит MANAGED; пользователь нажимает «подтвердить MANAGED». По тексту §6.2.8 это разрешает продолжить в том же чате — то есть in-place downgrade с plaintext в чате, где была E2EE-история. J3 это запрещает: только E2EE-сессия или **новый** managed-чат.

**Риск.** P0-3 закрыт только для «молчаливого» plaintext; явное подтверждение в текущей формулировке оставляет путь in-place downgrade, который спека в других местах называет атакой. Реализатор, читающий §6.2.8, может выбрать неверную ветку.

**Исправление.** Заменить в §6.2.8 п. 3(б) на «явно подтвердить **новый managed-чат** (не in-place); текущий чат остаётся E2EE/недоступным». Синхронизировать §7.6/§9.3. J3 оставить нормативным.

**Тест/вектор.** J3 + Playwright fresh context: после подтверждения `chat_id` не меняет режим; plaintext в старом чате = 0; создаётся новый чат.

### P1-I01-1. Handoff §6.3.1 неполон для «применить без изобретений»

**Где.** §6.3.1:1913–1933 (схемы), §6.3.1:1935 (paths), текущий `contracts/openapi.yaml`: `ChatSummary` (1067–1077), `DeviceRegistration` (819–…), `Chat`/`ChatCreateRequest` отсутствуют.

**Что достаточно.** Схемы `Base64Url16/32/64`, `SignedPrekey`, `OneTimePrekey`, `CryptoHeader`, `PrekeyBlock`, `CryptoEnvelope`, `DeviceList`, `PrekeyUploadResult`, `KeyClaimRequest`/`PrekeyBundle`/`UnavailableDevice`/`KeyClaimResponse`, `DeviceKeyInfo`, `ChatKeysResponse`, `VerificationRequest/Response`, `EnvelopeCoverage`, `Message`/`MessageCreate`/`MessageCreateResult`, `ChatSummary.peer_id`, `ErrorCode` — перечислены с полями/required/статусами; OpenAPI 3.1, поэтому `type: [string,"null"]` и `contentEncoding` валидны; `X-Device-Id`/`Idempotency-Key` параметры в контракте уже есть.

**Чего не хватает (P1 для B3/B4/B5, не для B1).**
1. `Chat` и `ChatCreateRequest` в контракте **отсутствуют**, а handoff говорит «расширить»; нужны `add` (в §6.3 схемы есть).
2. `ChatSummary.name` — `required` string, `Chat.name` — nullable; для DIRECT с `name=null` ответ `GET /chats` нарушит контракт. Нужно `name: [string,"null"]` или derived display name.
3. `DeviceRegistration` требует `identity_*`/`signed_prekey`; старый frontend/клиент без ключей получает `422`. Нужен rollout-план/version gate (см. P2-9).
4. `MessageCreateResult.envelope_coverage` не required; для E2EE-ответа should be required; `PrekeyBlock.spk_id/opk_id` без pattern `[A-Za-z0-9._-]`.

**Риск.** PM может применить handoff и получить несовместимость `GET /chats`/старых клиентов; это не крипто-дефект, но I-01 остаётся открытым.

**Тест.** Contract-check: `GET /chats` DIRECT с `name=null`; `POST /devices` legacy body; `MessageCreateResult` E2EE; schema regen.

---

## P2

| # | Где | Finding | Риск | Исправление | Тест |
|---|---|---|---|---|---|
| P2-1 | §6.5:2314–2319 + §6.5:2191–2196 | Индексы `message_envelopes` создаются и на родителе, и в `ensure_partition` для каждой партиции; на текущей партиции **7** индексов вместо 4 (PK + 3) | Дублирование индексов: write-amplification/размер, путаница при EXPLAIN | Оставить только parent-индексы (они автоматически создаются на партициях) **или** только child; убрать второй набор | PG16: `count(*)` по `pg_indexes` = 4, не 7 |
| P2-2 | §6.5:2296–2313 | Нет ограничения «один конверт на `(message_id, recipient_device_id)`»; PK включает `created_at` (partition key), поэтому unique без `created_at` в partitioned-таблице невозможен | Два конверта одному устройству одного сообщения (баг/ретрай) не ловятся БД; `GET` может вернуть два | App-level идемпотентность по `(message_id, recipient_device_id)` + тест; либо отдельная non-partitioned таблица уникальности; `UNIQUE (message_id, recipient_device_id, created_at)` проблему не решает | INSERT дубля с разным `created_at` → app reject/DB scan |
| P2-3 | §6.5:2225–2249 | `key_verifications` без FK на `auth.devices`/`chat.chats`; RLS только `workspace_id`; `verifier_user_id`/`verifier_device_id` можно записать чужие | DB не мешает подделке attestation при ошибке API; cross-chat строки | FK/проверки ownership + `EXISTS` chat membership в policy | INSERT чужого verifier → fail; RLS |
| P2-4 | §6.5:2084–2128 | `auth.claim_one_time_prekey` не проверяет `c.chat_id` workspace; под `app.workspace_id=W2` claim в чат W1 прошёл (T26) | Cross-workspace расход OPK/DoS; не утечка (членство проверено) | Добавить `c.workspace_id = ops.current_workspace_id()` | Claim в чужом workspace → UNKNOWN_DEVICE |
| P2-5 | §7.2:2410 | `entry = user_id(16) ‖ device_id(16) ‖ fingerprint(32)` назван «80 байт», фактически 64; вектор G2 сходится только с 64 | Реализатор, следующий «80», добавит padding и не сойдётся с G2 | Исправить «80» → «64» (формула и вектор — истина) | G2 sha512 |
| P2-6 | `meta.conventions.signature_encoding`; B3/B4; §8.3:2575 | B3/B4 `expected.signature` — 128 hex, хотя это wire-поля `signed_prekey.signature`/`prekey.signature` (b64u64); конвенция говорит «never appear on the wire», §8.3 велит Java DTO-тестам использовать B3/B4 | Тест может подать hex в `Base64Url64` и получить ложный отказ; P1-E-класс ошибки сохраняется для SPK/prekey | Добавить b64u-поля в B3/B4 или явно описать конверсию; обновить конвенцию | Schema-check: все wire-подписи 86 b64u; B4→F1 |
| P2-7 | `contracts/openapi.yaml`:1067–1077; §6.3.1:1930–1931 | `ChatSummary.name` required string, `Chat` отсутствует; DIRECT `name` nullable | `GET /chats` нарушает контракт; PM изобретает `Chat` | `Chat` add; `name` nullable/derived | Contract-тест DIRECT null name |
| P2-8 | §6.3:1627–1629; §4.1:725–727 | `PrekeyBlock.spk_id/opk_id` без pattern `[A-Za-z0-9._-]` | Сервер примет id, который клиент/DDL потом отвергнут | Добавить pattern | Contract/schema |
| P2-9 | §2.5:1205; §6.3.1:1916 | `POST /devices` требует ключи; старые клиенты без ключей → 422; legacy-устройства «остаются», но новая регистрация старой версией невозможна | Rollout-разрыв: старый frontend/клиент не зарегистрируется после I-01 | Version gate/явный `422` с инструкцией; релизить backend+frontend одним PR; решить судьбу старых версий | Contract/integration legacy body |
| P2-10 | §6.2.8:1474; J3 | J3 input `peer_has_e2ee_capable_device` неоткуда получить для MANAGED-чата: `GET /chats/{id}/keys` → `409 MODE_NOT_SUPPORTED` (§6.2.6:1401); `ChatSummary` не содержит capability | «Признаки E2EE» нереализуемы как описано; остаётся fallback rule 4 (explicit confirmation) | Добавить `peer_has_e2ee_capable_devices` в ChatSummary/Chat или разрешить capability-метаданные для MANAGED; либо честно убрать criterion | J3 wire-realizable |
| P2-11 | §1.3:116–118; §6.5:2308 | DB принимает ciphertext 16..49152 decoded, канонический max 33040; 33041..49152 получатель отвергнет | DoS/UX: формально валидный, но невалидный по фреймингу конверт | Серверный canonical cap 33040 для E2EE или явное документирование | Boundary 33040/33041/49152 |
| P2-12 | §7.2:2403–2405; P2-14 review-02 | Verification scoped по `chat_id`, SN — по паре устройств; одна пара требует сверки в каждом чате | Ложные «не сверено»/потеря verification при удалении чата | Scope `(verifier_device,target_device)` или UI «сверено в другом чате» | G5 + два чата |
| P2-13 | §1.3:120; P2-15 review-02 | `ENVELOPE_WIRE_BUDGET=45056` посчитан для 5-символьных id; max id 64 добавляет ~118 B | Бюджет занижен; 10 конвертов всё ещё <512 KiB, но расчёт неверен | Пересчитать с max id | Boundary max ids |
| P2-14 | §1.3:134; §4.5:905 | `MAX_KEY_GENERATION=2^31-1`, но нет кода/поведения на overflow (для header есть `CHAIN_EXHAUSTED`) | Неопределённое поведение на 2^31 | `422 KEY_GENERATION_EXHAUSTED`/новая регистрация | Boundary |
| P2-15 | §1.3:136; §3.4.5.1:558 | `SESSION_IDLE_TTL=90d` может удалить сессию с in-flight outbox | Потеря нерасшифровываемых сообщений | Не удалять сессию с pending outbox; метрика | Property |
| P2-16 | §3.4.4:527; P2-18 review-02 | MKSKIPPED eviction самых старых — тихая потеря | Старые сообщения не расшифруются | Предупреждение/метрика, не тихое удаление | E2/property |
| P2-17 | §6.5:2276–2293; `WorkspaceRepositoryAdapter.java:91–101` | `ON CONFLICT ... DO UPDATE SET security_mode = EXCLUDED.security_mode` пересекается с immutability trigger | Onboarding-upsert на существующем workspace может дать 500/409 | `DO NOTHING` для `security_mode`; тест | Integration upsert |
| P2-18 | §6.5:2254–2273 | `ux_chats_direct_pair` падает и на дублях пары, если они есть до V16; repair-скрипт не входит в S3 | Миграция на исторических данных | Repair/diagnostic до unique-индекса; `NOT VALID`+validate | PG16 duplicate pair |
| P2-19 | §6.5:2002 | `DROP COLUMN identity_public_key` — destructive; backend Java её не использует (проверено grep), но внешние read-model/BI могут | Потеря данных/ошибка внешнего consumers | Проверить все consumers; отдельная миграция после деплоя | Migration + grep |
| P2-20 | §6.5:2008–2024 | `p_devices_chat_peer` — EXISTS-join на каждый SELECT; на больших чатах дорого | Латентность claim/keys/send | Функция `auth.devices_for_chat(chat_id)`/кэш; EXPLAIN | EXPLAIN |
| P2-21 | §6.5:2234 | `vh_version integer NOT NULL DEFAULT 2 CHECK (vh_version=2)` — default 2 означает, что старый/ошибочный INSERT без `vh_version` пройдёт как v2 | «v1 untrusted» не enforced на DB-уровне, только API | Убрать default; `NOT NULL` без default; API обязан передать | INSERT без vh → fail |
| P2-22 | §6.5:2181–2183 | Policy `p_<part>_tenant` для `messages`/envelopes использует `ops.current_workspace_id()`; при `NULL` контексте — 0 строк (fail-closed, хорошо), но нет теста | Ошибка контекста выглядит как «нет данных» | Явный тест «no context → 0 rows + метрика» | PG16 |

**Открытые P2 из review-02/S3:** P2-11 (form cap vs canonical — P2-11 выше), P2-14 (chat-scoped verification — P2-12), P2-15 (wire budget — P2-13), P2-16 (generation overflow — P2-14), P2-17 (idle TTL — P2-15), P2-18 (MKSKIPPED — P2-16), P2-19 (**I-01**, open). P2-6 (squatting) — partial: риск записан, challenge v1.1; P2-10 (repair) — partial, подтверждён P1-A-1.

---

## Closure matrix (P0-2b/P0-3/P1-A..H/5/6 + evidence)

| ID | Заявление S3 | Review-03 | Evidence / остаток |
|---|---|---|---|
| **P0-2b** | closed | **CLOSED** | §3.3.1:425–426/430–433, §3.3.2:443, §3.3.3:457, §4.1:766, §4.7:934/958–961; I3: server 422, client `KEY_HANDSHAKE_INVALID`, no session/OPK/display; мой verifier: sig/binding/X3DH/AD/AEAD I3 валидны, mismatch только по registered/bundle |
| **P0-3** | closed | **CLOSED (P1-G text)** | §6.2.8:1470–1477; J1/J2/J3; PG16 T23 trigger `MODE_CHANGE_FORBIDDEN`; J3 block, 0 plaintext. Остаток: §6.2.8 3(б) in-place MANAGED — P1-G-1 |
| **P1-A** | closed | **PARTIAL** | grants/RLS/`p_devices_chat_peer`/partitions/`reply_to_id`/sender/`vh_version` работают под `krug_app` (T01–T33); **но** backfill вырожденного DIRECT падает (P1-A-1), duplicate indexes (P2-1), key_verifications ownership (P2-3), claim workspace (P2-4) |
| **P1-B** | closed | **PARTIAL** | M1 409 / M2 201+warning сходятся; **но** legacy-target даёт ложный `peer_covered` (P1-B-1), M3 отсутствует |
| **P1-C** | closed | **PARTIAL** | L3: 5 сообщений, все новые id, 0 дублей при `delivered_before_reset=0`; **но** при частичной доставке дубли (P1-C-1), L3b отсутствует |
| **P1-D** | closed | **CLOSED** | §1.3:128/137 (3/90), §3.4.5.1:550–562 (OPK/DHs/SPK/MKSKIPPED, PCS, zeroization), S1; «2 total/60» нигде не осталось |
| **P1-E** | closed | **CLOSED (I1/I2/I3); P2-6 residual** | I1/I2/I3 `presented_*`/`pinned_*` — 86 b64u, 64 B; мой verifier decode; I2: AEAD/sig/binding valid, pin mismatch → `KEY_CHANGE_DETECTED`, no session/OPK/display. B3/B4 hex — P2-6 |
| **P1-F** | closed | **CLOSED (spec/DB), I-01 open** | §4.2:793, §4.7:947, R1: 422, field `reply_to_id`, no message/seq, DB `ck_messages_e2ee_no_reply_to_id` (T20); контракт не применён |
| **P1-G** | closed | **PARTIAL** | J3 block/0 plaintext; **но** §6.2.8 3(б) in-place (P1-G-1); J3 capability input нереализуем (P2-10) |
| **P1-H** | closed | **CLOSED (spec), I-01 open** | §6.3:1869–1880, §6.3.1:1931; `ChatSummary.peer_id` nullable; контракт — PM |
| **P1-5** | closed (spec) | **PARTIAL** | `direct_key` normal backfill/unique — PG16 ok; вырожденный DIRECT — P1-A-1; contract — I-01 |
| **P1-6** | closed (spec) | **CLOSED (spec)** | §2.5/§3.1/§4.6/§6.2.1/§6.2.2; N1 410/`DEVICE_REVOKED`, N2 422/`E2EE_LEGACY_DEVICE`; P2-9 legacy clients |
| **P1-1** | closed | **PARTIAL** | L1/L2/L3; P1-C-1 duplicates |
| **P1-2** | closed | **CLOSED** | B5: 88 B, verify/negative; §3.1/§7.1 |
| **P1-3** | closed | **CLOSED** | limits arithmetic: 33024/33040/44054/45001/405098/450099/119190/74189; boundary — E7-B7; P2-11 form cap |
| **P1-4** | closed | **CLOSED** | V10 dropped TEXT→body; V4 `crypto_scheme`; V14 `sticker_id`; no `text`; §6.5 CHECKs; P2-1/P2-2 |
| **P1-7** | closed | **PARTIAL** | `peer_devices==0`→409; P1-B-1 legacy bypass |
| **P1-8** | closed | **CLOSED** | §3.4.5.1, S1; P2-15/P2-16 are GC/TTL, not FS |
| **P1-9** | closed | **CLOSED** | §3.3.2:447, §3.4.2:493; E1 `alice-ratchet-0 ≠ alice-ek`; my verifier |
| **P1-10** | closed | **CLOSED** | K1/K2; scope `(chat_id,sender_id,client_message_id)`; PG16 index/checks |
| **P1-11** | closed | **CLOSED** | §2.3:219–225; `STORAGE_LOCKED` removed; `KEY_STORAGE_UNAVAILABLE` |
| **P1-12** | closed | **CLOSED (spec)** | J1/J2; §6.2.8:1468, §6.6, §10.4; contract I-01 |
| **I-01** | open (PM) | **OPEN/PARTIAL** | §6.3.1:1907–1941; `contracts/**` не изменены; gaps P2-7/P1-I01-1 |
| P2-1/2/3/4/5/8/9/12/13 | closed | **CLOSED** | G5, `vh_version` (T22), `NOT_MEMBER` removed, legacy/N1/N2, 273 meta, conventions, sender CHECK (T21), §4.3 P2-13 |
| P2-6 | partial | **PARTIAL** | §2.5; challenge v1.1; squatting residual |
| P2-10 | partial | **PARTIAL** | `min(uuid)` fixed; repair не в S3; P1-A-1 |
| P2-11/14–18 | open | **OPEN** | P2-11/P2-12/P2-13/P2-14/P2-15/P2-16 |
| P2-19 | open | **OPEN** | = I-01 |

**Итог матрицы.** P0: 4/4 closed (P0-3 с текстовой оговоркой). P1-1..12: **9 closed, 3 partial** (P1-1/P1-5/P1-7). P1-A..H: **4 closed, 4 partial** (A/B/C/G). I-01 open. Блокирующие P2 review-02 закрыты; P2-6/10 partial; P2-11/14–18 открыты и не блокируют E7-B1.

---

## Векторы (команды/результаты)

### Команды

```bash
# 1) авторский S3-верификатор, извлечён из docs/E2EE-SPIKE-NOTES.md §10.3
node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json
# 273 checks, 0 failures

# 2) мой независимый верификатор, написан по §1–§7 спеки (не импортирует код генератора/верификатора)
python3 independent_verify.py docs/E2EE-TEST-VECTORS.json
# 242 checks, 0 failures

# 3) детерминизм: S2-генератор §9.1 + S3-патч §10.2 в чистой директории
python3 gen_s2.py && python3 gen_s3.py
# S3 patch written; vectors: 43 sections: 17
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8
cmp docs/E2EE-TEST-VECTORS.json <repo>/docs/E2EE-TEST-VECTORS.json
# IDENTICAL
```

Скрипты лежали в `/tmp/e2ee_review3`, в репозиторий не добавлялись (зона — только этот файл).

### Что покрыто (16 нормативных секций + meta)

| Секция | Что пересчитано | Результат |
|---|---|---|
| A1–A4 | X25519 RFC 7748, Ed25519 RFC 8032, HKDF RFC 5869, AES-256-GCM NIST | 0 failures |
| B1–B5 | DH1–DH4, IKM/SK/SID, 3DH, SPK-подпись, преамбул 323 B, binding 88 B | 0 failures |
| C1–C3 | session_id, root step, три message key | 0 failures |
| D1–D3 | framing 51→77→256 (179 нулей), AD 163 B, AEAD, decrypt/re-encrypt | 0 failures |
| E1 | 4 сообщения, 2 DH-ratchet turn, `pn`, AD, все ciphertext | 0 failures |
| E2 | chain 0..2, AD, delivery 0,2,1, skipped n=1, `Nr=3` | 0 failures |
| F1–F2 | JSON 1310/756 B, b64u, prekey/header/AD/preamble из полей, подпись, ciphertext | 0 failures |
| G1–G5 | FP, SN 60 digits, key change, VH v2, per-device L1/L2 | 0 failures |
| I1–I3 | wire-valid b64u, preamble/binding, Mallory X3DH/AD/AEAD, TOFU mismatch, prekey↔registered mismatch | 0 failures |
| J1–J3 | mode immutability, flag-off, fresh-device block/0 plaintext | 0 failures |
| K1–K2 | sender-scoped replay, cross-user 409 | 0 failures |
| L1–L3 | content_type=2 framing, reset state machine, multi-message | 0 failures |
| M1–M2 | peer_covered==0→409; partial→201+warning; M2 wire-valid F1 | 0 failures |
| N1–N2 | REVOKED→410, legacy prekeys→422 | 0 failures |
| R1 | `reply_to_id`→422, no message/seq, DB check, not in AD | 0 failures |
| S1 | 3 SPK/90, destruction, PCS/idle/zeroization | 0 failures |
| meta | 43/17, 273/0, v3, envelope v1, limits arithmetic | 0 failures |

H-sender-key — informative, в нормативный объём не входит; я не пересчитывал его отдельно (это честно, не «все 17»).

### I3/J3/M1/M2/L3/N1/N2/R1/S1 — отдельно

- **I3.** Проверено: `prekey.sender_identity_*` ≠ `registered`/`bundle`; подпись преамбула и binding **валидны** для подставленных ключей; envelope байт-в-байт совпадает с I1; X3DH → `session_id`, AD 163 B и AEAD расшифровываются. Ожидания `422`/`KEY_HANDSHAKE_INVALID`, `session_created=false`, `opk_consumed=false`, `message_displayed=false`, `tofu_pin_written=false` — согласованы со спекой.
- **J3.** `client_has_pin=false`, `pin=null`, `peer_has_e2ee_capable_device=true`, `chat_had_e2ee_history=true`, server MANAGED → `BLOCK_SEND_SECURITY_ALERT`, `server_request_sent=false`, `plaintext_messages_sent=0`, `fallback_to_managed_allowed=false`, `allow_after_user_confirmation` — E2EE only / новый managed. Замечание P2-10: capability-input неоткуда получить для MANAGED-чата.
- **M1.** `peer_devices=2`, `peer_covered=0` → `409 E2EE_NO_PEER_ENVELOPE`, `message_created=false`, `seq_allocated=false`, `warning=null`.
- **M2.** `peer_devices=2`, `peer_covered=1` → `201`, `warning=PEER_DEVICE_UNCOVERED`, uncovered `…022`; встроенный envelope — F1, recipient `…021`.
- **L3.** 5 старых id, все новые, порядок, 0 дублей при `delivered_before_reset=0`, batch 20, `superseded`, пустой outbox no-op. P1-C-1 — частичная доставка не покрыта.
- **N1/N2.** REVOKED+same IK → 410, без реактивации/новой строки, generation 2; legacy prekeys → 422 `E2EE_LEGACY_DEVICE`, `prekeys_stored=false`, claim reason `NO_KEYS`.
- **R1.** 422, `details.field=reply_to_id`, no message/seq, DB `ck_messages_e2ee_no_reply_to_id`; `reply_to_id` не в AD.
- **S1.** 3/90, OPK immediately, old DHs immediately, PCS after reply, idle TTL не FS, zeroization best-effort, deleted SPK → `KEY_HANDSHAKE_INVALID`/reset.

### Tamper/negative (сверх JSON)

| Подмена | Ожидание | Факт |
|---|---|---|
| D2 ciphertext, 1 байт | AEAD fail | reject |
| D2 AD `chat_id` / `session_id` / `header.n` | AEAD fail | reject (все три) |
| B4 преамбул, 1 байт / подпись, 1 байт | signature fail | reject |
| B5 binding message, 1 байт | verify fail | reject |
| I1/I2/I3 AEAD | расшифровывается (валидный конверт) | decrypt ok, 256 B, padding 256 |
| I2 pin fp ≠ presented fp | `KEY_CHANGE_DETECTED` | mismatch=true; AEAD/sig/binding при этом валидны |
| F1 prekey sig = B4 signature | одна и та же подпись | `b64u(B4.sig) == F1.prekey.signature` |

### Арифметика лимитов (независимо)

`32794 → 33024 → 33040 → 44054`; 9 конвертов `405098`, 10 `450099`; slack `119190`/`74189`; `45001*10+89=450649 < 524288`; canonical fit 11, form cap fit 7; `b64u(272)=363`. Всё сходится.

### Что векторами не проверяется (честно)

Browser WebCrypto (non-extractable/structured clone/Safari/Firefox), IndexedDB/transactions/crash-recovery, multi-tab, реальный Java Ed25519, proxy 413, RLS на реальном Postgres (проверено отдельно smoke, не векторами), H-sender-key. Это G2–G4/E7-B/E7-F.

---

## DDL smoke

### Воспроизведение

```bash
docker run -d --name e2ee_g2_pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=krug -p 55432:5432 postgres:16
# PostgreSQL 16.16
# (a) как в §2.4 changelog: V1–V15 по одной, затем §6.5 одной транзакцией
for f in V1..V15; do psql -U postgres -d krug -v ON_ERROR_STOP=1 -f "$f"; done
psql -U postgres -d krug -v ON_ERROR_STOP=1 -1 -f v16_spec.sql
# (b) строже: V1–V15 + §6.5 одним файлом в одной транзакции (1558 строк)
cat $(ls V*.sql | sort -V) v16_spec.sql > all_single.sql
psql -U postgres -d krug -v ON_ERROR_STOP=1 -1 -f all_single.sql
# оба варианта: exit 0; 3 partition ensure_partition
```

Затем seed (2 workspace, DIRECT A–B и A–C, 5 E2EE-устройств + 1 legacy, prekeys) и тесты под `SET ROLE krug_app` + `set_config('app.user_id'/'app.workspace_id')`.

### Результаты (фактические)

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| T01 | peer devices (B) | 2 | 2 |
| T02 | non-peer devices (C) | 0 | 0 |
| T03 | self devices (A) | 3 (2 E2EE + legacy) | 3 |
| T04 | peer prekeys B | 4 строки (3 OPK + 1 SPK) | 4 |
| T05 | non-peer prekeys C | 0 | 0 |
| T06–T08 | claim OPK | `opk-1`, `opk-2`, `opk-3` | совпало |
| T09 | claim exhausted | NULL | NULL |
| T10 | claim в чужой чат | UNKNOWN_DEVICE | `22023 UNKNOWN_DEVICE` |
| T11 | peer INSERT prekey | RLS violation | `42501` |
| T12 | own prekey INSERT | ok | ok |
| T13 | peer UPDATE prekey | 0 rows | 0 |
| T14 | peer UPDATE device | 0 rows | 0 |
| T15 | E2EE message INSERT | ok | ok |
| T16 | envelope в текущую партицию | 1 | 1 |
| T17 | envelope в чужой workspace | RLS violation | `42501` |
| T18 | verification own | ok | ok |
| T19 | verification чужой workspace | RLS violation | `42501` |
| T20 | E2EE `reply_to_id` | CHECK fail | `ck_messages_e2ee_no_reply_to_id` |
| T21 | E2EE NULL sender | CHECK fail | `ck_messages_e2ee_sender_required` |
| T22 | `vh_version=1` | CHECK fail | `key_verifications_vh_version_check` |
| T23 | `UPDATE security_mode` | exception | `MODE_CHANGE_FORBIDDEN` |
| T24 | envelopes partitions | 3 | 3 |
| T25 | cross-workspace envelope SELECT | 0 | 0 |
| T26 | own device claim | OPK | `opk-a` |
| T27 | E2EE `body_ciphertext` | CHECK fail | `ck_messages_e2ee_no_managed_body` |
| T28 | managed message | ok | ok |
| T29 | attachment-only TEXT | ok | ok |
| T30/T32 | DIRECT duplicate pair | unique violation | `23505 ux_chats_direct_pair` (T32) |
| T31 | E2EE `content_meta` non-empty | CHECK fail | `ck_messages_e2ee_meta` |
| T33 | indexes on current envelope partition | 4 | **7** (P2-1) |

**Self/claim не сломаны:** T03/T12/T26 + own `UPDATE auth.devices` (A1 renamed) работают; peer-read — только по общему чату; cross-tenant — 0/RLS.

### Backfill

- **Нормальный** DIRECT с 2 ACTIVE: V16 exit 0; `direct_key = 000…001:000…002`; `ux_chats_direct_pair` создан. Это воспроизводит заявление §2.4 changelog.
- **Вырожденный** DIRECT (1 ACTIVE, второй REMOVED): V16 exit **3**, `ERROR: check constraint "ck_chats_direct_key" ... is violated by some row`; транзакция откатилась, constraint отсутствует. Это **P1-A-1**, блокер E7-B1 на реальных данных.

### Ограничения smoke

Это не Testcontainers E7-B1: нет конкурентной гонки claim, Flyway, реальных исторических данных, `EXPLAIN`, job-планировщика. Роль `krug_app` и RLS проверены; grants/partitions — да. Smoke доказывает исполнимость §6.5 на чистой V1–V15 и обнаруживает backfill-дефект, но не заменяет миграционный тест.

---

## I-01 readiness

**Ответ: PARTIAL — handoff применим, но не «без изобретений».**

Что уже достаточно в §6.3.1:1907–1941:
- полный список схем и полей (включая `Base64Url16/32/64`, `CryptoEnvelope`, `PrekeyBlock`, `Device`, `DeviceList`, `PrekeyUploadResult`, `KeyClaimRequest`/`PrekeyBundle`/`UnavailableDevice`/`KeyClaimResponse`, `DeviceKeyInfo`, `ChatKeysResponse`, `VerificationRequest/Response`, `EnvelopeCoverage`, `Message`/`MessageCreate`/`MessageCreateResult`, `ChatSummary.peer_id`, `ErrorCode`);
- paths/статусы/`X-Device-Id`/`Idempotency-Key`/`GET /chats` — перечислены; текущий контракт — OpenAPI 3.1, так что `type: [string,"null"]` и `contentEncoding` валидны;
- WS `chat.keys.changed`/`device.list.changed`, запрет `chat.session.reset`;
- `npm run api:types` + `contract:check`, порядок PR и contract-тесты.

Чего не хватает (нужны решения PM, не «изобретения крипто»):
1. `Chat` в контракте отсутствует; handoff говорит «расширить» — надо **добавить** (полная схема есть в §6.3).
2. `ChatSummary.name` required string vs `Chat.name` nullable → `GET /chats` для DIRECT с `name=null` нарушит контракт; сделать nullable/derived.
3. `DeviceRegistration` с обязательными ключами ломает старые клиенты; нужен rollout/version gate (P2-9).
4. `MessageCreateResult.envelope_coverage` should be required для E2EE; `PrekeyBlock.spk_id/opk_id` — pattern; `EnvelopeCoverage.peer_devices.minimum=1` — ок при P1-B, но проверить self-only сценарий.

**Вывод.** PM может применить A–C без изменения крипто-семантики, но 4 пункта выше требуют явного решения; после них I-01 можно закрывать. Без I-01 E7-B3/B4/B5/F3 не стартуют (backend/frontend несовместимы).

---

## Условия GO для E7-B1

### Блокирующие для E7-B1 (иначе NO-GO на миграцию)

1. **P1-A-1/P1-5-1:** починить backfill `direct_key` для DIRECT-чатов, где не ровно 2 ACTIVE (removed/1/3, а также deleted с <2 ACTIVE), и для дублей пары; либо `NOT VALID` + repair + `VALIDATE`. Добавить миграционный тест на реальном снимке V1–V15 (2 пользователя, DIRECT с removed-участником, deleted DIRECT, duplicate pair).
2. **PG16/Testcontainers:** повторить V1–V15 + §6.5 под `krug_app` на данных, а не на пустой БД; проверить `GRANT`/RLS/partitions после backfill; `EXPLAIN` на `(recipient_device_id, created_at)`.
3. **P2-17:** убрать/защитить `ON CONFLICT ... SET security_mode = EXCLUDED.security_mode` в `WorkspaceRepositoryAdapter` до включения trigger; иначе onboarding-upsert может дать 500 на существующем workspace.
4. **P2-19:** подтвердить, что `DROP COLUMN identity_public_key` не используется внешними read-model/BI; иначе — отдельная миграция/период deprecation.
5. **P2-1/P2-2:** решить duplicate indexes и `UNIQUE (message_id, recipient_device_id)` до B1 (иначе индексы/дубли закрепятся в схеме).

### До E7-B4/B5/включения E2EE

6. **P1-B-1:** `target.e2ee_capable` + `peer_covered` только по capable; M3.
7. **P1-C-1:** окно повторной отправки по `failed_n`/старым id или дедуп; L3b.
8. **P1-G-1:** §6.2.8 3(б) — только новый managed-чат, никогда in-place; синхронизировать §7.6/§9.3/J3.
9. **I-01:** применить §6.3.1 + regenerated `schema.d.ts` + contract-тесты; решить 4 gaps.
10. **P1-E/P2-6:** B3/B4 wire-кодировка (b64u) или явная конверсия; schema-check всех wire-подписей.
11. **P2-3/P2-4/P2-10:** ownership `key_verifications`, workspace-check claim, канал capability для J3.
12. **G2/G3/G4:** browser KAT (Node ≠ браузер), E2E двух браузеров, внешний review реализации/пентест. Без G4 — flag off в prod.

### Что можно начинать сразу (flag off)

- E7-B2 (VO/identity binding) — можно, контракт §6.3 согласован.
- E7-B1 — **только после** пункта 1 (backfill) и 2 (данные).
- E7-B3/B4/B5 — после I-01 + P1-B/C/G.
- E7-F1/F2 — можно (KAT/WebCrypto/storage), векторы v3.
- Включение E2EE/реальные ключи/бейдж — **нет** до G4.

---

## Вопросы

1. **P1-B-1.** Подтверждаете, что `recipient_device_id` в E2EE-конверте обязан быть `e2ee_capable=true`, а `peer_covered` считается только по capable? Если нет — как отличить «покрыт legacy» от «покрыт capable» в `201`?
2. **P1-C-1.** При частичной доставке reset перешифровывает все pending или только `n >= failed_n`? Какой ключ дедупликации у получателя (старые `client_message_id` в reset или иное)?
3. **P1-A-1.** Как чинить DIRECT с removed-участником: backfill по любым двум членам, `NOT VALID` + repair, или fail-fast с diagnostic? Кто владелец repair-скрипта (E7-B1)?
4. **P1-G-1.** Подтверждаете «никогда in-place MANAGED, только новый чат»? Можно ли поправить §6.2.8 3(б) без изменения J3?
5. **P1-I01-1.** `ChatSummary.name` — nullable или derived display name? `Chat` добавляется как новая схема? Какой rollout для старых клиентов `POST /devices` без ключей?
6. **P2-6.** B3/B4: добавить b64u-поля или оставить hex с явной инструкцией конверсии в §8.3? Почему конвенция говорит «never appear on the wire», если B4 = `prekey.signature`?
7. **P2-10.** Какой канал даёт `peer_has_e2ee_capable_device` для MANAGED-чата, если `GET /keys` → 409? Добавлять поле в `ChatSummary` или убрать criterion?
8. **P2-1/P2-2.** Индексы envelopes: parent-only или child-only? Нужен ли `UNIQUE (message_id, recipient_device_id)` в v1?
9. **P2-3/P2-4.** Добавляем FK/ownership для `key_verifications` и workspace-check в claim-функцию, или это app-level и достаточно текущего RLS?
10. **P2-17.** Когда будет убран `ON CONFLICT ... security_mode`? Это часть E7-B1 или отдельный backend-PR?
11. **P2-19.** Есть ли внешние consumers `identity_public_key` (BI/read-model), которых нет в Java-коде? Нужен ли deprecation-период?
12. **P2-11/14–18.** Кто и к какому этапу закрывает открытые P2 (form cap, chat-scoped verification, wire budget, generation overflow, idle TTL, MKSKIPPED)? Это backlog E7-B7 или v1.1?

---

*Конец review-03. Изменён только `docs/E2EE-REVIEW-03.md`; `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md`, `docs/TASKS*.md`, `contracts/**`, `backend/**`, `frontend/**` не изменялись.*

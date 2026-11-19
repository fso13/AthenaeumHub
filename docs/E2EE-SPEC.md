# E2EE 1:1 — протокол, wire format и план реализации (v1)

> **Статус:** SPIKE / нормативное предложение, **редакция S4** (targeted remediation по [`docs/E2EE-REVIEW-03.md`](<E2EE-REVIEW-03.md>); предыдущие — S3 по [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>), S2 по [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>)). Production-код не написан и не изменён.
> **Задача:** [`docs/TASKS-E7.md`](<TASKS-E7.md>) §1 (E7-S) + E7-S2 + E7-S3 + E7-S4.
> **Источники:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §6.8, §7, §8.2, §9.6, §11, ADR-04/05/06/23, FR-SEC-2/4/5/6/9; [`docs/CONCEPT.md`](<CONCEPT.md>) §8 — только как контекст; [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>) — 4 P0 + 12 P1; [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>) — 2 P0 + 6 P1 partial + I-01.
> **Векторы:** [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) (**48 векторов, 18 секций**; 345 независимых проверок базового v4-набора + O-векторы AAD, `vector_set_version=4` + addendum E7-F2G). Envelope wire format остался `v=1` (`header.v=1`, AD 163 B, преамбул 313+L+M); менялись только `VH` (v2), API/DDL и wire-кодировка подписей (hex → b64u64 в B3/B4/I1/I2).
> **Заметки спайка:** [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) — генератор/верификатор S2 (§9), S3-патч/верификатор (§10) и **S4-патч/верификатор + PG16 smoke (§11)**, арифметика лимитов, отклонения, вопросы.
> **Changelog S4:** [`docs/E2EE-S4-CHANGELOG.md`](<E2EE-S4-CHANGELOG.md>) — что/где/какой тест по P1-A/B/C/G и I-01 review-03, closure matrix, artifacts. S3 — [`docs/E2EE-S3-CHANGELOG.md`](<E2EE-S3-CHANGELOG.md>), S2 — [`docs/E2EE-S2-CHANGELOG.md`](<E2EE-S2-CHANGELOG.md>).
> **Контракты не изменены.** Все delta к `contracts/openapi.yaml`, `contracts/ws-protocol.md` и `backend/**` — только текстовые предложения в §6 и §11; точный handoff I-01 — §6.3.1. Миграции E7-B1 должны быть написаны по §6.5 (исправлено против фактических V1–V15), а не по старой редакции.
>
> **Что зафиксировано решениями PM в S2/S3/S4:** D-05 (обязательный `chat_id` в claim), D-06 (**512 KiB — wire-лимит**, per-envelope **64 KiB encoded**, inner body **32 KiB decoded**), D-07 (`client_message_id` в `Message`, scope `(chat_id, sender_id, client_message_id)`), D-17 (legacy не апгрейдится in-place; prekeys → `422 E2EE_LEGACY_DEVICE`), D-18 (`SPK_RETAIN_PRIVATE=3`, окно **90** дней; «2 total/60» отклонено), D-19 (`reply_to_id` в E2EE запрещён на верхнем уровне, разрешён в inner payload), D-20 (`peer_covered>=1` обязателен; partial coverage — warning), D-21 (reset покрывает всю failed-сессию, batch 20), D-22 (fresh-device MANAGED без пина → block, не plaintext; **in-place downgrade запрещён**, только `E2EE_ONLY` или новый managed-чат), D-23 (`direct_key` по двум любым участникам DIRECT, CHECK `NOT VALID`+`VALIDATE`, fail-fast + runbook), D-24 (coverage только по `e2ee_capable`; legacy-target → `422 E2EE_LEGACY_DEVICE`), D-25 (reset: окно от `retry_of_client_message_id`/`failed_n`, дедуп по `retry_of_client_message_id`), D-26 (canonical ciphertext cap 33040 в API+БД, 65536 — только form guard), D-27 (`DeviceRegistration` keys optional/all-or-none, legacy rollout), D-28 (`ChatSummary.name` nullable + `peer_has_e2ee_capable_devices`). Две identity-пары приняты с обязательной самоподписью `IK_sig → IK_dh`. **Self-envelope отклонён**: отправитель обязан атомарно сохранить локальную копию до отправки.

---

## 0. Резюме для ревьюера

1. **Модель:** у каждого **устройства** свой независимый набор ключей. Identity — **две** долгоживущие пары: Ed25519 для подписей и X25519 для DH. Связь между ними доказывается **самоподписью** `identity_binding_signature = Ed25519(IK_sig, D_IKBIND || IK_dh || IK_sig)` (S2, P1-2), а не только fingerprint. Это отклонение от «Ed25519 и для подписи, и для DH» (XEdDSA) зафиксировано как **E2EE-ADR-01**: в браузере нет XEdDSA, а тащить WASM/libsodium в v1 дороже по review-поверхности.
2. **Handshake:** X3DH-подобный: `DH1=DH(IK_A, SPK_B)`, `DH2=DH(EK_A, IK_B)`, `DH3=DH(EK_A, SPK_B)`, `DH4=DH(EK_A, OPK_B)`; `SK=HKDF-SHA-256(0xFF×32 || DH1..DH4, salt=0^32, info="Krug/E2EE/v1/x3dh")`. При отсутствии one-time prekey — 3DH, с честным предупреждением о более слабой forward secrecy.
3. **Аутентификация handshake:** подпись Ed25519 над **бинарным преамбулом**, который связывает чат, оба устройства, обе identity, все prekey-ключи и `session_id`. Это не «чистый X3DH» (там подписи первого сообщения нет) и не libsignal: мы добавляем явную подпись, чтобы исключить подмену/склейку транскрипта.
4. **Double Ratchet:** стандартные `KDF_RK`/`KDF_CK` (Signal DR), AES-256-GCM с ключом и nonce, выведенными из message key; AD — 163-байтовая бинарная структура, а **не** JSON. JSON-канонизация в криптографии не используется нигде.
5. **Multi-device:** до 5 активных устройств; конверт на **каждое** устройство получателя и на **каждое другое устройство отправителя** (до 9 конвертов при 5+5). **Self-envelope отсутствует** (решение PM): своё текущее устройство обязано **атомарно сохранить локальную копию ciphertext и plaintext до отправки** (§3.4.6, §5.2); свои другие устройства получают обычный fan-out. Новое устройство **не получает историю** — это не баг, а отсутствие backup v1.
6. **Сервер:** хранит публичные ключи, prekeys, opaque `ciphertext` и структурные поля конверта; проверяет **только структуру, подпись signed prekey и identity binding** публичными ключами; никогда не расшифровывает, не индексирует, не логирует контент. Поиск/DLP/серверные плагины в E2EE возвращают `409 MODE_NOT_SUPPORTED`.
7. **Verification per-device:** safety number на **пару устройств** (не на пользователя), 60 цифр, QR; `verified` — свойство **пары (verifier_device_id, target_device_id, chat_id)**, а не пользователя. Сервер хранит только `safety_number_hash` и метаданные сверки; `VH` v2 включает `verifier_device_id`. Клиент — источник истины; серверный флаг `verified` — attestation, не доказательство.
8. **Wire:** `POST /messages` получает `envelopes[]` и **не** принимает plaintext в E2EE; `GET /messages` отдаёт `crypto` только для устройства из `X-Device-Id`, иначе `crypto:null`. `client_message_id` добавлен в `Message` (долг I-01) и нужен для локального кэша/outbox. Scope уникальности — `(chat_id, sender_id, client_message_id)`; replay только для своего сообщения (P1-10).
9. **Ключевая честность:** сервер видит метаданные (участники, время, размеры, число конвертов, IP, device_id), но не текст. Компрометация устройства, скриншоты, принуждение к разблокировке, квантовые атаки и подмена ключей без key transparency — вне обещаний.
10. **Объём E7:** только 1:1, только текст (и reply), только в E2EE-воркспейсе. Группы/sender keys, файлы, стикеры, backup, MLS, sealed sender — следующие фазы.
11. **Порядок работ:** сначала внешний crypto-review этой спеки и векторов, затем крипто-ядро. Инфраструктуру/контракты/хранение/UI-каркас можно делать до review; включать E2EE в production — нельзя.
12. **Главные вопросы к ревьюеру:** две identity-пары vs XEdDSA; per-device safety number; отсутствие self-envelope; 512 KiB лимит запроса; серверная проверка подписи SPK; правило одновременного инициирования сессий. Полный список — §10.7; ответы S2 — §10.9 и changelog.
13. **Результат S2:** P0-1/P0-4 закрыты, P0-2/P0-3 и 6 P1 — частично (review-02): не было prekey↔registered binding, fresh-device режима, DDL grants/RLS/partitions, multi-message reset, `peer_covered`, FS-чисел, wire-кодировки I1/I2 и контракта I-01. Wire format не менялся.
14. **Результат S3:** закрыты P0-2b (prekey↔`auth.devices`/bundle, I3), P1-A (grants/RLS/partitions/CHECK), P1-E (b64u64), P1-B (coverage), P1-C (multi-reset), P1-D (3 SPK/90), P1-G (fresh-device block), P1-F (`reply_to_id`), P1-H (`ChatSummary.peer_id`), P1-5/6 (contract handoff, legacy code, REVOKED idempotency); P2-1/2/3/4/5/8/9 закрыты текстом/векторами. I-01 остаётся **open для PM**: §6.3.1 — точный список, контракт не тронут.
15. **Результат S4 (targeted, review-03):** закрыты P1-A-1 (degraded DIRECT backfill + инвариант `direct_key`), P1-B-1 (coverage только `e2ee_capable`, M3), P1-C-1 (reset по `failed_n`/`failed_chain_dh` + дедуп по `retry_of_client_message_id`, L3b), P1-G-1 (никогда in-place MANAGED), P1-I01-1 (handoff без изобретений: `Chat`/`ChatCreateRequest`, `name` nullable, backward-compatible `DeviceRegistration`, `envelope_coverage`, prekey patterns, `peer_id`, точный порядок файлов). P2-1 (4 индекса), P2-3 (ownership/FK `key_verifications`), P2-4 (claim workspace), P2-5 (64 B), P2-6 (B3/B4 wire b64u64), P2-11 (canonical cap 33040 в БД) закрыты в спеке/векторах. Wire format **не менялся** (`envelope.v=1`); векторы — v4 + O-addendum (48/18).

### 0.3. Что изменилось в S4 (карта для ревьюера)

| ID review-03 | Решение S4 | Где в спеке | Вектор/тест |
|---|---|---|---|
| **P1-A-1 / P1-5-1** degraded DIRECT | Инвариант: `direct_key` = `least(A,B):greatest(A,B)` по **множеству `chat_members.user_id` независимо от status** (REMOVED/INVITED — участники пары). Preflight `DIRECT_KEY_UNRESOLVED` при `count(DISTINCT user_id) <> 2`; CHECK `NOT VALID` → `VALIDATE`; `ck_chats_direct_key_format` (порядок + UUID) закрывает обход unique через `B:A`; duplicate-pair preflight `DIRECT_PAIR_DUPLICATE` + runbook soft-delete | §6.2.8, §6.5 (5a–5e), §6.5.1, **§6.5.2** | PG16 smoke: V1–V15 + §6.5 на normal + degraded (1 ACTIVE + 1 REMOVED) + deleted DIRECT; corrupt/duplicate — понятная ошибка, после runbook V16 применяется (30/30 проверок) |
| **P1-B-1** legacy в coverage | `peer_devices`/`peer_covered`/`self_*` — только `e2ee_capable`; конверт на legacy-target → `422 E2EE_LEGACY_DEVICE` до `Message`/`seq`; legacy не кандидат и не в `uncovered_device_ids` | §4.2, §4.5, §4.7, §4.8, §5.2 | **M3-peer-legacy-not-coverage** (2 варианта: legacy-only → 422; capable-only → 201/covered=1) |
| **P1-C-1** дубли при частичной доставке | Reset несёт `failed_chain_dh` + `failed_n` + `retry_of_client_message_id`; отправитель перешифровывает только сообщения с якоря и позже (локальный send order) и дедуплицирует повторный reset по `(failed_session_id, failed_chain_dh, failed_n, retry_of_client_message_id)`. Полный L3b-дедуп на получателе по `retry_of_client_message_id` требует поля в TEXT — это **v1.1**; в v1 wire не меняется | §1.3, §3.5.1, §5.5 | **L3b** (v1: sender window + reset dedupe); v1.1: receiver dedupe; L1 = wire-фрейминг reset |
| **P1-G-1** in-place MANAGED | §6.2.8 п. 3(б): только `E2EE_ONLY` **или новый managed-чат**; in-place downgrade запрещён, текущий чат остаётся E2EE/заблокированным; критерий «признаки E2EE» стал проводным (`ChatSummary.peer_has_e2ee_capable_devices`) | §6.2.8, §7.6, §9.3, §6.3/§6.3.1 | **J3** (без изменений) + contract-тест `peer_has_e2ee_capable_devices` |
| **P1-I01-1** handoff | 6 решений PM (D-S4-01…06) + пофайловый handoff: `Chat`/`ChatCreateRequest` **add** (в контракте отсутствуют), `ChatSummary.name` nullable, `DeviceRegistration` keys **optional** (rollout), `MessageCreateResult.envelope_coverage` required для E2EE, `PrekeyBlock.spk_id/opk_id` pattern, `ciphertext.maxLength: 44054`, точный порядок openapi → ws → `api:types` → contract-check | §6.3, **§6.3.1** | contract-тесты: `GET /workspaces/{id}/chats` DIRECT `name=null`; legacy `POST /devices`; E2EE `MessageCreateResult`; schema regen |
| **P2-1** 7 индексов | Убраны child-индексы envelopes в `ensure_partition`; parent-индексы наследуются (включая будущие партиции) | §6.5 (3a/7), §6.5.1 | PG16: на партиции 4 индекса (PK + 3), в т.ч. на новой партиции |
| **P2-3** `key_verifications` | Composite FK `(verifier_user_id, verifier_device_id) → devices(user_id,id)` + FK `chat_id`/`target_device_id`/`workspace_id`; строгий scope — `BEFORE INSERT` триггер (ACTIVE-членство verifier и target, чат текущего workspace); RLS — tenant-граница (иначе revoke/soft-delete не смог бы проставить `revoked_at`) | §6.5 (4), §6.5.1 | PG16 T16–T22, T29/T30: валидная строка ok; чужой verifier → 23503; не-участник/чужой workspace → 23514; revoke после REMOVED/soft-delete → ok |
| **P2-4** claim workspace | `auth.claim_one_time_prekey` требует `chat.chats.workspace_id = ops.current_workspace_id()` и не удалённый чат | §6.5 (2), §6.5.1 | PG16 T06: claim в чате W2 при контексте W1 → `UNKNOWN_DEVICE`; T07/T08 — свой чат работает |
| **P2-5** safety number | «80 байт» → **64** (`16+16+32`); формула/значения не менялись | §7.2, vectors G2/G3 | verifier: длина entry = 64 |
| **P2-6** B3/B4 signatures | `expected.signature` = wire b64u64 (86 симв.); байтовый KAT — `expected.signature_hex`; F1 `prekey.signature == B4.signature` | §8.1–§8.4, §6.3.1 | verifier: b64u/64 B/равенство F1; Ed25519 verify по `signature_hex` |
| **P2-7/8/9/10** контракт | `ChatSummary.name` nullable; `Chat` add; patterns для prekey id; legacy `DeviceRegistration` rollout; `peer_has_e2ee_capable_devices` для J3 | §6.3, §6.3.1, §6.6 | contract-тесты (см. §6.3.1 E) |
| **P2-11** form cap vs canonical | Приёмочный лимит — канонический 33040 decoded / 44054 encoded (API 413 + DB CHECK 272..33040); 65536 encoded — только pre-decode form guard, не обещание доставки | §1.3, §3.5.1, §4.5, §4.7, §6.3, §6.5 (7) | PG16 T11/T12 (33041 fail / 33040 ok); `meta.limits` |

### 0.2. Что изменилось в S3 (карта для ревьюера)

| ID review-02 | Решение S3 | Где в спеке | Вектор/тест |
|---|---|---|---|
| **P0-2b** prekey↔registered identity | сервер требует `prekey.sender_identity_* == auth.devices.identity_*`; клиент — `== bundle == TOFU pin`; binding над теми же ключами | §3.3.1, §3.3.2, §3.3.3, §4.1, §4.7 п. 4a | **I3**; integration «токен без ключей не выдаёт себя за устройство» |
| **P1-A** DDL не исполним | grants на 3 таблицы + `EXECUTE` claim; RLS prekeys/envelopes; `p_devices_chat_peer`; `ensure_partition` создаёт envelopes; CHECK `reply_to_id`/sender NOT NULL | §6.5, §6.5.1 | Testcontainers V1–V15 под `krug_app`; DB/RLS-тесты |
| **I-01** контракт | точный API/WS/schema handoff, файлы и порядок; **контракт не изменён** | §6.3.1 | PM-PR + `npm run api:types` + contract-check |
| **P1-E** I1/I2 hex | `presented_*`/`pinned_*` → b64u64 (86 символов, 64 B); schema-проверка в верификаторе | §8.1/§8.2, vectors | I1/I2/I3; 273/0 verifier |
| **P1-B** peer coverage | `peer_covered>=1` иначе `409 E2EE_NO_PEER_ENVELOPE`; partial → `PEER_DEVICE_UNCOVERED` | §4.2, §4.7, §5.2, §4.8 | **M1/M2**; backend conformance |
| **P1-C** multi-message reset | reset = свойство сессии; все pending перешифровываются, batch 20, одна UI-группа | §3.3.3, §5.5, §1.3 | **L3**; E2E «5 сообщений, 0 дублей» |
| **P1-D** FS 60/90 | `SPK_RETAIN_PRIVATE=3`, окно 90; явное уничтожение OPK/DHs/SPK; PCS не мгновенный | §1.3, §2.3, §3.4.2, §3.4.5.1, §5.5, §10.7 | **S1**; storage-scan |
| **P1-G** fresh-device | без пина MANAGED не принимается молча: block/alert/explicit confirmation; без серверного кода (сервер не может проверить) | §6.2.8, §7.6, §9.3 | **J3**; Playwright fresh context |
| **P1-F** `reply_to_id` | запрещён на верхнем уровне (`422` + DB CHECK), разрешён в inner payload; не в AD | §4.2, §4.7, §6.5 | **R1**; contract/DB |
| **P1-H** `ChatSummary.peer_id` | nullable `peer_id` в `ChatSummary` (DIRECT), null для GROUP | §6.3, §6.3.1 | contract-тест `GET /chats` |
| **P1-5/6** | `direct_key` остаётся; legacy-код достижим на prekeys; REVOKED + тот же IK → 410 | §2.5, §3.1, §6.2.1, §6.2.2, §4.6 | **N1/N2** |
| **P2-1/2/3/4/5/8/9** | `verified_count` per verifier; `vh_version`; `NOT_MEMBER` удалён; legacy-код; REVOKED; meta 273; schema-конвенции | §6.2.6, §6.2.7, §6.5, §6.3, §8 | G5/contract; `meta.checks` |

### 0.1. Что изменилось в S2 (карта для ревьюера)

| Дефект | Решение S2 | Где в спеке | Вектор/тест |
|---|---|---|---|
| P0-1 verification per-user | `verifier_device_id` в DDL/API/`VH`; `verified` per verifier device | §6.2.6, §6.2.7, §6.5, §7.4 | G4 (VH v2), G5; integration «L1 сверил → L2 видит null» |
| P0-2 нет TOFU на prekey | обязательный пиннинг `(user_id, device_id) → IK_sig/IK_dh/fingerprint` до отображения; mismatch → `KEY_CHANGE_DETECTED` | §3.3.1, §3.3.3, §5.6, §7.5 | I1, I2; E2E-AC-09 |
| P0-3 downgrade `security_mode` | серверный immutability trigger + `409 MODE_CHANGE_FORBIDDEN`; клиентский пиннинг режима; plaintext не отправляется | §6.2.8, §6.5, §9.3 | J1, J2; E2E-AC-10 |
| P0-4 своя копия | локальная копия ciphertext+plaintext в одной транзакции **до** send; outbox/recovery; без self-envelope | §3.4.6, §5.2 | property crash-recovery; E2E-AC-11 |
| P1-1 R-15 | `content_type=2 SESSION_RESET` в новом prekey-конверте, rate limit, новый `client_message_id` | §3.5.1, §3.6, §5.5 | L1, L2; E2E-AC-12 |
| P1-2 IK binding | `identity_binding_signature` (D_IKBIND), проверка сервером и клиентом | §3.1, §3.2, §7.1 | B5 |
| P1-3 лимиты | 512 KiB **wire**, per-envelope **64 KiB encoded**, body **32 KiB decoded**, точная арифметика | §1.3, §3.5.1, §4.5, §4.7, §6.3 | `meta.limits`; boundary-тесты |
| P1-4 DDL | `crypto_scheme` вместо нового `security_mode`; `body_ciphertext`, `sticker_id`, `content_meta`; без `text` | §6.5 | Testcontainers V16+; DB scan |
| P1-5 DIRECT | `direct_key` + partial unique; `peer_id` из members | §6.2.8, §6.5 | race-тест |
| P1-6 POST /devices | binding, `identity_key_alg`, приоритет identity-идемпотентности, миграция | §2.5, §3.1, §6.2.1, §6.6 | contract/integration |
| P1-7 coverage | `E2EE_NO_ACTIVE_DEVICES` для получателя; split peer/self; `minimum: 0` | §4.2, §4.7, §6.3 | coverage tests |
| P1-8 FS window | немедленное уничтожение ключей, окно FS/PCS с числами | §3.4.5, §9.2 | property/storage tests |
| P1-9 DHs_A | явный запрет `DHs_A = EK`/`IK_dh`; свежая пара | §3.3.2, §3.4.2 | assert в векторах + negative |
| P1-10 client_message_id | scope `(chat_id, sender_id, client_message_id)`; cross-user → 409 | §4.2, §4.6, §6.5 | K1, K2 |
| P1-11 K_storage | честный текст: не at-rest; `STORAGE_LOCKED` удалён | §2.3, §3.6, §9.9 | UI/DPA review |
| P1-12 flag-off | не создаёт E2EE-воркспейсы/бейджи; существующий режим не закрывает; plaintext → 422 | §6.6, §10.4 | J2; feature-flag test |

---

## 1. Термины, версии и параметры

### 1.1. Термины

| Термин | Значение |
|---|---|
| Device | Устройство пользователя; единица ключей, сессий, конвертов и отзыва. |
| IK_sig | Долгоживущий Ed25519 identity signing key устройства. |
| IK_dh | Долгоживущий X25519 identity DH key устройства. |
| SPK | Signed prekey, X25519, подписан IK_sig. |
| OPK | One-time prekey, X25519, одноразовый. |
| EK | Ephemeral key инициатора X3DH, X25519. |
| SK | Shared secret X3DH (32 байта). |
| Session | Пара устройств + `session_id`; состояние Double Ratchet. |
| Envelope | Один шифротекст для одного recipient device. |
| Fan-out | Набор конвертов на все устройства-получатели. |
| key_generation | Версия identity-ключей устройства; растёт при revoke/ротации. |
| Safety number | 60-значный отпечаток пары устройств. |
| Opaque bytes | `ciphertext`/`session_id`/`prekey` для сервера: он проверяет форму, но не смысл. |

### 1.2. Версии

| Что | Значение | Правило |
|---|---|---|
| `envelope.v` | `1` | Неизвестная версия → сервер `422 UNSUPPORTED_ENVELOPE_VERSION`, клиент не пытается расшифровать. |
| `header.v` | `1` | Входит в AD; несовпадение → отказ. |
| `scheme` | `PAIRWISE_X3DH_DR` | Строка обязательна и сравнивается побайтово. |
| `suite` | `X25519-ED25519-AES256GCM-HKDFSHA256` | Информационно; версия протокола определяет набор. |
| `v` в `krug://verify/v1` | `1` | Версия QR-формата. |
| `VH` | `2` | `verification_hash`: u8(2) + `verifier_device_id` (P0-1). Значения u8(1) считаются недоверенными. |
| `identity_binding_signature` | `1` | Самоподпись `IK_sig → IK_dh` (P1-2). Новая версия = новый домен/ADR. |
| `vector_set_version` | `4` + addendum O | Версия набора тестовых векторов (S4; E7-F2G добавил секцию O без изменения версии). Не является версией протокола и не влияет на wire. |

Понижение версии невозможно: сессия хранит `envelope.v`; конверт с другой версией отвергается. Будущие версии (PQ, MLS) получают новый `v` и новый `scheme`; смешивание в одной сессии запрещено.

**S2/S3 не меняют envelope wire format.** `envelope.v`, `header.v`, AD и преамбул остаются v1; поэтому старые векторы A–H (кроме пересчитанного G4) сохраняют значения. `VH` — это server-side attestation hash, а не поле конверта; его переход на v2 не требует bump `envelope.v`. Кодировка binding-полей в I1/I2 (hex→b64u64) — исправление векторов, а не wire. Любое будущее изменение полей конверта/AD/преамбула — только новый `envelope.v` + ADR.

### 1.3. Константы

| Константа | Значение | Где проверяется |
|---|---|---|
| `PROTOCOL_VERSION` | `1` | клиент/сервер |
| `MAX_DEVICES` | `5` активных | сервер |
| `MAX_ENVELOPES_PER_MESSAGE` | `10` | сервер |
| `MAX_ENVELOPE_CIPHERTEXT_ENCODED_CHARS` | `65536` (**64 KiB encoded**, символов b64u) — **form guard до base64-decode**; это **не** приёмочный лимит и не обещание доставки | сервер (413 до decode; `details.reason="form"`) |
| `MAX_CANONICAL_CIPHERTEXT_BYTES` | `33040` (decoded, включая 16-байтовый tag) — **приёмочный** лимит: API отвергает больше, DB CHECK хранит только `272..33040` | сервер + контракт + БД (P2-11) |
| `MAX_CANONICAL_CIPHERTEXT_CHARS` | `44054` (b64u) — приёмочный лимит в символах (`ciphertext.maxLength` в контракте) | сервер/контрактные тесты |
| `MAX_MESSAGE_REQUEST_BYTES` | `524288` (**512 KiB wire = байт HTTP body**) | сервер/прокси |
| `ENVELOPE_WIRE_BUDGET` | `45056` (конверт + JSON-обёртка; бюджет fan-out) | клиент/сервер |
| `MAX_INNER_BODY_BYTES` | `32768` (**32 KiB decoded**) | клиент (сервер не видит) |
| `MAX_TEXT_CHARS` | `8000` | клиент + UI |
| `PAD_BLOCK` | `256` | клиент |
| `MAX_SKIP` | `1000` сообщений в одной цепочке | клиент |
| `MAX_SKIPPED_TOTAL` | `2000` ключей на сессию | клиент |
| `MAX_SKIPPED_AGE` | `30 дней` | клиент |
| `SPK_TTL` | `90 дней` (**retained** private SPK, `current + 2`) — нормативный срок жизни приватного SPK | сервер + клиент |
| `SPK_ROTATION_INTERVAL` | `30 дней` — плановая ротация/срок публикуемого current SPK; **не** TTL удаления private SPK (CR1c P1-03) | сервер + клиент |
| `SPK_RETAIN_PRIVATE` | `текущий + 2 предыдущих = 3` private SPK (P1-D); 30-дневный «unused» TTL не применяется | клиент |
| `OPK_TTL` | `30 дней` | сервер |
| `OPK_TARGET` | `100` | клиент |
| `OPK_LOW_WATERMARK` | `20` | клиент |
| `OPK_MAX_OUTSTANDING` | `200` | сервер |
| `CLAIM_MAX_DEVICES` | `10` | сервер |
| `MAX_KEY_GENERATION` | `2^31-1` | сервер |
| `MAX_HEADER_COUNTER` | `2^31-1` | сервер/клиент |
| `SESSION_IDLE_TTL` | `90 дней` (клиент может удалить неактивную сессию) | клиент |
| `SPK_RETAIN_WINDOW` | `90 дней` (= `SPK_TTL`) — окно хранения private SPK (`current + 2`, P1-D); в нём prekey-сообщение ещё расшифровывается. 30 дней (`SPK_ROTATION_INTERVAL`) — только интервал ротации | клиент |
| `MAX_RESET_PER_FAILED_SESSION` | `1` | клиент |
| `MAX_RESET_BATCH` | `20` сообщений на один reset (P1-C) | клиент |
| `RESET_COOLDOWN` | `300 с` | клиент |
| `TOFU_PIN_RETENTION` | бессрочно, пока устройство в ключах чата | клиент |
| `PREKEY_UPLOAD_RATE` | `10/час` на пользователя | сервер |
| `CLAIM_RATE` | `120/мин` на пользователя | сервер |
| `KEYS_READ_RATE` | `30/мин` на пользователя | сервер |
| `VERIFY_RATE` | `30/мин` на пользователя | сервер |
| `MESSAGE_RATE` | `30/10 с`, `5/с` на чат (существующее) | сервер |

**Лимиты S2 (D-06, P1-3): единицы измерения и арифметика.**

- **`512 KiB` — это wire-лимит HTTP body** (UTF-8 байты фактического тела **до** парсинга JSON), а не сумма decoded-полей. Старая редакция §4.7 сравнивала 512 KiB с decoded-суммой, что пропускало бы запрос ~683 KiB по проводу (`699051` символов b64u) — это исправлено.
- **Per-envelope: 64 KiB encoded** (`65536` символов b64u) — жёсткий **form guard**, который проверяется **до** base64-decode (дешёвая защита от гигантских строк), но **не** является приёмочным лимитом: канонический клиент v1 никогда не превышает **44054** символа / **33040** decoded-байт, и всё, что больше, сервер отклоняет `413 ENVELOPE_TOO_LARGE` с `details.reason="canonical"` (P2-11). Причина: получатель всё равно отверг бы такой конверт (33024 padded + 16 tag — максимум фрейма), поэтому хранить его в БД бессмысленно; DB CHECK — `272..33040`. Арифметика канонического максимума: body 32768 → raw 32794 → padded 33024 → +16 tag = **33040 decoded** → **44054 b64u** (43.0 KiB). Form guard — не бюджет fan-out: 10 × 65536 > 512 KiB, поэтому действует общий wire-лимит.
- **Inner body: 32 KiB decoded**; `MAX_TEXT_CHARS=8000` code points.
- Худший канонический конверт (JSON-обёртка 947 B + 44054) = **45001 B**. 9 конвертов + обёртка запроса = **405098 B (395.6 KiB)**; 10 = **450099 B (439.5 KiB)**. Измерение ревью — 405129 B; расхождение 31 B — длина JSON-обёртки/ids, обе величины < 512 KiB.
- Запас: 512 KiB − 405098 = **119190 B (116.4 KiB)** для 9; для 10 — **74189 B (72.4 KiB)**. Бюджет `45056` на конверт даёт 10 × 45056 + 89 = 450649 B < 524288.
- 256 KiB физически не хватает (405 KiB); уменьшение body до 16 KiB сломало бы обещание 8000 code points (32 000 B UTF-8).
- Прокси/ingress обязан иметь **тот же** лимит 512 KiB и отдавать тот же `413 PAYLOAD_TOO_LARGE`; приложение проверяет `Content-Length` и фактический размер потока до парсинга.

`MAX_MESSAGE_REQUEST_BYTES = 512 KiB` — принятое решение PM (D-06); 256 KiB из `SYSTEM-ANALYSIS` §8.2 отклонено.

### 1.4. Домены KDF/подписей (точные ASCII-строки, UTF-8, без NUL)

| Константа | Строка | Назначение |
|---|---|---|
| `D_X3DH` | `Krug/E2EE/v1/x3dh` | HKDF info для SK. |
| `D_SID` | `Krug/E2EE/v1/session-id` | HKDF info для `session_id`. |
| `D_RK` | `Krug/E2EE/v1/dr-root` | HKDF info для KDF_RK. |
| `D_AEADK` | `Krug/E2EE/v1/aead-key` | HKDF info для ключа AES-GCM. |
| `D_AEADN` | `Krug/E2EE/v1/aead-nonce` | HKDF info для nonce. |
| `D_AD` | `Krug/E2EE/v1/ad` | Префикс AD. |
| `D_PRE` | `Krug/E2EE/v1/prekey` | Префикс преамбула. |
| `D_PRESIG` | `Krug/E2EE/v1/prekey-signature` | Префикс подписываемого сообщения преамбула. |
| `D_SPKSIG` | `Krug/E2EE/v1/spk-signature` | Префикс подписи SPK. |
| `D_FP` | `Krug/E2EE/v1/fingerprint` | Префикс fingerprint. |
| `D_SN` | `Krug/E2EE/v1/safety-number` | Префикс safety number. |
| `D_VER` | `Krug/E2EE/v1/verification` | Префикс verification hash. |
| `D_PAY` | `Krug/E2EE/v1/payload` | Префикс inner payload. |
| `D_IKBIND` | `Krug/E2EE/v1/ik-binding` | Самоподпись `IK_sig → IK_dh` (P1-2, 88 байт сообщения). |

Любые изменения строк — новая версия протокола. Домены не являются секретами.

`H1/H2` используют домены `Krug/E2EE/v1/sender-key`, `sender-ad`, `sender-aead-key`, `sender-aead-nonce`, которых **нет** в реестре v1: они **informative** (группы вне E7) и не входят в acceptance. Это зафиксировано в `meta.conventions.informative_domains` и §9.7.

### 1.5. Обозначения

- `u8`, `u16`, `u32` — беззнаковые big-endian.
- `X` — 32-байтовый публичный ключ X25519; `S` — 32-байтовый приватный seed (X25519 клампит при использовании).
- `b64u` — base64url без padding (RFC 4648 §5).
- `||` — конкатенация.
- `HMAC(K, m)` — HMAC-SHA-256.
- `HKDF(IKM, salt, info, L)` — HKDF-SHA-256 (RFC 5869), `L` в байтах.
- `AESGCM(K, N, P, A)` — AES-256-GCM; результат `C || T`, `T` — 16 байт.
- `UUID` — 16 байт RFC 4122.

---

## 2. Ключи устройства

### 2.1. Иерархия

```
Устройство D (пользователь U)
├── IK_sig(D)   Ed25519, долгоживущий; подписывает SPK, преамбул и IKB
├── IK_dh(D)    X25519, долгоживущий; участвует в X3DH
├── IKB(D)      Ed25519-самоподпись over D_IKBIND||IK_dh||IK_sig (P1-2)
├── SPK(D,i)    X25519, подписан IK_sig; i — key_id; ротация 30 дней
├── OPK(D,j)    X25519, одноразовые; j — key_id; TTL 30 дней
├── RK/CK       Double Ratchet для каждой пары (D, E)
├── K_storage   AES-256-GCM, non-extractable; шифрует записи сессий и локальную копию
├── Outbox      точные bytes конвертов + Idempotency-Key + client_message_id (до send)
└── Локальная копия plaintext/ciphertext своих сообщений (IndexedDB, K_storage)
```

Приватные ключи **никогда** не покидают устройство: ни `POST /devices`, ни prekey-upload, ни экспорт, ни логи, ни аналитика. На сервере — только публичные ключи, подписи, `key_id`, TTL и opaque envelopes.

### 2.2. Почему две identity-пары (E2EE-ADR-01)

| Вариант | Плюсы | Минусы | Решение |
|---|---|---|---|
| Один Ed25519 + XEdDSA (libsignal) | Одна identity, совместимость с Signal | XEdDSA нет в WebCrypto; нужен WASM/libsodium; сложнее review | Отклонено для v1 |
| Один X25519 + отдельная подпись через Ed25519-конвертацию | Компактно | Та же проблема конвертации | Отклонено |
| **Ed25519 (подпись) + X25519 (DH)** | Нативно в WebCrypto; простая проверка; обе связи связываются fingerprint/подписью | Две пары; нужно явно связывать | **Принято** |

Связывание: `IK_sig` подписывает SPK, преамбул и **самоподпись** `IKB = Ed25519(IK_sig_priv, D_IKBIND || u8(1) || IK_dh_pub || IK_sig_pub)`; fingerprint и safety number хешируют **оба** ключа. Подмена только одного ключа меняет fingerprint и ломает safety number.

**Честная граница (P1-2).** Ни fingerprint, ни safety number не доказывают, что владелец `IK_sig` владеет `IK_dh`: их может посчитать кто угодно из публичных ключей. Доказательство даёт только `identity_binding_signature`, проверяемая сервером при регистрации и **клиентом при каждом claim/keys/смене ключа**. Но и она не защищает от подмены *всей* пары: атакующий сгенерирует свою пару и валидную самоподпись. От подмены пары защищают TOFU-пиннинг (§3.3.1) и safety number, а не binding-подпись.

### 2.3. Генерация и хранение

| Ключ | Когда | Где хранится | Ротация/уничтожение |
|---|---|---|---|
| IK_sig, IK_dh | Первый запуск/регистрация устройства | IndexedDB, `CryptoKey` с `extractable=false` | Только с новым устройством; при revoke устройство уничтожает локально |
| SPK | При регистрации и каждые 30 дней (ротация current) | Приватный — IndexedDB; публичный + подпись — сервер | Плановая; хранить **текущий + 2 предыдущих = 3** приватных SPK в окне **90 дней**, затем уничтожение; 30 дней — только интервал ротации, **не** TTL удаления private SPK (§3.4.5.1) |
| OPK | Батчами (100), пополнение при <20 | Приватные — IndexedDB; публичные — сервер | Уничтожать после успешного использования; TTL 30 дней |
| RK/CK/skipped MK | На каждую сессию | IndexedDB, зашифрованы `K_storage` | Удалять с сессией; никогда не логировать |
| `K_storage` | Первый запуск | IndexedDB, non-extractable AES-GCM `CryptoKey` | Теряется вместе с профилем браузера |

**Правила:**

- `K_storage` — случайные 32 байта, импортированные как non-extractable `AES-GCM` ключ. Им шифруются записи сессий, outbox и локальная копия: `AAD = device_id || session_id || client_message_id || record_type || version`, nonce — случайные 12 байт на запись.
- **`K_storage` не является at-rest защитой (P1-11).** Non-extractable `CryptoKey` защищает от извлечения raw key JS-кодом и разделяет состояние, но любой JS в origin и копия профиля браузера могут использовать ключ без пароля пользователя. В v1 **нет** passphrase/WebAuthn-PRF unlock; состояние `STORAGE_LOCKED` удалено (см. §3.6) и не должно появляться в коде. DPA/UI/маркетинг не обещают «шифрование на диске» и защиту от кражи профиля.
- Состояние сессии — **не** `localStorage`, **не** cookies, **не** логи. Только IndexedDB + `K_storage`.
- Локальная копия своих сообщений обязательна (P0-4): одна IndexedDB-транзакция на `state + exact envelope bytes + idempotency key + client_message_id + plaintext copy` **до** сети (§3.4.6).
- Если браузерный профиль очищен, ключи и история теряются безвозвратно (backup v1 вне E7); свои отправленные при этом помечаются «недоступно на этом устройстве», факт отправки остаётся.
- Сервер не принимает и не хранит `IK_sig`/`IK_dh` private, `SPK` private, `OPK` private, `SK`, `RK/CK`, `K_storage`, локальную копию.

#### 2.3.1. AAD `K_storage` — нормативно, ровно 50 байт (P1-07)

`K_storage` шифрует записи AES-256-GCM (tag 128 бит). Associated Data — **фиксированные 50 байт** без length-prefix, presence-битов и выбора endianness (кроме RFC 4122 порядка байт для UUID):

| Offset | Size | Поле | Кодировка |
|---:|---:|---|---|
| 0 | 16 | owner `device_id` | RFC 4122 UUID bytes (network order) |
| 16 | 16 | `session_id` | 16 байт протокольного `session_id`; поля нет → `0×16` |
| 32 | 16 | `client_message_id` | RFC 4122 UUID bytes; поля нет → `0×16` |
| 48 | 1 | `record_type` | u8: `session=1`, `outbox=2`, `localCopy=3`, `pin=4`, `keyChange=5`, `modePin=6` |
| 49 | 1 | `LOCAL_RECORD_VERSION` | u8, в v1 — `1` |

Нормативные инварианты:

- nil UUID (`00000000-0000-0000-0000-000000000000`) в любом UUID-поле и all-zero `session_id` **отвергаются** (`KEY_STORAGE_UNAVAILABLE`). Поэтому `0×16` может означать только «поля нет», и отображение инъективно: `null` и гипотетический nil UUID не дают одинаковый AAD.
- present `session_id`/`client_message_id` **никогда** не кодируется нулями; отсутствие — ровно 16 нулевых байт.
- `local_message_id` в эти 50 байт не входит: он связан storage-ключом локальной копии (`chat/direction/sender/id`) и sealed payload cross-check (§3.4.6).
- Изменение раскладки выше требует новой `LOCAL_RECORD_VERSION`, а не нового wire-version; `vector_set_version` — отдельная версия набора тестов.

**KAT.** `docs/E2EE-TEST-VECTORS.json` секция `O-kstorage-aad`: O1 фиксирует AAD hex, offsets и AES-256-GCM `ciphertext||tag` при фиксированных key/nonce/plaintext; O2 — nil/zero инъективность. Клиентский тест читает значения прямо из JSON (`kStorageKAT.test.ts`), а не дублирует их.

#### 2.3.2. AAD sealed-пинов и mode-пинов — нормативно (P2-18)

Пины (`pin`, `keyChange`, `modePin`) запечатаны тем же `K_storage` и используют **ту же** 50-байтовую раскладку §2.3.1; отдельного префикса/версии записи нет. Два «optional» слота несут opaque scope:

| `record_type` | Code | `session_id` (offset 16) | `client_message_id` (offset 32) |
|---|---:|---|---|
| `pin` | 4 | target `device_id` (UUID bytes) | target `user_id` (UUID bytes) |
| `keyChange` | 5 | target `device_id` (UUID bytes) | target `user_id` (UUID bytes) |
| `modePin` | 6 | `chat_id` (UUID bytes) | `0×16` (нет поля) |

- Owner account/device связывается полем `device_id` (offset 0), а не отдельным полем; поэтому один и тот же sealed pin нельзя перенести на другой аккаунт/устройство.
- `pin`/`keyChange` связываются с парой `(target user_id, target device_id)`; `modePin` — с `chat_id`. Подмена ciphertext между user/device/chat или между `pin`/`keyChange`/`modePin` даёт `DECRYPT_FAILED`/`KEY_STORAGE_UNAVAILABLE`, а не «пин отсутствует».
- Это local record scope, не wire: значения публичных id не секретны, nonce случаен на запись. Тест: O3 в `docs/E2EE-TEST-VECTORS.json` и `device/pinStore` AAD-тест.

### 2.4. WebCrypto: практические требования

| Операция | API | Обязательно |
|---|---|---|
| X25519 DH | `subtle.deriveBits({name:"X25519"})` | Да |
| Ed25519 sign/verify | `subtle.sign/verify({name:"Ed25519"})` | Да |
| HKDF-SHA-256 | `subtle.deriveBits({name:"HKDF",hash:"SHA-256"})` | Да |
| AES-256-GCM | `subtle.encrypt/decrypt({name:"AES-GCM"})` | Да |
| HMAC-SHA-256 | `subtle.sign({name:"HMAC"})` | Да |
| SHA-256/512 | `subtle.digest` | Да |
| CSPRNG | `crypto.getRandomValues` | Да |

- **Никакого fallback на JS-реализацию/XEdDSA/libsodium в v1** (E2EE-ADR-02): если хотя бы один примитив недоступен, E2EE выключен с честным сообщением «браузер не поддерживает E2EE», а не «тихий» переход на слабое шифрование.
- **Non-extractable private + public для загрузки:** на практике пара генерируется с `extractable:true`, публичный ключ экспортируется, приватный импортируется заново с `extractable:false`, исходный объект и raw bytes удаляются. Альтернатива — `generateKey({extractable:false})` и экспорт только public, если браузер это поддерживает; E7-F фиксирует фактическое поведение feature-detect-тестом.
- **Версии браузеров** не угадываются по User-Agent: только feature detection; точный floor фиксирует E7-F и документирует в README. Известный риск R-07 — Ed25519 в WebCrypto появился позже X25519.
- Приватные `CryptoKey` и `K_storage` — только IndexedDB; raw bytes приватных ключей не попадают в JS-переменные дольше, чем нужно для импорта, и никогда — в логи/аналитику.

### 2.5. Запись устройства на сервере (предложение к E7-B)

Поля (заменяют `identity_public_key` из `SYSTEM-ANALYSIS` §6.4):

| Поле | Тип | Правило |
|---|---|---|
| `id` | uuid | Генерирует сервер; стабилен. |
| `user_id` | uuid | Владелец. |
| `identity_signing_key` | bytea(32) | Ed25519 public; `NOT NULL` для **E2EE**-устройств (`identity_key_alg='Ed25519+X25519'`); `NULL` для legacy, включая `POST /devices` без ключей (D-S4-03). |
| `identity_dh_key` | bytea(32) | X25519 public; `NOT NULL` для **E2EE**-устройств (`identity_key_alg='Ed25519+X25519'`); `NULL` для legacy, в том числе зарегистрированных через `POST /devices` без ключей (rollout, D-S4-03). |
| `identity_binding_signature` | bytea(64) | Ed25519-самоподпись `D_IKBIND \|\| u8(1) \|\| identity_dh_key \|\| identity_signing_key`. Обязательна для **E2EE**-устройств; проверяется сервером и клиентом (P1-2). Legacy — `NULL`. |
| `e2ee_capable` | bool (derived) | `identity_signing_key IS NOT NULL AND identity_dh_key IS NOT NULL AND identity_binding_signature IS NOT NULL AND status='ACTIVE'`. Legacy/dev-устройства без ключей — `false`. |
| `identity_key_alg` | text | `Ed25519+X25519` для E2EE-устройств; `LEGACY` для устройств без ключей (включая legacy-регистрацию, D-S4-03). Значение `Ed25519` из V2 больше не выдаётся. |
| `key_generation` | int | `1..2^31-1`; `+1` при revoke/ротации identity. |
| `status` | text | `PENDING/ACTIVE/REVOKED`; `REVOKED` терминален. |
| `name`, `platform`, `app_version` | text | Как в B-01. |
| `created_at`, `last_seen_at`, `revoked_at`, `revoked_reason` | timestamptz | Как в B-01. |

Уникальность (P2-11 закрыт усилением): **глобальные** partial unique `identity_signing_key` и `identity_dh_key` среди `status <> 'REVOKED'` (не только внутри `user_id`), плюс `UNIQUE(user_id, id)`. Публичные ключи нельзя безнаказанно копировать в другой аккаунт: повтор вызывает `409 IDENTITY_KEY_CONFLICT` и алерт. Legacy/dev-устройства без ключей не участвуют в claim/fan-out и не считаются E2EE-eligible.

**Честная граница (P2-6):** глобальная уникальность **не доказывает владение** ключами. Публичный bundle (IK_sig/IK_dh + валидные binding/SPK-подписи — всё публично) можно скопировать в другой аккаунт первым; сервер примет, а законный владелец получит `409` (squatting/DoS). В v1 это **принятый остаточный риск**: TOFU/safety number покажут чужой fingerprint при контакте, но регистрацию не спасут. Полное исправление — challenge-response (server nonce, подписанный `IK_sig`) при `POST /devices`; вводится отдельной задачей v1.1 и меняет контракт. До этого сервер обязан алертить на `IDENTITY_KEY_CONFLICT` и не «переносить» устройство между аккаунтами автоматически. Тест v1: копия bundle во второй аккаунт → `409` после первой регистрации; challenge — тест v1.1.

**Legacy (D-17):** устройство, зарегистрированное до E7, **никогда** не апгрейдится in-place. Оно остаётся `e2ee_capable=false`, не получает prekeys (`422 E2EE_LEGACY_DEVICE` на `POST /devices/{id}/prekeys`), не появляется в `GET /chats/{id}/keys`; чтобы участвовать в E2EE, пользователь регистрирует **новое** устройство. Это осознанная цена: иначе пришлось бы доверять «докинутым» ключам на устройстве с неизвестной историей.

**Важно:** natural key B-01 `(user_id, name, platform, app_version)` **перестаёт** быть ключом идемпотентности. Иначе два браузера с одинаковым именем получат одно устройство, а E2EE-ключи второго потеряются. Новая семантика — §5.1 и §6.2; это breaking change для существующего `DeviceRegistrationService` и тестов.

**Приоритет идемпотентности (P1-6, P2-5):** (0) если `identity_signing_key`/`identity_dh_key` совпадают с **REVOKED**-устройством — `410 DEVICE_REVOKED`, устройство не реактивируется и новое не создаётся (обход revoke запрещён; для возврата — новая пара ключей); (1) иначе тот же `IK_sig`/`IK_dh` среди не-REVOKED → существующее устройство; (2) затем `Idempotency-Key` (повтор того же body → replay). Тот же `Idempotency-Key` с другим body → `409 IDEMPOTENCY_KEY_REUSED`; тот же `identity_dh_key` с другим `identity_signing_key` → `409 IDENTITY_KEY_CONFLICT`; та же пара, но другая binding-подпись → `422 INVALID_IDENTITY_BINDING`.

---

## 3. Протокол 1:1

### 3.1. Регистрация устройства и подпись SPK

Клиент генерирует `IK_sig`, `IK_dh`, `SPK` и (опционально) батч `OPK`. `POST /devices` отправляет публичные ключи и подпись SPK.

**Подписываемое сообщение SPK** (бинарь, не JSON):

| Смещение | Размер | Поле |
|---|---|---|
| 0 | 26 | ASCII `Krug/E2EE/v1/spk-signature` |
| 26 | 1 | `u8` version = 1 |
| 27 | 2 | `u16` длина `key_id` (UTF-8, 1..64) |
| 29 | L | `key_id` |
| 29+L | 32 | `spk_pub` |

`signature = Ed25519_sign(IK_sig_priv, signed_message)`. Вектор: **B3-SPK-signature**.

**Проверки сервера при регистрации:**

0. **Legacy-путь (D-S4-03):** если ни одно из полей `identity_signing_key`, `identity_dh_key`, `identity_binding_signature`, `identity_key_alg`, `signed_prekey` не передано (и `one_time_prekeys` пуст) — устройство создаётся с `identity_key_alg='LEGACY'`, `e2ee_capable=false`, `201`; проверки 1–6 не применяются, prekeys не пишутся, устройство не участвует в claim/fan-out. Частичный набор ключей → `422 INVALID_KEY_FORMAT`. Далее — полный E2EE-путь.
1. Длины: `IK_sig` = 32, `IK_dh` = 32, `identity_binding_signature` = 64, `SPK` = 32, `signature` = 64; `key_id` 1..64 ASCII `[A-Za-z0-9._-]`.
2. `Ed25519_verify(IK_sig, signed_message, signature) == true`; иначе `422 INVALID_SPK_SIGNATURE`.
3. **Binding (P1-2):** `Ed25519_verify(IK_sig, D_IKBIND || u8(1) || IK_dh || IK_sig, identity_binding_signature) == true`; иначе `422 INVALID_IDENTITY_BINDING`. Это доказывает, что владелец signing-ключа владеет DH-ключом, но **не** защищает от подмены всей пары (см. §2.2).
4. `identity_key_alg` = `Ed25519+X25519`; иное → `422 INVALID_KEY_FORMAT`.
5. Глобальная уникальность `IK_sig`/`IK_dh` среди не-REVOKED; конфликт → `409 IDENTITY_KEY_CONFLICT`.
6. `key_generation = 1`, `status = ACTIVE`; устройство + SPK + OPK пишутся в одной транзакции.
7. Лимит 5 активных; новый при лимите → `409 DEVICE_LIMIT_REACHED`.
8. Приоритет идемпотентности: повтор с теми же `IK_sig`/`IK_dh` → существующее устройство, даже при достигнутом лимите; другой body под тем же `Idempotency-Key` → `409 IDEMPOTENCY_KEY_REUSED`.
8a. **REVOKED (P2-5):** если `IK_sig`/`IK_dh` совпадают с отозванным устройством — `410 DEVICE_REVOKED`, без реактивации и без создания нового устройства. Вернуть устройство в E2EE можно только с новой identity-парой (новое устройство); global unique partial index не должен позволять «воскресить» те же ключи.
9. Сервер **не** проверяет приватные ключи (их нет) и **не** участвует в X3DH. Проверка SPK и binding — публичные операции; клиент обязан проверить обе повторно при claim/keys и не доверять серверу.
10. Legacy-устройство не может «докинуть» ключи: `POST /devices` без ключей для нового устройства → `422 INVALID_KEY_FORMAT`; существующее legacy-устройство не апгрейдится (D-17).

**OPK:** подписи не имеют (как в X3DH); подмена OPK не позволяет вычислить SK без SPK private, но может вызвать отказ расшифровки (DoS). Клиент проверяет, что `opk_pub` соответствует сохранённому приватному ключу по `opk_id`.

### 3.2. Prekey bundle и claim

Prekey bundle устройства, который отдаётся по `POST /keys/claim`:

```json
{
  "user_id": "uuid",
  "device_id": "uuid",
  "key_generation": 1,
  "identity_signing_key": "b64u32",
  "identity_dh_key": "b64u32",
  "identity_binding_signature": "b64u64",
  "identity_key_alg": "Ed25519+X25519",
  "signed_prekey": {
    "key_id": "spk-2026-11-01",
    "public_key": "b64u32",
    "signature": "b64u64",
    "created_at": "2026-11-01T00:00:00Z",
    "expires_at": "2026-12-01T00:00:00Z"
  },
  "one_time_prekey": {
    "key_id": "opk-0007",
    "public_key": "b64u32"
  },
  "otp_exhausted": false
}
```

- `one_time_prekey` может быть `null`; тогда `otp_exhausted: true` — сессия строится на 3DH, клиент показывает предупреждение «меньше forward secrecy» (§9.3).
- Claim возвращает только `e2ee_capable` устройства; устройства без ключей (legacy/dev) попадают в `unavailable[]` с `NO_KEYS`. `POST /devices/{id}/prekeys` для такого устройства → `422 E2EE_LEGACY_DEVICE` (P2-4; `NO_KEYS` — только claim/unavailable).
- **Клиент обязан проверить `identity_binding_signature`** из bundle для **каждого** устройства и сверить пару `(IK_sig, IK_dh)` с локальным TOFU-пином (P0-2). Без валидной binding-подписи bundle не используется (для устройств, зарегистрированных после S2; для legacy его и не будет, но legacy не попадает в bundle).
- Сервер выдаёт **ровно один** OPK на устройство в рамках claim, атомарно (`FOR UPDATE SKIP LOCKED` + `consumed_at`), и никогда не отдаёт его повторно.
- `unavailable[]` — устройства, для которых bundle не выдан (`NO_SPK`, `NO_KEYS`); если bundle не выдан ни для одного устройства — `409 NO_PREKEYS`. `NOT_MEMBER` **удалён** (P2-3): не-участник даёт `422 UNKNOWN_DEVICE` на весь запрос (§6.2.5), а не запись в `unavailable[]`, — иначе два взаимоисключающих контракта.
- Claim **не** идемпотентен по `Idempotency-Key`: каждый вызов должен потребить свежий OPK. Повтор с тем же ключом опасен (повторное использование OPK), поэтому `Idempotency-Key` для claim не принимается; защита — rate limit и membership-проверка.
- `key_id` уникален в пределах устройства и **никогда не переиспользуется** (PK `(device_id,key_id)`); OPK с истёкшим `expires_at` не выдаётся; SPK с истёкшим `expires_at`/`retired_at` не считается текущим.
- `user_id` в запросе сверяется с владельцем `device_id`; несовпадение → `422 UNKNOWN_DEVICE` (не раскрывать чужие устройства).
- **Claim scope (D-05):** `chat_id` обязателен; разрешены только устройства **участников этого чата** и **собственные** устройства вызывающего. Не-участник, чужое устройство и несуществующее устройство дают **один и тот же** `422 UNKNOWN_DEVICE` (без oracle существования). `403 FORBIDDEN` — только если вызывающий сам не член чата. Claim до создания чата невозможен — это нормально: сначала чат, потом сессии.
- `one_time_prekeys_available` не отдаётся не-владельцу (в bundle его нет).
- Rate limit `120/мин` на пользователя; метрика/алерт на массовый `otp_exhausted` (P2-6): `otp_exhausted` — downgrade FS, не конфиденциальности.

### 3.3. X3DH-подобный handshake

Обозначим инициатора A (его устройство `A_dev`) и получателя B (`B_dev`).

**Входы:** `IK_A_dh`, `EK_A` (новые), `IK_B_dh`, `SPK_B`, `OPK_B` (если есть).

```
DH1 = DH(IK_A_dh_priv, SPK_B_pub)
DH2 = DH(EK_A_priv,   IK_B_dh_pub)
DH3 = DH(EK_A_priv,   SPK_B_pub)
DH4 = DH(EK_A_priv,   OPK_B_pub)          // только если OPK есть
IKM = 0xFF×32 || DH1 || DH2 || DH3 [|| DH4]
SK  = HKDF(IKM, salt=0×32, info=D_X3DH, L=32)
SID = HKDF(SK,  salt=0×32, info=D_SID,  L=16)
```

Вектор с OPK: **B1-X3DH-4DH** (`SK=bbaf2376…d9d5`, `SID=86c68f64…1f5e`); без OPK: **B2-X3DH-3DH-otp-exhausted**.

**Почему 0xFF×32:** префикс F из X3DH отделяет IKM от «просто конкатенации DH» и фиксирует длину. Для X25519 F = 32 байта 0xFF.

#### 3.3.1. Преамбул первого сообщения (подписывается A)

Преамбул — **бинарный**, фиксированной структуры, с переменными `spk_id` (L) и `opk_id` (M). Он не передаётся отдельным полем: получатель реконструирует его побайтово из полей `prekey` block и собственных identity-ключей.

| Смещение | Размер | Поле |
|---|---|---|
| 0 | 19 | ASCII `Krug/E2EE/v1/prekey` |
| 19 | 1 | `u8` version = 1 |
| 20 | 16 | `chat_id` |
| 36 | 16 | `sender_device_id` (A_dev) |
| 52 | 16 | `recipient_device_id` (B_dev) |
| 68 | 32 | `sender_ik_sig` (Ed25519 public) |
| 100 | 32 | `sender_ik_dh` (X25519 public) |
| 132 | 32 | `sender_ek` |
| 164 | 32 | `recipient_ik_dh` (X25519 public) |
| 196 | 32 | `recipient_ik_sig` (Ed25519 public) |
| 228 | 2 | `u16` L — длина `spk_id` |
| 230 | L | `spk_id` UTF-8 |
| 230+L | 32 | `recipient_spk_pub` |
| 262+L | 1 | `opk_present` (0/1) |
| 263+L | 2 | `u16` M — длина `opk_id` (0, если нет) |
| 265+L | M | `opk_id` UTF-8 |
| 265+L+M | 32 | `recipient_opk_pub` (нули, если нет) |
| 297+L+M | 16 | `session_id` |

Итого `313 + L + M` байт. Для `spk-1`/`opk-1` (L=M=5) — **323 байта** (вектор **B4-prekey-preamble**).

```
prekey_signature = Ed25519_sign(IK_A_sig_priv, D_PRESIG || preambul)
```

`recipient_ik_sig` не передаётся в конверте: получатель подставляет собственный `IK_sig` при реконструкции преамбула. Поэтому подмена сервером любого identity-ключа получателя ломает подпись, а не только safety number.

**Источник истины для identity отправителя (P0-2b).** `prekey.sender_identity_signing_key`/`sender_identity_dh_key` — не «свободные» публичные ключи: они обязаны **побайтово** совпадать с `identity_signing_key`/`identity_dh_key` зарегистрированного устройства `sender_device_id` (`auth.devices`) и с теми же полями claim-bundle/`GET /chats/{id}/keys`. Prekey-блок **не** является источником истины и не может вводить новую identity-пару для существующего `device_id`; смена identity — только новое устройство (D-17) либо явный key-change flow с подтверждением. Сервер обязан отвергнуть расхождение (§4.7, п. 4a); клиент обязан проверить его независимо, даже если сервер «уже проверил».

Получатель обязан проверить (исчерпывающий чек-лист, P0-2 + P0-2b):

1. **Подпись преамбула** `Ed25519_verify(sender_ik_sig, D_PRESIG||preambul, prekey.signature)`.
2. **Равенство identity отправителя (P0-2b):** `(envelope.prekey.sender_identity_signing_key, envelope.prekey.sender_identity_dh_key)` == `(bundle.identity_signing_key, bundle.identity_dh_key)` == `(TOFU pin.IK_sig, pin.IK_dh)` для `sender_device_id` (если пин уже есть; при первом контакте пина ещё нет — сравниваются prekey и bundle, а пин создаётся после проверок). Bundle берётся из `POST /keys/claim`/`GET /chats/{id}/keys`; пин — локальный. Любое расхождение → `KEY_HANDSHAKE_INVALID`: **не** создавать сессию, **не** расходовать OPK, **не** отображать сообщение. Это ловит подмену prekey-блока при краже bearer-токена без приватных ключей устройства.
3. **Binding-подпись отправителя** `IK_sig → IK_dh` из bundle **над теми же ключами, что в п. 2** (P1-2); отсутствие/невалидность для нового устройства → `KEY_HANDSHAKE_INVALID`.
4. `recipient_ik_dh` и `recipient_ik_sig` совпадают с собственными `IK_dh`/`IK_sig`.
5. `spk_id`/`spk_pub` совпадают с сохранённым SPK; `opk_id`/`opk_pub` — с неиспользованным OPK.
6. `session_id` совпадает с вычисленным; `chat_id` и оба `device_id` совпадают с конвертом и чатом.
7. **TOFU-пиннинг (P0-2):** сравнить `(sender_user_id, sender_device_id) → {IK_sig, IK_dh, fingerprint, identity_binding_signature, key_generation}` с локальной записью. Пиннинг ведётся **по `device_id`**, никогда не по `user_id` (у пользователя до 5 устройств).
   - Записи нет → это **первый контакт**: сохранить пин **после** проверок 1–6 и **до** отображения сообщения/создания сессии; пометить `verified=false`, показать «устройство не сверено» и safety number. Это TOFU-окно: подмена при первом контакте не детектируется.
   - Запись есть и `IK_sig`/`IK_dh`/fingerprint совпадают → продолжить.
   - Запись есть и **любое** поле отличается → `KEY_CHANGE_DETECTED`: **не** отображать сообщение, **не** создавать/перезаписывать сессию, **не** расходовать OPK, заблокировать отправку до явного подтверждения пользователем, сбросить `verified` для этого устройства.
8. Любое расхождение из 1–7 → локальная ошибка (`KEY_HANDSHAKE_INVALID` или `KEY_CHANGE_DETECTED`), сообщение не отображается, ключи не создаются.

Проверки 2 и 7 — нормативная часть приёма **первого** prekey-сообщения, а не «общая рекомендация §5.6»/§4.1. Реализатор, читающий только §3.3.1, обязан реализовать обе. Проверка 2 не заменяет 7: п. 2 ловит расхождение prekey↔bundle для одного и того же `device_id`, п. 7 — смену закреплённой пары. Вектор **I3-prekey-sender-identity-mismatch** фиксирует отказ, когда подпись преамбула и binding валидны для **подставленных** ключей, но они не равны зарегистрированным/bundle.

#### 3.3.2. Порядок установки сессии (A)

1. Получить bundle устройств через `POST /keys/claim` (для получателя и для своих других устройств).
2. Проверить подпись `SPK` **самостоятельно** (`Ed25519_verify`), даже если сервер уже проверял.
3. Проверить **binding-подпись** `IK_sig → IK_dh` каждого bundle (P1-2).
3a. **Собственные ключи (P0-2b):** в `prekey` блок подставляются **ровно те** `IK_sig`/`IK_dh`, которые зарегистрированы для `sender_device_id`; свежая identity-пара для существующего `device_id` запрещена. Перед отправкой сверить `GET /devices` (своя запись) с локальными ключами; расхождение → `KEY_CHANGE_DETECTED`, отправка блокируется, требуется новое устройство/подтверждение. Сервер дополнительно отвергает расхождение (§4.7 п. 4a).
4. Сверить пару `(IK_sig, IK_dh, fingerprint)` с локальным TOFU-пином **по `device_id`** (P0-2). Нет пина → это первый контакт: сохранить пин **после** проверок 2–3a и пометить «не проверено». Есть и отличается → `KEY_CHANGE_DETECTED`, отправка на это устройство блокируется до явного подтверждения и сброса verified.
5. Сгенерировать `EK` (свежий CSPRNG).
6. Вычислить `SK`, `SID`.
7. **Сгенерировать `DHs_A` — свежую ratchet-пару**, не `EK` и не `IK_dh` (P1-9); только после вычисления `SK`.
8. Собрать преамбул (§3.3.1), подписать.
9. Инициализировать Double Ratchet (§3.4.2) и зашифровать первое сообщение с `prekey` block.
10. **Одной транзакцией** сохранить: новое состояние сессии, точные bytes конвертов, `Idempotency-Key`, `client_message_id` и локальную копию plaintext/ciphertext; только после commit — отправлять (§3.4.6).
11. Отправить `POST /messages` с конвертами. При падении/сетевой ошибке — повтор **тех же bytes** с тем же `Idempotency-Key`, без перешифрования.

#### 3.3.3. Приём первого сообщения (B)

1. Найти `spk_id`; приватный SPK обязателен. Если SPK уже удалён (окно `SPK_RETAIN_WINDOW` истекло) — расшифровка невозможна; клиент **не** пытается «позже», а фиксирует `SPK_DELETED` и запускает R-15 reset (§5.5).
2. Найти `opk_id` (если есть); проверить, что OPK не использован. **Не** удалять приватный OPK до успешной AEAD.
3. Проверки §3.3.1: подпись преамбула, **равенство `prekey.sender_identity_*` bundle/`auth.devices` (P0-2b)**, binding, собственные `recipient_ik_dh`/`recipient_ik_sig`, `spk`/`opk`, `session_id`, чат/устройства, **TOFU-пин отправителя по `device_id`** (P0-2). При расхождении prekey↔bundle — `KEY_HANDSHAKE_INVALID` (не `KEY_CHANGE_DETECTED`: это подмена блока, а не смена закреплённой пары); при расхождении с пином — `KEY_CHANGE_DETECTED`.
4. Вычислить `SK`, `SID`; сравнить с `session_id` из конверта и преамбула.
5. Если `session_id` уже существует с другими peer-ключами — `KEY_CHANGE_DETECTED` (не перезаписывать). Если пин отправителя не совпал — тоже `KEY_CHANGE_DETECTED`, сессия не создаётся.
6. Инициализировать состояние B (§3.4.2) на **копии** состояния и обработать сообщение.
7. Если AEAD не прошёл: состояние не менять, OPK не расходовать, сообщение не показывать; для prekey-конверта отправить **зашифрованный** `SESSION_RESET` (content_type=2, §5.5), не чаще одного раза на сессию/5 минут. Reset относится ко **всей** failed-сессии: отправитель перешифровывает все её нерасшифрованные сообщения (P1-C), а не только текущее.
8. Только после успешной AEAD-проверки: пометить OPK использованным (удалить приватный ключ), одной транзакцией сохранить состояние сессии + `Message`-привязку + локальную копию plaintext, затем отобразить.
9. Ключевое подтверждение — первое успешно расшифрованное сообщение; отдельного `key confirmation` сообщения нет.

### 3.4. Double Ratchet

#### 3.4.1. KDF

```
KDF_RK(RK, dh_out):
    okm = HKDF(IKM=dh_out, salt=RK, info=D_RK, L=64)
    return okm[0..32] as RK', okm[32..64] as CK

KDF_CK(CK):
    MK   = HMAC(CK, 0x01)
    CK'  = HMAC(CK, 0x02)
    return MK, CK'
```

Векторы: **C2** (root step) и **C3** (три message key подряд).

#### 3.4.2. Инициализация

| Сторона | RK | DHs | DHr | CKs/CKr | Счётчики |
|---|---|---|---|---|---|
| A (инициатор) | `SK` | новая пара | `SPK_B` pub | `null/null` | 0 |
| A, перед первым send | `RK, CKs = KDF_RK(SK, DH(DHs, DHr))` | — | — | CKs | 0 |
| B (получатель) | `SK` | `SPK_B` keypair | `null` | `null/null` | 0 |
| B, при первом receive | DH-ratchet с `DH(SPK_B, DHr)` | — | — | см. §3.4.4 | — |

Ключевая деталь: **первый ratchet-ключ B — это SPK_B**, поэтому B обязан хранить приватный SPK до тех пор, пока жива хоть одна сессия, созданная с этим SPK. Это причина `SPK_RETAIN_PRIVATE = 3` (current + 2 previous) и окна `SPK_RETAIN_WINDOW = 90` дней, а не «2 total».

**P1-9:** `DHs_A` (первая отправляющая ratchet-пара инициатора) — **всегда свежая** X25519-пара, сгенерированная после `SK`; запрещено использовать `EK`, `IK_dh`, `SPK` или любой ключ, уже входящий в IKM. Иначе первый root step вырождается в уже известный DH (например, `DH(EK,SPK)=DH3`) и ratchet не добавляет свежей энтропии. В векторах `alice-ratchet-0 ≠ alice-ek`; это проверяется assert'ом и негативным тестом реализации.

#### 3.4.3. Отправка

1. Требуется `CKs != null`.
2. `MK, CKs = KDF_CK(CKs)`.
3. `header = {v:1, dh:DHs_pub, pn:PN, n:Ns}`.
4. `AD = build_ad(...)` (§3.5.3).
5. `ciphertext = AESGCM(K_enc, N, padded_plaintext, AD)`; `K_enc/N` — из `MK`.
6. `Ns += 1`.
7. Одной IndexedDB-транзакцией сохранить новое состояние + `header` + точные bytes конверта(ов) + `session_id` + `Idempotency-Key` + `client_message_id` + **локальную копию plaintext/ciphertext**; только после commit — отправлять (§3.4.6).

#### 3.4.4. Приём

1. Найти сессию по `session_id` (и `sender_device_id`).
2. Если `header.dh != DHr`:
   - если `DHr != null`: `skip_message_keys(header.pn)` для предыдущей принимающей цепочки (если `CKr == null`, шаг — no-op);
   - `PN = Ns; Ns = 0; Nr = 0; DHr = header.dh`;
   - `RK, CKr = KDF_RK(RK, DH(DHs_priv, DHr))`;
   - `DHs = new keypair`;
   - `RK, CKs = KDF_RK(RK, DH(DHs_priv, DHr))`.
3. `skip_message_keys(header.n)`.
4. Если `(header.dh, header.n)` есть в `MKSKIPPED` — взять и удалить ключ; если `header.n < Nr` и ключа нет — отказ `DUPLICATE_OR_OLD_MESSAGE`; иначе `MK, CKr = KDF_CK(CKr)`, `Nr += 1`.
5. Расшифровать на **копии** состояния; при ошибке AEAD состояние не менять, показать `DECRYPT_FAILED`.
6. При успехе — атомарно сохранить состояние + plaintext; удалить использованный skipped key.

`skip_message_keys(until)`:

```
if until - Nr > MAX_SKIP: reject SESSION_TOO_FAR_BEHIND
while Nr < until:
    MK, CKr = KDF_CK(CKr)
    MKSKIPPED[(DHr, Nr)] = MK
    Nr += 1
if |MKSKIPPED| > MAX_SKIPPED_TOTAL: удалить самые старые (риск потери очень старых сообщений)
if возраст ключа > MAX_SKIPPED_AGE: удалить
```

Вектор **E2-skipped-key-trace**: доставка m1(n=0), m3(n=2), затем m2(n=1); ключ n=1 сохраняется и используется позже. Дубликат n и гэп >1000 отвергаются.

#### 3.4.5. Состояние сессии

| Поле | Размер/тип | Примечание |
|---|---|---|
| `session_id` | 16 байт | Ключ записи. |
| `peer_device_id`, `peer_user_id` | uuid | Получатель. |
| `peer_ik_sig`, `peer_ik_dh` | 32+32 | Для детекта подмены. |
| `RK` | 32 | Root key. |
| `DHs_priv/pub` | 32+32 | Текущая отправляющая ratchet-пара. |
| `DHr` | 32 или null | Принимающий ratchet pub. |
| `CKs`, `CKr` | 32 или null | Цепочки. |
| `Ns`, `Nr`, `PN` | u32 | Счётчики. |
| `MKSKIPPED` | map | `(dh_pub, n) -> MK`, TTL/лимиты. |
| `version` | u8 | 1. |
| `created_at`, `last_used_at` | time | Для TTL/GC. |
| `local_copy_ref` | uuid/null | Ссылка на локальную копию отправленного/принятого; без неё сообщение помечается «недоступно на этом устройстве». |

**3.4.5.1. FS/PCS window и уничтожение ключей (нормативно, P1-D).** Единственная семантика чисел: **`SPK_TTL = 90 дней` retained** (**`SPK_RETAIN_PRIVATE = 3`**, текущий + 2 предыдущих, **`SPK_RETAIN_WINDOW = 90 дней`**); **`SPK_ROTATION_INTERVAL = 30 дней`** — только плановая ротация current SPK, а не TTL удаления private. Формулировки «2 total / 60 дней» и «удалять private SPK через 30 дней без сессий» недействительны и не должны встречаться в коде/тестах.

| Ключ/состояние | Когда уничтожается | Что это даёт | Что **не** даёт |
|---|---|---|---|
| OPK private | **сразу** после успешной AEAD первого сообщения (в той же транзакции, что state+`Message`); при ошибке AEAD — не уничтожается | одноразовость, FS для prekey-сообщения | не защищает от компрометации до использования |
| Старый `DHs_priv` | **сразу** после DH-ratchet в приёме/отправке; хранится только текущая пара `DHs_priv/pub` | PCS после ответного ratchet | не мгновенный PCS: до ответного DH старый ключ нужен |
| SPK private | при ротации: новый SPK становится current, предыдущий остаётся; всё, что старше 3-го, уничтожается; **запись без сессий не удаляется по 30-дневному TTL** — private SPK живёт до 90 дней (или до 4-й ротации, P2-26) | расшифровка prekey-сообщений в окне **90 дней**; 30 дней — только интервал ротации current SPK | после уничтожения prekey-сообщение не расшифровывается → `KEY_HANDSHAKE_INVALID`/`SPK_DELETED` + reset |
| `MKSKIPPED` | TTL 30 дней, ≤2000 на сессию, ≤1000 на цепочку; eviction самых старых — с метрикой | ограниченная память | не бесконечная доставка out-of-order |
| Сессия | `SESSION_IDLE_TTL = 90 дней` (неактивная), после подтверждённого reset/revoke | гигиена | `SESSION_IDLE_TTL` — **не** FS-граница: это GC, а не обещание |

- **Zeroization:** JS не даёт гарантированного zeroize `CryptoKey`; нормативно — удалить запись IndexedDB, обнулить raw-byte буферы (если они были), сбросить ссылки, не логировать. Честная формулировка: «best-effort, без обещания стойкости к дампу памяти» (§9.3).
- **PCS:** только после ответного DH-ratchet; «мгновенный PCS» не обещается. `SESSION_IDLE_TTL=90` не является границей FS.
- **Property/тест (E2EE-AC-12, S1):** после N ratchet в IndexedDB нет старых `DHs_priv`; после использования OPK его private отсутствует; после 3 ротаций SPK приватных SPK ровно 3, 4-й удалён; неиспользованный (нет сессий) SPK возраста **31/60/89 дней сохраняется, 90 — сохраняется, 91 — уничтожается**; prekey-сообщение со старым (удалённым) `spk_id` → `KEY_HANDSHAKE_INVALID`/`SPK_DELETED` и reset, а не «попробуем позже»; storage-scan не находит уничтоженных ключей.

#### 3.4.6. Атомарность, локальная копия и multi-tab (критично, P0-4)

**Инвариант: сначала локальная персистенция — потом сеть.** Self-envelope отсутствует, поэтому единственный экземпляр собственного сообщения — локальный. Потеря между `send` и записью копии означает, что отправитель никогда не прочитает своё сообщение, хотя получатель его прочитал.

**Порядок отправки (обязателен):**

1. `derive MK` и зашифровать (state сдвигается только в памяти).
2. Открыть **одну** IndexedDB read-write транзакцию по store `sessions` + `outbox` + `local_messages` и записать:
   - новое состояние сессии (`RK/CK/Ns/DHs` и т.д.);
   - **точные bytes** каждого конверта (`envelopes[]`), `header`, `session_id`;
   - `Idempotency-Key`, `client_message_id`, `chat_id`, `type`;
   - **локальную копию** plaintext и ciphertext, зашифрованную `K_storage`, с `status='pending'`, `local_message_id`.
3. `commit`. Только после успешного commit — HTTP-запрос.
4. После ответа `201` — отдельная транзакция: `status='sent'`, `server_message_id`, `seq`; при replay — те же значения.
5. Если commit не удался — **ничего не отправлять**; состояние в памяти откатывается (повторная попытка с тем же plaintext допустима только после успешного commit).

**Crash/replay (обязательные сценарии):**

| Точка падения | Состояние на диске | Действие после reload |
|---|---|---|
| до commit | ничего | сообщение не отправлено; UI «не отправлено»; можно повторить с новым/тем же `client_message_id` (MK не сдвинут) |
| после commit, до сети | state+bytes+копия, `pending` | outbox worker отправляет **те же bytes** и `Idempotency-Key`; сервер отвечает replay/201; помечает `sent` |
| после сети, до `sent` | bytes+копия, `pending` | повтор тех же bytes; `201`/`Idempotent-Replay:true` с тем же `seq`; помечает `sent` |
| после `sent` | `sent` | ничего; локальная копия — источник отображения |
| кэш очищен | копии нет | сообщение видно по серверному `Message`, но текст «недоступно на этом устройстве»; self-envelope нет — восстановления нет |

- **Запрещено** перешифровывать сообщение после падения: повтор всегда идёт с сохранёнными bytes. Новая шифровка того же текста — только новый `client_message_id` + новый `Idempotency-Key`.
- **Приём:** `decrypt` на копии состояния → одной транзакцией `state + plaintext copy + message_id` → только затем `display`. При падении до commit повторная расшифровка тем же ключом безопасна (состояние ещё не сдвинуто).
- **Multi-tab:** один writer на сессию: `navigator.locks.request("krug-session:"+session_id)` вокруг send/receive; outbox — отдельный lock `"krug-outbox"`. Фолбэк — leader election через `BroadcastChannel`. Два таба не должны одновременно двигать цепочку или отправлять один outbox-элемент.
- Незавершённая запись откатывается IndexedDB-транзакцией; «полу-сдвинутое» состояние недопустимо.
- **Честный UI:** при отсутствии копии — «недоступно на этом устройстве», а не пустое сообщение и не ошибка. Факт отправки и `client_message_id` остаются видимы.

### 3.5. AEAD, inner payload и padding

#### 3.5.1. Inner payload

Открытый текст — бинарный фрейм, не «голый» JSON:

| Смещение | Размер | Поле |
|---|---|---|
| 0 | 20 | ASCII `Krug/E2EE/v1/payload` |
| 20 | 1 | `u8` version = 1 |
| 21 | 1 | `u8` content_type: `1` = TEXT_JSON, `2` = SESSION_RESET (управляющий, не показывается) |
| 22 | 4 | `u32` body_len (≤32768) |
| 26 | body_len | UTF-8 JSON body |
| 26+body_len | 0..255 | нули до кратности 256 |

Body (TEXT_JSON) — фиксированная схема v1 (неизвестные поля игнорируются):

```json
{"text":"...","reply_to_id":null,"mentions":[]}
```

- `text` — строка 1..8000 Unicode code points; пустой текст запрещён.
- `reply_to_id` — uuid или null; должен ссылаться на сообщение того же чата (проверяет клиент; сервер не видит).
- `mentions` — массив uuid; в E7 не используется, зарезервировано.
- `attachment_refs` — в E7 запрещено (файлы E2EE — следующая фаза).
- Неизвестные поля клиент игнорирует, но `content_type`/версия определяют схему; unknown content_type → `UNSUPPORTED_CONTENT_TYPE`.
- HTML/Markdown не исполняются; рендер — текстовыми узлами (существующее правило frontend).
- **Получатель обязан валидировать inner payload сам (P2-7)**, а не доверять отправителю: `body_len ≤ 32768`, `padded_len % 256 == 0`, padding нулевой, `text` — 1..8000 code points, допустимые Unicode (без C0/C1, кроме `\n`/`\t`; без bidi-override `U+202A..U+202E/U+2066..U+2069`), `reply_to_id` — uuid/null и только сообщение того же чата, `mentions` — массив uuid (в v1 пустой), `attachment_refs` отсутствует. Нарушение → `INVALID_PAYLOAD`, сообщение не рендерится; это защита от UI-DoS/спуфинга со стороны вредоносного peer.
- `content_type=2 (SESSION_RESET)` — управляющий payload R-15. **Схема v1 (S4, P1-C):** тело
  ```json
  {"failed_session_id":"<b64u16>","failed_chain_dh":"<b64u32>","failed_n":3,
   "reason":"SPK_DELETED|UNKNOWN_SPK|DECRYPT_FAILED|NO_SESSION|KEY_HANDSHAKE_INVALID",
   "retry_of_client_message_id":"<uuid|null>"}
  ```
  - `failed_chain_dh` — **`header.dh` того сообщения, которое получатель не смог расшифровать** (ratchet-цепочка); `failed_n` — его `header.n`; `retry_of_client_message_id` — его `client_message_id` (якорь окна повтора, §5.5).
  - Обязательны `failed_session_id`, `failed_chain_dh`, `failed_n`, `reason`; `retry_of_client_message_id` может быть `null` только если отправитель не смог сопоставить сообщение (тогда окно определяется парой `(failed_chain_dh, failed_n)`).
  - Передаётся **внутри нового prekey-конверта**, не показывается, не уведомляет, не считается пользовательским сообщением и не участвует в unread после расшифровки; сервер не может отличить его от TEXT (content_type не видит) — клиент скрывает и помечает прочитанным.
  - Получатель reset (`A`) обязан: (1) удалить failed-сессию; (2) выбрать сообщения этой сессии с локальным индексом отправки **≥** индекса `retry_of_client_message_id` (fallback — `header.dh == failed_chain_dh && header.n >= failed_n`); (3) перешифровать только их, каждому — новый `client_message_id` и новый `Idempotency-Key`. Сообщения **до** якоря не перешифровываются (§5.5).
  - **V1.1 `retry_of_client_message_id`.** Inner body `TEXT_JSON` остаётся обратно совместимым: нормальные сообщения не содержат поле; переотправленный TEXT несёт `retry_of_client_message_id` (UUID) внутри inner payload. Поле не меняет framing/AD и не видно серверу. `vector_set_version=5`; D1-байты обычного TEXT не изменились.
  - **V1-дедуп reset (E7-F5F).** Отправитель дедуплицирует повторный reset по `(failed_session_id, failed_chain_dh, failed_n, retry_of_client_message_id)`: первый reset удаляет failed-сессию, поэтому повтор не перешифровывает окно ещё раз (после reload — `invalid_session`, в памяти — `duplicate`). Это защищает от повторной доставки/ретрая самого control-сообщения.
  - **Получатель retry (`B`) в v1.1.** Если переотправленный TEXT несёт `retry_of_client_message_id`, `B` проверяет, было ли это сообщение уже расшифровано. Если да — replacement молча скрывается (`superseded`), без UI-дубля, unread и уведомления; если оригинал был failed/unavailable — replacement принимается, а исходная строка скрывается. Dedupe не делается по ciphertext.
  - Точный wire-фрейминг этого тела — вектор **L1** (body 217 B → raw 243 → padded 256, 13 нулей), значения окна — **L3b**.

Длина: `raw_len = 26 + body_len`; `padded_len = ceil(raw_len / 256) * 256` (если уже кратно — padding 0). Получатель проверяет `padded_len % 256 == 0`, `body_len <= 32768`, `padded_len - raw_len < 256`, все padding-байты нулевые.

**Точная арифметика лимитов (P1-3):** 32768 (body) → `raw_len = 32794` → `padded_len = 33024` (230 нулей) → `+16` tag = **33040 decoded** → **44054 b64u-символа = 43.0 KiB encoded**. 9 конвертов + JSON-обёртка = **405098 B (395.6 KiB)**; 10 = **450099 B (439.5 KiB)**; 512 KiB wire хватает с запасом 116.4/72.4 KiB. Измерение ревью 405129 B отличается на 31 B (длина обёртки/ids) и тоже < 512 KiB.

`MAX_ENVELOPE_CIPHERTEXT_ENCODED_CHARS = 65536` — это **form guard** (64 KiB именно **encoded**), проверяемый до base64-decode; он **не** является приёмочным лимитом (P2-11): приём ограничен каноническими **33040 decoded / 44054 encoded**, всё большее → `413` (`details.reason="canonical"`). Guard — не бюджет fan-out: 10 × 65536 > 512 KiB, поэтому действует общий wire-лимит. 32 KiB body выбрано так, чтобы 8000 code points по 4 байта UTF-8 (32 000 байт) + JSON-обёртка помещались в body. Клиент проверяет **байтовую** длину body, а не только число code points: JSON-экранирование управляющих символов может увеличить размер, и тогда сообщение отклоняется `MESSAGE_TOO_LONG`.

Вектор **D1-inner-payload-framing** (body 51 байт → raw 77 → padded 256; padding 179 нулевых байт).

#### 3.5.2. AEAD

```
K_enc = HKDF(IKM=MK, salt=0×32, info=D_AEADK, L=32)
N     = HKDF(IKM=MK, salt=0×32, info=D_AEADN, L=12)
C     = AESGCM(K_enc, N, padded_plaintext, AD)   // C = ciphertext || tag16
```

Nonce детерминирован от MK; MK уникален для `(session, chain, n)`, поэтому nonce не повторяется. Запрещено использовать случайный nonce с тем же MK.

Расшифровка: проверить tag (AEAD), затем фрейм. При неверном tag — `DECRYPT_FAILED`, без утечки деталей в UI/логи.

Векторы **D2** (prekey-сообщение) и **D3** (n=1).

#### 3.5.3. Associated Data (AD) — точная структура, 163 байта

| Смещение | Размер | Поле |
|---|---|---|
| 0 | 15 | ASCII `Krug/E2EE/v1/ad` |
| 15 | 1 | `u8` envelope version = 1 |
| 16 | 1 | `u8` flags: bit0 = PREKEY; остальные 0 |
| 17 | 16 | `chat_id` |
| 33 | 16 | `sender_device_id` |
| 49 | 4 | `u32` `sender_key_generation` |
| 53 | 16 | `recipient_device_id` |
| 69 | 4 | `u32` `recipient_key_generation` |
| 73 | 16 | `session_id` |
| 89 | 32 | `preamble_hash`: `SHA-256(preambul)` при PREKEY, иначе `0×32` |
| 121 | 42 | `header` (см. ниже) |

Header, 42 байта:

| Смещение | Размер | Поле |
|---|---|---|
| 0 | 1 | `u8` header version = 1 |
| 1 | 1 | `u8` flags = 0 |
| 2 | 4 | `u32` `pn` |
| 6 | 4 | `u32` `n` |
| 10 | 32 | `dh` (ratchet public) |

AD собирается из **полей**, а не из полученных байтов JSON. Поэтому парсер обязан сначала провалидировать типы/длины/диапазоны, затем собрать AD. Вектор **F1** содержит `decoded.ad_hex` (163 байта); **E1** — AD для каждого шага.

### 3.6. Ошибки протокола (клиентские)

| Код | Когда | Действие |
|---|---|---|
| `KEY_HANDSHAKE_INVALID` | Подпись/ключи/чат/session_id не совпали | Не отображать, не отправлять, алерт безопасности |
| `KEY_CHANGE_DETECTED` | Для `session_id` другие peer-ключи или fingerprint изменился | Сбросить сессию, warning, требует подтверждения |
| `UNSUPPORTED_ENVELOPE_VERSION` | `v != 1` | «Обновите приложение»; не пытаться расшифровать |
| `UNSUPPORTED_CONTENT_TYPE` | Неизвестный тип inner payload | Показать «неподдерживаемое сообщение» |
| `DECRYPT_FAILED` | AEAD tag неверен | Не молчать (R-15): показать «не удалось расшифровать»; для prekey-конверта отправить `SESSION_RESET`; для ratchet — один retry, затем reset |
| `DUPLICATE_OR_OLD_MESSAGE` | `n < Nr` без skipped key | Игнорировать (дубль) |
| `SESSION_TOO_FAR_BEHIND` | Гэп > `MAX_SKIP` | Показать «пропущено слишком много сообщений»; запросить историю/новую сессию |
| `NO_SESSION` | Нет сессии для устройства | Создать новую через claim |
| `OPK_EXHAUSTED` | `otp_exhausted=true` | Продолжить 3DH + предупреждение |
| `KEY_STORAGE_UNAVAILABLE` | `K_storage` отсутствует/повреждён | Не отправлять; честно сказать «хранилище ключей недоступно, войдите заново/новое устройство»; **не** фабриковать `STORAGE_LOCKED` и не обещать unlock, которого нет (P1-11) |
| `SESSION_RESET_REQUIRED` | Prekey-сообщение не расшифровано/SPK удалён | Отправить `SESSION_RESET` (content_type=2), удалить сессию, новый claim, новый `client_message_id` (§5.5) |
| `PAYLOAD_INVALID` | Inner schema/limits/bidi/unknown content_type | Не рендерить, показать «неподдерживаемое сообщение», не падать |

Ни при каких ошибках нельзя отправлять plaintext или «пустое» сообщение. Fallback на managed в E2EE-чате запрещён.

---

## 4. Wire format

### 4.1. Envelope (JSON)

Один конверт = один recipient device. Все бинарные поля — `b64u` без padding, канонические (см. §4.7).

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| `v` | int | да | 1 |
| `scheme` | string | да | `PAIRWISE_X3DH_DR` |
| `chat_id` | uuid | да | Совпадает с путём/сообщением. |
| `sender_device_id` | uuid | да | Устройство из `X-Device-Id`. |
| `sender_key_generation` | int | да | 1..2^31-1; текущая генерация отправителя. |
| `recipient_device_id` | uuid | да | Не равен `sender_device_id` (self-envelope отсутствует; своя копия — локальная, §5.2). |
| `recipient_key_generation` | int | да | 1..2^31-1; текущая генерация получателя. |
| `session_id` | b64u16 | да | 22 символа. |
| `header` | object | да | `{v:1, dh:b64u32, pn:u32, n:u32}`, `additionalProperties:false`. |
| `ciphertext` | b64u | да | **Приёмочный лимит — канонический v1:** decoded 272..33040 B = 363..44054 символа; нижняя граница 272 B = один 256-байтовый padding-блок + 16-байтовый AEAD tag (P1-02), верхняя — 33024 padded + 16 tag; больше → `413 ENVELOPE_TOO_LARGE` (`details.reason="canonical"`). Form guard 65536 символов проверяется до decode и приёмом не является (P2-11). V18 хранит floor как `NOT VALID` CHECK, V19 переносит legacy-строки вне диапазона в quarantine и валидирует constraint; для устройства без валидного конверта `GET`/WS отдают `crypto:null` (`200`/кадр), а не `500` (§6.5.3). |
| `prekey` | object/null | нет | Только в первом сообщении сессии; см. ниже. |

`prekey` (public, не секрет):

| Поле | Тип | Правило |
|---|---|---|
| `sender_identity_signing_key` | b64u32 | Ed25519 A. |
| `sender_identity_dh_key` | b64u32 | X25519 A. |
| `sender_ephemeral_key` | b64u32 | EK A. |
| `recipient_identity_dh_key` | b64u32 | X25519 B. |
| `spk_id` | string | 1..64, `[A-Za-z0-9._-]`. |
| `spk_public` | b64u32 | SPK B. |
| `opk_id` | string/null | null, если OPK нет. |
| `opk_public` | b64u32/null | null, если OPK нет. |
| `signature` | b64u64 | 86 символов. |

**Пример F1** (полный JSON — в `docs/E2EE-TEST-VECTORS.json`, `F1-envelope-prekey.expected.envelope_json`):

```json
{
  "v": 1,
  "scheme": "PAIRWISE_X3DH_DR",
  "chat_id": "00000000-0000-4000-8000-000000000100",
  "sender_device_id": "00000000-0000-4000-8000-000000000011",
  "sender_key_generation": 1,
  "recipient_device_id": "00000000-0000-4000-8000-000000000021",
  "recipient_key_generation": 1,
  "session_id": "hsaPZNLDvpn95Kq-hX4fXg",
  "header": {
    "v": 1,
    "dh": "-TrAwtuY_1u1fnmkvVMICLzgSqhwqEgx_3v8_rBObBk",
    "pn": 0,
    "n": 0
  },
  "ciphertext": "9REZaO8UOmYZm-qmZipQNpajqEbLAbgdDpmm4usOlzJXTVJLjDJRJNjpm4X_Jf-zr6ohMC0aJejhLPQY7cKxjry-mKWW028SW0ayxxVgE14cnBGd8G2R7Nl6m55G6OgvIJEwU1fnyZhiks_5ARAuEuxK4w5i187h2yPnwIZBprtG5_BubPACubuSC8iMg9GekKsGJvYKbsM0ZEKwifaY_KX9-x7RLZDUQOJ8KzDPFQCcxZ-kxsBsI2z9WR4V2CswMy_VtV-P3BtU962eP2krXBwaCmPQuL3fOx1dNb-wAnMRWc6gGYun7rYXhS30VfRVDcoi1T_lY1RfY-iniGsD7BmtklukhcQLZNkNtlim29c",
  "prekey": {
    "sender_identity_signing_key": "djQ2_H11EhPhoJ9Sjy1A15gAwRV7ALsbCWyjGT7YLmI",
    "sender_identity_dh_key": "n_dIUK4u8DZXOKn0vQbq36OKwko6ah9l_akxZCFFcT4",
    "sender_ephemeral_key": "PDxMC6X0x90zWTllWCCqlnLX5Y_sQFLLx5HvOBk0kiQ",
    "recipient_identity_dh_key": "gNQawPXrkUyR6Kekq9RAEHA9mCki-0D9QhwuOmZrpAQ",
    "spk_id": "spk-1",
    "spk_public": "CA4puJFgi4K5Jsi7SaGO1dK929yHxKUJ6N2uxRk7Dno",
    "opk_id": "opk-1",
    "opk_public": "b5S3QEwMb1HN0gi_UuxrXlfNmy-L5hSGsbFrmVvd0CU",
    "signature": "Rj4RhxwlwK_CmZLayCo_vIKQYbs9tiLGKYPu-7A0HXFuRFJRK2s0L1YNqlbZXe3ce5YlMsISj9So7ikY-tMIBw"
  }
}
```

Второй конверт без `prekey` — **F2-envelope-no-prekey**; `flags` bit0 = 0, `preamble_hash` = 0×32.

**Связь prekey-блока с зарегистрированными ключами (P0-2b).** `prekey.sender_identity_signing_key`/`sender_identity_dh_key` обязаны совпадать с `auth.devices.identity_signing_key`/`identity_dh_key` для `sender_device_id` и с полями claim-bundle/`GET /chats/{id}/keys`. Это не новое поле wire format и не меняет `envelope.v=1`: проверка использует уже переданные значения. Сервер отвергает расхождение `422 INVALID_ENVELOPE_FORMAT` (или `409 KEY_CHANGED`, если `key_generation` успела измениться); клиент отвергает `KEY_HANDSHAKE_INVALID`. Исключение — `recipient_identity_dh_key`: это ключ **получателя**, он сверяется с собственным `IK_dh` (п. 4 §3.3.1).

**Где binding-подпись отправителя.** В `prekey` block её нет (это не меняет wire format). `identity_binding_signature` приходит в `GET /chats/{id}/keys` и в `POST /keys/claim` (§6.2.5/§6.2.6); получатель обязан проверить её **над ключами из prekey/bundle** и сохранить в TOFU-пине. Добавление поля в конверт потребовало бы `envelope.v=2`; в S3 этого нет.

### 4.2. Сообщение: создание (`POST /chats/{chatId}/messages`)

**Managed** — без изменений (`text`, `sticker_id`, `attachment_ids`).

**E2EE** — только конверты:

```json
{
  "client_message_id": "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e10",
  "type": "TEXT",
  "envelopes": [
    {"…": "F1-envelope-prekey для устройства Bob"},
    {"…": "конверт для второго устройства Alice (если есть)"}
  ]
}
```

Правила:

- `envelopes` обязателен, 1..10, без дублей `recipient_device_id`; **`recipient != sender`** (self-envelope нет).
- **Каждый `recipient_device_id` обязан быть `e2ee_capable=true`** (ACTIVE-устройство с `identity_key_alg='Ed25519+X25519'` и ключами). Конверт на legacy-устройство (нет ключей/`LEGACY`) — `422 E2EE_LEGACY_DEVICE` с `details.field="envelopes[i].recipient_device_id"`; сообщение и `seq` не создаются, частичного fan-out нет (P1-B-1). Legacy-устройство нельзя «покрыть» конвертом: у него нет SPK/OPK, сессия с ним невозможна.
- `text`, `sticker_id`, `attachment_ids` должны отсутствовать; иначе `422 E2EE_PLAINTEXT_FORBIDDEN`.
- `envelopes` в managed-чате → `422 ENVELOPES_NOT_ALLOWED`.
- `type` в E2EE v1 — только `TEXT`; `STICKER`/`SYSTEM` → `422`. Управляющий `SESSION_RESET` — внутри inner payload (`content_type=2`) и остаётся `type=TEXT` для сервера.
- `reply_to_id` передаётся **только внутри** inner payload (TEXT_JSON, §3.5.1); верхнеуровневый `reply_to_id` в E2EE **запрещён** и даёт `422 E2EE_PLAINTEXT_FORBIDDEN` (`details.field="reply_to_id"`), сообщение не создаётся. Причина: серверное поле — plaintext-метаданные «на что отвечали» и связь с `message_id`, которых в E2EE-конверте нет; DB CHECK `ck_messages_e2ee_no_reply_to_id` (§6.5) — вторая линия. `reply_to_id` **не** входит в AD (он в inner payload, а не в заголовке); это не меняет wire format.
- **`client_message_id` (D-07, P1-10):** уникальность scoped — `(chat_id, sender_id, client_message_id)`, **не** глобально по чату. Повтор **тем же отправителем** с теми же bytes → существующее сообщение (`201`, `Idempotent-Replay: true`, тот же `id`/`seq`). Повтор с тем же id, но другим body → `409 CLIENT_MESSAGE_ID_CONFLICT`. **Другой пользователь** с тем же id в том же чате → `409 CLIENT_MESSAGE_ID_CONFLICT`, никогда не replay и не возврат чужого сообщения. Значение эхоится в `Message`, но **не** входит в AD и не является аутентификатором прав.
- **Legacy-only replay (P2-09, E7-B3F3):** если у сообщения **не осталось ни одного валидного конверта** (единственный конверт был 16..271 B и перенесён V19 в quarantine), `201` по новому idempotency-identity не выдаётся: повтор тех же коротких bytes → `422 INVALID_ENVELOPE_FORMAT` (`details.reason="ciphertext_too_short"`, кодек отвергает их до replay-ветки); валидное, но другое тело с тем же `client_message_id` → `409 CLIENT_MESSAGE_ID_CONFLICT`; с тем же `Idempotency-Key`, но другим телом → `409 IDEMPOTENCY_KEY_REUSED`. `201` возможен только для настоящего idempotency-replay с валидным телом (тот же ключ + те же bytes) или если у сообщения есть хотя бы один валидный конверт; повтор исходных 16..271 B даёт `422` даже с тем же ключом. Это не `500`, не пересоздание сообщения и не потеря данных: `GET` отдаёт `crypto:null` (§6.5.3).
- Своё текущее устройство **не** получает конверт; локальная копия сохраняется до отправки (§3.4.6, §5.2). В ответе `crypto:null`.

Ответ 201 — `Message` + (только для E2EE) `envelope_coverage`:

```json
{
  "id": "8b0f...",
  "chat_id": "00000000-0000-4000-8000-000000000100",
  "seq": 42,
  "type": "TEXT",
  "sender_id": "...",
  "sender_display_name": "...",
  "text": null,
  "reply_to_id": null,
  "created_at": "2026-11-16T12:00:00Z",
  "version": 1,
  "client_message_id": "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e10",
  "crypto": null,
  "envelope_coverage": {
    "devices": 3,
    "covered": 2,
    "peer_devices": 1,
    "peer_covered": 1,
    "self_devices": 2,
    "self_covered": 1,
    "uncovered_device_ids": ["00000000-0000-4000-8000-000000000021"],
    "warning": "SELF_DEVICE_UNCOVERED"
  }
}
```

`envelope_coverage` — ответ только на POST, не хранится и не возвращается в GET.

- `devices` (deprecated-агрегат) = `peer_devices + self_devices`, `minimum: 0`; `covered` = `peer_covered + self_covered`.
- `peer_devices` — активные `e2ee_capable` устройства **получателя**; `self_devices` — другие активные `e2ee_capable` устройства отправителя (текущее исключено). Legacy-устройства (в т.ч. `ACTIVE`, но `e2ee_capable=false`) **не входят ни в один счётчик**: они не кандидаты доставки и не могут быть покрытием (P1-B-1).
- `uncovered_device_ids` — **только `e2ee_capable`** устройства, для которых конверта нет (нет сессии/SPK/OPK). Legacy-устройства в этом списке не появляются: UI не должен показывать «недоступно на части устройств» из-за устройства, которое в принципе не адресуется E2EE.
- **P1-7:** если при **новом** send `peer_devices == 0` (у получателя нет ни одного активного capable-устройства), сервер **отклоняет** сообщение `409 E2EE_NO_ACTIVE_DEVICES` до создания `Message`, а не возвращает ложный `covered==devices`.
- **Replay (P2-01):** coverage не хранится и при идемпотентном replay (`Idempotency-Key` или тот же `client_message_id`+bytes) пересчитывается по **текущим** устройствам в tenant-scope. Поэтому контрактный `EnvelopeCoverage.peer_devices` — `minimum: 0`: после revoke единственного capable-устройства peer replay честно отдаёт `peer_devices=0` (не клампится до 1 и не маскируется под доставку). Новый send в этом же состоянии по-прежнему `409 E2EE_NO_ACTIVE_DEVICES`. Повторные `201`-ответы всегда содержат `envelope_coverage` (D-S4-04); при невозможности пересчитать coverage сервер отвечает `5xx`, а не `201` без поля.
- **P1-B (coverage ≠ candidates):** `peer_devices` — только кандидаты; доставка доказывается `peer_covered` = число **разных** `recipient_device_id`, принадлежащих peer **и являющихся `e2ee_capable`**, для которых есть конверт. Legacy-устройство peer не увеличивает `peer_covered` ни при каких обстоятельствах (P1-B-1; вектор **M3**). Если `peer_covered == 0`, сервер отклоняет `409 E2EE_NO_PEER_ENVELOPE` до создания `Message`/`seq` — иначе отправитель получает `201`, а собеседник не получает ничего. Если `0 < peer_covered < peer_devices` — `201` с `warning: "PEER_DEVICE_UNCOVERED"`; UI честно пишет «на устройствах собеседника недоступно» и показывает, сколько покрыто. Клиент делает тот же pre-check до запроса: нет ни одного peer-bundle → не отправлять, показать причину (`PEER_UNCOVERED`).
- **Self-предупреждение:** если `self_covered < self_devices`, сервер принимает сообщение (получатель важнее) и ставит `warning: "SELF_DEVICE_UNCOVERED"`; UI пишет «на других ваших устройствах недоступно». Если одновременно не покрыт peer — приоритет у `PEER_DEVICE_UNCOVERED`.
- `warning` — ровно одно значение или `null`; оба условия одновременно в одно поле не смешиваются. 
- `crypto:null` в ответе отправителю, потому что своему устройству конверт не адресуется; своя копия уже локально (§5.2).

### 4.3. Сообщение: чтение (`GET /chats/{chatId}/messages`)

Для E2EE каждый элемент содержит `crypto` — **только конверт для устройства из `X-Device-Id`**:

```json
{
  "id": "8b0f...",
  "chat_id": "...",
  "seq": 42,
  "type": "TEXT",
  "sender_id": "...",
  "sender_display_name": "...",
  "text": null,
  "reply_to_id": null,
  "created_at": "2026-11-16T12:00:00Z",
  "version": 1,
  "client_message_id": "...",
  "crypto": {
    "v": 1,
    "scheme": "PAIRWISE_X3DH_DR",
    "chat_id": "00000000-0000-4000-8000-000000000100",
    "session_id": "hsaPZNLDvpn95Kq-hX4fXg",
    "sender_device_id": "...",
    "sender_key_generation": 1,
    "recipient_device_id": "...",
    "recipient_key_generation": 1,
    "header": {"v": 1, "dh": "...", "pn": 0, "n": 0},
    "ciphertext": "...",
    "prekey": null
  }
}
```

- Если для устройства конверта нет (новое устройство, сообщение до его регистрации, своё отправленное сообщение) — `crypto:null`. Клиент показывает «недоступно на этом устройстве», не ошибку. Для **своих** отправленных источник — локальная копия (P0-4); при её отсутствии — честный статус `unavailable`, а не пустой текст.
- `Message.client_message_id` присутствует всегда (nullable) и позволяет сопоставить локальную копию с серверным сообщением после reload/retry; это не аутентификатор.
- Сервер **не** отдаёт конверты других устройств, даже того же пользователя. Это приватность метаданных между устройствами.
- Сервер не отдаёт `envelopes[]` целиком и не сообщает их число.
- **P2-13 (server-forged plaintext):** в E2EE-чате клиент **обязан игнорировать** `Message.text`, `reply_to_id`, `sticker`/`sticker_id` и `attachments` от сервера, если `crypto:null` (и вообще всегда, кроме локальной копии). Рендер — только из расшифрованного `crypto`/локальной копии; иначе malicious-сервер может «нарисовать» plaintext от имени собеседника. Обнаруженное непустое plaintext-поле в E2EE-сообщении — security alert + метрика, не рендер.
- `client_message_id` добавлен в `Message` (nullable), чтобы клиент мог сопоставить локальный plaintext-кэш с серверным сообщением после reload/retry. Это закрывает долг I-01.

### 4.4. WebSocket

- `message.created`: payload — тот же `Message`, что GET, с `crypto` для устройства соединения. Для отправителя на том же устройстве `crypto:null` (локальная копия уже есть). При `e2ee.enabled=false` live- и replay-кадры E2EE не публикуются (P2-03), как и REST GET → `409 E2EE_DISABLED`.
- **R-15 не использует WS-событие.** `chat.session.reset` как неаутентифицированное событие сервера **отклонён**: любой, кто может инжектить WS/подменить сервер, сбросил бы сессии. Reset передаётся только зашифрованным `content_type=2` внутри нового prekey-конверта (§5.5). `chat.keys.changed` остаётся для ключей/устройств, не для контента.
- `content_type=2` сервер не видит; клиент скрывает такое сообщение, не уведомляет и сразу помечает прочитанным. Возможный кратковременный unread-счётчик на сервере — известное ограничение, не security.
- `chat.keys.changed` — новый event, **без** `seq` (не replay-ится):

```json
{"v":1,"type":"event","event":"chat.keys.changed","event_id":"...","chat_id":"...","ts":"...",
 "payload":{"chat_id":"...","reason":"DEVICE_REVOKED","device_id":"...","key_generation":2}}
```

`reason`: `DEVICE_ADDED | DEVICE_REVOKED | IDENTITY_KEY_CHANGED | VERIFICATION_CHANGED | KEY_GENERATION_CHANGED`.

- `device.list.changed` — для собственных устройств (новое/отозванное), payload `{device_id, status, key_generation}`.
- Клиент на `chat.keys.changed` делает `GET /chats/{id}/keys`, обновляет сессии/предупреждения; на reconnect — всегда перечитывает ключи.
- Сервер не рассылает `chat.keys.changed` с содержимым сообщений.

### 4.5. Лимиты

| Лимит | Значение (единицы) | Ответ при превышении |
|---|---|---|
| Конвертов на сообщение | 10 (штук; fan-out max 9) | `422 TOO_MANY_ENVELOPES` |
| Дубли recipient device | — | `422 DUPLICATE_ENVELOPE` |
| `ciphertext` на конверт | **decoded 272..33040 B** и **encoded 363..44054** (приём); encoded >65536 отсекается form guard до decode | `413 ENVELOPE_TOO_LARGE` (`details.reason`: `canonical`/`form`) |
| **Всё тело запроса** | **524288 B (512 KiB) wire**, до парсинга | `413 PAYLOAD_TOO_LARGE` (тот же код на прокси) |
| Inner body | 32768 B decoded (32 KiB) | `422 MESSAGE_TOO_LONG` (managed); `MESSAGE_TOO_LONG`/`PAYLOAD_INVALID` (клиент/получатель) |
| Текст | 8000 code points | managed: `422 MESSAGE_TOO_LONG`; E2EE: клиент/получатель |
| `pn`, `n` | 2^31-1 | `422 INVALID_ENVELOPE_FORMAT`; на 2^31 → `CHAIN_EXHAUSTED` (P2-14) |
| `key_generation` | 2^31-1 | `422 INVALID_ENVELOPE_FORMAT` |
| `session_id` | ровно 16 байт (22 b64u) | `422 INVALID_ENVELOPE_FORMAT` |
| `spk_id`/`opk_id` | 1..64 | `422 INVALID_ENVELOPE_FORMAT` |
| OPK outstanding | 200 | `422 PREKEY_LIMIT_EXCEEDED` |
| Claim devices | 10 | `422 TOO_MANY_DEVICES` |
| Reset | 1 на failed session / 300 с | клиент (rate limit) |

### 4.6. Идемпотентность и retry

| Endpoint | `Idempotency-Key` | Семантика |
|---|---|---|
| `POST /devices` | обязателен | **Сначала** REVOKED-check по IK (`410 DEVICE_REVOKED`), затем identity key (тот же `IK_sig`/`IK_dh` среди не-REVOKED → то же устройство), затем `Idempotency-Key` (тот же body → replay). Другой body под тем же ключом → `409 IDEMPOTENCY_KEY_REUSED`; конфликт пары → `409 IDENTITY_KEY_CONFLICT`; невалидная binding → `422 INVALID_IDENTITY_BINDING`. |
| `POST /devices/{id}/prekeys` | обязателен | Повтор с теми же key_id+bytes → `200` идемпотентно; другие bytes при том же key_id → `409 PREKEY_ID_CONFLICT`. |
| `POST /keys/claim` | **нет** | Каждый вызов потребляет новый OPK; повтор опасен. Защита — rate limit. |
| `PUT /chats/{id}/keys/verification` | обязателен | Повтор → та же запись. |
| `DELETE /devices/{id}` | обязателен | Повтор → `204`. |
| `POST /chats/{id}/messages` | обязателен | Повтор с теми же envelope bytes → тот же `seq` и `Idempotent-Replay: true`. |

**Критично для E2EE:** перед отправкой клиент одной транзакцией сохраняет **точные bytes** конвертов, `Idempotency-Key`, `client_message_id` и локальную копию (§3.4.6). Повтор после network error отправляет те же bytes. Если клиент перешифровал (новый ratchet state), это новый body → нужен **новый** `Idempotency-Key` и новый `client_message_id`; иначе `409 IDEMPOTENCY_KEY_REUSED` (иначе сервер принял бы два разных шифротекста под одним ключом). При `client_message_id` replay сервер возвращает то же сообщение только если `sender_id == caller`; иначе `409 CLIENT_MESSAGE_ID_CONFLICT`.

### 4.7. Как сервер валидирует opaque bytes, не читая их

Сервер **не** расшифровывает, не выводит ключи, не индексирует и не логирует ciphertext/plaintext. Он проверяет только форму и права:

1. **Канонический base64url:** алфавит `[A-Za-z0-9_-]`, без `=`, `len % 4 != 1`; `decode → encode` совпадает с исходной строкой. Это исключает несколько представлений одних байтов.
2. **Точные длины:** `identity_*`/`spk_public`/`dh` — 32; `signature`/`identity_binding_signature` — 64; `session_id` — 16; `ciphertext` — decoded **272**..**33040**, encoded **363**..**44054** (приём, P2-11); encoded >65536 отсекается form guard до decode.
3. **Диапазоны:** `v==1`; `scheme` строго; `pn/n/key_generation` 0..2^31-1; `key_generation >= 1`.
4. **Согласованность:** `chat_id` = путь; `sender_device_id` = `X-Device-Id`; отправитель — active device вызывающего; `recipient_device_id` — **active и `e2ee_capable`** device участника чата (включая другие устройства отправителя); конверт на legacy-устройство → `422 E2EE_LEGACY_DEVICE` (`details.field`), сообщение/`seq` не создаются (P1-B-1); `recipient != sender`; `sender_key_generation`/`recipient_key_generation` равны текущим; нет дублей recipient; `prekey` присутствует только если это первый конверт сессии (сервер не может знать — проверяет только структуру; логическая проверка на клиенте).
4a. **Привязка prekey к зарегистрированной identity (P0-2b).** Для каждого конверта с `prekey != null`: `prekey.sender_identity_signing_key == devices.get(sender_device_id).identity_signing_key` **и** `prekey.sender_identity_dh_key == devices.get(sender_device_id).identity_dh_key`. Расхождение → `422 INVALID_ENVELOPE_FORMAT` с `details.field` (`prekey.sender_identity_signing_key`/`..._dh_key`); если `sender_key_generation` уже не равна текущей — `409 KEY_CHANGED`. Проверка публичная, без секретов; сервер не проверяет приватные ключи. Это дешёвая защита от имперсонации `device_id` при украденном bearer-токене без ключей устройства.
5. **JSON-схема:** `additionalProperties:false` для `header`/`prekey`; неизвестные поля → `422 INVALID_ENVELOPE_FORMAT`. Это защита от контрабанды полей, которые клиент мог бы интерпретировать иначе.
6. **Размеры:** per-envelope (приём: decoded 272..33040 / encoded 363..44054; form guard 65536 — до decode) и **total wire ≤524288 B до парсинга**; decoded-сумма не сравнивается с 512 KiB.
7. **Права:** membership в чате, `chat.security_mode == E2EE`, device active/not revoked, `recipient.e2ee_capable`, лимит устройств.
8. **Никакого `decrypt`:** сервер не импортирует crypto-библиотеки для контента; AES/X25519 в backend отсутствуют. Допустимы только публичные `Ed25519_verify` для SPK и `identity_binding_signature` (без секретов и без оракула).

Псевдокод:

```
on POST /chats/{id}/messages:
  require(raw_body_bytes <= 524288)            // WIRE limit, before JSON parse
  chat = requireMember(chatId, actor)
  require(chat.security_mode == E2EE)          // no plaintext fallback, ever
  rejectIfPresent(text, sticker_id, attachment_ids, reply_to_id)   // reply_to_id: P1-F
  require(1 <= envelopes.length <= 10)
  peer_devices = active e2ee_capable devices of the peer
  require(peer_devices.count >= 1) else 409 E2EE_NO_ACTIVE_DEVICES
  for e in envelopes:
     validateEnvelopeShape(e)                   // canonical b64url, schema
     require(length(e.ciphertext) <= 65536)     // pre-decode form guard (details.reason="form")
     decode(e.ciphertext); require(272 <= decoded <= 33040)   // acceptance cap (details.reason="canonical", P2-11)
     require(e.chat_id == chatId)
     require(e.sender_device_id == actor.deviceId)
     require(devices.get(e.sender_device_id).active)
     require(e.sender_key_generation == devices.get(e.sender_device_id).key_generation)
     if e.prekey != null:
        require(e.prekey.sender_identity_signing_key == devices.get(e.sender_device_id).identity_signing_key)  // P0-2b
        require(e.prekey.sender_identity_dh_key      == devices.get(e.sender_device_id).identity_dh_key)        // P0-2b
        // mismatch -> 422 INVALID_ENVELOPE_FORMAT (details.field); generation changed -> 409 KEY_CHANGED
     target = devices.get(e.recipient_device_id)
     require(target != null && target.active)
     require(target.e2ee_capable)                // P1-B-1: legacy target -> 422 E2EE_LEGACY_DEVICE,
                                                 // details.field="envelopes[i].recipient_device_id"; no partial fan-out
     require(isChatParticipant(target.user_id, chatId))
     require(e.recipient_key_generation == target.key_generation)
     require(e.recipient_device_id != e.sender_device_id)   // no self-envelope
     require(unique(e.recipient_device_id))
  // coverage counts ONLY capable devices: legacy is never a candidate and never coverage (P1-B-1)
  peer_covered = count(distinct e.recipient_device_id)
                    where devices.get(e.recipient_device_id).user_id == chat.peer_user_id
                      and devices.get(e.recipient_device_id).e2ee_capable
  self_covered = count(distinct e.recipient_device_id)
                    where devices.get(e.recipient_device_id).user_id == actor.user_id
                      and devices.get(e.recipient_device_id).e2ee_capable
  require(peer_covered >= 1) else 409 E2EE_NO_PEER_ENVELOPE   // P1-B: 201 без доставки собеседнику запрещён
  warning = (peer_covered < peer_devices.count) ? PEER_DEVICE_UNCOVERED
          : (self_covered < self_devices.count) ? SELF_DEVICE_UNCOVERED : null
  // NB: do NOT sum decoded lengths against 512 KiB; the wire body was already checked.
  tx: allocate seq; insert message(crypto_scheme='E2EE_PAIRWISE', body_ciphertext=null, text column absent);
      insert envelopes; outbox
  respond 201 Message(text=null, client_message_id) + coverage(peer/self, uncovered, warning)
```

**Coverage и legacy (P1-B-1).** `peer_devices`/`self_devices` и `peer_covered`/`self_covered` считаются только по `e2ee_capable`; legacy-устройство (в т.ч. `ACTIVE`) не является ни кандидатом, ни покрытием, ни элементом `uncovered_device_ids`. Поэтому «покрыт только legacy» невозможно: такой конверт отклоняется `422 E2EE_LEGACY_DEVICE` (per-envelope target check) **до** coverage-гейта, а если бы проверка была пропущена — `peer_covered==0` дал бы `409 E2EE_NO_PEER_ENVELOPE`. Оба исхода исключают ложный `201` (вектор **M3**, два варианта).

**Чего сервер не делает:** не парсит inner payload, не проверяет padding, не сравнивает ciphertext с чем-либо, не кэширует по хэшу ciphertext, не отдаёт конверты не адресату, не пишет ciphertext/ключи в логи.

### 4.8. Коды ошибок (новые/изменённые)

| HTTP | `code` | Когда | Retry |
|---|---|---|---|
| 409 | `DEVICE_LIMIT_REACHED` | 6-е активное устройство | после revoke |
| 409 | `DEVICE_ID_CONFLICT` | (резерв; id генерирует сервер) | — |
| 422 | `INVALID_KEY_FORMAT` | длина/алфавит/base64 ключа | нет |
| 422 | `INVALID_SPK_SIGNATURE` | подпись SPK неверна | нет |
| 422 | `INVALID_PREKEY` | OPK/SPK форма/дубль | нет |
| 409 | `PREKEY_ID_CONFLICT` | тот же key_id, другие bytes | нет |
| 422 | `PREKEY_LIMIT_EXCEEDED` | >200 OPK | нет |
| 409 | `NO_PREKEYS` | ни одного bundle | после replenish |
| 422 | `UNKNOWN_DEVICE` | устройство не участник/revoked | после refresh keys |
| 422 | `KEY_GENERATION_MISMATCH` | устаревшая generation | после refresh keys |
| 422 | `ENVELOPES_REQUIRED` | E2EE без envelopes | нет |
| 422 | `ENVELOPES_NOT_ALLOWED` | envelopes в managed | нет |
| 422 | `E2EE_PLAINTEXT_FORBIDDEN` | text/sticker/attachments/**reply_to_id** в E2EE (P1-F) | нет |
| 422 | `TOO_MANY_ENVELOPES` | >10 | нет |
| 422 | `DUPLICATE_ENVELOPE` | два конверта одному устройству | нет |
| 422 | `INVALID_ENVELOPE_FORMAT` | форма/поля/диапазоны | нет |
| 422 | `UNSUPPORTED_ENVELOPE_VERSION` | `v != 1` | после обновления |
| 413 | `ENVELOPE_TOO_LARGE` | ciphertext выше приёмочного кап: decoded >33040 или encoded >44054 (`details.reason="canonical"`); encoded >65536 отсекается до decode (`details.reason="form"`) (P2-11) | нет |
| 413 | `PAYLOAD_TOO_LARGE` | тело >512 KiB | нет |
| 409 | `E2EE_NO_ACTIVE_DEVICES` | у **получателя** (peer) нет ни одного активного `e2ee_capable` устройства; сообщение не создаётся | после регистрации |
| 409 | `E2EE_NO_PEER_ENVELOPE` | `peer_devices >= 1`, но `peer_covered == 0` (ни один конверт не адресован устройству peer); сообщение/`seq` не создаются (P1-B) | после claim/повторной отправки с peer-конвертом |
| 409 | `E2EE_DISABLED` | feature flag выключен; создание E2EE-воркспейса/чата запрещено | позже |
| 409 | `MODE_NOT_SUPPORTED` | чат не E2EE / E2EE-поиск/DLP | нет |
| 409 | `MODE_CHANGE_FORBIDDEN` | попытка изменить `security_mode` чата/воркспейса | нет; новый чат/воркспейс |
| 409 | `CLIENT_MESSAGE_ID_CONFLICT` | тот же id у другого отправителя или другой body | нет |
| 409 | `IDENTITY_KEY_CONFLICT` | глобальный конфликт `IK_sig`/`IK_dh` | нет |
| 422 | `INVALID_IDENTITY_BINDING` | binding-подпись неверна/отсутствует у нового устройства | нет |
| 422 | `NO_KEYS` | claim/`unavailable[]` для legacy/устройства без ключей (**не** для prekeys upload) | после новой регистрации |
| 422 | `E2EE_LEGACY_DEVICE` | попытка использовать legacy-устройство в E2EE: `POST /devices/{id}/prekeys` для legacy-target (P2-4) **или** envelope c `recipient_device_id` legacy-устройства (P1-B-1, M3); `details.field` указывает на устройство | новое устройство |
| 422 | `VH_VERSION_UNSUPPORTED` | `vh_version` != 2 в verification (P2-2) | клиент обновляет VH |
| 409 | `E2EE_GROUP_NOT_SUPPORTED` | E2EE GROUP в E7 | следующая фаза |
| 409 | `KEY_CHANGED` | generation изменилась между claim и verification, либо TOFU-пин не совпал | refresh + re-verify |
| 410 | `DEVICE_REVOKED` | target устройства отозван | нет |
| 422 | `INVALID_SAFETY_NUMBER_HASH` | не 32 байта/base64 | нет |
| 422 | `TOO_MANY_DEVICES` | claim >10 | нет |

`MODE_NOT_SUPPORTED` используется вместо `MODE_NOT_E2EE` из `SYSTEM-ANALYSIS`, чтобы не плодить код; в `details.required_mode="E2EE"`. Если PM хочет точное имя — добавить алиас, но не менять существующий код.

---

## 5. Multi-device (до 5)

### 5.1. Модель

- Каждое устройство — отдельный identity и отдельный набор prekeys; общего «ключа пользователя» нет.
- До 5 **активных** устройств; revoked не считаются.
- `POST /devices` идемпотентен по identity signing key: повтор возвращает то же устройство; одинаковое имя у другого устройства создаёт новое (пока есть слот).
- `POST /devices` **для E2EE** требует `IK_sig`, `IK_dh`, binding-подпись и SPK (все пять полей сразу). Без ключей запрос создаёт legacy-устройство (`identity_key_alg='LEGACY'`, `e2ee_capable=false`, `201`) — это rollout-путь для старых клиентов (D-S4-03), а не апгрейд: legacy-устройства (до E7) и dev-session (`POST /dev/session`, обходит API и не имеет клиентских ключей) остаются без ключей, исключены из claim/fan-out и не дают пользователю участвовать в E2EE, пока он не зарегистрирует хотя бы одно **новое** устройство с ключами. **In-place апгрейд legacy запрещён** (D-17): только новая регистрация; иначе «докинутые» ключи на устройстве с неизвестной историей пришлось бы считать доверенными. Частичный набор ключей → `422 INVALID_KEY_FORMAT`. В prod dev-session отсутствует; для E2E-тестов E2EE используется реальный OIDC flow.
- Каждое устройство хранит свою локальную копию отправленных/принятых сообщений; синхронизация между устройствами — только через fan-out новых сообщений, не через историю.

### 5.2. Fan-out

Для сообщения в DIRECT-чате от устройства A1:

```
recipients =
    все ACTIVE и e2ee_capable устройства пользователя B
  + все другие ACTIVE и e2ee_capable устройства пользователя A (A2..An)
  - A1 (своё текущее устройство)
```

- Максимум: 5 (B) + 4 (свои другие) = **9**; лимит 10 с запасом. Self-envelope **не** добавляется (решение PM), поэтому лимит не меняется.
- Конверт на каждое устройство свой; один plaintext шифруется N раз (нет sender key в 1:1).
- **Своё текущее устройство не получает конверт.** Вместо self-envelope отправитель обязан **до** сети одной IndexedDB-транзакцией сохранить состояние сессии, точные bytes конвертов, `Idempotency-Key`, `client_message_id` и **локальную копию plaintext/ciphertext** (§3.4.6). Копия — единственный экземпляр своего сообщения; она зашифрована `K_storage`. После reload сообщение читается из копии, `client_message_id` сопоставляет её с серверным `Message`.
- **Crash/replay:** падение после commit и до/после сети не теряет сообщение: outbox повторяет **те же bytes** с тем же `Idempotency-Key`; сервер отвечает replay/201 с тем же `seq`. Перешифрование после падения запрещено.
- Свои другие устройства получают конверт и расшифровывают как обычные получатели; так новые сообщения синхронизируются между устройствами.
- Если у устройства нет сессии — она создаётся через claim (для получателя и для своих других устройств).
- Устройство, добавленное после отправки, не получает старые конверты; история на нём недоступна.
- **Очистка кэша:** локальная копия потеряна безвозвратно; UI показывает «недоступно на этом устройстве», но факт отправки, время и `client_message_id` видны. Это честная цена отказа от self-envelope; backup v1 вне E7.
- **Coverage:** `peer_devices == 0` → `409 E2EE_NO_ACTIVE_DEVICES` (P1-7); `peer_devices >= 1`, но `peer_covered == 0` → `409 E2EE_NO_PEER_ENVELOPE` (P1-B), сообщение не создаётся; `peer_covered < peer_devices` → `201` + `warning=PEER_DEVICE_UNCOVERED`; `self_covered < self_devices` → `201` + `warning=SELF_DEVICE_UNCOVERED` (приоритет у peer-warning). Кандидаты (`peer_devices`) не равны покрытию (`peer_covered`). **Все четыре счётчика — только `e2ee_capable`:** конверт на legacy-устройство отклоняется `422 E2EE_LEGACY_DEVICE` до создания сообщения, а legacy-устройства не попадают ни в кандидаты, ни в `uncovered_device_ids` (P1-B-1, M3).

### 5.3. `key_generation`

- `1` при регистрации; `+1` при revoke и при in-place ротации identity (в v1 in-place ротации нет, поэтому у активных устройств generation = 1). `identity_key_alg=LEGACY` для старых устройств — ортогонально generation.
- Конверт несёт `sender_key_generation` и `recipient_key_generation`; сервер сверяет с текущими значениями, клиент — с сохранёнными.
- Получатель отбрасывает конверт с generation меньше сохранённого (`KEY_GENERATION_STALE`).
- Смена generation ломает старые сессии: клиент удаляет сессию, сбрасывает verification, пересоздаёт через claim.
- Семантика «generation только на revoke» честно зафиксирована; в v2 (in-place rotation) она станет основной защитой от stale-конвертов.

### 5.4. Revoke устройства

`DELETE /devices/{deviceId}` (owner, step-up рекомендуется):

1. В одной транзакции: `status=REVOKED`, `revoked_at`, `key_generation++`, удаление/пометка prekeys, отзыв refresh/access family, закрытие WS, `key_verifications` с `target_device_id` → `revoked_at` (**все** verifier-device строки этого target; verified сбрасывается у каждого верифицировавшего устройства, а не «у пользователя»).
2. События: `device.list.changed` владельцу, `chat.keys.changed` (reason `DEVICE_REVOKED`) во все E2EE-чаты пользователя, `session.revoked` отозванному устройству.
3. Другие клиенты: удаляют сессию с этим устройством, исключают его из fan-out, показывают «устройство удалено» (не системным сообщением в E2EE-чате, а UI-сообщением из события).
4. Попытка отправить конверт отозванному устройству → `422 UNKNOWN_DEVICE`; весь запрос отклоняется, сообщение не создаётся (нет частичного fan-out).
5. Уже доставленные сообщения и ключи не отзываются ретроактивно; устройство, имеющее старые ключи, может читать старую историю, если физически сохранено. Это честное ограничение. Legacy-конверты, перенесённые V19 в quarantine, для своего устройства остаются `crypto:null` — это «недоступно на этом устройстве», а не удаление сообщения или `500` (§6.5.3).
6. Последнее устройство можно отозвать (с предупреждением): пользователь теряет E2EE-историю; собеседники видят удаление устройства.
7. Локальная копия отправленных **не** удаляется при revoke другого устройства; при revoke собственного устройства она уничтожается вместе с профилем (честное ограничение, backup v1 нет).

### 5.5. Новое устройство и история (честно)

- Сервер хранит конверты, адресованные **конкретным** device_id на момент отправки. Новое устройство не получает чужие конверты и не может их расшифровать.
- Даже если бы сервер отдал старый конверт, приватных ключей старого устройства у нового нет.
- Поэтому: **история E2EE до регистрации устройства недоступна**. UI показывает разделитель «История недоступна на этом устройстве» и объясняет, что backup появится в v1.
- Старое устройство (если не отозвано) сохраняет свою историю; новое видит только сообщения после регистрации.
- Будущие сообщения на новое устройство идут после того, как отправители увидят его в `GET /chats/{id}/keys` / `chat.keys.changed` и создадут сессию. До этого новые сообщения на него не попадут — это нормальный race, а не потеря уже отправленного.
- **Prekey-сообщение и офлайн (R-15, P1-1/P1-C):** первое сообщение сессии требует приватного SPK, которым оно было зашифровано. Если получатель был офлайн дольше окна хранения приватных SPK (`SPK_RETAIN_WINDOW` = 90 дней, §1.3/§3.4.5), prekey-сообщение **не** расшифровывается и не подлежит «попробуем позже». Это ограничение prekey-механизма, а не Double Ratchet; после установки сессии старый SPK не нужен.
  - Получатель при `SPK_DELETED`/`KEY_HANDSHAKE_INVALID`/`DECRYPT_FAILED` **обязан** отправить управляющий `SESSION_RESET` (`content_type=2`) в **новом** prekey-конверте на отправителя: `{failed_session_id, failed_chain_dh, failed_n, reason, retry_of_client_message_id}`. Он не показывается, не уведомляет, rate limit 1/300 с на failed session.
  - **Reset — свойство сессии, но повторяется только недоставленное (P1-C, исправлено в S4).** Reset несёт `failed_session_id`, `failed_chain_dh`, `failed_n` и `retry_of_client_message_id` (§3.5.1). Получив reset, отправитель:
    1. удаляет failed-сессию и делает новый claim/new prekey-handshake;
    2. выбирает сообщения **только с якоря и позже**: локальный индекс отправки **≥** индекса `retry_of_client_message_id` (fallback, если id не найден локально: `header.dh == failed_chain_dh AND header.n >= failed_n`, затем все последующие в send order);
    3. перешифровывает выбранные сообщения в новую сессию: каждому — новый `client_message_id`, новый `Idempotency-Key`, новые bytes. В v1 inner `TEXT_JSON` **не** несёт `retry_of_client_message_id`: схема TEXT заморожена, поле — **v1.1** (§3.5.1). `retry_of_client_message_id` остаётся только в теле `SESSION_RESET`, по которому отправитель и строит окно.
    Сообщения **до** якоря не перешифровываются: получатель их уже расшифровал, и повтор создал бы дубли с новыми `client_message_id`, которые нечем сопоставить. Старые записи помечаются `superseded` (не удаляются до успешной замены), UI показывает **одну группу retry**; пустой набор — no-op без нового handshake (L3b).
  - **Дедупликация reset (v1, E7-F5F).** Повторный `SESSION_RESET` для той же failed-сессии/цепочки/якоря не перешифровывает окно второй раз: отправитель сверяет `(failed_session_id, failed_chain_dh, failed_n, retry_of_client_message_id)` и после первого reset удаляет failed-сессию (`duplicate`/`invalid_session`). Это защищает от ретрая control-сообщения.
  - **Дедупликация на получателе retry (v1.1).** Переотправленный TEXT несёт `retry_of_client_message_id`; `B` отбрасывает replacement, если оригинал уже расшифрован, и показывает replacement вместо failed-строки, если оригинал не был расшифрован. Дедуп **не** делается по ciphertext (он каждый раз новый).
  - **Проверка окна: `failed_n` — это `header.n` первого сообщения, которое получатель не смог расшифровать.** Получатель пытается расшифровывать в порядке прихода, поэтому всё, что раньше по этому же `header.dh`, уже расшифровано; но правило «перешифровать всё после якоря» покрывает и разрывы (потерянные ранее сообщения). В v1 получатель reset-сообщений дедуплицирует сам reset (не TEXT); receiver-дедуп переотправленных TEXT — v1.1. Именно это делает L3b отличным от L3: в L3 `delivered_before_reset=0` (перешифровывается всё), в L3b расшифрованы m1–m3 (перешифровываются m4–m5, 0 дублей).
  - **Batch limit:** не более `MAX_RESET_BATCH=20` сообщений на один reset в порядке отправки. Если после якоря больше 20 — перешифровываются первые 20, остальные остаются в статусе `retry_pending` с явным UI «часть сообщений не отправлена, повторить»; следующий reset/повтор — только после подтверждения предыдущего. Молчаливого отбрасывания нет.
  - **Порядок и дубли:** сервер не гарантирует атомарность batch; каждое сообщение идёт отдельным `POST /messages` (свой `seq`), поэтому UI сортирует по `created_at`/локальному порядку. Если часть batch упала — успешные остаются `sent`, неуспешные — `retry_pending`; повтор не создаёт дубль в UI (локальная копия заменяется, а не добавляется). Серверный replay по старому `client_message_id` не используется: старый id указывает на старый ciphertext.
  - Без этого сигнала R-15 — тихая потеря **всех** последующих сообщений сессии; поэтому reset обязателен, а не «рекомендация».
  - Неаутентифицированное WS-событие `chat.session.reset` **не используется** (спуфинг). Метрики: `e2ee_prekey_undecrypted_24h` (reset-события), `e2ee_reset_batch_size` (гистограмма), `e2ee_reset_duplicates` — **v1.1** (в v1 не эмитится; рост = ошибка окна отправителя).

### 5.6. Смена ключа / переустановка / «устройства-призраки»

- Переустановка браузера = новое устройство (новый `device_id`, новые identity). Старая запись остаётся ACTIVE, пока пользователь не отзовёт; она занимает слот и получает конверты, которые некому читать.
- UX: экран «Устройства» (`GET /devices`) с `last_seen_at`, `key_generation`, `status`, кнопкой revoke; предупреждение при приближении к лимиту 5.
- Автоматического revoke по неактивности в E7 нет (это политика/риск). Рекомендация v1: напоминание после 60 дней, revoke — вручную.
- Если сервер (или ошибка/атака) отдаст для того же `device_id` другие identity-ключи, клиент обязан обнаружить это по сохранённому пиннингу и не создавать сессию (`KEY_CHANGE_DETECTED`), а не «доверять новому ключу».
- **Локальный пиннинг (P0-2)** — не опциональный кэш: `device_id → {user_id, IK_sig, IK_dh, fingerprint, identity_binding_signature, key_generation, first_seen, verified, verified_at}`. Пишется при первом prekey-контакте **после** проверки подписи/binding/no-revoke и **до** отображения; при несовпадении — блокировка отправки до явного «Принять новый ключ» + повторная сверка. Пиннинг по `user_id` запрещён: у пользователя до 5 устройств, и перенос verified между ними — дефект P0-1.
- Новое устройство (новый `device_id`) — это **не** key change: оно просто не сверено; показывать «устройство добавлено» и отдельный safety number. Только совпадение `device_id` при других ключах — атака/сброс.
- Серверный audit: `chat.keys.changed` с `reason=IDENTITY_KEY_CHANGED` и `device_id`; пользователь получает уведомление «ключ безопасности устройства изменился», даже если UI чата закрыт.

### 5.7. Одновременное инициирование и несколько сессий

Возможна ситуация: A и B одновременно отправили первые сообщения друг другу, создав две сессии с разными `session_id`.

Правило v1 (уточнено по Q-10):

- Разрешаются несколько сессий на пару устройств (keyed by `session_id`).
- **Входящий prekey-конверт для неизвестной сессии всегда принимается** (создаёт/дополняет сессию), после проверок §3.3.1/§3.3.3; он не «проигрывает» только потому, что есть другая сессия.
- **Исходящая отправка** идёт в сессию, из которой было последнее **успешно принятое** сообщение; если такой нет — в сессию, инициированную собой; при полном равенстве — с меньшим `session_id` (детерминированный tie-break). «Последняя send» сама по себе не выбирает сессию: у двух устройств она может указывать на разные сессии.
- При одновременной отправке обе стороны **сохраняют обе сессии** до первого успешного приёма; ни одна не удаляется «сразу».
- **V1 (E7-F6, variant A): детерминированный winner + отложенное удаление loser.** Для точной пары «одно локальное + одно peer-устройство» winner = меньший canonical b64u `session_id`; обе стороны видят одинаковые ids. Persisted metadata: loser `supersededBy`/`supersededAt`, winner `winnerConfirmedAt` (plaintext + sealed, cross-checked, входит в `previousStateFingerprint`; переходы монотонны). Отправка исключает `superseded`; explicit retry id проигравшей сессии отклоняется, без silent fallback. Первый успешный приём на winner атомарно фиксирует `winnerConfirmedAt` с message/OPK/local copy. Loser удаляется только после подтверждения winner + `SUPERSEDED_DELIVERY_WINDOW_MS` (5 мин) + нет pending outbox envelope + не в reset; ключи loser остаются читаемыми для in-flight конвертов. Реконсиляция идемпотентна на receive/loadChat/initialize; если winner пропал, survivor повышается. Late loser envelope после окна уходит в R-15 reset. `SESSION_IDLE_TTL` остаётся GC, не заменой winner-deletion.
- Приём пробует сессии по `session_id` (сначала последнюю принятую), пока AEAD не подтвердит; перебор ограничен 3 сессиями.
- Дубликаты сообщений (одно и то же сообщение в двух сессиях) дедуплицируются по `message_id`/`client_message_id`, не по ciphertext.
- State-machine тест: одновременный init, два prekey-конверта, первый приём, выбор winner; in-flight loser envelope; reload/reconcile; удаление loser после окна — `frontend/src/e2ee/parallelSessions.test.ts`.

---

## 6. Wire/API delta

> Это **предложение**. `contracts/openapi.yaml`, `contracts/ws-protocol.md` и код не изменялись; изменения должен внести PM/лид через I-01 и отдельные задачи E7-B/E7-F.

### 6.1. Сводка endpoint’ов

| # | Метод и путь | Статус | Назначение | Права | Идемпотентность | Лимит |
|---|---|---|---|---|---|---|
| API-D1 | `POST /devices` | **изменён (breaking)** | Регистрация с IK/IKB/SPK/OPK | Auth | identity key → затем `Idempotency-Key` | 10/час |
| API-D2 | `GET /devices` | **новый** | Список своих устройств (для revoke/UX) | Auth | — | 60/мин |
| API-D3 | `DELETE /devices/{deviceId}` | **новый** | Отзыв устройства, `key_generation++` | Auth (+ step-up) | `Idempotency-Key` | 10/час |
| API-D4 | `POST /devices/{deviceId}/prekeys` | **новый** | Ротация SPK, пополнение OPK | Auth (своё устройство) | `Idempotency-Key` | 10/час |
| API-D5 | `POST /keys/claim` | **новый** | Атомарная выдача prekey bundle; `chat_id` обязателен (D-05) | Auth, член чата (или своё устройство) | нет (см. §4.6) | 120/мин |
| API-D6 | `GET /chats/{chatId}/keys` | **новый** | Устройства, обе identity, binding, fingerprint, `verified` per verifier device | Член E2EE-чата | — | 30/мин |
| API-D7 | `PUT /chats/{chatId}/keys/verification` | **новый** | Attestation сверки; verifier device = `X-Device-Id` | Член E2EE-чата | `Idempotency-Key` | 30/мин |
| API-D8 | `POST /workspaces/{workspaceId}/chats` | **новый** | Создание DIRECT-чата (E2EE или managed) | Член воркспейса | `Idempotency-Key` + unique pair | 30/час |
| API-D9 | `POST /chats/{chatId}/messages` | **изменён** | `envelopes[]` для E2EE | Член чата | `Idempotency-Key` + `client_message_id` | как B-01 |
| API-D10 | `GET /chats/{chatId}/messages` | **изменён** | `Message.crypto` для `X-Device-Id` | Член чата | — | 300/мин |
| API-D11 | WS `message.created` | **изменён** | `crypto` для устройства соединения | — | — | — |
| API-D12 | WS `chat.keys.changed` | **новый** | Смена ключей/устройств в чате | — | — | — |
| API-D13 | WS `device.list.changed` | **новый** | Свои устройства | — | — | — |

### 6.2. Примеры JSON

#### 6.2.1. `POST /devices` (запрос)

```http
POST /api/v1/devices
Authorization: Bearer <jwt>
Idempotency-Key: 5c1e8d0a-4b2f-4a6e-9d1c-7e3f2a1b0c9d
Content-Type: application/json
```

```json
{
  "name": "Bob MacBook Chrome",
  "platform": "WEB",
  "app_version": "0.7.0",
  "identity_signing_key": "ilSdUaBSv8OSsYTqI_XaMX6vqlT2Y1ZYcz0F5Tjc3c4",
  "identity_dh_key": "gNQawPXrkUyR6Kekq9RAEHA9mCki-0D9QhwuOmZrpAQ",
  "identity_binding_signature": "avTqOu46tdK6yHeJODw0m6mFtXgPRiXWtNSZT-AMClWerfo0bWwrFbh2DS35ueV6_z61hix7LPcbjn4tmKSdBQ",
  "identity_key_alg": "Ed25519+X25519",
  "signed_prekey": {
    "key_id": "spk-1",
    "public_key": "CA4puJFgi4K5Jsi7SaGO1dK929yHxKUJ6N2uxRk7Dno",
    "signature": "wjk09AvSyAHvcEINQckiWq4o1Jozkm9kLyxxUVF1PtoVQgmSxOjPU8rIY_Sa0kwgdxaPwl6pTAGusCf90_WdDw"
  },
  "one_time_prekeys": [
    {"key_id": "opk-1", "public_key": "b5S3QEwMb1HN0gi_UuxrXlfNmy-L5hSGsbFrmVvd0CU"}
  ]
}
```

Ответ `201`:

```json
{
  "id": "00000000-0000-4000-8000-000000000021",
  "name": "Bob MacBook Chrome",
  "platform": "WEB",
  "app_version": "0.7.0",
  "status": "ACTIVE",
  "e2ee_capable": true,
  "key_generation": 1,
  "identity_signing_key": "ilSdUaBSv8OSsYTqI_XaMX6vqlT2Y1ZYcz0F5Tjc3c4",
  "identity_dh_key": "gNQawPXrkUyR6Kekq9RAEHA9mCki-0D9QhwuOmZrpAQ",
  "identity_binding_signature": "avTqOu46tdK6yHeJODw0m6mFtXgPRiXWtNSZT-AMClWerfo0bWwrFbh2DS35ueV6_z61hix7LPcbjn4tmKSdBQ",
  "identity_key_alg": "Ed25519+X25519",
  "fingerprint": "QqhpMx-bqss5KfxE9Og0PZcpbwzz0Qva5perj6G1lmg",
  "signed_prekey": {
    "key_id": "spk-1",
    "public_key": "CA4puJFgi4K5Jsi7SaGO1dK929yHxKUJ6N2uxRk7Dno",
    "signature": "wjk09AvSyAHvcEINQckiWq4o1Jozkm9kLyxxUVF1PtoVQgmSxOjPU8rIY_Sa0kwgdxaPwl6pTAGusCf90_WdDw",
    "created_at": "2026-11-16T12:00:00Z",
    "expires_at": "2026-12-16T12:00:00Z"
  },
  "one_time_prekeys_available": 1,
  "created_at": "2026-11-16T12:00:00Z",
  "last_seen_at": null
}
```

Семантика:

- **Ключи — optional в схеме, но all-or-none в семантике (D-S4-03, P2-9).** `identity_signing_key`, `identity_dh_key`, `identity_binding_signature`, `identity_key_alg`, `signed_prekey` — либо **все** присутствуют (полный E2EE-путь, §3.1), либо **ни одного** (legacy-регистрация: `identity_key_alg='LEGACY'`, `e2ee_capable=false`, `201`; `one_time_prekeys` должен быть пуст, иначе `422 INVALID_KEY_FORMAT`). Частичный набор → `422 INVALID_KEY_FORMAT`; ничего не сохраняется. Это сохраняет совместимость со старыми клиентами/фронтендом, которые ещё не умеют ключи, и **не** является in-place апгрейдом: legacy-устройство навсегда `e2ee_capable=false`.
- **Rollout (Phase 1 / Phase 2).** Phase 1 (этот PR): сервер принимает и legacy-body, и keyed-body; новый frontend **обязан** отправлять ключи и проверять `e2ee_capable=true` в ответе. Phase 2 (после G3 + телеметрии, отдельный PR): для `app_version >= e2ee.require-device-keys-min-version` отсутствие ключей → `422 INVALID_KEY_FORMAT`; версии ниже floor продолжают регистрироваться как legacy до принудительного апгрейда. Обе фазы совместимы с D-17: legacy не апгрейдится, а получает `e2ee_capable=false` и не участвует в E2EE.
- `one_time_prekeys` — 0..200 (рекомендуется 100); допустимы только вместе с ключами.
- `POST /devices` **не адресует** существующее устройство по `device_id` (его нет в body) и поэтому **не** возвращает `E2EE_LEGACY_DEVICE`; этот код достижим на `POST /devices/{deviceId}/prekeys` для существующего legacy-target (§6.2.2), на envelope с legacy-`recipient_device_id` (P1-B-1) и на будущем admin/in-place endpoint. Попытка «докинуть» ключи в legacy через новый `POST /devices` создаёт **новое** устройство (если есть слот), а не апгрейдит старое (D-17).
- **P2-5:** совпадение `IK_sig`/`IK_dh` с `status=REVOKED` → `410 DEVICE_REVOKED`, без реактивации. Иначе идемпотентный replay «воскрешал» бы отозванное устройство.
- **Порядок идемпотентности:** (0) REVOKED по IK → `410 DEVICE_REVOKED`; (1) тот же `identity_signing_key`+`identity_dh_key` среди не-REVOKED → `201` и то же устройство, даже при лимите; (2) тот же `Idempotency-Key` и тот же body → replay; (3) тот же `Idempotency-Key` и другой body → `409 IDEMPOTENCY_KEY_REUSED`; (4) `IK_dh` уже занят другой парой → `409 IDENTITY_KEY_CONFLICT`.
- Те же `name/platform/app_version`, но другой `identity_signing_key` → **новое** устройство (если <5), не «то же самое».
- Сервер проверяет подпись SPK **и** binding-подпись; невалидные → `422 INVALID_SPK_SIGNATURE`/`422 INVALID_IDENTITY_BINDING`, ничего не сохраняется.
- При 6-м активном → `409 DEVICE_LIMIT_REACHED` с `details.limit=5`.
- Изменение контракта: `Device`/`DeviceView` расширяются полями `name`, `status`, `e2ee_capable`, `key_generation`, `identity_*`, `identity_binding_signature`, `fingerprint`, `signed_prekey`, `one_time_prekeys_available`; `schema.d.ts` перегенерируется (P1-6).

#### 6.2.2. `POST /devices/{deviceId}/prekeys`

```json
{
  "signed_prekey": {
    "key_id": "spk-2026-12-16",
    "public_key": "LlODUi_yhcR9Tu-LdOiyGwXfTrQWl6bPB031r0HXLEQ",
    "signature": "iNoT-Wq7AjCxULnLhMEPlpQaxA7syyDwGGLKFiaw-V1s-QMn2KjyWUj5OjciNKFs6ueVvrNYh9BNS7T3mMxYDQ"
  },
  "one_time_prekeys": [
    {"key_id": "opk-0101", "public_key": "8tIlFlfhch8T-igI5rIyN9ilULn25f9PLOv_mVLGdHM"}
  ]
}
```

Ответ `200`:

```json
{
  "device_id": "00000000-0000-4000-8000-000000000021",
  "key_generation": 1,
  "signed_prekey_id": "spk-2026-12-16",
  "signed_prekey_expires_at": "2027-01-15T12:00:00Z",
  "one_time_prekeys_stored": 1,
  "one_time_prekeys_available": 101,
  "one_time_prekeys_limit": 200
}
```

- Требуется `X-Device-Id == deviceId` (P2-9): одно устройство не может ротировать SPK другому. Иначе `403 FORBIDDEN`.
- Legacy/`e2ee_capable=false` target → **`422 E2EE_LEGACY_DEVICE`** (`details.device_id`, `details.remedy="register_new_device"`); ключи «на лету» не добавляются — только новая регистрация. `NO_KEYS` на этом endpoint **не** используется (он зарезервирован за claim/`unavailable[]`, чтобы не было двух кодов для одного случая — P2-4).
- Новая SPK проверяется по подписи **IK_sig целевого устройства** (как при регистрации); невалидная → `422 INVALID_SPK_SIGNATURE`. Binding-подпись не меняется (identity та же); её смена = новое устройство.
- Новая SPK заменяет текущую; старая помечается `retired_at`, но не удаляется сразу (grace 7 дней для in-flight).
- OPK с существующим `key_id` и теми же bytes — no-op (идемпотентно); другие bytes → `409 PREKEY_ID_CONFLICT`.
- Превышение 200 outstanding → `422 PREKEY_LIMIT_EXCEEDED`, ничего не сохраняется.
- `one_time_prekeys_available` отдаётся только владельцу.

#### 6.2.3. `GET /devices`

```json
{
  "items": [
    {
      "id": "00000000-0000-4000-8000-000000000011",
      "name": "Alice MacBook",
      "platform": "WEB",
      "status": "ACTIVE",
      "e2ee_capable": true,
      "key_generation": 1,
      "identity_signing_key": "djQ2_H11EhPhoJ9Sjy1A15gAwRV7ALsbCWyjGT7YLmI",
      "identity_dh_key": "n_dIUK4u8DZXOKn0vQbq36OKwko6ah9l_akxZCFFcT4",
      "identity_binding_signature": "fIRfXVyFWk76XIuYEqJfamYFvBV7vqpiHvHeGcD2gsUWXHH14jS-MpM2Ceh7He-Yzbhzvs5XZo1RoOZ8mHJCCQ",
      "identity_key_alg": "Ed25519+X25519",
      "fingerprint": "Jxd0vDNUdEAFE2YD3Qc7Jf7oxsAT1DHuRxmPOfAEIHE",
      "signed_prekey_id": "spk-1",
      "one_time_prekeys_available": 87,
      "created_at": "2026-11-01T10:00:00Z",
      "last_seen_at": "2026-11-16T11:59:00Z",
      "current": true
    }
  ]
}
```

`current` — устройство, сделавшее запрос (`X-Device-Id`). `one_time_prekeys_available` — только для своих.

#### 6.2.4. `DELETE /devices/{deviceId}`

```http
DELETE /api/v1/devices/00000000-0000-4000-8000-000000000022
Authorization: Bearer <jwt>
X-Device-Id: 00000000-0000-4000-8000-000000000011
Idempotency-Key: 7e2c...
```

`204`; повтор → `204`. Чужое устройство → `404` (не раскрывать существование). Уже revoked → `204`. Последнее устройство — `204` + предупреждение в UI (сервер не блокирует).

#### 6.2.5. `POST /keys/claim`

```json
{
  "chat_id": "00000000-0000-4000-8000-000000000100",
  "devices": [
    {"device_id": "00000000-0000-4000-8000-000000000021", "user_id": "00000000-0000-4000-8000-000000000002"}
  ]
}
```

Ответ `200`:

```json
{
  "bundles": [
    {
      "user_id": "00000000-0000-4000-8000-000000000002",
      "device_id": "00000000-0000-4000-8000-000000000021",
      "key_generation": 1,
      "identity_signing_key": "ilSdUaBSv8OSsYTqI_XaMX6vqlT2Y1ZYcz0F5Tjc3c4",
      "identity_dh_key": "gNQawPXrkUyR6Kekq9RAEHA9mCki-0D9QhwuOmZrpAQ",
      "identity_binding_signature": "avTqOu46tdK6yHeJODw0m6mFtXgPRiXWtNSZT-AMClWerfo0bWwrFbh2DS35ueV6_z61hix7LPcbjn4tmKSdBQ",
      "identity_key_alg": "Ed25519+X25519",
      "signed_prekey": {
        "key_id": "spk-1",
        "public_key": "CA4puJFgi4K5Jsi7SaGO1dK929yHxKUJ6N2uxRk7Dno",
        "signature": "wjk09AvSyAHvcEINQckiWq4o1Jozkm9kLyxxUVF1PtoVQgmSxOjPU8rIY_Sa0kwgdxaPwl6pTAGusCf90_WdDw",
        "created_at": "2026-11-16T12:00:00Z",
        "expires_at": "2026-12-16T12:00:00Z"
      },
      "one_time_prekey": {
        "key_id": "opk-1",
        "public_key": "b5S3QEwMb1HN0gi_UuxrXlfNmy-L5hSGsbFrmVvd0CU"
      },
      "otp_exhausted": false
    }
  ],
  "unavailable": []
}
```

Ошибки:

- `409 NO_PREKEYS` — ни одного bundle (все `unavailable`), `details.devices`.
- `422 UNKNOWN_DEVICE` — устройство не участник чата/revoked/не существует; весь запрос отклоняется. **Один и тот же ответ** для «не участник» и «не существует» — не раскрывать чужие устройства (D-05).
- `403 FORBIDDEN` — вызывающий сам не член чата; `chat_id` обязателен.
- `422 TOO_MANY_DEVICES` — >10.
- `user_id` каждого элемента обязан совпадать с владельцем `device_id`; иначе `422 UNKNOWN_DEVICE` (запрос целиком).
- Legacy-устройство в списке → `unavailable[{reason:"NO_KEYS"}]`, не 500 и не bundle без ключей.

Правило: `signed_prekey` всегда есть у активного устройства (SPK обязателен); `one_time_prekey` может быть `null` (`otp_exhausted:true`).

#### 6.2.6. `GET /chats/{chatId}/keys`

```json
{
  "chat_id": "00000000-0000-4000-8000-000000000100",
  "security_mode": "E2EE",
  "key_epoch": null,
  "my_device_id": "00000000-0000-4000-8000-000000000011",
  "verifier_device_id": "00000000-0000-4000-8000-000000000011",
  "verified_count": 1,
  "verified_by_other_devices_count": 0,
  "devices_total": 2,
  "devices": [
    {
      "device_id": "00000000-0000-4000-8000-000000000011",
      "user_id": "00000000-0000-4000-8000-000000000001",
      "platform": "WEB",
      "status": "ACTIVE",
      "identity_signing_key": "djQ2_H11EhPhoJ9Sjy1A15gAwRV7ALsbCWyjGT7YLmI",
      "identity_dh_key": "n_dIUK4u8DZXOKn0vQbq36OKwko6ah9l_akxZCFFcT4",
      "identity_binding_signature": "fIRfXVyFWk76XIuYEqJfamYFvBV7vqpiHvHeGcD2gsUWXHH14jS-MpM2Ceh7He-Yzbhzvs5XZo1RoOZ8mHJCCQ",
      "identity_key_alg": "Ed25519+X25519",
      "fingerprint": "Jxd0vDNUdEAFE2YD3Qc7Jf7oxsAT1DHuRxmPOfAEIHE",
      "key_generation": 1,
      "signed_prekey_id": "spk-1",
      "is_self": true,
      "verified": null,
      "verified_at": null,
      "verification_method": null,
      "last_seen_at": "2026-11-16T11:59:00Z"
    },
    {
      "device_id": "00000000-0000-4000-8000-000000000021",
      "user_id": "00000000-0000-4000-8000-000000000002",
      "platform": "WEB",
      "status": "ACTIVE",
      "identity_signing_key": "ilSdUaBSv8OSsYTqI_XaMX6vqlT2Y1ZYcz0F5Tjc3c4",
      "identity_dh_key": "gNQawPXrkUyR6Kekq9RAEHA9mCki-0D9QhwuOmZrpAQ",
      "identity_binding_signature": "avTqOu46tdK6yHeJODw0m6mFtXgPRiXWtNSZT-AMClWerfo0bWwrFbh2DS35ueV6_z61hix7LPcbjn4tmKSdBQ",
      "fingerprint": "QqhpMx-bqss5KfxE9Og0PZcpbwzz0Qva5perj6G1lmg",
      "key_generation": 1,
      "signed_prekey_id": "spk-1",
      "is_self": false,
      "verified": true,
      "verified_at": "2026-11-16T12:10:00Z",
      "verification_method": "MANUAL",
      "last_seen_at": "2026-11-16T12:05:00Z"
    }
  ]
}
```

- В ответе только ACTIVE + `e2ee_capable` устройства; legacy/dev без ключей не участвуют в safety number и не показываются (D-17).
- `verifier_device_id` = устройство из `X-Device-Id`; **весь** `verified` в ответе относится к паре `(verifier_device_id, target device)` в этом чате. Для себя — `null`.
- **P0-1:** `verified=true` для target устройства означает «именно это устройство-верификатор сверяло safety number именно с этим target в этом чате». Оно **не** наследуется другим устройством того же пользователя. Новое устройство получает `null`, даже если старое сверяло.
- **P2-1:** `verified_count` = число строк `key_verifications`, где `verifier_device_id = X-Device-Id`, `target_device_id` — устройство из этого чата, `revoked_at IS NULL`. Это **не** агрегат по всем верификаторам. `verified_by_other_devices_count` — сколько target-устройств сверено **другими** устройствами пользователя; UI показывает это отдельной подписью «сверено на другом устройстве», не замочек. L2 (второе устройство) видит `verified_count=0`, `verified=null`.
- `identity_binding_signature` — обязательна для проверки `IK_sig→IK_dh` (P1-2); клиент проверяет её сам и сохраняет в TOFU-пин. **Клиент обязан также сверить `prekey.sender_identity_*` с этими полями при приёме (P0-2b).**
- `fingerprint` — convenience; клиент **обязан** пересчитать его из ключей и сравнить; доверять серверному значению нельзя.
- Non-E2EE чат → `409 MODE_NOT_SUPPORTED` (`details.required_mode="E2EE"`).
- `key_epoch` для DIRECT = `null`; для групп появится позже.
- Сервер **не хранит** digits и не проверяет их; `safety_number_hash` — attestation, не источник истины. `verified` в UI не рисовать как замок (P2-5).

#### 6.2.7. `PUT /chats/{chatId}/keys/verification`

```json
{
  "device_id": "00000000-0000-4000-8000-000000000021",
  "method": "MANUAL",
  "vh_version": 2,
  "safety_number_hash": "a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw"
}
```

(hex `6badfd8f77b750a8d7ef6451ea26a1de7b075f895dc8e6e396d12f5ed70b772c`, `VH` v2 с `verifier_device_id`)

Ответ `201`:

```json
{
  "chat_id": "00000000-0000-4000-8000-000000000100",
  "verifier_device_id": "00000000-0000-4000-8000-000000000011",
  "device_id": "00000000-0000-4000-8000-000000000021",
  "key_generation": 1,
  "verified": true,
  "verified_at": "2026-11-16T12:10:00Z",
  "method": "MANUAL"
}
```

- **Verifier device берётся из `X-Device-Id`, а не из body** — нельзя аттестовать сверку с чужого устройства. `verifier_device_id` в response — эхо.
- `vh_version` обязателен и равен `2` (P2-2); `1`/отсутствие → `422 VH_VERSION_UNSUPPORTED`, запись не создаётся. Сервер не может «догадаться», какой VH прислал старый клиент, поэтому версия — часть запроса и колонки `key_verifications.vh_version`.
- `safety_number_hash` — 32 байта, `b64u`; `VH = SHA-256(D_VER || u8(2) || chat_id || verifier_user_id || verifier_device_id || target_device_id || u32(target_gen) || ascii(digits60))`. Сервер не хранит digits и не проверяет их правильность (attestation пользователя).
- `409 KEY_CHANGED` — `key_generation` target изменилась или локальный TOFU-пин не совпал на клиенте; `410 DEVICE_REVOKED` — устройство отозвано; `422 INVALID_SAFETY_NUMBER_HASH` — форма; `422 NO_KEYS` — target legacy.
- Повторное `PUT` заменяет запись (один активный verification на `(verifier_device_id, target_device_id, chat_id)`). `verifier_user_id` хранится денормализацией для аудита.
- `Idempotency-Key` обязателен; повтор → та же запись. Запись, созданная с `VH` u8(1), не считается verified (миграция: не переносить/пометить).

#### 6.2.8. `POST /workspaces/{workspaceId}/chats` (E2EE DIRECT)

```json
{"type": "DIRECT", "peer_id": "00000000-0000-4000-8000-000000000002"}
```

Ответ `201` (или `200`, если DIRECT-пара уже существует):

```json
{
  "id": "00000000-0000-4000-8000-000000000100",
  "type": "DIRECT",
  "security_mode": "E2EE",
  "peer_id": "00000000-0000-4000-8000-000000000002",
  "key_epoch": null,
  "last_seq": 0,
  "unread_count": 0,
  "created_at": "2026-11-16T12:00:00Z"
}
```

Правила:

- `security_mode` наследуется от воркспейса; `E2EE` в `MANAGED`-воркспейсе → `409 MODE_NOT_SUPPORTED` (MVP; v1 — политика).
- **`security_mode` неизменяем (P0-3):** ни API, ни `UPDATE` не могут изменить режим существующего чата/воркспейса. Смена = новый чат/воркспейс. Сервер: trigger `trg_chats_security_mode_immutable` → `409 MODE_CHANGE_FORBIDDEN`; `WorkspaceRepositoryAdapter` не должен делать `ON CONFLICT DO UPDATE SET security_mode`.
- `E2EE` + `GROUP` → `409 E2EE_GROUP_NOT_SUPPORTED`.
- **`DIRECT` уникален по `direct_key`** = `least(user_a,user_b) || ':' || greatest(...)` в воркспейсе: partial unique `(workspace_id, direct_key) WHERE type='DIRECT' AND deleted_at IS NULL`. Повтор возвращает существующий чат; гонка ловится unique violation → select. `peer_id` вычисляется из `chat_members`, не хранится отдельно (P1-5).
- В E2EE-чате **нет** системных сообщений от сервера: членство/ключи приходят событиями WS (`chat.member.changed`, `chat.keys.changed`). Backend обязан подавлять system messages для E2EE (включая join/leave/revoke).
- Оба участника должны иметь ≥1 активное E2EE-eligible устройство (`e2ee_capable=true`); иначе `409 E2EE_NO_ACTIVE_DEVICES`. Legacy/dev без ключей не считаются (D-17).
- При `e2ee.enabled=false`: создание E2EE-воркспейса/чата → `409 E2EE_DISABLED`; бейдж E2EE не показывается; уже существующие E2EE-чаты **не** понижаются и не принимают plaintext (P1-12). Kill-switch также покрывает чтение и replay: REST `GET` → `409`, WS replay не отдаёт E2EE-сообщения/конверты, а `Idempotency-Key`/`client_message_id` replay E2EE-сообщения → `409 E2EE_DISABLED`; managed-сообщения не затронуты (P2-03).

**Bootstrap режима на новом устройстве / после очистки профиля (P1-G, нормативно).** Локального пина `chat_id → security_mode` нет; сервер не является источником истины. Клиент обязан:

1. При первом открытии чата получить `security_mode` и **записать локальный пин** `chat_id → {mode, pinned_at, source}`; пин переживает reload, удаляется только вместе с чатом/профилем.
2. Если сервер говорит `E2EE` — пин `E2EE`, работа только через конверты; plaintext невозможен (существующий `422`).
3. Если сервер говорит `MANAGED`, а **есть признаки E2EE** (серверный `workspace.security_mode=E2EE` в прошлом/сейчас, поле `ChatSummary.peer_has_e2ee_capable_devices=true` — проводной критерий, см. §6.3/§6.3.1, `GET /chats/{id}/keys` для MANAGED-чата недоступен, либо локальный маркер «чат был E2EE» пережил очистку через `localStorage`-флаг — необязательный, недоверенный) — **запрещено** молча отправлять plaintext. Клиент: security alert «режим чата не совпадает с ожидаемым», отправка заблокирована. Разрешены **ровно два** исхода:
    - **(а) `E2EE_ONLY`** — установить E2EE-сессию в этом чате (если сервер его отдаёт как E2EE после refresh) или создать **новый E2EE-чат**;
    - **(б) новый managed-чат** — пользователь явно подтверждает MANAGED **только для нового чата**; создаётся **новый** чат с `security_mode=MANAGED`, а текущий чат остаётся E2EE/недоступным.
    **In-place downgrade запрещён:** §6.2.8 не разрешает «подтвердить MANAGED» в существующем чате с E2EE-историей. Это согласовано с J3 (`allow_after_user_confirmation = "E2EE_ONLY (or a NEW managed chat; never an in-place downgrade)"`) и с immutability-триггером (§6.5): смена режима существующего чата невозможна ни через API, ни через БД. До выбора `plaintext_messages_sent = 0`.
4. Если сервер говорит `MANAGED` и признаков E2EE нет — это обычный managed-чат: пин `MANAGED` ставится после явного подтверждения пользователя при первом открытии (TOFU выбора режима); до подтверждения отправка заблокирована, но это UX-подтверждение, а не security-инцидент.
5. **Серверного кода для fresh-device нет by design:** если сервер действительно отдал `MANAGED`, он примет plaintext; защита — клиентский block + immutable trigger для честной БД. `409 MODE_CHANGE_FORBIDDEN` остаётся для попытки **смены** режима, а не для этого сценария. Не вводить «достижимый» код, который сервер не может проверить.
6. **Честная граница:** без локального пина и без server-signed mode attestation (v2) клиент не может доказать, что чат «был E2EE»; malicious-сервер может выдать MANAGED. Защита — блокировка по признакам E2EE + явное подтверждение, а не «сервер сказал». Остаточный риск зафиксирован в §7.6/§9.3.
7. **Откуда берётся признак «у собеседника есть capable-устройство» (P2-10, S4).** `GET /chats/{id}/keys` для MANAGED-чата отвечает `409 MODE_NOT_SUPPORTED`, поэтому критерий вынесен в список чатов: `ChatSummary.peer_has_e2ee_capable_devices: boolean` (§6.3) — **производное** поле (EXISTS по `chat_members` + `auth.devices.status='ACTIVE' AND identity_key_alg='Ed25519+X25519'`), без ключей и без per-device деталей. Оно доступно и для MANAGED-чата, и не раскрывает больше, чем уже известно участнику (факт наличия E2EE-устройства). Клиент обязан использовать **только** это поле + локальный пин + `workspace.security_mode`; никаких догадок по `ChatSummary.name`/`last_message_at`.

#### 6.2.9. `POST /chats/{chatId}/messages` (E2EE)

```json
{
  "client_message_id": "3f0c4a2e-8d1b-4c1a-9e2f-2b7a6d5c4e10",
  "type": "TEXT",
  "envelopes": [
    { "…": "F1-envelope-prekey для устройства Bob" }
  ]
}
```

Полный конверт — §4.1/F1. Ответ — §4.2, с `envelope_coverage`.

#### 6.2.10. Ошибки

```json
{
  "code": "E2EE_PLAINTEXT_FORBIDDEN",
  "message": "E2EE chat accepts only encrypted envelopes",
  "details": {"field": "text", "chat_id": "..."},
  "request_id": "req_01JC..."
}
```

```json
{
  "code": "KEY_GENERATION_MISMATCH",
  "message": "Device key generation changed; refresh keys and re-encrypt",
  "details": {"device_id": "...", "expected": 2, "received": 1},
  "request_id": "req_01JC..."
}
```

```json
{
  "code": "NO_PREKEYS",
  "message": "No prekey bundles available for requested devices",
  "details": {"devices": ["..."]},
  "request_id": "req_01JC..."
}
```

### 6.3. Предлагаемый diff `contracts/openapi.yaml` (фрагмент, не применён)

```diff
@@ components.schemas.DeviceRegistration
     DeviceRegistration:
       type: object
      required: [name, platform, app_version]      # D-S4-03: ключи optional в схеме (all-or-none в семантике)
       properties:
         name: { type: string, minLength: 1, maxLength: 80 }
         platform: { type: string, enum: [WEB] }
         app_version: { type: string, maxLength: 40 }
+        identity_signing_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_binding_signature: { $ref: '#/components/schemas/Base64Url64' }
+        identity_key_alg: { type: string, enum: [Ed25519+X25519, LEGACY] }
+        signed_prekey: { $ref: '#/components/schemas/SignedPrekey' }
+        one_time_prekeys:
+          type: array
+          maxItems: 200
+          items: { $ref: '#/components/schemas/OneTimePrekey' }
+        # all-or-none: все пять полей ключей присутствуют (E2EE) или ни одного (legacy,
+        # e2ee_capable=false); частичный набор -> 422 INVALID_KEY_FORMAT.

@@ components.schemas.Message
     Message:
       type: object
       required: [id, chat_id, seq, type, created_at, version]
       properties:
         ...
         version: { type: integer, minimum: 1 }
+        client_message_id: { type: [string, "null"], format: uuid }
+        crypto:
+          oneOf:
+            - $ref: '#/components/schemas/CryptoEnvelope'
+            - type: "null"

@@ components.schemas.MessageCreate
     MessageCreate:
       type: object
-      description: Managed text and/or attachments; text or attachment_ids must be present.
+      description: >
+        Managed: text/sticker/attachments. E2EE: only envelopes[]; text/sticker/attachments forbidden.
       required: [client_message_id, type]
       properties:
         client_message_id: { type: string, format: uuid }
         type: { type: string, enum: [TEXT, STICKER] }
         text: { type: [string, "null"], maxLength: 8000 }
         reply_to_id: { type: [string, "null"], format: uuid }
         sticker_id: { type: [string, "null"], format: uuid }
         attachment_ids:
           type: array
           maxItems: 10
           items: { type: string, format: uuid }
+        envelopes:
+          type: array
+          minItems: 1
+          maxItems: 10
+          items: { $ref: '#/components/schemas/CryptoEnvelope' }

+    Base64Url32:
+      type: string
+      contentEncoding: base64url
+      pattern: '^[A-Za-z0-9_-]{43}$'
+    Base64Url64:
+      type: string
+      contentEncoding: base64url
+      pattern: '^[A-Za-z0-9_-]{86}$'
+    Base64Url16:
+      type: string
+      contentEncoding: base64url
+      pattern: '^[A-Za-z0-9_-]{22}$'
+
+    SignedPrekey:
+      type: object
+      additionalProperties: false
+      required: [key_id, public_key, signature]
+      properties:
+        key_id: { type: string, minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' }
+        public_key: { $ref: '#/components/schemas/Base64Url32' }
+        signature: { $ref: '#/components/schemas/Base64Url64' }
+        created_at: { type: string, format: date-time }
+        expires_at: { type: string, format: date-time }
+
+    OneTimePrekey:
+      type: object
+      additionalProperties: false
+      required: [key_id, public_key]
+      properties:
+        key_id: { type: string, minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' }
+        public_key: { $ref: '#/components/schemas/Base64Url32' }
+
+    CryptoHeader:
+      type: object
+      additionalProperties: false
+      required: [v, dh, pn, n]
+      properties:
+        v: { type: integer, enum: [1] }
+        dh: { $ref: '#/components/schemas/Base64Url32' }
+        pn: { type: integer, minimum: 0, maximum: 2147483647 }
+        n: { type: integer, minimum: 0, maximum: 2147483647 }
+
+    PrekeyBlock:
+      type: object
+      additionalProperties: false
+      required: [sender_identity_signing_key, sender_identity_dh_key, sender_ephemeral_key,
+                 recipient_identity_dh_key, spk_id, spk_public, signature]
+      properties:
+        sender_identity_signing_key: { $ref: '#/components/schemas/Base64Url32' }
+        sender_identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        sender_ephemeral_key: { $ref: '#/components/schemas/Base64Url32' }
+        recipient_identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        spk_id: { type: string, minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' }
+        spk_public: { $ref: '#/components/schemas/Base64Url32' }
+        opk_id: { type: [string, "null"], maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' }
+        opk_public:
+          oneOf:
+            - $ref: '#/components/schemas/Base64Url32'
+            - type: "null"
+        signature: { $ref: '#/components/schemas/Base64Url64' }
+
+    CryptoEnvelope:
+      type: object
+      additionalProperties: false
+      required: [v, scheme, chat_id, sender_device_id, sender_key_generation,
+                 recipient_device_id, recipient_key_generation, session_id, header, ciphertext]
+      properties:
+        v: { type: integer, enum: [1] }
+        scheme: { type: string, enum: [PAIRWISE_X3DH_DR] }
+        chat_id: { type: string, format: uuid }
+        sender_device_id: { type: string, format: uuid }
+        sender_key_generation: { type: integer, minimum: 1, maximum: 2147483647 }
+        recipient_device_id: { type: string, format: uuid }
+        recipient_key_generation: { type: integer, minimum: 1, maximum: 2147483647 }
+        session_id: { $ref: '#/components/schemas/Base64Url16' }
+        header: { $ref: '#/components/schemas/CryptoHeader' }
+        # accepted: decoded 272..33040 B; encoded 363..44054 chars. The 65536-char form guard is
+        # applied before base64-decode and is NOT an acceptance limit (P2-11).
+        # The total request wire body is limited separately to 524288 B.
+        ciphertext: { type: string, contentEncoding: base64url, minLength: 363, maxLength: 44054 }
+        prekey:
+          oneOf:
+            - $ref: '#/components/schemas/PrekeyBlock'
+            - type: "null"
+
+    Device:
+      type: object
+      required: [id, platform, created_at]
+      properties:
+        id: { type: string, format: uuid }
+        platform: { type: string, enum: [WEB] }
+        created_at: { type: string, format: date-time }
+        name: { type: string }
+        status: { type: string, enum: [PENDING, ACTIVE, REVOKED] }
+        e2ee_capable: { type: boolean }
+        key_generation: { type: integer, minimum: 1 }
+        identity_signing_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_binding_signature: { $ref: '#/components/schemas/Base64Url64' }
+        identity_key_alg: { type: string, enum: [Ed25519+X25519, LEGACY] }
+        fingerprint: { $ref: '#/components/schemas/Base64Url32' }
+        signed_prekey: { $ref: '#/components/schemas/SignedPrekey' }
+        one_time_prekeys_available: { type: integer, minimum: 0 }
+        last_seen_at: { type: [string, "null"], format: date-time }
+
+    DeviceList:
+      type: object
+      required: [items]
+      properties:
+        items:
+          type: array
+          items: { $ref: '#/components/schemas/Device' }

+    PrekeyUploadResult:
+      type: object
+      required: [device_id, key_generation, one_time_prekeys_available]
+      properties:
+        device_id: { type: string, format: uuid }
+        key_generation: { type: integer, minimum: 1 }
+        signed_prekey_id: { type: [string, "null"] }
+        signed_prekey_expires_at: { type: [string, "null"], format: date-time }
+        one_time_prekeys_stored: { type: integer, minimum: 0 }
+        one_time_prekeys_available: { type: integer, minimum: 0 }
+        one_time_prekeys_limit: { type: integer, enum: [200] }

+    KeyClaimRequest:
+      type: object
+      required: [chat_id, devices]
+      properties:
+        chat_id: { type: string, format: uuid }
+        devices:
+          type: array
+          minItems: 1
+          maxItems: 10
+          items:
+            type: object
+            additionalProperties: false
+            required: [device_id, user_id]
+            properties:
+              device_id: { type: string, format: uuid }
+              user_id: { type: string, format: uuid }

+    PrekeyBundle:
+      type: object
+      required: [user_id, device_id, key_generation, identity_signing_key,
+                 identity_dh_key, identity_binding_signature, identity_key_alg,
+                 signed_prekey, otp_exhausted]
+      properties:
+        user_id: { type: string, format: uuid }
+        device_id: { type: string, format: uuid }
+        key_generation: { type: integer, minimum: 1 }
+        identity_signing_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_binding_signature: { $ref: '#/components/schemas/Base64Url64' }
+        identity_key_alg: { type: string, enum: [Ed25519+X25519] }
+        signed_prekey: { $ref: '#/components/schemas/SignedPrekey' }
+        one_time_prekey:
+          oneOf:
+            - $ref: '#/components/schemas/OneTimePrekey'
+            - type: "null"
+        otp_exhausted: { type: boolean }

+    UnavailableDevice:
+      type: object
+      required: [device_id, reason]
+      properties:
+        device_id: { type: string, format: uuid }
+        reason: { type: string, enum: [NO_SPK, NO_KEYS] }   # NOT_MEMBER удалён (P2-3): не-участник -> 422 UNKNOWN_DEVICE

+    KeyClaimResponse:
+      type: object
+      required: [bundles, unavailable]
+      properties:
+        bundles:
+          type: array
+          items: { $ref: '#/components/schemas/PrekeyBundle' }
+        unavailable:
+          type: array
+          items: { $ref: '#/components/schemas/UnavailableDevice' }

+    DeviceKeyInfo:
+      type: object
+      required: [device_id, user_id, status, key_generation, identity_signing_key,
+                 identity_dh_key, identity_binding_signature, identity_key_alg,
+                 fingerprint, is_self]
+      properties:
+        device_id: { type: string, format: uuid }
+        user_id: { type: string, format: uuid }
+        platform: { type: string, enum: [WEB] }
+        status: { type: string, enum: [PENDING, ACTIVE, REVOKED] }
+        identity_signing_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_dh_key: { $ref: '#/components/schemas/Base64Url32' }
+        identity_binding_signature: { $ref: '#/components/schemas/Base64Url64' }
+        identity_key_alg: { type: string, enum: [Ed25519+X25519] }
+        fingerprint: { $ref: '#/components/schemas/Base64Url32' }
+        key_generation: { type: integer, minimum: 1 }
+        signed_prekey_id: { type: [string, "null"] }
+        is_self: { type: boolean }
+        # verified is scoped to (verifier_device_id from X-Device-Id, this device, chat):
+        verified: { type: [boolean, "null"] }
+        verified_at: { type: [string, "null"], format: date-time }
+        verification_method: { type: [string, "null"], enum: [QR, MANUAL, null] }
+        last_seen_at: { type: [string, "null"], format: date-time }

+    ChatKeysResponse:
+      type: object
+      required: [chat_id, security_mode, my_device_id, verifier_device_id, devices]
+      properties:
+        chat_id: { type: string, format: uuid }
+        security_mode: { type: string, enum: [E2EE], readOnly: true }
+        key_epoch: { type: [integer, "null"], minimum: 0 }
+        my_device_id: { type: string, format: uuid }
+        verifier_device_id: { type: string, format: uuid }
+        verified_count: { type: integer, minimum: 0 }   # только строки verifier_device_id = X-Device-Id (P2-1)
+        verified_by_other_devices_count: { type: integer, minimum: 0 }  # информационно, не замочек
+        devices_total: { type: integer, minimum: 0 }
+        devices:
+          type: array
+          items: { $ref: '#/components/schemas/DeviceKeyInfo' }

+    VerificationRequest:
+      type: object
+      additionalProperties: false
+      required: [device_id, method, vh_version, safety_number_hash]
+      properties:
+        device_id: { type: string, format: uuid }   # target; verifier device = X-Device-Id
+        method: { type: string, enum: [QR, MANUAL] }
+        vh_version: { type: integer, enum: [2] }    # P2-2; 1 -> 422 VH_VERSION_UNSUPPORTED
+        safety_number_hash: { $ref: '#/components/schemas/Base64Url32' }

+    VerificationResponse:
+      type: object
+      required: [chat_id, verifier_device_id, device_id, key_generation, verified, verified_at, method]
+      properties:
+        chat_id: { type: string, format: uuid }
+        verifier_device_id: { type: string, format: uuid }
+        device_id: { type: string, format: uuid }
+        key_generation: { type: integer, minimum: 1 }
+        verified: { type: boolean }
+        verified_at: { type: string, format: date-time }
+        method: { type: string, enum: [QR, MANUAL] }

+    EnvelopeCoverage:
+      type: object
+      required: [devices, covered, peer_devices, peer_covered, self_devices, self_covered, uncovered_device_ids]
+      properties:
+        devices: { type: integer, minimum: 0 }          # deprecated aggregate = peer+self
+        covered: { type: integer, minimum: 0 }
+        peer_devices: { type: integer, minimum: 0 }      # new sends reject 0 with 409; replay may honestly report 0 (P2-01)
+        peer_covered: { type: integer, minimum: 0 }
+        self_devices: { type: integer, minimum: 0 }      # other devices of the sender
+        self_covered: { type: integer, minimum: 0 }
+        warning: { type: [string, "null"], enum: [SELF_DEVICE_UNCOVERED, PEER_DEVICE_UNCOVERED, null] }
+        uncovered_device_ids:
+          type: array
+          items: { type: string, format: uuid }

+    MessageCreateResult:
+      allOf:
+        - $ref: '#/components/schemas/Message'
+        - type: object
+          # Схема не может выразить «required только в E2EE» (в ответе нет режима/дискриминатора),
+          # поэтому поле optional в схеме, но НОРМАТИВНО обязательно для E2EE-ответа:
+          # backend всегда его отдаёт, клиент обязан отвергнуть E2EE-ответ без него (INVALID_RESPONSE).
+          properties:
+            envelope_coverage: { $ref: '#/components/schemas/EnvelopeCoverage' }

+    ChatCreateRequest:
+      type: object
+      additionalProperties: false
+      required: [type]
+      properties:
+        type: { type: string, enum: [DIRECT, GROUP] }
+        peer_id: { type: [string, "null"], format: uuid }
+        name: { type: [string, "null"], maxLength: 120 }

+    Chat:
+      type: object
+      required: [id, type, security_mode, last_seq, unread_count, created_at]
+      properties:
+        id: { type: string, format: uuid }
+        type: { type: string, enum: [DIRECT, GROUP] }
+        security_mode: { type: string, enum: [MANAGED, E2EE], readOnly: true }   # immutable
+        peer_id: { type: [string, "null"], format: uuid }   # derived from chat_members
+        peer_has_e2ee_capable_devices: { type: boolean }    # derived; false/null для GROUP
+        name: { type: [string, "null"] }
+        key_epoch: { type: [integer, "null"], minimum: 0 }
+        last_seq: { type: integer, format: int64, minimum: 0 }
+        unread_count: { type: integer, minimum: 0 }
+        created_at: { type: string, format: date-time }
+
+     # P1-H: GET /chats (ChatList) должен позволять однозначно сопоставить DIRECT-чат.
+     # peer_id nullable: null для GROUP, UUID собеседника для DIRECT; derived из chat_members, не хранится.
+     ChatSummary:
+       type: object
+       required: [id, name, type, security_mode, unread_count, last_seq]
+       properties:
+         id: { type: string, format: uuid }
+         name: { type: [string, "null"] }                   # S4/P2-7: DIRECT без имени -> null
+         type: { type: string, enum: [DIRECT, GROUP] }
+         security_mode: { type: string, enum: [MANAGED, E2EE] }
+         peer_id: { type: [string, "null"], format: uuid }   # NEW (P1-H), DIRECT only
+         peer_has_e2ee_capable_devices: { type: boolean }    # NEW (S4/P2-10): derived, критерий J3
+         last_message_at: { type: [string, "null"], format: date-time }
+         unread_count: { type: integer, minimum: 0 }
+         last_seq: { type: integer, format: int64, minimum: 0 }

@@ paths
  /devices:
+    post:   # изменён: identity keys + signed_prekey обязательны; 201 Device
+    get:    # + operationId listDevices, 200 DeviceList
+  /devices/{deviceId}:
+    delete: # + operationId revokeDevice, 204
+  /devices/{deviceId}/prekeys:
+    post:   # + operationId uploadPrekeys, 200 PrekeyUploadResult
+  /keys/claim:
+    post:   # + operationId claimPrekeys, 200 KeyClaimResponse
+  /chats/{chatId}/keys:
+    get:    # + operationId getChatKeys, 200 ChatKeysResponse
+  /chats/{chatId}/keys/verification:
+    put:    # + operationId verifyDeviceKeys, 201 VerificationResponse
+  /workspaces/{workspaceId}/chats:
+    post:   # + operationId createChat, 201 Chat
+  /chats/{chatId}/messages:
+    post:   # изменён: E2EE envelopes[], 201 MessageCreateResult
+    get:    # изменён: Message.crypto только для X-Device-Id
```

Дополнительно в `Message` для E2EE: `text` всегда `null`, `attachments` пуст, `sticker`/`sticker_id` отсутствуют. Сервер обязан отклонять попытки записать plaintext в E2EE (constraint + code, см. §6.5).

**Новые/уточнённые OpenAPI-коды S2:** `409 MODE_CHANGE_FORBIDDEN`, `409 CLIENT_MESSAGE_ID_CONFLICT`, `409 IDENTITY_KEY_CONFLICT`, `409 E2EE_DISABLED`, `409 E2EE_NO_ACTIVE_DEVICES`, `422 INVALID_IDENTITY_BINDING`, `422 NO_KEYS`, `422 E2EE_LEGACY_DEVICE`, `413 PAYLOAD_TOO_LARGE`/`ENVELOPE_TOO_LARGE`. Для `ciphertext` `minLength/maxLength`: **363/44054** (приёмочный канонический диапазон, P2-11; 65536 остаётся form guard до decode и в схему не входит), а не 24/87384 (P1-3). `EnvelopeCoverage.devices.minimum: 0`, добавлены peer/self-счётчики (P1-7). В S3 добавлены `409 E2EE_NO_PEER_ENVELOPE` (P1-B), `422 VH_VERSION_UNSUPPORTED` (P2-2), `410 DEVICE_REVOKED` для `POST /devices` (P2-5); `UnavailableDevice.reason` больше **не** содержит `NOT_MEMBER` (P2-3).

#### 6.3.1. I-01: точный handoff для PM (контракт в S4 **не изменён**)

> `contracts/openapi.yaml`, `contracts/ws-protocol.md`, `frontend/src/api/schema.d.ts` в S4 **не редактировались** (зона S4 — только spec/vectors/notes). Ниже — handoff, который PM применяет **без изобретений**: что добавить, что расширить, какие поля/обязательность/статусы, в каком порядке и какими тестами это принимается. Текущий контракт — **OpenAPI 3.1.0**, поэтому `type: [string, "null"]`, `contentEncoding` и `additionalProperties` валидны. Сокращение `GET /chats` в спеке означает реальный путь **`GET /workspaces/{workspaceId}/chats`** (в контракте он уже есть, `operationId: listChats`, схема `ChatList`).

**Решения PM, которые фиксирует handoff (D-S4-01…06).** Это ответы на 4 вопроса review-03 §I-01 и на P2-7/8/9/10; менять их в PR-е I-01 нельзя — только новым решением.

| ID | Решение | Причина |
|---|---|---|
| **D-S4-01** | `Chat` и `ChatCreateRequest` — **новые схемы** (`add`), а не «расширить»: в контракте их нет. `POST /workspaces/{workspaceId}/chats` — **новый path** (сейчас есть только `GET`). | review-03 P1-I01-1/P2-7: иначе PM «расширяет» несуществующее |
| **D-S4-02** | `ChatSummary.name` → `type: [string, "null"]`; имя DIRECT не синтезируется на сервере (display name — клиентский fallback). `required` **не** меняется (ключ остаётся, значение может быть `null`). | review-03 P2-7: `Chat.name` nullable, `GET /chats` для DIRECT с `name=null` иначе нарушает контракт |
| **D-S4-03** | `DeviceRegistration`: `required` остаётся `[name, platform, app_version]`; поля ключей **optional в схеме**, но **all-or-none в семантике**. Нет ключей → `201` legacy-устройство (`identity_key_alg=LEGACY`, `e2ee_capable=false`). Частичный набор → `422 INVALID_KEY_FORMAT`. Phase 2 (после G3) — version-floor `e2ee.require-device-keys-min-version`. | review-03 P2-9: старый frontend/клиент не должен получать `422` и не должен ломать регистрацию; in-place апгрейд по-прежнему запрещён (D-17) |
| **D-S4-04** | `MessageCreateResult.envelope_coverage` **optional в схеме** (managed-ответ его не содержит), **нормативно обязателен для E2EE**: backend всегда отдаёт, клиент отвергает E2EE-ответ без него (`INVALID_RESPONSE`). `POST …/messages` 201 → `MessageCreateResult` (superset `Message`). | review-03: OpenAPI не выражает «required только в E2EE»; ломать managed-ответы нельзя |
| **D-S4-05** | `PrekeyBlock.spk_id`/`opk_id` получают `pattern: '^[A-Za-z0-9._-]+$'` (как `SignedPrekey.key_id`); `ciphertext.maxLength: 44054` (канонический приём, P2-11). | review-03 P2-8/P2-11: сервер не должен принимать id/строки, которые потом отвергнут DDL/получатель |
| **D-S4-06** | `ChatSummary`/`Chat` получают `peer_has_e2ee_capable_devices: boolean` (derived, без ключей). Это **единственный** проводной критерий «признаки E2EE» для J3 при MANAGED-чате. | review-03 P2-10: `GET /chats/{id}/keys` для MANAGED → `409`, критерий J3 был нереализуем |

**A. `contracts/openapi.yaml` → `components.schemas`.**

| Схема | Действие | Точные поля/правила |
|---|---|---|
| `Base64Url16`/`32`/`64` | **add** | `type: string`, `contentEncoding: base64url`, `pattern` `^[A-Za-z0-9_-]{22}$` / `{43}$` / `{86}$`; без padding. |
| `DeviceRegistration` | **extend** (D-S4-03) | `required` **не менять**: `[name, platform, app_version]`. Добавить `identity_signing_key` (`Base64Url32`), `identity_dh_key` (`Base64Url32`), `identity_binding_signature` (`Base64Url64`), `identity_key_alg` enum `[Ed25519+X25519, LEGACY]`, `signed_prekey` (`SignedPrekey`), `one_time_prekeys: array maxItems 200 of OneTimePrekey`. В `description` — «all-or-none: либо все ключи, либо ни одного; частичный набор → 422 INVALID_KEY_FORMAT; без ключей → legacy, e2ee_capable=false». |
| `SignedPrekey`, `OneTimePrekey`, `CryptoHeader`, `PrekeyBlock`, `CryptoEnvelope` | **add** | Как в §6.3. `additionalProperties: false` у `SignedPrekey`/`OneTimePrekey`/`CryptoHeader`/`PrekeyBlock`; `spk_id`/`opk_id` — `pattern: '^[A-Za-z0-9._-]+$'` (D-S4-05); `ciphertext` `minLength: 363`, `maxLength: 44054`; `prekey` nullable (`oneOf`). |
| `Device` | **extend** | `+ name` (`[string,"null"]`), `status` enum `[PENDING, ACTIVE, REVOKED]`, `e2ee_capable` (bool), `key_generation` (`>=1`), `identity_signing_key`, `identity_dh_key`, `identity_binding_signature`, `identity_key_alg` enum `[Ed25519+X25519, LEGACY]`, `fingerprint`, `signed_prekey`, `one_time_prekeys_available` (`>=0`), `last_seen_at`. |
| `DeviceList` | **add** | `{items: Device[]}`. |
| `SignedPrekeyUpload`, `PrekeyUploadResult` | **add** | Request `{signed_prekey?, one_time_prekeys?[]}`; response `{device_id, key_generation, signed_prekey_id, signed_prekey_expires_at, one_time_prekeys_stored, one_time_prekeys_available, one_time_prekeys_limit}`. |
| `KeyClaimRequest`, `PrekeyBundle`, `UnavailableDevice`, `KeyClaimResponse` | **add** | `chat_id` required; `devices` 1..10; bundle — identity + binding + `signed_prekey` + nullable `one_time_prekey` + `otp_exhausted`; `UnavailableDevice.reason` enum **`[NO_SPK, NO_KEYS]`** (без `NOT_MEMBER`). |
| `DeviceKeyInfo` | **add** | identity/binding/fingerprint/`key_generation`/`signed_prekey_id`/`is_self`/nullable `verified`, `verified_at`, `verification_method`, `last_seen_at`; `verified` scoped to `(X-Device-Id, target, chat)`. |
| `ChatKeysResponse` | **add** | `chat_id`, `security_mode` (`E2EE`, `readOnly`), `key_epoch`, `my_device_id`, `verifier_device_id`, `verified_count` (только текущий verifier), `verified_by_other_devices_count`, `devices_total`, `devices[]`. |
| `VerificationRequest`, `VerificationResponse` | **extend / add** | Request: `required += vh_version`, `vh_version: enum [2]`, `safety_number_hash: Base64Url32`; Response: `chat_id, verifier_device_id, device_id, key_generation, verified, verified_at, method`. |
| `EnvelopeCoverage` | **extend** | `required: [devices, covered, peer_devices, peer_covered, self_devices, self_covered, uncovered_device_ids]`; `devices`/`covered` — deprecated-агрегат; `warning` enum `[SELF_DEVICE_UNCOVERED, PEER_DEVICE_UNCOVERED, null]`; семантика — §4.2 (только `e2ee_capable`, P1-B-1). |
| `Message` | **extend** | `+ client_message_id: [string,"null"] uuid`; `+ crypto: CryptoEnvelope \| null`. |
| `MessageCreate` | **extend** | `+ envelopes: CryptoEnvelope[1..10]`; `description`: managed — text/sticker/attachments, E2EE — только envelopes; `text`/`reply_to_id`/`sticker_id`/`attachment_ids` в E2EE запрещены (`422 E2EE_PLAINTEXT_FORBIDDEN`). |
| `MessageCreateResult` | **add** (D-S4-04) | `allOf: Message + {envelope_coverage: EnvelopeCoverage}`; поле **не** required в схеме, но required нормативно для E2EE (см. D-S4-04). |
| `Chat` | **add** (D-S4-01) | `required: [id, type, security_mode, last_seq, unread_count, created_at]`; поля `id, type, security_mode (readOnly), peer_id ([string,null]), peer_has_e2ee_capable_devices (bool), name ([string,null]), key_epoch ([integer,null]), last_seq, unread_count, created_at`. |
| `ChatCreateRequest` | **add** (D-S4-01) | `required: [type]`; `type` enum `[DIRECT, GROUP]`, `peer_id: [string,null] uuid`, `name: [string,null] maxLength 120`. |
| `ChatSummary` | **extend** (D-S4-02/D-S4-06) | `+ peer_id: [string,null] uuid` (P1-H), `+ peer_has_e2ee_capable_devices: boolean`, `name: [string,"null"]`. `required` не менять. |
| `Error.code` | **extend description** | Отдельной `ErrorCode`-схемы в контракте **нет** (`Error.code` — свободная строка). Не вводить enum в I-01 (сломает codegen существующих кодов): перечислить E2EE-коды §4.8 в `description` и покрыть contract-тестами. Enum — отдельным PR при желании. |

**B. `contracts/openapi.yaml` → `paths`.** `POST /devices` и `POST /chats/{chatId}/messages`/`GET /chats/{chatId}/messages`/`GET /workspaces/{workspaceId}/chats` **уже есть** — их надо изменить; остальные пути — **новые**.

| Метод и путь | Действие | Успех | Ошибки (коды §4.8) |
|---|---|---|---|
| `POST /devices` | **изменить** | `201 Device` (ключи/legacy, D-S4-03) | `410 DEVICE_REVOKED`, `409 IDENTITY_KEY_CONFLICT`/`DEVICE_LIMIT_REACHED`/`IDEMPOTENCY_KEY_REUSED`, `422 INVALID_KEY_FORMAT`/`INVALID_SPK_SIGNATURE`/`INVALID_IDENTITY_BINDING` |
| `GET /devices` | **add** (`operationId: listDevices`) | `200 DeviceList` | `401` |
| `DELETE /devices/{deviceId}` | **add** (`revokeDevice`) | `204` | `404`, `409`, `410` |
| `POST /devices/{deviceId}/prekeys` | **add** (`uploadPrekeys`) | `200 PrekeyUploadResult` | `422 E2EE_LEGACY_DEVICE`/`INVALID_PREKEY`/`PREKEY_LIMIT_EXCEEDED`, `409 PREKEY_ID_CONFLICT`, `410` |
| `POST /keys/claim` | **add** (`claimPrekeys`), **без** `Idempotency-Key` | `200 KeyClaimResponse` | `409 NO_PREKEYS`, `422 UNKNOWN_DEVICE`/`TOO_MANY_DEVICES` |
| `GET /chats/{chatId}/keys` | **add** (`getChatKeys`) | `200 ChatKeysResponse` | `409 MODE_NOT_SUPPORTED`, `422 UNKNOWN_DEVICE` |
| `PUT /chats/{chatId}/keys/verification` | **add** (`verifyDeviceKeys`) | `201 VerificationResponse` | `422 VH_VERSION_UNSUPPORTED`/`INVALID_SAFETY_NUMBER_HASH`/`UNKNOWN_DEVICE`, `409 KEY_CHANGED` |
| `POST /workspaces/{workspaceId}/chats` | **add** (`createChat`, D-S4-01) | `201 Chat`; `200` — существующая DIRECT-пара (idempotent by `direct_key`) | `409 MODE_NOT_SUPPORTED`/`E2EE_GROUP_NOT_SUPPORTED`/`E2EE_NO_ACTIVE_DEVICES`/`E2EE_DISABLED`/`MODE_CHANGE_FORBIDDEN` |
| `GET /workspaces/{workspaceId}/chats` | **изменить** ответ | `200 ChatList` c `ChatSummary.{peer_id, name nullable, peer_has_e2ee_capable_devices}` | — |
| `POST /chats/{chatId}/messages` | **изменить** | `201 MessageCreateResult` | `409 E2EE_NO_PEER_ENVELOPE`/`E2EE_NO_ACTIVE_DEVICES`/`MODE_NOT_SUPPORTED`/`CLIENT_MESSAGE_ID_CONFLICT`, `422 E2EE_PLAINTEXT_FORBIDDEN`/`E2EE_LEGACY_DEVICE`/`ENVELOPES_REQUIRED`/`INVALID_ENVELOPE_FORMAT`/`DUPLICATE_ENVELOPE`/`TOO_MANY_ENVELOPES`/`E2EE_LEGACY_DEVICE`, `413 ENVELOPE_TOO_LARGE`/`PAYLOAD_TOO_LARGE` |
| `GET /chats/{chatId}/messages` | **изменить** | `200 MessagePage` c nullable `crypto` | — |

Заголовки: `Authorization: Bearer` — все E2EE-операции; `X-Device-Id` (параметр `DeviceId` уже есть) — обязателен для device-scoped (`/devices/*`, `/keys/claim`, `/chats/{id}/keys*`, `/messages`); `Idempotency-Key` (параметр `IdempotencyKey` уже есть) — для всех мутирующих, **кроме** `POST /keys/claim`.

**C. `contracts/ws-protocol.md`.** Добавить `chat.keys.changed` (`{chat_id, reason, device_id, key_generation}`, `reason` enum `DEVICE_ADDED|DEVICE_REVOKED|IDENTITY_KEY_CHANGED|VERIFICATION_CHANGED|KEY_GENERATION_CHANGED`, **без `seq`**, не replay-ится) и `device.list.changed` (`{device_id, status, key_generation}`). В `message.created` payload — `Message` с `crypto` для устройства соединения. **Не добавлять** `chat.session.reset` (reset — только зашифрованный `content_type=2`, §4.4/§5.5). `chat.member.changed` в E2EE не порождает системных сообщений.

**D. `frontend/src/api/schema.d.ts` — точный порядок (не переставлять).**

1. Изменить `contracts/openapi.yaml` (A+B) и `contracts/ws-protocol.md` (C) в одной ветке.
2. `cd frontend && npm run api:types` — перегенерировать `schema.d.ts` **из уже изменённого** `openapi.yaml`; вручную файл не править.
3. `npm run contract:check` — должен пройти; красный contract-check = неверный handoff, а не «шум».
4. Закоммитить `openapi.yaml` + `ws-protocol.md` + regenerated `schema.d.ts` **одним PR** (D-«one PR»): иначе frontend типизирован по старому контракту, а backend — по новому.
5. Только после (4) — backend DTO/мапперы (`DeviceRegistrationService`, `Message`, `ChatSummary`, `Chat`) и contract-тесты Spring `@WebMvcTest`/MockMvc на новые схемы; backend не должен стартовать с расхождением DTO ↔ OpenAPI.
6. Frontend-фичи (E7-F3/F4/F5) — только после (4); `schema.d.ts` в `main` всегда соответствует `openapi.yaml`.

**E. Обратная совместимость и contract-тесты (обязательны в PR I-01).**

| Тест | Ожидание |
|---|---|
| `POST /devices` **без** ключей (старый клиент) | `201`, `e2ee_capable=false`, `identity_key_alg=LEGACY`, prekeys не сохранены, устройство видно в `GET /devices` (D-S4-03) |
| `POST /devices` с **частичным** набором ключей | `422 INVALID_KEY_FORMAT`, устройство не создано |
| `POST /devices` с полным набором | `201`, `e2ee_capable=true`, `key_generation=1`, SPK сохранён |
| `GET /workspaces/{id}/chats` для DIRECT с `chat.name=null` | `200`, `name: null` (не `""`, не 500), `peer_id` = UUID собеседника (D-S4-02) |
| `GET /workspaces/{id}/chats` для GROUP | `peer_id: null`, `peer_has_e2ee_capable_devices: false` |
| `POST /chats/{id}/messages` в E2EE | `201 MessageCreateResult` **с** `envelope_coverage` (D-S4-04); без него клиент → `INVALID_RESPONSE` |
| `POST /chats/{id}/messages` в managed | `201 Message` **без** `envelope_coverage`; схема не падает (optional) |
| `PUT /chats/{id}/keys/verification` c `vh_version: 1` | `422 VH_VERSION_UNSUPPORTED` |
| `POST /keys/claim` не-участником | `422 UNKNOWN_DEVICE` (не `409 NOT_MEMBER`) |
| `POST /chats/{id}/messages` E2EE с `reply_to_id` | `422 E2EE_PLAINTEXT_FORBIDDEN`, `details.field="reply_to_id"` |
| `POST /chats/{id}/messages` E2EE с envelope на legacy-устройство | `422 E2EE_LEGACY_DEVICE` (P1-B-1), сообщение/`seq` не созданы |
| `POST /chats/{id}/messages` E2EE без peer-конверта | `409 E2EE_NO_PEER_ENVELOPE` |
| `POST /workspaces/{id}/chats` DIRECT повторно | `200 Chat` (не `409`), тот же `id` |

**F. Критерий «I-01 применён».** (1) В `contracts/**` есть все A-схемы и B-пути; (2) `ws-protocol.md` содержит C-события; (3) `schema.d.ts` перегенерирован и закоммичен вместе с контрактом; (4) `npm run contract:check` зелёный; (5) все тесты E зелёные; (6) backend компилируется и стартует с новыми DTO. **Без F I-01 остаётся open**, и E7-B3/B4/B5/F3 не начинаются.

### 6.4. Изменения `contracts/ws-protocol.md` (предложение)

1. В §3 таблицу событий добавить:

| `event` | `payload` |
|---|---|
| `chat.keys.changed` | `chat_id`, `reason`, `device_id?`, `key_generation?` |
| `device.list.changed` | `device_id`, `status`, `key_generation` |

2. `message.created` для E2EE: payload — `Message` с `crypto`/`null`; `text` = null.
3. Уточнить: `event_id` дедупликация остаётся; `crypto` не логируется; `chat.keys.changed` не replay-ится, клиент перечитывает `GET /chats/{id}/keys`.
4. §8 «Ограничения E3»: убрать «E2EE envelopes/payload — отдельный срез» после E7; но `crypto` — только для устройства соединения.
5. **Не добавлять** `chat.session.reset` как WS-событие: R-15 передаётся зашифрованным `content_type=2` (P1-1). `chat.keys.changed` — только метаданные ключей/устройств; `reason=IDENTITY_KEY_CHANGED` при TOFU-mismatch/смене ключа.
6. `Message.client_message_id` присутствует в WS payload; секретов не добавляет.

### 6.5. Изменения хранилища (предложение E7-B, без кода)

```sql
-- ============================================================================
-- E7-S4 / V16+ (forward-only). Написано против фактических V1–V15:
--   message.messages УЖЕ имеет crypto_scheme/body_ciphertext/content_meta/sticker_id
--   и НЕ имеет колонки text; auth.device_prekeys/key_verifications ЕЩЁ НЕ СУЩЕСТВУЮТ.
-- Один источник истины о режиме: chat.chats.security_mode + messages.crypto_scheme.
-- ============================================================================

-- 1. auth.devices: две identity-пары + binding + fingerprint; identity_public_key удаляется.
ALTER TABLE auth.devices
  ADD COLUMN identity_signing_key bytea,
  ADD COLUMN identity_dh_key bytea,
  ADD COLUMN identity_binding_signature bytea,
  ADD COLUMN fingerprint bytea;

ALTER TABLE auth.devices ALTER COLUMN identity_key_alg DROP DEFAULT;
UPDATE auth.devices SET identity_key_alg = 'LEGACY' WHERE identity_signing_key IS NULL;
UPDATE auth.devices SET identity_key_alg = 'Ed25519+X25519' WHERE identity_signing_key IS NOT NULL;

ALTER TABLE auth.devices
  ADD CONSTRAINT ck_devices_identity_key_alg
    CHECK (identity_key_alg IN ('LEGACY', 'Ed25519+X25519')),
  ADD CONSTRAINT ck_devices_keys_all_or_none CHECK (
    (identity_signing_key IS NULL AND identity_dh_key IS NULL
     AND identity_binding_signature IS NULL AND fingerprint IS NULL
     AND identity_key_alg = 'LEGACY')
    OR
    (octet_length(identity_signing_key) = 32
     AND octet_length(identity_dh_key) = 32
     AND octet_length(identity_binding_signature) = 64
     AND octet_length(fingerprint) = 32
     AND identity_key_alg = 'Ed25519+X25519'));

-- Глобальная уникальность: публичные ключи нельзя копировать в другой аккаунт (P2-11).
CREATE UNIQUE INDEX ux_devices_identity_sig
  ON auth.devices (identity_signing_key)
  WHERE status <> 'REVOKED' AND identity_signing_key IS NOT NULL;
CREATE UNIQUE INDEX ux_devices_identity_dh
  ON auth.devices (identity_dh_key)
  WHERE status <> 'REVOKED' AND identity_dh_key IS NOT NULL;

-- В коде V1–V15 identity_public_key не используется (nullable, мёртвая); удаляем, а не оставляем врущую схему.
ALTER TABLE auth.devices DROP COLUMN identity_public_key;

-- 1a. auth.devices RLS: p_devices_self (V2) НЕ даёт читать устройства собеседника, а claim/keys/send
--     обязаны это делать. Добавляем ОТДЕЛЬНУЮ SELECT-policy по членству в общем чате, не расширяя
--     p_devices_self до «весь workspace» и не ломая self. Политики OR-ятся, FORCE RLS сохраняется.
--     RLS для chat.chat_members — tenant-wide, поэтому EXISTS не рекурсирует и не скрывает peer-строки.
CREATE POLICY p_devices_chat_peer ON auth.devices
  FOR SELECT
  USING (
    status = 'ACTIVE'
    AND EXISTS (
      SELECT 1
      FROM chat.chat_members me
      JOIN chat.chat_members peer
        ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
      JOIN chat.chats c
        ON c.id = me.chat_id AND c.deleted_at IS NULL
       AND c.workspace_id = ops.current_workspace_id()
      WHERE me.user_id = ops.current_user_id()
        AND me.status = 'ACTIVE'
        AND peer.user_id = auth.devices.user_id
    )
  );

-- 2. auth.device_prekeys: таблицы НЕ БЫЛО; создаём с SPK/OPK, TTL, retire, consume.
CREATE TABLE auth.device_prekeys (
  device_id      uuid NOT NULL REFERENCES auth.devices(id) ON DELETE CASCADE,
  key_id         text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  kind           text NOT NULL CHECK (kind IN ('SIGNED', 'ONE_TIME')),
  public_key     bytea NOT NULL CHECK (octet_length(public_key) = 32),
  signature      bytea,
  signature_alg  text NOT NULL DEFAULT 'Ed25519',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  retired_at     timestamptz,
  consumed_at    timestamptz,
  PRIMARY KEY (device_id, key_id),
  CHECK (kind <> 'SIGNED' OR (signature IS NOT NULL AND octet_length(signature) = 64)),
  CHECK (kind <> 'ONE_TIME' OR signature IS NULL)
);
CREATE UNIQUE INDEX ux_prekeys_one_signed_active
  ON auth.device_prekeys (device_id) WHERE kind = 'SIGNED' AND retired_at IS NULL;
CREATE INDEX ix_prekeys_one_time_available
  ON auth.device_prekeys (device_id, expires_at) WHERE kind = 'ONE_TIME' AND consumed_at IS NULL;
-- Claim: SELECT ... FOR UPDATE SKIP LOCKED + UPDATE consumed_at в одной транзакции.

-- 2a. RLS + GRANT для device_prekeys (P1-A). V1 не задаёт ALTER DEFAULT PRIVILEGES: без явного
--     GRANT krug_app получает permission denied. FORCE здесь НЕ ставим осознанно: claim-функция
--     SECURITY DEFINER принадлежит владельцу таблицы (миграционная роль) и должна обновлять
--     consumed_at; owner без FORCE обходит RLS. krug_app RLS не обходит и видит только политики.
ALTER TABLE auth.device_prekeys ENABLE ROW LEVEL SECURITY;

-- Владелец устройства: полный доступ к своим prekey (upload/retire/delete).
CREATE POLICY p_prekeys_owner ON auth.device_prekeys
  USING (EXISTS (
    SELECT 1 FROM auth.devices d
    WHERE d.id = device_id AND d.user_id = ops.current_user_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM auth.devices d
    WHERE d.id = device_id AND d.user_id = ops.current_user_id()));

-- Чтение prekeys собеседника: только если он участник общего чата в текущем workspace.
-- Публичные ключи; запись/consume — только owner-политика и claim-функция.
CREATE POLICY p_prekeys_chat_peer_read ON auth.device_prekeys
  FOR SELECT
  USING (EXISTS (
    SELECT 1
    FROM auth.devices d
    JOIN chat.chat_members me
      ON me.user_id = ops.current_user_id() AND me.status = 'ACTIVE'
    JOIN chat.chat_members peer
      ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
    JOIN chat.chats c
      ON c.id = me.chat_id AND c.deleted_at IS NULL
     AND c.workspace_id = ops.current_workspace_id()
    WHERE d.id = auth.device_prekeys.device_id
      AND d.status = 'ACTIVE'
      AND peer.user_id = d.user_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.device_prekeys TO krug_app;

-- Атомарный claim одного OPK с проверкой membership; вызывается из POST /keys/claim.
-- P2-4 (S4): membership обязан проверяться В ТЕКУЩЕМ WORKSPACE — chat_members.chat_id сам по себе
-- не доказывает tenant: чат может принадлежать другому workspace, а app.workspace_id задан W2.
CREATE OR REPLACE FUNCTION auth.claim_one_time_prekey(p_device_id uuid, p_chat_id uuid)
  RETURNS auth.device_prekeys
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k auth.device_prekeys;
  target_user uuid;
BEGIN
  SELECT d.user_id INTO target_user
    FROM auth.devices d
   WHERE d.id = p_device_id AND d.status = 'ACTIVE';
  IF target_user IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_DEVICE' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM chat.chat_members me
      JOIN chat.chat_members peer
        ON peer.chat_id = me.chat_id AND peer.status = 'ACTIVE'
      JOIN chat.chats c
        ON c.id = me.chat_id
       AND c.deleted_at IS NULL
       AND c.workspace_id = ops.current_workspace_id()
     WHERE me.chat_id = p_chat_id
       AND me.user_id = ops.current_user_id()
       AND me.status = 'ACTIVE'
       AND peer.user_id = target_user
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_DEVICE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO k
    FROM auth.device_prekeys
   WHERE device_id = p_device_id
     AND kind = 'ONE_TIME'
     AND consumed_at IS NULL
     AND expires_at > now()
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;                       -- otp_exhausted: 3DH, не ошибка
  END IF;
  UPDATE auth.device_prekeys
     SET consumed_at = now()
   WHERE device_id = k.device_id AND key_id = k.key_id;
  RETURN k;
END $$;
GRANT EXECUTE ON FUNCTION auth.claim_one_time_prekey(uuid, uuid) TO krug_app;
-- SPK читается тем же SELECT'ом: SIGNED-строка с retired_at IS NULL и expires_at > now().
-- (Функция может быть расширена до claim_spk_and_opk; контракт — один OPK на устройство.)

-- 3. message.messages: E2EE-инварианты через crypto_scheme (НЕ добавляем security_mode и НЕ ссылаемся на text).
--    V10 уже снял CHECK "TEXT => body_ciphertext NOT NULL" (attachments-only), V14 добавил sticker_id.
--    Поэтому не воскрешаем старый CHECK; запрещаем именно managed-поля у E2EE.
ALTER TABLE message.messages
  ADD CONSTRAINT ck_messages_e2ee_no_managed_body
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR body_ciphertext IS NULL),
  ADD CONSTRAINT ck_messages_e2ee_no_sticker
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR sticker_id IS NULL),
  ADD CONSTRAINT ck_messages_e2ee_meta
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR content_meta = '{}'::jsonb),
  ADD CONSTRAINT ck_messages_e2ee_type
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR type = 'TEXT'),
  -- P1-F: reply_to_id в E2EE запрещён на верхнем уровне (ответ — только внутри inner payload).
  ADD CONSTRAINT ck_messages_e2ee_no_reply_to_id
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE' OR reply_to_id IS NULL),
  -- P2-12: sender обязателен для E2EE; NULL ломает sender-scoped unique/replay.
  ADD CONSTRAINT ck_messages_e2ee_sender_required
    CHECK (crypto_scheme <> 'E2EE_PAIRWISE'
           OR (sender_id IS NOT NULL AND sender_device_id IS NOT NULL));

-- 3a. client_message_id scope = (chat_id, sender_id, client_message_id), а не (chat_id, client_message_id).
--     Индексы messages создаются в каждой партиции функцией ensure_partition(); старые индексы пересоздаются.
--     P1-A: та же функция обязана создавать партиции message_envelopes_YYYY_MM, иначе первый INSERT
--     в envelopes падает с «no partition of relation found for row».
--     P2-1 (S4): НЕ создавать индексы envelopes на партиции — они наследуются от parent
--     (CREATE INDEX на partitioned-таблице автоматически создаёт индекс на каждой партиции,
--     включая будущие). Иначе на партиции 7 индексов вместо 4.
CREATE OR REPLACE FUNCTION message.ensure_partition(p_month date)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (start_date + interval '1 month')::date;
  part_name  text := format('messages_%s', to_char(start_date, 'YYYY_MM'));
  env_name   text := format('message_envelopes_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS message.%I PARTITION OF message.messages FOR VALUES FROM (%L) TO (%L)',
    part_name, start_date, end_date);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, seq)',
    'ux_' || part_name || '_chat_seq', part_name);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I (chat_id, sender_id, client_message_id) '
                 'WHERE client_message_id IS NOT NULL',
    'ux_' || part_name || '_chat_sender_client', part_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON message.%I (chat_id, created_at DESC)',
    'ix_' || part_name || '_chat_created', part_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON message.%I (workspace_id, chat_id, seq)',
    'ix_' || part_name || '_ws_chat_seq', part_name);
  EXECUTE format('ALTER TABLE message.%I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE message.%I FORCE ROW LEVEL SECURITY', part_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON message.%I', 'p_' || part_name || '_tenant', part_name);
  EXECUTE format('CREATE POLICY %I ON message.%I USING (workspace_id = ops.current_workspace_id()) '
                 'WITH CHECK (workspace_id = ops.current_workspace_id())',
    'p_' || part_name || '_tenant', part_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON message.%I TO krug_app', part_name);

  -- P1-A: партиция конвертов того же месяца. RLS/policy/grant — свои; индексы НЕ дублируем:
  -- parent-индексы (ix_envelopes_*) создаются на партиции автоматически вместе с PK.
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS message.%I PARTITION OF message.message_envelopes '
    'FOR VALUES FROM (%L) TO (%L)',
    env_name, start_date, end_date);
  EXECUTE format('ALTER TABLE message.%I ENABLE ROW LEVEL SECURITY', env_name);
  EXECUTE format('ALTER TABLE message.%I FORCE ROW LEVEL SECURITY', env_name);
  EXECUTE format('DROP POLICY IF EXISTS %I ON message.%I', 'p_' || env_name || '_tenant', env_name);
  EXECUTE format('CREATE POLICY %I ON message.%I USING (workspace_id = ops.current_workspace_id()) '
                 'WITH CHECK (workspace_id = ops.current_workspace_id())',
    'p_' || env_name || '_tenant', env_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON message.%I TO krug_app', env_name);
END $$;

-- Для уже созданных партиций messages: удалить старый (chat_id, client_message_id) и создать sender-scoped.
DO $$
DECLARE part record;
BEGIN
  FOR part IN
    SELECT c.relname AS name
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'message.messages'::regclass
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS message.%I', 'ux_' || part.name || '_client');
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON message.%I '
                   '(chat_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL',
                   'ux_' || part.name || '_chat_sender_client', part.name);
  END LOOP;
END $$;

-- 4. auth.key_verifications (ENT-50): verified привязан к устройству-верификатору (P0-1).
--    V1–V15 такой таблицы нет. Если в промежуточной ветке была старая — переносить только строки
--    с известным verifier_device_id; остальные НЕ переносить (backfill не угадывается).
--    P2-3 (S4): ownership и scope выражены в схеме, а не только в API:
--      (a) composite FK (verifier_user_id, verifier_device_id) -> devices(user_id, id):
--          нельзя записать чужое устройство верификатором (в V2 уже есть UNIQUE (user_id, id));
--      (b) FK target_device_id/chat_id/workspace_id — строки не висят в воздухе;
--      (c) строгий scope — BEFORE INSERT триггер: verifier и target обязаны быть ACTIVE-участниками
--          чата, чат — текущего workspace и не удалён (кросс-чат/кросс-tenant INSERT невозможен);
--          RLS остаётся tenant-границей, иначе revoke/soft-delete не смог бы обновить revoked_at.
CREATE TABLE auth.key_verifications (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id               uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  verifier_user_id      uuid NOT NULL,
  verifier_device_id    uuid NOT NULL,
  target_device_id      uuid NOT NULL REFERENCES auth.devices(id) ON DELETE CASCADE,
  target_key_generation integer NOT NULL CHECK (target_key_generation > 0),
  method                text NOT NULL CHECK (method IN ('QR', 'MANUAL')),
  vh_version            integer NOT NULL CHECK (vh_version = 2),  -- P2-2: только VH v2
  safety_number_hash    bytea NOT NULL CHECK (octet_length(safety_number_hash) = 32),
  verified_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  UNIQUE (verifier_device_id, target_device_id, chat_id),
  CONSTRAINT fk_key_verifications_verifier_owner
    FOREIGN KEY (verifier_user_id, verifier_device_id)
    REFERENCES auth.devices (user_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_key_verifications_chat ON auth.key_verifications (chat_id);
CREATE INDEX ix_key_verifications_target
  ON auth.key_verifications (target_device_id, revoked_at);
ALTER TABLE auth.key_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.key_verifications FORCE ROW LEVEL SECURITY;
-- RLS — только tenant-граница. Строгий scope (verifier/target = ACTIVE-члены того же чата)
-- проверяется BEFORE INSERT триггером, а НЕ WITH CHECK: иначе revoke устройства или
-- soft-delete чата не смог бы проставить revoked_at существующим строкам (WITH CHECK
-- переоценивается на UPDATE и потребовал бы ACTIVE-членства, которого уже нет).
CREATE POLICY p_key_verifications_tenant ON auth.key_verifications
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());

CREATE OR REPLACE FUNCTION auth.check_key_verification_scope()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  chat_ws      uuid;
  chat_deleted timestamptz;
  target_user  uuid;
BEGIN
  SELECT c.workspace_id, c.deleted_at INTO chat_ws, chat_deleted
    FROM chat.chats c WHERE c.id = NEW.chat_id;
  IF chat_ws IS NULL OR chat_ws <> NEW.workspace_id OR chat_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514',
            DETAIL = 'chat is missing, deleted, or belongs to another workspace';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.chat_id = NEW.chat_id
       AND m.user_id = NEW.verifier_user_id
       AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'verifier is not an ACTIVE member of the chat';
  END IF;
  SELECT d.user_id INTO target_user FROM auth.devices d WHERE d.id = NEW.target_device_id;
  IF target_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.chat_id = NEW.chat_id
       AND m.user_id = target_user
       AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'VERIFICATION_SCOPE_MISMATCH'
      USING ERRCODE = '23514', DETAIL = 'target is not an ACTIVE member of the chat';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_key_verifications_scope
  BEFORE INSERT ON auth.key_verifications
  FOR EACH ROW EXECUTE FUNCTION auth.check_key_verification_scope();
-- P1-A: без явного GRANT krug_app получает permission denied (V1 не задаёт default privileges).
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.key_verifications TO krug_app;

-- 5. chat.chats: direct_key для уникальности DIRECT-пары (P1-5/P1-A-1).
ALTER TABLE chat.chats ADD COLUMN direct_key text;

-- 5a. Инвариант (S4). direct_key определён для КАЖДОГО type='DIRECT' и строится по ПАРЕ
--     участников чата независимо от их status: {A,B} = множество различных chat_members.user_id,
--     direct_key = least(A,B)::text || ':' || greatest(A,B)::text. REMOVED/INVITED-участник —
--     всё ещё участник пары; выход из DIRECT не превращает чат в GROUP и не удаляет историю.
--     DIRECT с числом различных участников != 2 — повреждение данных: миграция обязана остановиться
--     с диагностикой (DIRECT_KEY_UNRESOLVED), а не молча оставить direct_key NULL.
DO $$
DECLARE bad_direct text;
BEGIN
  SELECT string_agg(c.id::text, ',' ORDER BY c.id) INTO bad_direct
    FROM chat.chats c
   WHERE c.type = 'DIRECT'
     AND (SELECT count(DISTINCT m.user_id)
            FROM chat.chat_members m
           WHERE m.chat_id = c.id) <> 2;
  IF bad_direct IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_KEY_UNRESOLVED'
      USING ERRCODE = '23514',
            DETAIL = 'DIRECT chats without exactly 2 distinct member rows: ' || bad_direct,
            HINT = 'repair chat_members (restore the missing/removed participant row) or soft-delete the chat; see E2EE-SPEC §6.5.2';
  END IF;
END $$;

-- 5b. Backfill: ЛЮБЫЕ два участника DIRECT (не только ACTIVE), включая deleted DIRECT.
WITH pairs AS (
  SELECT c.id,
         min(m.user_id::text) || ':' || max(m.user_id::text) AS dk
  FROM chat.chats c
  JOIN chat.chat_members m ON m.chat_id = c.id
  WHERE c.type = 'DIRECT'
  GROUP BY c.id
  HAVING count(DISTINCT m.user_id) = 2
)
UPDATE chat.chats c SET direct_key = p.dk FROM pairs p WHERE c.id = p.id;

-- 5c. Fail-fast: если после backfill остался DIRECT без ключа — это ошибка данных, не NOT NULL violation.
DO $$
DECLARE leftover text;
BEGIN
  SELECT string_agg(id::text, ',' ORDER BY id) INTO leftover
    FROM chat.chats WHERE type = 'DIRECT' AND direct_key IS NULL;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_KEY_UNRESOLVED'
      USING ERRCODE = '23514',
            DETAIL = 'DIRECT chats with direct_key still NULL after backfill: ' || leftover,
            HINT = 'see E2EE-SPEC §6.5.2 (repair runbook)';
  END IF;
END $$;

-- 5d. Duplicate pair preflight: до создания unique-индекса, с понятной диагностикой и id.
DO $$
DECLARE dup_pairs text;
BEGIN
  SELECT string_agg(p.pair, ',' ORDER BY p.pair) INTO dup_pairs
    FROM (
      SELECT c.workspace_id::text || '/' || c.direct_key AS pair
        FROM chat.chats c
       WHERE c.type = 'DIRECT' AND c.deleted_at IS NULL
       GROUP BY c.workspace_id, c.direct_key
      HAVING count(*) > 1
    ) p;
  IF dup_pairs IS NOT NULL THEN
    RAISE EXCEPTION 'DIRECT_PAIR_DUPLICATE'
      USING ERRCODE = '23505',
            DETAIL = 'more than one live DIRECT chat for pair(s): ' || dup_pairs,
            HINT = 'soft-delete the newer duplicate (E2EE-SPEC §6.5.2), then re-run V16';
  END IF;
END $$;

-- 5e. CHECK добавляется NOT VALID и валидируется отдельной командой ПОСЛЕ backfill:
--     если данные всё же неполные, падает VALIDATE с именем constraint, а не ADD CONSTRAINT
--     «violated by some row» (S3 падал именно так на чате с REMOVED-участником).
ALTER TABLE chat.chats
  ADD CONSTRAINT ck_chats_direct_key CHECK (
    (type = 'DIRECT' AND direct_key IS NOT NULL)
    OR (type <> 'DIRECT' AND direct_key IS NULL)) NOT VALID,
  -- Формат и порядок: 'меньший:больший' UUID. Без порядка пара (A,B) и (B,A) дала бы два разных
  -- direct_key и обошла бы unique-индекс; CHECK делает инвариант обязательным и для future-кода.
  ADD CONSTRAINT ck_chats_direct_key_format CHECK (
    type <> 'DIRECT'
    OR (direct_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND split_part(direct_key, ':', 1) < split_part(direct_key, ':', 2))) NOT VALID;

ALTER TABLE chat.chats VALIDATE CONSTRAINT ck_chats_direct_key;
ALTER TABLE chat.chats VALIDATE CONSTRAINT ck_chats_direct_key_format;

CREATE UNIQUE INDEX ux_chats_direct_pair
  ON chat.chats (workspace_id, direct_key)
  WHERE type = 'DIRECT' AND deleted_at IS NULL;

-- 6. Immutability security_mode (P0-3). Смена режима = новый чат/воркспейс.
CREATE OR REPLACE FUNCTION ops.forbid_security_mode_change()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.security_mode IS DISTINCT FROM OLD.security_mode THEN
    RAISE EXCEPTION 'MODE_CHANGE_FORBIDDEN'
      USING ERRCODE = '23514', DETAIL = 'security_mode is immutable; create a new chat/workspace';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_chats_security_mode_immutable
  BEFORE UPDATE ON chat.chats
  FOR EACH ROW EXECUTE FUNCTION ops.forbid_security_mode_change();
CREATE TRIGGER trg_workspaces_security_mode_immutable
  BEFORE UPDATE ON workspace.workspaces
  FOR EACH ROW EXECUTE FUNCTION ops.forbid_security_mode_change();
-- NB: WorkspaceRepositoryAdapter сейчас делает ON CONFLICT ... DO UPDATE SET security_mode =
-- EXCLUDED.security_mode. Это должно быть убрано/заменено на "DO NOTHING" для security_mode,
-- иначе onboarding-upsert упрётся в триггер (и это правильный сигнал 409, а не 500).

-- 7. message.message_envelopes: opaque-конверты, партиционирование как messages, без FK.
CREATE TABLE message.message_envelopes (
  message_id             uuid NOT NULL,
  recipient_device_id    uuid NOT NULL,
  sender_device_id       uuid NOT NULL,
  workspace_id           uuid NOT NULL,
  chat_id                uuid NOT NULL,
  scheme                 text NOT NULL CHECK (scheme = 'PAIRWISE_X3DH_DR'),
  sender_key_generation  integer NOT NULL CHECK (sender_key_generation > 0),
  recipient_key_generation integer NOT NULL CHECK (recipient_key_generation > 0),
  session_id             bytea NOT NULL CHECK (octet_length(session_id) = 16),
  header                 jsonb NOT NULL CHECK (jsonb_typeof(header) = 'object'),
  -- P2-11 (S4) + P1-02 (E7-B3F): принимается только КАНОНИЧЕСКИЙ конверт v1 —
  -- decoded 272..33040 B (256 padding + 16 tag … 33024 padded + 16 tag), что
  -- соответствует 363..44054 b64u-символам. Значения 33041..49152 получатель всё равно
  -- отвергнет, поэтому БД их не хранит. Form guard 65536 encoded остаётся в API как
  -- дешёвая проверка до base64-decode (413, details.reason="form"). V18 поднимает floor
  -- существующих установок 16 → 272 через `NOT VALID` CHECK (новые строки проверяются,
  -- старые короткие не ломают rollout).
  ciphertext             bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 272 AND 33040),
  prekey                 jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_device_id, created_at),
  CHECK (prekey IS NULL OR jsonb_typeof(prekey) = 'object')
) PARTITION BY RANGE (created_at);
-- Parent-индексы: создаются на partitioned-таблице и АВТОМАТИЧЕСКИ наследуются каждой партицией
-- (включая созданные позже). Дублировать их в ensure_partition() нельзя: это даёт 7 индексов на
-- партиции вместо 4 (PK + 3) и двойную запись (P2-1).
CREATE INDEX ix_envelopes_recipient
  ON message.message_envelopes (recipient_device_id, created_at);
CREATE INDEX ix_envelopes_message
  ON message.message_envelopes (message_id, created_at);
CREATE INDEX ix_envelopes_ws_chat
  ON message.message_envelopes (workspace_id, chat_id, created_at);

-- P1-A: RLS на родителе + явный GRANT. Партиции создаёт ensure_partition() (см. 3a),
-- вместе с их RLS/grants; индексы партиция получает от parent.
ALTER TABLE message.message_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE message.message_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY p_message_envelopes_tenant ON message.message_envelopes
  USING (workspace_id = ops.current_workspace_id())
  WITH CHECK (workspace_id = ops.current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON message.message_envelopes TO krug_app;

-- Стартовые партиции: текущий + два следующих месяца (как у messages), ПОСЛЕ создания таблиц.
SELECT message.ensure_partition(date_trunc('month', now())::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT message.ensure_partition((date_trunc('month', now()) + interval '2 months')::date);
```

### 6.5.1. Замечания и миграционные правила

- **P1-4 (исправлено):** в `message.messages` **нет** колонки `text`; текст managed-сообщений — `body_ciphertext` (AES-GCM backend), а E2EE-сообщение хранится с `crypto_scheme='E2EE_PAIRWISE'`, `body_ciphertext NULL`. Не добавляем дублирующий `security_mode` в `messages`: источник истины о режиме сообщения — `crypto_scheme`; о режиме чата — `chat.chats.security_mode`.
- **V10 уже снял** CHECK `type='TEXT' => body_ciphertext NOT NULL` (attachments-only). Поэтому старый чек из ревью не воспроизводим; вместо него — CHECK на отсутствие managed-полей у `E2EE_PAIRWISE`. `content_meta = '{}'` гарантирует, что в E2EE не просочились plaintext-метаданные; при необходимости allowlist расширяется новой миграцией.
- **P1-A (grants):** V1 **не** задаёт `ALTER DEFAULT PRIVILEGES`, поэтому каждый новый объект требует явного `GRANT` для runtime-роли `krug_app` (`AUTH_*`/datasource). В §6.5 это `auth.device_prekeys`, `auth.key_verifications`, `message.message_envelopes` (родитель + каждая партиция в `ensure_partition`) и `EXECUTE` на `auth.claim_one_time_prekey`. Без них E7-B падает с `permission denied`, а не «работает медленно».
- **P1-A (RLS prekeys):** `auth.device_prekeys` — `ENABLE RLS` + две политики: owner (полный доступ к своим) и chat-peer `FOR SELECT` через `chat_members`+`chat.chats.workspace_id`. `FORCE` **не** ставится осознанно: claim-функция `SECURITY DEFINER` принадлежит владельцу таблицы и должна обновлять `consumed_at`; `krug_app` RLS не обходит. Consume OPK идёт только через функцию; прямой `UPDATE` peer-prekey политикой не разрешён. Это устраняет cross-tenant перечисление prekeys.
- **P1-A (RLS devices):** `p_devices_self` (V2) сохранена как есть; добавлена **отдельная** `p_devices_chat_peer FOR SELECT`, которая разрешает читать только ACTIVE-устройства собеседников по общему чату в текущем workspace (claim/keys/send). Это не «весь workspace» и не ломает self-write/revoke. Альтернатива `SECURITY DEFINER auth.devices_for_chat(chat_id)` допустима, но policy проще и не требует нового кода; если PM выберет функцию — контракт §6.2 не меняется.
- **P1-A (RLS envelopes):** `message.message_envelopes` — `ENABLE`+`FORCE`, policy `workspace_id = ops.current_workspace_id()`, явный `GRANT`; каждая партиция получает то же в `ensure_partition`. Сервер дополнительно фильтрует по `recipient_device_id`; RLS — tenant-граница, не per-device.
- **P1-A (partitions):** `message.ensure_partition(date)` создаёт **обе** партиции месяца (`messages_*` и `message_envelopes_*`) + RLS/policy/grant. Индексы envelopes на партиции **не** создаются повторно: parent-индексы `ix_envelopes_*` наследуются автоматически (включая будущие партиции), поэтому на партиции ровно **4** индекса — PK + 3 (P2-1: в S3 их было 7). Для `messages` child-индексы остаются: unique `(chat_id, seq)` и `(chat_id, sender_id, client_message_id)` нельзя создать на parent без partition key. Стартовые партиции (текущий + 2 следующих месяца) создаются в конце миграции; job вызывает ту же функцию. Первый `INSERT` в envelopes без партиции невозможен.
- **P1-F / P2-12 (CHECK):** `ck_messages_e2ee_no_reply_to_id` запрещает верхнеуровневый `reply_to_id` у `E2EE_PAIRWISE`; `ck_messages_e2ee_sender_required` требует `sender_id`/`sender_device_id NOT NULL` для E2EE (иначе sender-scoped unique/replay допускает NULL-дубли). Ответ внутри inner payload (`reply_to_id` в TEXT_JSON) остаётся разрешён — сервер его не видит.
- **P2-2 (VH):** `vh_version = 2` в таблице; запрос `PUT .../verification` без `vh_version=2` → `422 VH_VERSION_UNSUPPORTED` (см. §6.2.7). Старые v1-хэши не переносятся.
- `auth.device_prekeys` и `auth.key_verifications` в V1–V15 **отсутствуют** — это `CREATE TABLE`, а не `ALTER`. `identity_public_key` нигде в коде не используется, поэтому удаляется, а не остаётся «мёртвой» nullable-колонкой.
- **`key_verifications` ownership (P2-3, S4):** `verifier_device_id NOT NULL`; уникальность `(verifier_device_id, target_device_id, chat_id)`; composite FK `(verifier_user_id, verifier_device_id) → auth.devices(user_id, id)` (в V2 уже есть `UNIQUE (user_id, id)`) не даёт записать чужое устройство верификатором; FK `chat_id → chat.chats`, `workspace_id → workspace.workspaces`, `target_device_id → auth.devices`. **Строгий scope — на INSERT:** `BEFORE INSERT` триггер `auth.check_key_verification_scope()` требует, чтобы verifier и target были **ACTIVE-участниками того же чата**, а чат — текущего workspace и не удалён (`VERIFICATION_SCOPE_MISMATCH`, `23514`). RLS-политика при этом остаётся **tenant-границей** (`workspace_id = ops.current_workspace_id()`), а не `WITH CHECK` по членству: `WITH CHECK` переоценивается на `UPDATE`, и тогда revoke устройства (`revoked_at`) или soft-delete чата не смогли бы обновить существующие строки — это было бы регрессией (PG16 T29/T30). Строки без известного `verifier_device_id` не переносятся и считаются недоверенными (backfill не угадывается). `verified` сбрасывается триггером/сервисом при `key_generation++`, revoke target и TOFU-mismatch.
- **`verified_count` (P2-1):** это `count(*)` строк, где `verifier_device_id = X-Device-Id`, `target_device_id` — устройство в чате, `revoked_at IS NULL`; агрегат **не** смешивает верификаторов. Отдельное поле `verified_by_other_devices_count` — только информационное для UI «сверено на другом устройстве», не замочек. Для L2 (второе устройство) `verified_count=0`, `verified=null`.
- **`direct_key` (P1-A-1, S4):** инвариант — `direct_key = least(A,B)::text || ':' || greatest(A,B)::text`, где `{A,B}` — множество **различных `chat_members.user_id` независимо от `status`** (REMOVED/INVITED — всё ещё участники пары). Backfill идёт по **всем** DIRECT, включая deleted, и не ограничен `status='ACTIVE'`. `count(DISTINCT user_id) <> 2` — повреждение данных: `DO`-preflight бросает `DIRECT_KEY_UNRESOLVED` с id чатов **до** любых изменений схемы; после backfill — повторный fail-fast, если остался NULL. CHECK добавляются `NOT VALID` и затем `VALIDATE CONSTRAINT` (ошибка называет constraint, а не «violated by some row» на ADD). `ck_chats_direct_key_format` требует формат двух UUID и `least < greatest` — иначе пара `(B,A)` обошла бы unique-индекс. Дубли пары ловит `DIRECT_PAIR_DUPLICATE` (preflight) с runbook §6.5.2 (soft-delete более нового чата: `ux_chats_direct_pair` — partial по `deleted_at IS NULL`, данные не удаляются).
- **Immutability:** триггеры на `chat.chats` и `workspace.workspaces`; `security_mode` не обновляется даже через upsert. Backend транслирует исключение в `409 MODE_CHANGE_FORBIDDEN`.
- **client_message_id:** unique-индекс каждой партиции `(chat_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL`; старый `(chat_id, client_message_id)` удаляется. Replay-ветка обязана фильтровать `sender_id = caller`.
- **Envelopes (P2-11, S4; V18/V19 — E7-B3F/B3F3):** DB CHECK `octet_length(ciphertext) BETWEEN 272 AND 33040`. V18 поднял floor 16 → 272 через `NOT VALID` CHECK: новые строки проверяются сразу, установка с legacy 16..271 B не падает на миграции. **Старые строки после V19 не остаются читаемыми:** V19 переносит все строки вне `272..33040` в `message.message_envelopes_quarantine` (`legacy_short`/`legacy_out_of_range`), удаляет их из live только при побайтовом совпадении копии, валидирует constraint на parent и всех партициях и восстанавливает `FORCE RLS`. Read-path толерантен: устройство без валидного конверта получает `crypto:null`, не `500` (§6.5.3). Хранится только **канонический** конверт (272 = 256 padding + 16 tag; 33024 padded + 16 tag = 44054 b64u). API отвергает всё, что больше, `413 ENVELOPE_TOO_LARGE` (`details.reason="canonical"`), потому что получатель такой конверт всё равно не расшифрует; `65536` encoded остаётся pre-decode form guard (`details.reason="form"`) и не является обещанием доставки. Общий wire-лимит 512 KiB проверяется приложением/прокси **до** парсинга; в БД он не выражается.
- **Порядок V16+:** (1) devices + `p_devices_chat_peer`; (2) device_prekeys + RLS/grants/claim-функция; (3) messages CHECK + переиндексация партиций; (4) key_verifications + grant/vh_version; (5) direct_key + триггеры; (6) message_envelopes + RLS/grant; (7) `ensure_partition` (обе таблицы) + стартовые партиции. Всё forward-only; destructive `DROP COLUMN identity_public_key` — после проверки, что деплой backend уже не читает колонку (в текущем коде её нет).
- **Тесты (Testcontainers, роль `krug_app`, не owner):** миграция на данных V1–V15, включая **degraded DIRECT** (1 ACTIVE + 1 REMOVED), deleted DIRECT, duplicate pair и corrupt (1 member) DIRECT; два пользователя в DIRECT-чате → claim/keys/send; `INSERT` envelope в текущую партицию; `INSERT` E2EE с `reply_to_id`/NULL sender → fail; `INSERT` prekey/envelope другой tenant → 0 rows; `INSERT` verification чужим verifier'ом → FK fail, не-участником/в чужом чате → RLS fail; claim в чате чужого workspace → `UNKNOWN_DEVICE`; `UPDATE security_mode` → exception; DB-скан «нет plaintext в content_meta/логах»; `EXPLAIN` на `(recipient_device_id, created_at)`; гонка claim OPK (`SKIP LOCKED`, ровно один потребитель); отсутствие partition → ловится тестом «ensure_partition создаёт envelopes»; `count(pg_indexes)` на партиции envelopes = **4**.
- **S4 smoke (Postgres 16.16, выполнено при подготовке S4):** V1–V15 + seed + §6.5 **одной транзакцией** — `exit 0` на normal и degraded DIRECT; на партиции envelopes **4** индекса (и на новой, созданной `ensure_partition`); 30/30 conformance-проверок под `krug_app` (peer/non-peer видимость, prekeys, claim workspace, 33040/33041, CHECK'и, ownership `key_verifications` + revoke-регрессия, direct_key format/duplicate, mode immutability); corrupt DIRECT → `DIRECT_KEY_UNRESOLVED` с id; duplicate pair → `DIRECT_PAIR_DUPLICATE`, после runbook §6.5.2 V16 применяется и дублей 0. Полный лог/команды — `E2EE-SPIKE-NOTES.md` §11.4, runbook — §6.5.2. Это не заменяет Testcontainers E7-B1 (нет Flyway, гонки claim, реальных исторических объёмов), но доказывает исполнимость на вырожденных данных.

### 6.5.2. Repair runbook для V16 (выполняет E7-B1/ops, не миграция)

V16 **не чинит** повреждённые данные молча: он останавливается с machine-readable кодом и id. Runbook ниже выполняется **до** повторного запуска V16 (на схеме V1–V15: `direct_key` ещё нет, поэтому расчёт идёт по `chat_members`). Все шаги идемпотентны.

**1. `DIRECT_KEY_UNRESOLVED` — у DIRECT не ровно 2 различных участника.** Диагностика:

```sql
SELECT c.id, c.deleted_at IS NOT NULL AS deleted,
       count(DISTINCT m.user_id) AS members,
       string_agg(DISTINCT m.user_id::text || ':' || m.status, ',') AS rows
  FROM chat.chats c
  LEFT JOIN chat.chat_members m ON m.chat_id = c.id
 WHERE c.type = 'DIRECT'
 GROUP BY c.id, c.deleted_at
HAVING count(DISTINCT m.user_id) <> 2;
```

Варианты (решение PM/ops по каждому id, автоматического «угадывания» нет):

```sql
-- (a) потеряна вторая строка участника (данные целы): восстановить её с status='REMOVED'
INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
SELECT c.id, c.workspace_id, '<second_user_uuid>', 'MEMBER', 'REMOVED'
  FROM chat.chats c WHERE c.id = '<chat_uuid>'
ON CONFLICT (chat_id, user_id) DO NOTHING;

-- (b) чат не нужен / 3+ участников (не DIRECT по смыслу): soft-delete, история остаётся
UPDATE chat.chats SET deleted_at = now(), updated_at = now() WHERE id = '<chat_uuid>';
```

**2. `DIRECT_PAIR_DUPLICATE` — две живые DIRECT-пары.** Soft-delete более нового чата (partial unique `ux_chats_direct_pair` игнорирует `deleted_at`; `messages`/`chat_members` не удаляются, история доступна read-model):

```sql
WITH pairs AS (
  SELECT c.id, c.workspace_id, c.created_at,
         min(m.user_id::text) || ':' || max(m.user_id::text) AS dk
    FROM chat.chats c
    JOIN chat.chat_members m ON m.chat_id = c.id
   WHERE c.type = 'DIRECT'
   GROUP BY c.id, c.workspace_id, c.created_at
  HAVING count(DISTINCT m.user_id) = 2
), ranked AS (
  SELECT id, row_number() OVER (PARTITION BY workspace_id, dk ORDER BY created_at, id) AS rn
    FROM pairs
)
UPDATE chat.chats c SET deleted_at = now(), updated_at = now()
  FROM ranked r WHERE c.id = r.id AND r.rn > 1;
```

**3. Порядок.** (1) прогнать диагностику; (2) применить repair; (3) повторить V16 **той же транзакцией** (`psql -1 -f v16.sql`); (4) проверить: `SELECT count(*) FROM chat.chats WHERE type='DIRECT' AND direct_key IS NULL` = 0, дублей живых пар = 0, на партиции envelopes 4 индекса. Если V16 упал — транзакция откатилась целиком, повтор безопасен.

**4. Почему не «просто NOT VALID».** `NOT VALID` + `VALIDATE` уже используются в V16 (5e), но `NOT VALID` не спасает от NULL-значения: constraint всё равно должен стать валидным, а NULL `direct_key` у DIRECT — это либо потерянная строка участника, либо баг backfill. Поэтому V16 сначала **ремонтирует** (backfill по любым двум участникам), а затем валидирует; `NOT VALID` нужен, чтобы ошибка валидации называла constraint и не блокировала создание остальных объектов раньше времени.

**5. Роль миграции на managed PostgreSQL (P1-05, E2EE-REVIEW-04).** V16/V17 выполняют backfill-`UPDATE`/`SELECT` по таблицам с `FORCE ROW LEVEL SECURITY`
(`auth.devices`, `chat.chats`, `chat.chat_members`). У owner'а с `FORCE` и без `BYPASSRLS`/superuser эти запросы
видят **0 строк**: backfill молча не применяется, а падает позже неинформативным constraint-ом. Поэтому V16/V17
делают ровно это:

```sql
ALTER TABLE auth.devices NO FORCE ROW LEVEL SECURITY;   -- только на время repair/backfill
-- preflight → backfill → fail-fast DO-блоки
ALTER TABLE auth.devices FORCE ROW LEVEL SECURITY;      -- обязательно вернуть до VALIDATE/коммита
```

`ENABLE ROW LEVEL SECURITY` не снимается ни на одном шаге — `krug_app` всё время остаётся в tenant-политике.
Flyway выполняет файл одной транзакцией, поэтому падение откатывает и `NO FORCE`; «забыть FORCE» на успешном
прогоне невозможно (в конце стоит явный `FORCE`, а `E2eeMigrationIT` проверяет `relforcerowsecurity=true`).

Требования к роли:
- Flyway запускается **owner'ом** схем (`krug_migrator`), а не `krug_app`;
- роль **не обязана** быть superuser/BYPASSRLS — V16/V17 исполняются non-superuser owner'ом (проверено
  `E2eeMigrationIT.nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17`: `CREATE ROLE … NOSUPERUSER NOBYPASSRLS`,
  V1→V17, backfill `identity_key_alg`/`direct_key` применён, `FORCE` восстановлен);
- роль должна владеть таблицами (`ALTER TABLE` иначе упадёт `must be owner of table`). Если owner — не Flyway-роль,
  используйте `BYPASSRLS` и задокументируйте это в runbook деплоя.

Диагностика после миграции (обязательные нули/единицы):

```sql
SELECT count(*) FROM auth.devices
 WHERE identity_key_alg NOT IN ('LEGACY', 'Ed25519+X25519');              -- 0
SELECT count(*) FROM chat.chats WHERE type = 'DIRECT' AND direct_key IS NULL; -- 0
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE oid IN ('auth.devices'::regclass, 'chat.chats'::regclass,
               'chat.chat_members'::regclass);                             -- t/t/t
```

**6. V17: жёсткая уникальность identity-пары и NULL-safe CHECK (P1-06/P2-01/P2-02/P2-03).** V16 оставлял
partial-индексы `WHERE status <> 'REVOKED'` и NULL-небезопасный all-or-none CHECK. V17 (forward-only):
(а) карантинит в `auth.identity_key_quarantine` и обнуляет неполные/дублирующиеся identity-ключи (победитель —
ACTIVE, затем самый старый), затем создаёт **глобальные** unique-индексы без предиката по статусу и
NULL-safe CHECK (явные `IS NOT NULL` до `octet_length`); (б) заменяет scope-триггер `key_verifications`
(требует ACTIVE+capable target и ACTIVE verifier device); (в) добавляет `auth.device_is_e2ee_capable(...)`,
`auth.user_has_e2ee_capable_device(...)` и `chat.e2ee_chat_scopes(...)`. Дубли, пережившие repair, дают
fail-fast `IDENTITY_KEY_DUPLICATE_UNRESOLVED`, не «тихий» no-op.

**7. Откат.** V16/V17 forward-only; единственный «откат» — `NO FORCE`/repair-шаги идемпотентны, а неудачный
прогон откатывается транзакцией Flyway. Данные, удалённые из `auth.devices` при repair, сохранены в
`auth.identity_key_quarantine` (owner-only, без грантов `krug_app`).

### 6.5.3. V18/V19 — ciphertext floor, quarantine и tolerant read (E7-B3F/B3F3)

**V18** (`V18__e2ee_ciphertext_floor.sql`) добавляет
`ck_envelopes_ciphertext_min CHECK (octet_length(ciphertext) BETWEEN 272 AND 33040) NOT VALID`:
новые INSERT/UPDATE проверяются сразу (включая все партиции), но установка с legacy 16..271 B
не падает. `NOT VALID` — временное состояние, а **не** обещание «старые строки остаются
читаемыми».

**V19** (`V19__e2ee_legacy_envelope_quarantine.sql`) — постоянное исправление, одна
транзакция Flyway:

1. снимает `FORCE ROW LEVEL SECURITY` с `message.message_envelopes` на время копирования
   (`ENABLE` остаётся, `krug_app` сохраняет tenant-политику);
2. создаёт `message.message_envelopes_quarantine` — побайтовую копию envelope-колонок плюс
   `reason`/`quarantined_at`; таблица owner-only (V20 добавляет RLS и retention);
3. `INSERT ... SELECT` переносит **все** строки `< 272` (`legacy_short`) и `> 33040`
   (`legacy_out_of_range`), `ON CONFLICT DO NOTHING`;
4. `DELETE ... WHERE EXISTS` удаляет live-строку **только если** в quarantine есть строка с
   тем же PK и теми же bytes (`workspace_id`, `chat_id`, `session_id`, `header`,
   `ciphertext`). Если копия конфликтует, удаление не происходит, `VALIDATE` падает, и
   данные не теряются;
5. `VALIDATE CONSTRAINT` рекурсивно проверяет parent и все текущие партиции;
6. возвращает `FORCE ROW LEVEL SECURITY`.

Валидные строки не читаются и не меняются. Повторный запуск идемпотентен благодаря
`ON CONFLICT DO NOTHING` и проверке копии в `DELETE`.

**Tolerant read (до и после V19).** `findForDevice`/`findByMessage` фильтруют
`octet_length(ciphertext) BETWEEN 272 AND 33040`; `toDomainOrNull` пропускает **любую**
нечитаемую строку (legacy-длина, битый header/prekey, неожиданная форма/NPE), логируя только
`message_id`, `recipient_device_id` и reason — **ciphertext не логируется**. Устройство без
валидного конверта получает `GET /chats/{id}/messages` → `200` с `crypto:null` и WS replay →
кадр с `crypto:null`; `500` на legacy-строке быть не должно. Валидные конверты других устройств
и других сообщений не затрагиваются. Контракт `Message.crypto` допускает `null`.

**Rollout V19/V20 (обязательно).**

* V19 делает `ACCESS EXCLUSIVE` на `message.message_envelopes` и полный scan/`VALIDATE`.
  Запускать в maintenance-window с backup; V19/V20 forward-only, откат — restore из backup.
  Старые (strict) инстансы могут отдавать `500` на legacy-строках, пока V19 не завершён:
  деплоить новый tolerant-код вместе с V19 и не держать старые инстансы дольше окна.
* После миграции проверить:

```sql
SELECT conrelid::regclass, convalidated FROM pg_constraint
 WHERE conname = 'ck_envelopes_ciphertext_min';            -- t на parent и всех партициях
SELECT count(*) FROM message.message_envelopes
 WHERE octet_length(ciphertext) NOT BETWEEN 272 AND 33040; -- 0
SELECT relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE oid = 'message.message_envelopes'::regclass;        -- t / t
SELECT count(*) FROM message.message_envelopes_quarantine; -- = числу удалённых строк
```

* `DB_USER` (runtime) обязан отличаться от `FLYWAY_USER` (owner). V20:
  `ENABLE ROW LEVEL SECURITY` на quarantine **без policy** (owner обходит RLS, любой
  non-owner — нет, даже после будущего широкого `GRANT`), отзыв табличных грантов у
  `krug_app`/`PUBLIC`, индекс по `quarantined_at` и `message.purge_envelope_quarantine(days)`
  (`SECURITY DEFINER`, окно 1..3650 дней, `EXECUTE` только у `krug_app`).
  `EnvelopeQuarantineRetentionScheduler` вызывает функцию раз в сутки
  (`krug.e2ee.quarantine-retention-*`, по умолчанию 90 дней; в `test` выключен). Без
  приложения retention выполняет оператор: `SELECT message.purge_envelope_quarantine(90);`.
* Legacy-only replay — `422`/`409` по §4.1, не `201`; это не потеря данных.

### 6.6. Обратная совместимость и миграция

| Что | До E7 | После E7 (S3) | Действие |
|---|---|---|---|
| `POST /devices` | name/platform/app_version | + `IK_sig`, `IK_dh`, `identity_binding_signature`, `identity_key_alg`, SPK; ключи **optional** (all-or-none): без них — `201` legacy (`e2ee_capable=false`), с ними — E2EE; REVOKED IK → 410 | **Backward-compatible в Phase 1** (D-S4-03); Phase 2 — version floor с `422`; contract-first + regenerate `schema.d.ts`; старый клиент продолжает регистрироваться как legacy |
| `Device`/`DeviceView` | id/platform/createdAt | + name/status/e2ee_capable/key_generation/identity_*/binding/fingerprint/SPK/OPK count | Одна миграция + DTO/мапперы; см. P1-6 |
| Идемпотентность device | natural key (name, platform, version) | identity signing key → затем Idempotency-Key | Обновить `DeviceRegistrationService` + тесты; см. §5.1 |
| `identity_public_key` (V2) | nullable, default alg `Ed25519` | drop; `identity_key_alg` `LEGACY\|Ed25519+X25519` | Миграция V16; код колонку не использует |
| Legacy/dev устройство | может существовать без ключей | `e2ee_capable=false`; `POST prekeys` → `422 E2EE_LEGACY_DEVICE`; claim → `unavailable NO_KEYS` | **Не апгрейдить in-place** (D-17); новое устройство (P2-4) |
| `MessageCreate` | text/sticker/attachments | + envelopes; plaintext запрещён в E2EE | Backend validation по `chat.security_mode` |
| `Message` | без `crypto`/`client_message_id` | + оба (nullable); `client_message_id` scope по sender; `reply_to_id` null в E2EE | Frontend типы; backend read path; P1-10/P1-F |
| `client_message_id` уникальность | `(chat_id, client_message_id)` (V4) | `(chat_id, sender_id, client_message_id)` | Переиндексация партиций + replay по sender |
| `GET /workspaces/{id}/chats` | `ChatSummary.security_mode`, `name` required string | + `peer_id` (nullable, DIRECT), `name: [string,null]`, `peer_has_e2ee_capable_devices` (derived) | Обновить `ChatSummary` + `schema.d.ts`; contract-тесты DIRECT `name=null` и capability (P1-H, P2-7, P2-10) |
| `POST /chats/{id}/messages` (ответ) | `Message` | `MessageCreateResult = Message + envelope_coverage` (optional в схеме, обязателен для E2EE) | Обновить 201-схему + `schema.d.ts`; contract-тест «E2EE-ответ содержит coverage» (D-S4-04) |
| `Chat` / `ChatCreateRequest` | в контракте **отсутствуют** | `add`: `Chat` (+`peer_id`, `peer_has_e2ee_capable_devices`, nullable `name`), `ChatCreateRequest` (+`peer_id`, nullable `name`); `POST /workspaces/{id}/chats` — новый path | I-01 §6.3.1 (D-S4-01); PM добавляет, а не «расширяет» |
| DIRECT-чат | без `direct_key` | `direct_key` + partial unique; `peer_id` из members (в `Chat` и `ChatSummary`) | Backfill/repair + race-тест |
| Verification | нет таблицы/endpoint | `verifier_device_id`, `VH` v2, `vh_version` в запросе, per-device `verified` | Новая таблица; старые u8(1) — untrusted; `vh_version!=2` → 422 (P2-2) |
| Dev session | создаёт device без ключей | не может E2EE | E2E-тесты E2EE — только реальный OIDC flow |
| Workspace E2EE | создаётся, но чаты managed | E2EE DIRECT; security_mode неизменяем | `POST /workspaces/{id}/chats`; 409 на downgrade |
| Feature flag `e2ee.enabled=false` | бейдж/чат могли появиться | создание E2EE → 409 `E2EE_DISABLED`; бейджа нет; существующие E2EE не понижаются | см. §10.4 |

**Правило flag-off (P1-12).** Пока `e2ee.enabled=false`:
1. `POST /workspaces` с `security_mode=E2EE` и `POST /workspaces/{id}/chats` в E2EE-воркспейсе → `409 E2EE_DISABLED`; ничего не создаётся.
2. Бейдж E2EE/иконка замка не показываются, если crypto-слой не активен; UI-текст «появится позже» недостаточен.
3. Уже существующие E2EE-чаты (если появились в тестовом воркспейсе) **не** переводятся в MANAGED и **не** принимают plaintext: `422 E2EE_PLAINTEXT_FORBIDDEN`. Флаг не является downgrade-механизмом.
4. После включения флага сервер обязан отклонять plaintext в E2EE (P0-3/P1-4) и включить `MODE_CHANGE_FORBIDDEN`.
5. Тест: feature-flag matrix (workspace/chat/message), затем повтор с флагом on.

Порядок миграции: (1) контракт + схемы БД; (2) backend endpoints; (3) frontend crypto core; (4) feature flag off до review; (5) включение для тестового воркспейса; (6) включение по умолчанию после review.

---

## 7. Verification

### 7.1. Fingerprint устройства

```
FP = SHA-256("Krug/E2EE/v1/fingerprint" || IK_sig_pub || IK_dh_pub)   // 32 байта
```

- `FP` — 43 символа `b64u` для UI; hex — для логов тестов (не для production-логов).
- Вектор **G1**: Alice `271774bc…2071`, Bob `42a86933…9668`.
- Fingerprint хеширует обе identity-пары; подмена одной меняет FP. Но FP **не доказывает владение**: его может посчитать кто угодно. Владение доказывает `identity_binding_signature` (B5), проверяемая отдельно; в UI показывайте FP только после проверки binding.
- `identity_binding_signature` **не входит** в FP (иначе смена формата сломала бы G1/QR). Binding — отдельный чек-лист §3.3.1.

### 7.2. Safety number (на пару устройств)

Почему на пару, а не на пользователя: каждое устройство — отдельный ключевой набор; пользователь с 5 устройствами имел бы 25 пар. Per-device-pair даёт точную привязку «это то устройство, с которым я сейчас говорю», и совпадает с серверной моделью `key_verifications(verifier_device, target_device, chat)`. Это отличается от Signal (per-user) и является решением **E2EE-ADR-05**.

**Verification тоже на пару устройств (P0-1).** Safety number пары `(L, P)` — не свойство пользователя Alice. Если Alice сверила Bob на ноутбуке L, её телефон L2 имеет **другие** digits для пары `(L2, P)` и обязан видеть `verified=null`. Поэтому `VH` v2 включает `verifier_device_id`, а `verified` читается/пишется только для устройства из `X-Device-Id`.

Алгоритм:

1. Для пары устройств `(D1, D2)` (моё и собеседника в данном чате) взять записи:
   `entry = user_id(16) || device_id(16) || fingerprint(32)` — **64 байта** (P2-5: в S3 было ошибочно «80»; формула и вектор G2 всегда были 64).
2. Отсортировать две записи лексикографически по bytes (порядок не зависит от того, кто считает).
3. `digest = SHA-512(D_SN || u8(1) || u32(2) || entry1 || entry2)`.
4. `digits = decimal(bigint(digest) mod 10^60)`, дополнить ведущими нулями до 60.
5. Показать 12 групп по 5 цифр: `96664 14478 17221 34154 65605 80530 88349 50840 93893 63409 48675 01952` (contiguous `966641447817221341546560580530883495084093893634094867501952`).

Вектор **G2**: digits выше, SHA-512 `2a57cdb6…5380`; **G3** — после смены identity у Bob digits меняются.

Свойства:

- Симметрично: обе стороны видят одинаковые цифры.
- Меняется при смене любого из двух ключей (identity signing или DH) любого из двух устройств.
- Не является секретом; безопасность — в сравнении по независимому каналу.
- 60 цифр ≈ 199 бит; коллизии пренебрежимы.

### 7.3. QR

```
krug://verify/v1?dev1=<uuid>&fp1=<b64u32>&dev2=<uuid>&fp2=<b64u32>
```

- `dev1 < dev2` лексикографически (стабильный порядок); `fp` — fingerprint соответствующего устройства.
- Сканирующая сторона проверяет: оба `device_id` совпадают с локальными (моё и peer), `fp` совпадают с локально вычисленными; иначе — warning, не «verified».
- Вектор **G2** содержит `qr_payload` с Alice/Bob.

### 7.4. Что хранит сервер

| Данные | Хранение | Комментарий |
|---|---|---|
| identity/SPK/OPK public keys, `identity_binding_signature` | `auth.devices`, `auth.device_prekeys` | Публичные; нужны для claim; binding проверяется сервером и клиентом. |
| `safety_number_hash` | `auth.key_verifications` | 32 байта; **сервер не хранит digits** (но может пересчитать из публичных ключей). |
| `verifier_user_id`, **`verifier_device_id`**, `target_device_id`, `chat_id` | там же | `verified` привязан к verifier device (P0-1). |
| `method`, `verified_at`, `target_key_generation` | там же | Для reset при смене ключа/revoke. |
| digits / QR / private keys | **не хранит** | Только клиент. |

Сервер **может** пересчитать safety number из публичных ключей (они у него есть) и сравнить с hash; это не даёт ему новых секретов. Hash — attestation, а не секрет. Клиент не должен считать серверный `verified` доказательством: при подмене ключей сервером клиент увидит несовпадение цифр у собеседника, а не серверный флаг. Формулировка «сервер не знает digits» **неверна** (P2-5): правильно — «сервер не хранит digits».

`verification_hash` v2 (то, что клиент отправляет):

```
SHA-256(D_VER || u8(2) || chat_id(16) || verifier_user_id(16) || verifier_device_id(16) ||
        target_device_id(16) || u32(target_key_generation) || ascii(digits_60))
```

Вектор **G4**: hex `6badfd8f…772c`, b64u `a639j3e3UKjX72RR6iah3nsHX4ldyObjltEvXtcLdyw`; **G5** — второе устройство-верификатор даёт другой hash и `verified=null`. Значения `VH` с `u8(1)` (старая редакция) недоверенны и не переносятся.

### 7.5. Key change warning и сброс

Клиент хранит локально `(user_id, device_id) -> {IK_sig, IK_dh, identity_binding_signature, fingerprint, key_generation, first_seen, verified, verified_at, pin_source}`. Пиннинг ведётся **по `device_id`**, не по `user_id` (P0-2).

| Событие | Детект | UI | Сервер |
|---|---|---|---|
| Новое устройство peer (новый `device_id`) | `device_id` нет локально | «Устройство добавлено», safety number для него не сверен; TOFU-пин создан | `chat.keys.changed` `DEVICE_ADDED` |
| **Key change того же `device_id`** (TOFU mismatch) | `IK_sig`/`IK_dh`/binding/fingerprint ≠ пин | Красный banner «Ключ безопасности изменился», отправка **заблокирована** до явного подтверждения; сессия не создаётся/не перезаписывается; OPK не расходуется | `409 KEY_CHANGED`, `chat.keys.changed` `IDENTITY_KEY_CHANGED`; алерт пользователю |
| Устройство отозвано | `status=REVOKED`/событие | «Устройство удалено»; сессия удалена; проверка target сброшена | `DEVICE_REVOKED`, `key_generation++`, verification rows target → `revoked_at` |
| Verification потеряна | `verified=false/null` после смены generation/revoke | «Нужна повторная сверка» | `verification.revoked_at`; другие verifier devices не затронуты |
| Другое устройство верификатора | `verified` читается для `X-Device-Id` | «Сверено на другом устройстве» (информационно), не замочек | `verified=null` для текущего устройства |

Правила:

- После key change **нельзя** автоматически доверять новому ключу: требуется явное «Принять новый ключ» + повторная сверка; до этого отправка на устройство блокируется.
- Старые сообщения, уже расшифрованные, остаются; новые — только после подтверждения.
- Server-side `verified` сбрасывается при `key_generation++`, revoke и TOFU mismatch; клиентский локальный fingerprint — независимый источник истины. **Сброс касается только строк target-устройства; verified других устройств-верификаторов не наследуется и не сбрасывается чужим действием.**
- При revoke устройства собеседника safety number для него больше не показывается; история остаётся, но новые сообщения на это устройство не идут. Локальная копия своих старых сообщений сохраняется.
- Пиннинг удаляется только вместе с устройством (revoke) или явным действием пользователя «забыть устройство»; автоматическая очистка по TTL запрещена — иначе TOFU-защита деградирует до «доверяй первому ключу после простоя».

### 7.6. Что verification **не** доказывает

- Не доказывает, что собеседник — «тот человек»; только что ключи совпали по независимому каналу.
- Не доказывает владение ключами само по себе: `identity_binding_signature` доказывает связь `IK_sig→IK_dh`, но атакующий может сгенерировать свою пару и валидную самоподпись. От подмены **пары** защищают TOFU-пин + safety number.
- Не защищает от malicious server, который подменил ключи **до** первой сверки/первого контакта (TOFU-окно). Первый контакт всегда уязвим; честный UI обязан это говорить.
- Не защищает от key transparency-атак без KT v2; сервер может показать разные ключи разным клиентам, и пользователь заметит только при сравнении.
- Не отменяет компрометацию устройства: если устройство заражено, ключи и plaintext доступны атакующему.
- QR/цифры можно сфотографировать/переслать; сравнение должно идти по доверенному каналу; QR не ставит `verified` автоматически по deeplink.
- Не защищает от понижения `security_mode` malicious-сервером: клиент увидит расхождение с пином и заблокирует отправку, но гарантии «сервер не попытается» нет — серверный immutability trigger защищает только честную БД.
- **Fresh-device/cleared-profile (P1-G):** без локального пина режима клиент не может доказать, что чат был E2EE. Он **не** отправляет plaintext молча: при признаках E2EE (`ChatSummary.peer_has_e2ee_capable_devices=true`, workspace/история E2EE, локальный маркер) — `BLOCK_SEND_SECURITY_ALERT`; при чистом managed — explicit mode confirmation. Разрешены только `E2EE_ONLY` (**или новый managed-чат**); **in-place downgrade текущего чата запрещён** (§6.2.8 п. 3(б), J3) — это не «решение пользователя», а атака, которую спека не легитимизирует. Остаточный риск: malicious-сервер может выдать MANAGED для чата, о котором у нового устройства нет памяти; server-signed mode attestation — v2 (§9.6).

---

## 8. Test vectors

### 8.1. Файл и статус

[`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>):

- **18 секций, 48 векторов** (`vector_set_version=4` + AAD-addendum E7-F2G); 17 секций нормативные, `H-sender-key` — информативная (группы вне E7). **345 проверок** базового v4-набора, 0 failures; O-секция проверяется `kStorageKAT.test.ts`.
- Все значения — точные, сгенерированы reference-реализацией (Python) и **независимо** перепроверены второй реализацией (Node.js).
- Приватные ключи в файле — публичный тестовый материал; использовать только в тестах.
- Envelope wire format не менялся (`v=1`); G4 пересчитан под `VH` v2; E1/E2 `header` дополнены `v=1` (байты не изменились). В S3 I1/I2 `presented_*`/`pinned_identity_binding_signature` перекодированы из hex в wire-b64u64 (те же 64 байта); значения fingerprint/SN не менялись (P1-E).
- S3 добавил I3 (prekey↔registered/bundle identity, P0-2b), J3 (fresh-device mode, P1-G), M1/M2 (peer coverage, P1-B), L3 (multi-message reset, P1-C), N1/N2 (revoked idempotency/legacy addressability, P2-4/P2-5), R1 (`reply_to_id`, P1-F), S1 (FS/PCS window, P1-D).
- **S4 (review-03)** добавил M3 (legacy-устройство не покрытие, P1-B-1) и L3b (частичная доставка: reset не дублирует расшифрованное, P1-C-1); перекодировал `B3/B4.expected.signature` в wire-b64u64 (`signature_hex` — байтовый KAT, P2-6); пересобрал L1 с `failed_chain_dh` (теперь L1 — точный фрейминг reset из L3b); исправил «80 байт» в G2 на 64 (P2-5). Значения fingerprint/SN/A–H не менялись; `envelope.v=1`.

| Секция | Векторы | Что фиксирует |
|---|---|---|
| A-primitives | A1–A4 | Опубликованные KAT: RFC 7748 X25519, RFC 8032 Ed25519, RFC 5869 HKDF, NIST AES-256-GCM. |
| B-x3dh | B1–B5 | 4DH/3DH SK, SPK-подпись, преамбул + подпись, **B5 IK binding** (P1-2). |
| C-kdf | C1–C3 | session_id, root step, цепочка message keys. |
| D-aead | D1–D3 | фрейминг/padding, AEAD prekey-сообщения, AEAD n=1. |
| E-double-ratchet | E1 | полный диалог 4 сообщения, 2 DH-ratchet turn. |
| E2-skipped-keys | E2 | out-of-order: m1, m3, затем m2; skipped key n=1. |
| F-envelope | F1–F2 | JSON-конверт с prekey и без; header/AD hex. |
| G-verification | G1–G5 | fingerprint, safety number, key change, **VH v2**, **G5 per-verifier-device** (P0-1). |
| H-sender-key | H1–H2 | **informative**: цепочка sender key и AEAD (для будущих групп). |
| I-tofu | I1–I3 | первый контакт (TOFU pin), **negative TOFU mismatch** (P0-2) и **prekey sender identity mismatch** (P0-2b); wire-валидные b64u64 binding. |
| J-security-mode | J1–J3 | downgrade → 409/блокировка; flag-off; **fresh-device MANAGED без пина → block, 0 plaintext** (P0-3/P1-12/P1-G). |
| K-client-message-id | K1–K2 | replay своим отправителем; cross-user тот же UUID → 409 (P1-10). |
| L-session-reset | L1–L3b | `content_type=2 SESSION_RESET`: framing (L1 c `failed_chain_dh`), state machine (L2), **multi-message reset** (L3) и **частичная доставка без дублей** (L3b, P1-C-1). |
| M-envelope-coverage | M1–M3 | `peer_covered==0` → 409; partial coverage → warning; **legacy-устройство не покрытие** (M3, P1-B-1). |
| N-device-registration | N1–N2 | REVOKED + тот же IK → 410; `E2EE_LEGACY_DEVICE` достижим на prekeys (P2-4/P2-5). |
| R-plaintext-fields | R1 | верхнеуровневый `reply_to_id` в E2EE → 422; внутри inner payload разрешён (P1-F). |
| S-fs-pcs | S1 | SPK 3/90 дней, уничтожение OPK/DHs, PCS не мгновенный (P1-D). |
| O-kstorage-aad | O1–O3 | **E7-F2G:** 50-байтовая AAD `K_storage` + AES-GCM KAT (P1-07), nil/zero инъективность (P1-07) и слоты `pin`/`keyChange`/`modePin` (P2-18). |

**Границы применимости новых секций.** I/J/K/L/M/N/R/S — нормативные **conformance**-векторы: I содержит полный крипто-транскрипт (X3DH, преамбул, подпись, AD, AEAD, fingerprint, safety number), остальные фиксируют API/state-семантику и проверяются backend/contract/E2E-тестами, а не KAT-примитивами. Это не «примерные значения»: ожидаемые коды/булевы значения обязательны. M1/N/R/S не несут ciphertext by design (server/state decision), M2 встраивает wire-валидный F1-конверт.

### 8.2. Как сгенерировано и проверено

- Генератор: Python 3.14.6 + `cryptography 49.0.0`; полный исходник S2 — в [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §9.1; S3-патч — §10.2; **S4-патч** (детерминированная постобработка v3 + M3/L3b/B3/B4/L1) — **§11.2**.
- Проверка: Node.js 24.20.0, независимые `node:crypto` (X25519/Ed25519/HKDF/HMAC) и WebCrypto (AES-256-GCM); верификатор v4 = notes **§10.3 + §11.3 delta**.
- Результат: **345 checks, 0 failures**. Команды:

```bash
# 1) сохранить генератор S2 из E2EE-SPIKE-NOTES.md §9.1
python3 gen_e2ee_vectors_s2.py
# ожидаемо: written; vectors: 34 sections: 13
#          SK: bbaf2376…d9d5
#          SID: 86c68f64…1f5e
#          safety digits: 966641447817221341546560580530883495084093893634094867501952
#          ct1: f5111968…9732 len 272
#          env1 len 1310

# 2) сохранить S3-патч из §10.2 и применить (перезаписывает docs/E2EE-TEST-VECTORS.json)
python3 gen_e2ee_vectors_s3.py
# ожидаемо: S3 patch written; vectors: 43 sections: 17
#          I1 binding: 611ZRX0_…gdNCAA (86 chars, 64 bytes)

# 3) сохранить S4-патч из §11.2 и применить (вход — закоммиченный v3)
python3 gen_e2ee_vectors_s4.py
# ожидаемо: S4 patch written; vectors: 45 sections: 17
#          B3 wire: wjk09AvS…_WdDw
#          L1 padded: 256 sha256: 1e6a4d9880c710c9c1c4faae0913e78244d08c036a077b7fdae000e1cb87f4fe

# 4) независимый верификатор v4 (§10.3 + §11.3)
node verify_e2ee_vectors_s4.mjs docs/E2EE-TEST-VECTORS.json
# ожидаемо: 345 checks, 0 failures

# 5) детерминизм (повтор 3–4 на копии v3)
cmp docs/E2EE-TEST-VECTORS.json /tmp/repro/docs/E2EE-TEST-VECTORS.json
# IDENTICAL; sha256 2d69c941f892a2f1ed4469d6f1a7b0ccabbf678c07faf44a949b9ed19a0a9c26
```

Верификатор v4 **не использует** код генератора и проверяет: A1–A4 (RFC/NIST), B1–B5 (+ wire-b64u64 B3/B4 и Ed25519-verify по `signature_hex`), C1–C3, D1–D3, E1 (полная DR-симуляция, включая r2), E2, F1–F2 (+ равенство `F1.prekey.signature == B4.signature`), G1–G5 (+ entry = 64 B), I1–I3 (расшифровка «валидного, но чужого» prekey-конверта, TOFU-решение и prekey↔registered mismatch), J1–J3, K1–K2, L1–L3b (пересчёт фрейминга L1 и окно/дедуп L3b), M1–M3 (legacy не покрытие), N1–N2, R1, S1, `meta.normative_invariants`, `meta.limits` (DB cap 33040 = canonical) и structural-инварианты. Generation без верификатора не считается доказательством.

Почему это не «примерные значения»:

- X25519/Ed25519/HKDF/AES-GCM примитивы сверены с **опубликованными** векторами (RFC/NIST) — это внешний источник истины.
- Композитные векторы (X3DH, DR, envelope, safety number) вычислены reference-реализацией и перепроверены второй, независимой реализацией на другом стеке; расхождение хотя бы в одном байте ломает проверку.
- Верификатор проверяет не только «значение совпало», но и расшифровку AEAD, целостность ratchet-цепочек и подписей.

### 8.3. Как использовать в тестах

| Тест | Векторы | Минимум |
|---|---|---|
| TS unit: primitives | A1–A4 | Каждый примитив через WebCrypto; сравнить hex. |
| TS unit: X3DH | B1–B5 | SK, session_id, преамбул, подпись, IK binding; отдельно 3DH. |
| TS unit: DR | C1–C3, E1, E2 | Воспроизвести состояния и ciphertext; проверить skipped keys. |
| TS unit: AEAD/framing | D1–D3 | Padding, nonce, AD, tag; tamper → reject. |
| TS unit: envelope | F1–F2 | Парсинг/сериализация полей; AD/header; b64url canonical. |
| TS unit: verification | G1–G5 | FP, digits, QR, VH v2, per-device verified; смена ключа → другие digits. |
| TS unit: TOFU | I1–I3 | pin создаётся; mismatch → `KEY_CHANGE_DETECTED`; prekey↔bundle/registered mismatch → `KEY_HANDSHAKE_INVALID` (P0-2b); нет сессии/OPK/display. |
| Backend conformance | J1–J3, K1–K2, M1–M3, N1–N2, R1 | mode immutability/fresh-device block, flag-off, client_message_id scope/replay, peer coverage **только по capable** (legacy envelope → 422), registration semantics, reply_to_id rejection. |
| TS unit: reset | L1–L3b | content_type=2 framing с `failed_chain_dh`/`failed_n`; reset только в prekey-конверте; новый `client_message_id` для сообщений **от якоря и позже**; повторный reset не перешифровывает окно (дедуп по `(session, failed_chain_dh, failed_n, anchor)`); L3b receiver-дедуп — v1.1. |
| Property/storage | S1 | после ratchet/ротаций в IndexedDB нет старых DHs/SPK/OPK; удалённый SPK → reset. |
| Java DTO/validation | F1, B3, B4, B5 | Длины/base64/поля; binding; сервер не должен «понимать» ciphertext. **Подписи — wire-поля:** `B3.expected.signature`/`B4.expected.signature` — b64u64 (86 симв.), их и подавать в `SignedPrekey.signature`/`PrekeyBlock.signature`; 128-hex (`signature_hex`) — только для байтового KAT, в wire-DTO не попадает (P2-6). |
| Playwright/browser | A1–G5, I1–I2, L1 | Тот же JSON в браузере (WebCrypto отличается от Node в деталях). |

Рекомендуемая структура (не создаётся в этом spike):

```
frontend/src/crypto/__tests__/vectors.test.ts
frontend/src/crypto/__tests__/x3dh.test.ts
frontend/src/crypto/__tests__/doubleRatchet.test.ts
frontend/src/crypto/__tests__/envelope.test.ts
frontend/src/crypto/__tests__/safetyNumber.test.ts
backend/src/test/java/.../E2eeEnvelopeValidationTest.java
```

### 8.4. Негативные/ tamper-тесты (обязательны, не входят в JSON)

| Тест | Ожидание |
|---|---|
| Изменить 1 байт `ciphertext` | AEAD fail (`DECRYPT_FAILED`), состояние не сдвинуто; для prekey — reset-сигнал. |
| Подменить `IK_sig`/`IK_dh` для существующего `device_id` при валидной подписи/AD/AEAD | `KEY_CHANGE_DETECTED` (I2), нет сессии/OPK/display, отправка заблокирована. |
| Подменить **только** `prekey.sender_identity_*` новыми ключами при честных `auth.devices`/bundle (валидная подпись/AD/AEAD) | сервер `422 INVALID_ENVELOPE_FORMAT`; клиент `KEY_HANDSHAKE_INVALID`; нет сессии/OPK/display (I3, P0-2b). |
| E2EE `POST /messages` с верхнеуровневым `reply_to_id` | `422 E2EE_PLAINTEXT_FORBIDDEN`; DB CHECK (R1, P1-F). |
| `peer_devices>0`, но ни одного конверта собеседнику | `409 E2EE_NO_PEER_ENVELOPE`; `seq` не выделен (M1, P1-B). |
| Валидная binding-подпись, но `IK_dh` подменён | `422 INVALID_IDENTITY_BINDING` (B5), handshake отклонён. |
| Первый контакт с подменённой парой | TOFU-пин создаётся, сообщение помечено «не сверено»; честный warning (I1). |
| Изменить 1 байт `AD` (chat/device/generation/header) | AEAD fail. |
| Изменить `session_id` | Нет сессии; при prekey — `KEY_HANDSHAKE_INVALID`. |
| Изменить `header.n` на уже использованный | `DUPLICATE_OR_OLD_MESSAGE`. |
| `n` больше `Nr + 1000` | `SESSION_TOO_FAR_BEHIND`, ключи не создаются. |
| Подменить `prekey.signature` | `KEY_HANDSHAKE_INVALID`, OPK не расходуется. |
| Подменить `spk_public`/`opk_public` | `KEY_HANDSHAKE_INVALID`. |
| Два конверта одному устройству | `422 DUPLICATE_ENVELOPE`. |
| Конверт отозванному устройству | `422 UNKNOWN_DEVICE`, сообщение не создано. |
| `text` в E2EE | `422 E2EE_PLAINTEXT_FORBIDDEN`. |
| `reply_to_id` в E2EE | `422 E2EE_PLAINTEXT_FORBIDDEN`; DB CHECK (R1). |
| `peer_devices>0`, `peer_covered==0` | `409 E2EE_NO_PEER_ENVELOPE`, нет `Message`/`seq` (M1). |
| Envelope на legacy-устройство (ACTIVE, без ключей) | `422 E2EE_LEGACY_DEVICE`, нет `Message`/`seq`, нет частичного fan-out; legacy не увеличивает `peer_covered` (M3, P1-B-1). |
| Повтор уже расшифрованного сообщения после reset (`retry_of_client_message_id` в TEXT, v1.1) | Молча отброшено: 0 UI-дублей, 0 unread, 0 уведомлений (L3b). Маркер есть в v1.1; `vector_set_version=5`. |
| `PUT verification` с `vh_version:1` | `422 VH_VERSION_UNSUPPORTED` (P2-2). |
| Повтор `POST /devices` с IK отозванного устройства | `410 DEVICE_REVOKED`; нет реактивации (N1). |
| `POST /devices/{id}/prekeys` для legacy | `422 E2EE_LEGACY_DEVICE`; claim → `NO_KEYS` (N2). |
| `envelopes` в managed | `422 ENVELOPES_NOT_ALLOWED`. |
| Non-canonical base64 (`=`, `+`, `/`) | `422 INVALID_ENVELOPE_FORMAT`. |
| `ciphertext` decoded 33041 B / encoded 44055 / body 524289 B | `413` (`details.reason="canonical"`/`"form"`/`PAYLOAD_TOO_LARGE`); границы 272/33040/44054/524288 → accept; DB CHECK хранит только 272..33040 (P2-11). |
| 9 и 10 канонических конвертов | 405098/450099 B wire < 524288 → 201; decoded-счётчик не используется. |
| 10 конвертов по 44054 encoded (канонический максимум) | 450099 B < 512 KiB → 201; 10 × form guard (65536) > 512 KiB → `413 PAYLOAD_TOO_LARGE` (guard не бюджет). |
| `UPDATE security_mode` / смена через upsert | `409 MODE_CHANGE_FORBIDDEN`, режим не изменён (J1). |
| E2EE workspace при flag off | `409 E2EE_DISABLED`, бейджа нет (J2). |
| Тот же `client_message_id` другим пользователем | `409 CLIENT_MESSAGE_ID_CONFLICT`, не replay (K2). |
| У получателя 0 capable-устройств | `409 E2EE_NO_ACTIVE_DEVICES`, сообщение не создано (P1-7). |
| Prekey-конверт не расшифрован (SPK удалён) | `SESSION_RESET` (content_type=2), новый claim, новый `client_message_id` (L2). |
| Crash между commit и send / после send | outbox повторяет те же bytes; сообщение не теряется; нет перешифрования. |
| Очистить локальный кэш | своё сообщение «недоступно на этом устройстве», факт отправки виден. |
| Повтор `POST /messages` с теми же bytes | Тот же `seq`, `Idempotent-Replay: true`. |
| Повтор с другим body и тем же `Idempotency-Key` | `409 IDEMPOTENCY_KEY_REUSED`. |
| Повторный claim | Новый OPK/`otp_exhausted`; старый не выдаётся. |
| OPK consumed дважды (гонка) | Ровно один bundle получает OPK. |
| `DELETE /devices/{id}` | `key_generation++`, WS закрыт, envelopes отклоняются. |
| Логи | Нет ciphertext/plaintext/keys; только ids/размеры. |
| Поиск/DLP в E2EE | `409 MODE_NOT_SUPPORTED`. |
| Break-glass в E2EE | `409 BREAKGLASS_NOT_ALLOWED`. |

### 8.5. Покрытие acceptance E7

| AC | Векторы/тесты |
|---|---|
| E2EE-AC-01 Device keys | B3, B4, F1; backend: private keys не принимаются, SPK signature invalid → 422. |
| E2EE-AC-02 1:1 send | B1/B2, D2/D3, F1/F2; backend: envelopes stored, text null. |
| E2EE-AC-03 Decrypt + safety number | E1, E2, G1–G4; frontend KAT + E2E. |
| E2EE-AC-04 Key change | G3; `chat.keys.changed`, verified reset (per target device). |
| E2EE-AC-09 TOFU pinning + prekey binding | I1–I3; mismatch с пином блокирует сессию/отправку; prekey↔registered/bundle → `KEY_HANDSHAKE_INVALID` (P0-2b); E2E «L1 verified, L2 null» (G5). |
| E2EE-AC-10 Mode immutability / fresh device | J1–J3; 409 на downgrade; flag-off 409; fresh-device MANAGED без пина → block, 0 plaintext; plaintext в E2EE → 422. |
| E2EE-AC-11 Own-copy durability | crash-recovery property: kill tab между send/cache-write → после reload сообщение читается; clear cache → `unavailable` + факт отправки. |
| E2EE-AC-12 R-15 no silent loss + FS | L1–L3b (multi-message reset + частичная доставка без дублей), S1 (FS/PCS window); удалить приватный SPK → reset → недоставленные сообщения доходят, расшифрованные не дублируются; storage-scan без старых ключей. |
| E2EE-AC-13 Peer coverage | M1–M3; `peer_covered==0` → 409; partial → warning; legacy-устройство не покрытие и не кандидат; UI не врёт о доставке (P1-B/P1-B-1). |
| E2EE-AC-14 Device registration | N1–N2; REVOKED IK → 410; legacy prekeys → 422 `E2EE_LEGACY_DEVICE`; claim legacy → `NO_KEYS` (P2-4/P2-5). |
| E2EE-AC-15 No plaintext fields | R1; `reply_to_id`/text/sticker/attachments в E2EE → 422; клиент игнорирует server `text` при `crypto:null` (P1-F/P2-13). |
| E2EE-AC-05 Revoke | backend revoke test; gen++, envelopes rejected, WS closed. |
| E2EE-AC-06 No server search/plugins | API 409; log/DB assertions; no plaintext columns. |
| E2EE-AC-07 Multi-device | fan-out test N devices; каждый конверт адресный; coverage. |
| E2EE-AC-08 Logs/DB | log scrubber test; DB scan for plaintext/keys. |

### 8.6. Ограничения векторов

- Не покрывают WebCrypto-специфику (non-extractable keys, structured clone, Safari/Firefox quirks) — это E2E-тесты.
- Не покрывают гонки multi-tab, persistence, crash-recovery — property/integration тесты. P0-4 **не** доказывается вектором: нужен crash-recovery E2E.
- Sender key — informative; не использовать как E7 acceptance. Домены H (`sender-*`) не входят в реестр §1.4.
- J/K/L/M — conformance, а не крипто-KAT; они проверяют коды/состояния, а не байты AEAD. L3b доказывает **отсутствие дублей по UI-семантике**, а не криптографию: для него нужен integration/E2E-тест «B расшифровал 2 из 5 → reset → 0 дублей».
- Векторы не заменяют внешний crypto-review: они ловят регрессии, а не ошибки дизайна.
- `meta.limits` — расчётные значения; физический замер на прокси/ingress обязателен в G1/G2.

---

## 9. Threat model и что мы не обещаем

### 9.1. Что видит сервер

| Данные | Видимость | Комментарий |
|---|---|---|
| Текст, reply, inner payload | **Нет** | Только ciphertext. |
| Имена файлов/MIME/содержимое | **Нет** | Файлы E2EE вне E7. |
| Участники, чат, время, `seq` | Да | Метаданные. |
| Размер сообщения, число конвертов | Да | По ciphertext/заголовкам. |
| `sender_device_id`, `recipient_device_id`, `session_id` | Да | Нужны для маршрутизации; `session_id` **не логируется** (стабильный коррелятор). |
| `key_generation`, prekey ids | Да | Публичные метаданные. |
| Identity/SPK/OPK public keys | Да | Публичные по дизайну. |
| Safety number hash, verified | Да | Метаданные сверки; `verifier_device_id` виден; digits сервер **не хранит** (но может пересчитать из публичных ключей). |
| IP, user-agent, device_id, время | Да | Retention 90 дней (политика). |
| Приватные ключи, SK/RK/CK, plaintext, локальная копия | **Нет** | Никогда не покидают устройство; копия/outbox — только IndexedDB с `K_storage`. |

### 9.2. Угрозы и контрмеры

| ID | Угроза | В scope? | Контрмера | Остаточный риск |
|---|---|---|---|---|
| T-E2EE-01 | Пассивный перехват сети | Да | TLS 1.3 + E2EE | Метаданные. |
| T-E2EE-02 | Active MITM с валидным CA | Да | Safety number/QR; TOFU-пин; KT v2 | Пользователь не сверяет; первый контакт уязвим. |
| T-E2EE-03 | Malicious server подменяет ключи | Частично | **TOFU-пин по device_id** + key change warning + safety number; binding-подпись; KT v2 | До первого контакта/сверки; нет KT v1. |
| T-E2EE-04 | Компрометация сервера/БД | Да | Только ciphertext; нет ключей | Метаданные; размеры/тайминг. |
| T-E2EE-05 | Компрометация устройства | **Нет** | DR PCS после DH-ratchet (нужен обмен), revoke | Всё, пока устройство заражено; keylogger; PCS не мгновенный. |
| T-E2EE-06 | Украденное/потерянное устройство | Частично | Revoke, короткие токены, keychain | До revoke; старая история на устройстве. |
| T-E2EE-07 | Скриншоты/пересылка | **Нет** | — | Получатель может сохранить/переслать. |
| T-E2EE-08 | Анализ метаданных | Частично | Минимизация, retention | Кто/когда/размер/устройства. |
| T-E2EE-09 | Replay/rollback | Да | `seq`, counters, AEAD, idempotency, `client_message_id` scope по sender | Ошибка клиента/сервера. |
| T-E2EE-10 | OPK exhaustion | Да | Rate limit, replenish, 3DH fallback + warning | FS слабее; DoS участником чата. |
| T-E2EE-11 | Randomness failure | Да | CSPRNG, KAT, review | Компрометация RNG = катастрофа. |
| T-E2EE-12 | State rollback/clone | Частично | Persist-before-send, **атомарная локальная копия**, Web Locks, no backup v1 | Восстановление старого состояния = reuse MK; потеря копии = потеря своих сообщений. |
| T-E2EE-13 | XSS/вредоносное расширение | **Нет** | CSP, SRI, non-extractable keys | JS в origin может использовать ключи. |
| T-E2EE-14 | Supply chain | Частично | lockfile, SBOM, review | Вредоносная зависимость. |
| T-E2EE-15 | Принуждение/legal coercion | **Нет** | Нет escrow, ключи на устройстве | Могут заставить разблокировать устройство. |
| T-E2EE-16 | Квантовый противник | **Нет** | — | Harvest-now-decrypt-later; PQ v2+. |
| T-E2EE-17 | Malicious server не доставляет конверты | Частично | coverage, мониторинг | Сервер может врать или не доставлять конверты; KT/аудит v2. |
| T-E2EE-18 | Подмена OPK | Частично | SPK подпись, safety number | DoS расшифровки, не конфиденциальность. |
| T-E2EE-19 | **Downgrade `security_mode`** (сервер/ошибка/админ) | Да | Серверный immutability trigger + `409`; клиентский пиннинг режима; plaintext не отправляется | Клиент может принять решение «сменить режим» только явно и с новым чатом; malicious-сервер может врать, но не заставит отправить plaintext. |
| T-E2EE-20 | **Потеря локальной копии** (очистка профиля/краш) | Частично | Атомарная копия до send; outbox; нет self-envelope | Копия потеряна → своё сообщение недоступно; у получателя остаётся. Backup v2. |
| T-E2EE-21 | **Спуфинг R-15 reset** | Да | Reset только зашифрованным `content_type=2` в prekey-конверте; rate limit | Поддельный reset требует валидной сессии/ключей; иначе отбрасывается. |

### 9.3. Явные non-goals (что не обещаем)

- Защиту от компрометации разблокированного устройства, кейлоггера, вредоносного ПО, screen capture.
- Защиту от скриншотов, пересылки, копирования получателем.
- Анонимность: сервер видит участников, время, размеры, IP, device_id; sealed sender — v2.
- «Военную» стойкость против целевых атак с физическим доступом.
- Ретроактивный отзыв уже доставленных сообщений/ключей.
- Защиту от принудительного раскрытия ключей (legal coercion); key escrow отсутствует.
- Квантовую стойкость (X25519/Ed25519 не PQ; PQ — v2+).
- Восстановление истории без backup v1; потеря всех устройств = потеря истории. **Своя локальная копия — не backup**: очистка профиля уничтожает её, и self-envelope её не восстанавливает.
- Защиту от кражи профиля браузера/диска: `K_storage` не at-rest-шифрование (P1-11), пароля/unlock в v1 нет.
- Понижение `security_mode` — это **атака**, а не конфигурация. Мы не обещаем, что malicious-сервер не попытается; мы обещаем, что клиент не отправит plaintext **при наличии пина/признаков E2EE** и покажет alert. На **новом устройстве/после очистки профиля** пина нет: клиент блокирует отправку и требует явного решения (`E2EE_ONLY` **или новый managed-чат**; **никогда** in-place downgrade — §6.2.8 п. 3(б), J3), но доказать «чат был E2EE» без server-signed attestation v2 не может — это остаточный риск, а не гарантия.
- Серверный поиск, DLP, AV, серверные плагины/боты в E2EE — **невозможны by design**, а не «недоделка».
- Push с текстом в E2EE — по умолчанию нет (ADR-15); только «новое сообщение».
- Мгновенный отзыв ключей у устройства, которое уже получило сообщение.
- Защиту от malicious server, который подменяет ключи до первой сверки (TOFU-окно) или не доставляет сообщения.
- Per-user safety number, cross-signing, key transparency — v2.
- E2EE-группы, файлы, стикеры, звонки — следующие фазы.
- Deniability: подпись handshake привязывает устройство к установлению сессии; сами сообщения не подписаны, но полная отрицаемость handshake не обещается.
- Редактирование/удаление E2EE-сообщений, реакции и пины в E2EE — вне E7; сервер не может перешифровать текст. Удаление в v1 — только tombstone без перешифровки (если будет поддержано), реакции — метаданные (Q-11).

### 9.4. Серверный поиск/плагины/DLP в E2EE

| Функция | E2EE | Почему |
|---|---|---|
| Серверный поиск | `409 MODE_NOT_SUPPORTED` | Нет ключа; индекс ciphertext бесполезен. |
| Локальный поиск | Да (клиент) | Индекс на устройстве; не кросс-девайс. |
| DLP/AV на сервере | `409 MODE_NOT_SUPPORTED` | Сервер не читает контент. |
| Серверные плагины/боты | `409 MODE_NOT_SUPPORTED` | Нет plaintext. |
| Клиентские плагины | Только с consent на чат | Plaintext в памяти хоста; риск. |
| Break-glass | `409 BREAKGLASS_NOT_ALLOWED` | Нет ключей. |
| Аудит контента | Только метаданные | — |
| Экспорт `/me/export` | Метаданные | Контент экспортирует клиент. |
| Push | Без текста | Third-party. |
| Уведомления in-app | `body=null` | Существующий контракт. |

### 9.5. Потеря ключей и backup

- v1: ключи только на устройстве; очистка профиля/потеря устройства = потеря истории и возможности читать старые сообщения. Локальная копия своих сообщений также теряется; это осознанное следствие отказа от self-envelope (P0-4).
- Backup v1 (вне E7): encrypted key bundle, ключ из Argon2id-парольной фразы (или WebAuthn PRF), сервер хранит opaque blob; без фразы восстановление невозможно. Требует отдельного review: backup — это второй экземпляр ключей, он расширяет поверхность атаки.
- Recovery-коды, social recovery, HSM-backed escrow — не в v1; key escrow противоречит модели.
- При восстановлении backup counters/ratchet state должны быть согласованы; восстановление старого state при активной сессии = reuse MK/nonce. Поэтому backup v1 должен либо запрещать запись со старых устройств, либо использовать новый `key_generation`/новые сессии.

### 9.6. Key transparency v2

- v1: TOFU + safety number. Сервер может показать Alice и Bob разные ключи; обнаружится только при сверке.
- v2: append-only KT log (Merkle tree) с публикацией commitment для `(user_id, device_id, IK_sig, IK_dh, generation)`; клиенты проверяют inclusion/consistency; gossip между контактами.
- До KT любые заявления «сервер не может подменить ключ» **неверны**; честная формулировка — «подмена обнаруживается при сравнении safety number».

### 9.7. Группы и sender keys (вне E7)

- Sender keys дают forward secrecy внутри цепочки, но **не** post-compromise security при компрометации участника: скомпрометированный участник может расшифровывать сообщения своей эпохи, пока ключ не ротирован.
- Ротация при изменении состава/revoke; мгновенный отзыв уже доставленных ключей невозможен.
- MLS (RFC 9420) — v2; E7 его не проектирует.
- Векторы H — informative, чтобы не менять формат при старте групп. Их домены (`sender-key`, `sender-ad`, `sender-aead-key`, `sender-aead-nonce`) **не входят** в реестр §1.4 и не являются частью v1; это зафиксировано в `meta.conventions.informative_domains` (P2-4).

### 9.8. Логи, retention, аудит

- Запрещено логировать: plaintext, ciphertext, ключи, prekeys, **`session_id`** (стабильный коррелятор сессии; P2-18), `safety_number_hash`, локальные копии. Допустимы `message_id`, `chat_id`, `device_id`, `client_message_id`, размеры.
- Разрешено: `request_id`, ids, action, latency, status, размер.
- Audit: метаданные (кто/когда/чат/размер/действие), без контента.
- Retention: сообщения — политика воркспейса; envelopes — вместе с сообщением; prekeys — TTL 30 дней; verification — до revoke/смены generation.
- Логи — 30 дней, аудит — 12 месяцев, метаданные соединений — 90 дней (политика).
- Тест: log assertion + DB scan на plaintext/ключи.

### 9.9. Юридическая рамка (кратко)

- Нет key escrow; сервер не может выдать контент по запросу, которого у него нет.
- Может быть обязан выдать метаданные и, при наличии, managed-контент (другой режим).
- Пользователь может быть принуждён разблокировать устройство; E2EE не защищает от этого.
- DPA/UI должны явно описывать, что E2EE-контент недоступен администратору, DLP и восстановлению, и **не** обещать at-rest-шифрование или защиту от кражи профиля (P1-11).
- Локальная копия и ключи находятся на устройстве; при запросе «выдайте переписку» сервер может выдать только ciphertext/envelopes и метаданные, но не plaintext.

---

## 10. План реализации

### 10.1. Разбивка E7-B (backend)

| ID | Работа | Дни | Зависимости |
|---|---|---|---|
| E7-B1 | Миграции V16+: devices (identity+binding+fingerprint, drop identity_public_key, `p_devices_chat_peer`), **create** device_prekeys + RLS/grants/claim-функция, messages CHECK по `crypto_scheme` + `reply_to_id IS NULL` + sender NOT NULL, **create** key_verifications с `verifier_device_id`/`vh_version`, `direct_key`, mode-триггеры, message_envelopes + RLS/grant, `ensure_partition` для **обеих** таблиц + стартовые партиции, переиндексация партиций по sender, явные GRANT для `krug_app` | 4 | контракт §6.3, P1-A |
| E7-B2 | Domain/application: DeviceKeyBundle VO, IdentityBinding, KeyGeneration, PrekeyId, DeviceKeyChanged, ModeImmutable; порты; регистрация с ключами/binding, natural key, лимит 5, REVOKED-IK → 410 | 3 | B1 |
| E7-B3 | API: `POST /devices` delta (binding, alg, приоритет идемпотентности, REVOKED 410, legacy→422), `GET /devices`, `DELETE /devices/{id}`, `POST /devices/{id}/prekeys` (X-Device-Id, legacy `E2EE_LEGACY_DEVICE`), `POST /keys/claim` (`chat_id`, member, атомарный consume, `unavailable` без `NOT_MEMBER`) | 3 | B2 |
| E7-B4 | Messages: `envelopes[]` validation, **wire 512 KiB до parse**, per-envelope canonical cap (33040/44054; 65536 — form guard), `recipient.e2ee_capable` (legacy → 422), read filter by `X-Device-Id`, `client_message_id` echo+scope, coverage peer/self **только capable**, `409 E2EE_NO_ACTIVE_DEVICES`/`E2EE_NO_PEER_ENVELOPE`, `warning=PEER_DEVICE_UNCOVERED`, `reply_to_id` reject, WS `crypto` | 3 | B1 |
| E7-B5 | `GET /chats/{id}/keys`, `PUT verification` (X-Device-Id, VH v2, `vh_version`), `chat.keys.changed`, verification reset per target device, `verified_count` per verifier | 2 | B2 |
| E7-B6 | `POST /workspaces/{id}/chats` (DIRECT/E2EE), no system messages, `direct_key` uniqueness, mode immutability, flag-off 409 | 2 | B2 |
| E7-B7 | Hardening/tests: migration V1–V15, opaque storage, no plaintext logs, revoke/generation, fan-out, idempotency, cross-user id → 409, downgrade → 409, limits boundaries, search 409, ArchUnit | 3 | B3–B6 |
| **Итого** | | **~21 dev-days** | |

Порядок: B1 → B2 → (B3 ∥ B4) → B5 → B6 → B7. B1/B4 можно начинать до crypto-review; B3 (claim) — после согласования API. S3 добавляет ~1–2 dev-days (grants/RLS/partitions, coverage, reply/revoked) к оценке S2.

### 10.2. Разбивка E7-F (frontend)

| ID | Работа | Дни | Зависимости |
|---|---|---|---|
| E7-F1 | Crypto primitives + KAT harness (A1–A4, C1–C3, D1), feature-detect WebCrypto, browser floor | 3 | спека §1–3 |
| E7-F2 | Key storage: non-extractable CryptoKey, IndexedDB, `K_storage`, session records, **outbox + локальная копия**, Web Locks, **уничтожение OPK/старых DHs/SPK (3/90)** | 4 | F1 |
| E7-F3 | Device registration/prekey upload/replenish, **identity_binding_signature**; `POST /devices` integration | 2 | F2, B3 |
| E7-F4 | X3DH + DR: handshake, send/receive, skipped keys, multi-session, **fresh `DHs_A`**, self-device fan-out, **TOFU-пиннинг**, **prekey↔bundle equality (P0-2b)** | 7 | F2, F3, B3 |
| E7-F5 | Message integration: envelopes, **атомарная копия до send**, optimistic send, retry exact bytes, crash-recovery, `client_message_id` reconcile, **R-15 reset для всех сообщений failed-сессии (P1-C)**, coverage UI | 5 | F4, B4 |
| E7-F6 | Safety number/QR, **per-device verified**, key-change/TOFU warning, **mode pinning/alert + fresh-device bootstrap (P1-G)**, device list/revoke, history-unavailable UX | 4 | F4, B5 |
| E7-F7 | Hardening/tests: vectors in CI, tamper, E2E two browsers, crash/kill, fresh context, a11y, i18n | 3 | F5, F6 |
| **Итого** | | **~29 dev-days** | |

Порядок: F1 → F2 → F3 → F4 → (F5 ∥ F6) → F7.

### 10.3. Критический путь и гейты

```
E7-S (эта спека + векторы)
   │  crypto-review #1 (design)
   ▼
контракт (I-01/PM) ──► E7-B1..B2 ──► E7-B3/B4/B5/B6 ──► E7-B7
   │                                      │
   └──► E7-F1/F2 (можно параллельно) ──► E7-F3/F4 ──► E7-F5/F6 ──► E7-F7
                                          │
                                          ▼
                              crypto-review #2 (implementation)
                                          │
                                          ▼
                              feature flag ON (staging → prod)
```

| Гейт | Что должно быть готово | Кто |
|---|---|---|
| G0 | Эта спека + vectors **v4** + notes приняты; **S4 закрыл P1-A-1/B-1/C-1/G-1 и I-01 handoff review-03**, S3 — остальные P1 review-02; I-01 применён PM (§6.3.1); внешний ревьюер подтвердил closure | security + PM + external |
| G1 | Backend storage/validation/claim/revoke на staging (E2EE flag off) | backend |
| G2 | Crypto core проходит все KAT независимо (Node + browser) | frontend |
| G3 | E2E 1:1 two devices в staging, safety number, key change, revoke | QA/PM |
| G4 | Внешний crypto-review implementation + пентест фокуса E2EE | external |
| G5 | Включение E2EE (workspace/flag) | PM |

Без G0 нельзя писать крипто-ядро; без G4 нельзя включать E2EE для реальных пользователей. G0 после S4 — это **повторная проверка закрытия условий**, а не новый дизайн: wire format не менялся, но DDL/API/VH изменились и должны быть переревьюены (особенно backfill/`direct_key` на вырожденных данных, coverage-only-capable, reset-окно/дедуп, canonical ciphertext cap, ownership `key_verifications`, claim workspace, grants/RLS/partitions, `prekey↔auth.devices`, `reply_to_id`).

### 10.4. Что можно и нельзя до внешнего crypto-review

| Можно | Нельзя |
|---|---|
| Схемы БД, миграции, индексы, RLS | Включать E2EE в production |
| API DTO/валидация/base64/limits | Финальное крипто-ядро (X3DH/DR/AEAD) в main |
| Opaque storage, claim, revoke, fan-out | Генерировать реальные ключи пользователей |
| WS routing, `chat.keys.changed` | Обещать backup/восстановление |
| Feature flag, UI-каркас, i18n, a11y | Публичный запуск E2EE |
| P0/P1 S2: binding, TOFU, mode immutability, локальная копия (без реальных ключей) | Включать E2EE; генерировать реальные ключи |
| KAT harness и тесты на векторах | Изменять формат конверта после review без новой версии |
| Threat model, logging tests, CSP | «Оптимизации» crypto (nonce reuse, shortened tag) |
| Документация/ADR | Крипто-код без ревьюера |

### 10.5. Тест-план

**Backend:**

- Unit: domain VO (`KeyGeneration`, `PrekeyId`, `DeviceKeyBundle`, `IdentityBinding`), base64 canonical, limits, coverage, mode immutable; ArchUnit.
- Integration (Testcontainers): **миграция поверх V1–V15** с seed-данными; регистрация с валидной/невалидной SPK и binding; лимит 5; natural key; identity-idempotency priority; legacy prekeys → 422; claim consume once (параллельные запросы); claim не-участника → 422; revoke → gen++, WS close, envelopes rejected; read filter по device; idempotent send; cross-user `client_message_id` → 409; `UPDATE security_mode` → exception; `text`/`body_ciphertext` в E2EE запрещены; 0 peer capable → 409; search 409; logs без ciphertext/session_id.
- Contract: DTO ↔ OpenAPI; negative 422/409/413/410; **границы 363/44054/65536/524288**, 9/10 конвертов; `schema.d.ts` regeneration.
- Security: DB scan на plaintext/`content_meta`; RLS cross-tenant; audit metadata only; trigger не обходится upsert.

**Frontend:**

- KAT: A1–A4, B1–B5, C1–C3, D1–D3, E1, E2, F1–F2, G1–G5, I1–I2, L1.
- Property: random ratchet order/loss/duplication; skipped keys; replay; tamper; **fresh `DHs_A` ≠ EK/IK_dh**.
- Integration: device registration/binding, prekey replenish, send/receive with MSW, offline/retry exact bytes, multi-tab locks, **outbox recovery после kill**, TOFU pin create/mismatch.
- E2E: two browser contexts (Alice/Bob), 1:1, safety number match **per device**, key change warning, mode-downgrade alert, revoke, **R-15 reset**; no plaintext in network/console.
- Non-functional: a11y, i18n, CSP, no keys in localStorage/logs, browser floor; **K_storage не обещает at-rest**.

**Cross-cutting:**

- Log scrubber test: отправить E2EE-сообщение и проверить, что в логах нет plaintext/ciphertext/keys/`session_id`.
- Crash-recovery harness: убить вкладку в точках §3.4.6; после reload нет потери/дубля; outbox идемпотентен.
- Dependency review: WebCrypto only; no libsodium WASM in v1 (ADR-02).
- Fuzz: base64/envelope parser (server) и inner payload/frame parser (client).

### 10.6. Риски

| ID | Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|---|
| R-01 | Крипто-ошибка не ловится обычными тестами | Средняя | Критическое | Внешний review, KAT, property/fuzz, две реализации, запрет самодельных примитивов |
| R-02 | Потеря ratchet state → нерасшифровка | Высокая | Высокое | Persist-before-send, транзакции, Web Locks, тесты crash-recovery, UX «пропущено» |
| R-03 | Multi-tab гонка → reuse MK/nonce | Средняя | Критическое | Web Locks/leader, один writer, тесты |
| R-04 | OPK exhaustion/DoS | Средняя | Среднее | Rate limit, replenish, 3DH fallback + warning, мониторинг |
| R-05 | Новое устройство не получает историю | Высокая | Среднее (UX) | Честный UI, backup v1, документация |
| R-06 | «Устройства-призраки» занимают слот | Высокая | Среднее | Device list/revoke, напоминания, лимит 5 |
| R-07 | WebCrypto Ed25519/X25519 не во всех браузерах | Средняя | Высокое | Feature detect, browser floor, «E2EE недоступен» вместо fallback |
| R-08 | Серверная подмена ключей | Низкая/Средняя | Критическое | Safety number, key change warning, KT v2 |
| R-09 | Утечка через логи/аналитику | Средняя | Высокое | Log scrubber, запрет полей, тесты, review |
| R-10 | Контракт разъедется с backend | Средняя | Среднее | I-01, contract tests, diff в этом документе |
| R-11 | 512 KiB лимит не согласован | **Закрыт** | Низкое | D-06 принят: 512 KiB wire, per-envelope 64 KiB encoded, body 32 KiB decoded; §1.3/§4.5 |
| R-12 | Нет PCS для sender keys | — | — | Группы вне E7; MLS v2 |
| R-13 | Backup v1 спроектирован без review | Средняя | Высокое | Отдельный spike/review, не в E7 |
| R-14 | Срок 3–4 недели нереалистичен | Высокая | Среднее | Оценки §10.1–10.2: ~15 + ~23 dev-days + review; календарно 5–7 недель |
| R-15 | Offline дольше окна хранения SPK → prekey-сообщение не расшифровывается | Средняя | Среднее | **SESSION_RESET (content_type=2)** + новый claim + новый `client_message_id` для **всех** сообщений failed-сессии; retain 3 SPK/90 дней; метрика `e2ee_prekey_undecrypted_24h`; L1/L2/L3 |
| R-16 | Downgrade `security_mode` сервером/ошибкой | Средняя | Критическое | Immutability trigger + 409; клиентский пиннинг; plaintext никогда не отправляется; J1 |
| R-17 | Потеря локальной копии (очистка профиля, crash) | Средняя | Высокое | Атомарная копия до send, outbox, crash-recovery тесты; честный `unavailable`; backup v2 |
| R-18 | TOFU-окно: подмена при первом контакте | Средняя | Высокое | Safety number/QR, предупреждение «не сверено», KT v2; I1 |
| R-19 | Расхождение клиента/сервера/прокси по 413 | Средняя | Среднее | Единые лимиты 512 KiB/64 KiB encoded; contract boundary tests; тот же 413 на прокси |

### 10.7. Вопросы Q-01..Q-16: решения S2

| ID | Вопрос | Решение S2 |
|---|---|---|
| Q-01 | Две identity-пары vs XEdDSA? | **Принять две пары** + обязательная самоподпись `IK_sig→IK_dh` (B5). XEdDSA/libsignal отклонён (WebCrypto, supply chain, review), interop не цель. |
| Q-02 | Достаточна ли подпись преамбула? | **Да**, при побайтовой реконструкции, запрете JSON-AD и **TOFU-проверке** (P0-2). Двойной домен `D_PRESIG`+`D_PRE` сохранён. |
| Q-03 | AD слишком жёсткий? | **Оставить**; жёсткость — защита от cross-chat/device replay. Правило: новое поле AD = новый `envelope.v` + ADR. |
| Q-04 | Per-device safety number? | **Да**, и verification **per verifier device** (P0-1): `verifier_device_id` в VH/DDL/API; агрегированный UX «N из M». |
| Q-05 | Нет self-envelope — ОК? | **Да, но только с P0-4b:** атомарная локальная копия plaintext+ciphertext+outbox **до** send. Иначе был бы обязателен self-envelope. |
| Q-06 | Может ли сервер проверять SPK-подпись? | **Да** (публичная verify), и **binding-подпись** тоже; клиент перепроверяет. JDK 21 Ed25519, rate limit, без деталей ошибки. |
| Q-07 | 512 KiB vs 256 KiB? | **512 KiB wire** (D-06); per-envelope **64 KiB encoded**; body **32 KiB decoded**. 256 KiB не хватает (405 KiB). |
| Q-08 | OPK exhaustion: 3DH или блок? | **3DH + warning**, предупреждение один раз на устройство, постоянный индикатор «FS снижена», метрика; high-security — блок (v2). |
| Q-09 | SPK rotation 2×30 дней? | **3 SPK (current + 2 previous) / 90 дней** (P1-D; «2 total/60» отклонено), только вместе с **R-15 reset** (P1-1/P1-C); prekey-сообщение с удалённым SPK не восстанавливается. |
| Q-10 | Simultaneous initiation? | **Уточнено §5.7:** входящий prekey всегда принимается; отправка — в сессию последнего успешного приёма; обе сессии до первого приёма; проигравшая удаляется после подтверждения. Нужен state-machine тест. |
| Q-11 | `key_generation` — фикция? | В v1 почти no-op; **оставлен как задел v2**, убраны намёки на защиту от stale (её дают AEAD+AD+сервер). Тест «меньшая generation отвергается». |
| Q-12 | Padding 256? | **Принято**; в §9.1 явно перечислено, что видно (padded-длина с шагом 256, `n`, `pn`, частота ratchet, `session_id`). Рандомизация — v2. |
| Q-13 | WebCrypto-only? | **Да**, без libsodium WASM; floor по feature detection, KAT в реальном браузере, честный отказ без fallback. |
| Q-14 | Verification до отправки? | **Нет**; TOFU-пин, блокировка при **смене** ключа, постоянный маркер «не сверено», one-tap сверка. |
| Q-15 | KT в v1? | **Нет**; честный TOFU-текст, серверный audit `IDENTITY_KEY_CHANGED`, KT-lite — v1.5/v2. |
| Q-16 | QR/60 digits? | **Да**; QR — сравнение fingerprint, не SN; `verified` только после локальной сверки ids/fp, **никогда** по deeplink; QR одного устройства за раз. |

### 10.8. Оценка и вывод по срокам

- Backend: **~21 dev-days** (S3 добавил ~1–2: grants/RLS/partitions, coverage, reply/revoked к оценке S2).
- Frontend: **~29 dev-days** (S3 добавил ~1: multi-message reset, fresh-device bootstrap, уничтожение ключей к оценке S2).
- Параллельно: календарно **6–8 недель** до production-ready с двумя ревью и E2E; «3–4 недели» из TASKS-E7 достижимы только для backend+минимального frontend без hardening/review. Это риск R-14; честная оценка — в отчёте.

### 10.9. Ответы на 14 вопросов ревью (кратко)

> Числа проверок ниже — на момент соответствующего ревью (S2/S3); актуальный набор — §8.1 (v4 + O-addendum: 48 векторов, 345 проверок базового набора).

Полные ответы с «что/где/какой тест» — в [`docs/E2EE-S2-CHANGELOG.md`](<E2EE-S2-CHANGELOG.md>).

1. **P0-1 (verifier user vs device).** Это был недосмотр, а не UX-компромисс: DDL/API наследовали `verified` пользователю, хотя SN — на пару устройств. Исправлено: `verifier_device_id` в `key_verifications`, `VH` v2, `verified` читается для `X-Device-Id`; новое устройство видит `null` (G5).
2. **P0-2 (§3.3.1 как чек-лист).** Да, §3.3.1 теперь исчерпывающий: TOFU-сравнение `(user_id, device_id) → IK_sig/IK_dh/fingerprint/binding/generation` — обязательный пункт 6, до отображения. Подмена пары при существующем `device_id` ловится пином; при новом `device_id` — показывается «не сверено» (I1/I2).
3. **P0-3 (сервер прислал MANAGED).** Клиент пиннит `chat_id → security_mode`; при расхождении **не отправляет plaintext**, показывает security alert; серверный `UPDATE` запрещён триггером (`409 MODE_CHANGE_FORBIDDEN`). Смена режима — только новый чат (J1/J2).
4. **P1-1/R-15 (сигнал).** Зашифрованный `content_type=2 SESSION_RESET` в **новом prekey-конверте** (не WS-событие), rate limit 1/300 с; отправитель удаляет сессию, новый claim, новое сообщение с новым `client_message_id` (L1/L2).
5. **P1-9 (`DHs` = `EK`?).** Нет: `DHs_A` — **свежая** пара после `SK`, запрещены `EK`/`IK_dh`/`SPK`; assert в векторах и негативный тест.
6. **P1-3 (512 decoded/wire?).** **Wire**: 512 KiB — HTTP body до парсинга; per-envelope 64 KiB **encoded**, body 32 KiB decoded; канонический конверт 33040 B/44054 chars; 9 = 405098 B, 10 = 450099 B; прокси — тот же 413.
7. **P1-4 (миграция против V1–V15).** §6.5 переписана: `messages.text` **нет**; используется существующий `crypto_scheme='E2EE_PAIRWISE'`; V10 уже снял CHECK TEXT→body; новые CHECK запрещают managed-поля у E2EE; `device_prekeys`/`key_verifications` — `CREATE`, а не `ALTER`; `identity_public_key` удаляется.
8. **P1-5 (DIRECT без `direct_key`).** Добавлены `direct_key = least(uuid)||':'||greatest(uuid)` и partial unique `(workspace_id,direct_key)`; `peer_id` вычисляется из `chat_members`; гонка → повторный select.
9. **P1-8/P1-D (кто/когда уничтожает ключи).** OPK private — сразу после AEAD; старый `DHs_priv` — сразу после ratchet; `MKSKIPPED` — TTL 30 д/2000/1000; SPK private — **3 (current + 2 previous) / 90 дней**, затем сессии на нём → `KEY_HANDSHAKE_INVALID` + reset. Окно FS/PCS оцифровано в §3.4.5.1; «2 total/60» удалено.
10. **P1-11 (`K_storage`/`STORAGE_LOCKED`).** `K_storage` — **не at-rest**; unlock/passphrase в v1 нет, поэтому `STORAGE_LOCKED` удалён; введён `KEY_STORAGE_UNAVAILABLE` для отсутствующего/битого хранилища; DPA/UI не обещают защиту от кражи профиля.
11. **P1-10 (`client_message_id` scope).** `(chat_id, sender_id, client_message_id)`: повтор своим — replay; другой пользователь с тем же id — `409 CLIENT_MESSAGE_ID_CONFLICT`, не возврат чужого (K1/K2).
12. **P0-4 (self-envelope и лимит 10).** Self-envelope **отклонён** (решение PM): максимум остаётся 9, лимит 10. Вместо него — атомарная локальная копия + outbox до send, crash/replay-сценарии в §3.4.6; потеря кэша = честное `unavailable`.
13. **P2-5 («сервер не знает digits»).** Заменено на «сервер **не хранит** digits»; `verified` — attestation, в UI не замочек; клиент — источник истины.
14. **P2-3 (`header.v` в E1/E2).** В `expected_steps`/`expected.messages` добавлен `"v":1` (байты не изменились); F1/F2 уже были полными wire-объектами.

### 10.10. Ответы на 14 вопросов E2EE-REVIEW-02 (S3)

| # | Вопрос review-02 | Решение S3 |
|---|---|---|
| 1 | P0-2b: обязаны ли `prekey.sender_identity_*` совпадать с `auth.devices`/bundle, и проверяет ли сервер? | **Да.** §4.7 п. 4a: иначе `422 INVALID_ENVELOPE_FORMAT` (при сдвиге generation — `409 KEY_CHANGED`); клиент §3.3.1 п. 2 проверяет prekey == bundle == TOFU pin. Вектор **I3**. |
| 2 | P1-A: policy, `SECURITY DEFINER` или роль? Кто выдаёт grants? Где партиции? | Выбрана **отдельная SELECT-policy** `p_devices_chat_peer` (не расширяет `p_devices_self`), RLS на prekeys/envelopes, claim — `SECURITY DEFINER auth.claim_one_time_prekey`; grants выдаёт миграция V16+; партиции envelopes создаёт `message.ensure_partition` (+ стартовые). |
| 3 | P1-B: код/статус при `peer_covered==0`; требовать все или хотя бы одно устройство? | `409 E2EE_NO_PEER_ENVELOPE` (не warning) до `Message`/`seq`; требование — **хотя бы один** peer-конверт; partial → `warning=PEER_DEVICE_UNCOVERED`. Векторы M1/M2. |
| 4 | P1-C: одно сообщение или все pending? Лимит batch? | **Все** сообщения failed-сессии, в порядке отправки, batch ≤20; остальные `retry_pending` + явный UI; одна группа retry, 0 дублей. L3. |
| 5 | P1-D: `2 total` или `2 previous+current`? Кто уничтожает? Где FS/PCS? | **3 total (current + 2 previous), 90 дней**; OPK — сразу после AEAD, старый `DHs_priv` — сразу после ratchet, SPK — по окну; §3.4.5.1; S1. |
| 6 | P1-E: hex или b64u? | **b64u64 (86 символов, 64 B)** для всех wire `*_signature`; I1/I2 перекодированы, schema-check в верификаторе (273/0). |
| 7 | P1-G: что делать fresh device при MANAGED? | **Не отправлять plaintext:** block + security alert + explicit mode confirmation/новый чат; серверного кода нет (если сервер отдал MANAGED, он примет plaintext), остаточный риск записан. J3. |
| 8 | P1-H: `peer_id` в `ChatSummary` или отдельный GET? | **В `ChatSummary`** (nullable, DIRECT only), плюс в `Chat`; §6.3/§6.3.1. Отдельный GET не требуется. |
| 9 | P2-4: как достижим `E2EE_LEGACY_DEVICE`? | Через `POST /devices/{id}/prekeys` для legacy-target; `POST /devices` его не возвращает (не адресует device_id); claim — `unavailable NO_KEYS`. N2. |
| 10 | P2-3: `NOT_MEMBER` или 422? | **422 `UNKNOWN_DEVICE`** на весь claim; `NOT_MEMBER` удалён из `unavailable[]` и схемы. |
| 11 | P2-2: `vh_version` или пересчёт? | **`vh_version` в запросе + колонка**, только `2`; иначе `422 VH_VERSION_UNSUPPORTED`. |
| 12 | P2-1: `verified_count` — только текущий verifier? | **Да**, только строки `verifier_device_id = X-Device-Id`; отдельно `verified_by_other_devices_count` (информационно). |
| 13 | P2-8: 160 или 189? | Stale-строка генератора; в v3 — **273** checks, `meta.generator.verify_command` синхронизирован с `meta.checks`. |
| 14 | P2-6: challenge-response? | В v1 **не вводится** (меняет контракт): global unique + 409 + алерт; остаточный риск squatting зафиксирован в §2.5; challenge — v1.1. |



---

### 10.11. Ответы на 12 вопросов E2EE-REVIEW-03 (S4)

| # | Вопрос review-03 | Решение S4 |
|---|---|---|
| 1 | P1-B-1: обязан ли `recipient_device_id` быть `e2ee_capable`, и считается ли coverage только по capable? | **Да, оба.** Per-envelope target check `target.e2ee_capable` → иначе `422 E2EE_LEGACY_DEVICE` (`details.field`), без `Message`/`seq`/partial fan-out; `peer_devices`/`self_devices`/`peer_covered`/`self_covered` — только capable; legacy не в `uncovered_device_ids`. Вектор **M3** (2 варианта). |
| 2 | P1-C-1: reset перешифровывает все pending или только `n >= failed_n`? Ключ дедупликации? | **Только от якоря и позже:** `failed_chain_dh` (`header.dh`), `failed_n` (`header.n`) и `retry_of_client_message_id` в reset; окно — локальный send index ≥ индекса якоря (fallback `(chain,n)`). **v1:** отправитель дедуплицирует повторный reset по `(failed_session_id, failed_chain_dh, failed_n, retry_of_client_message_id)`; дедуп получателя по полю в TEXT — **v1.1** (wire v1 не меняется). Вектор **L3b**; `duplicates_in_ui=0`, `e2ee_reset_duplicates` — v1.1. |
| 3 | P1-A-1: как чинить DIRECT с removed-участником; кто владелец repair? | **Backfill по любым двум участникам независимо от status** (REMOVED/INVITED — пара), CHECK `NOT VALID` → `VALIDATE`, `ck_chats_direct_key_format` от обхода `B:A`. Повреждения (≠2 участника, duplicate pair) → fail-fast `DIRECT_KEY_UNRESOLVED`/`DIRECT_PAIR_DUPLICATE` + runbook §6.5.2; владелец — **E7-B1/ops**. |
| 4 | P1-G-1: подтверждаете «никогда in-place MANAGED, только новый чат»? Можно поправить §6.2.8 без изменения J3? | **Да.** §6.2.8 п. 3(б): `E2EE_ONLY` **или новый managed-чат**; текущий чат остаётся E2EE/заблокированным. **J3 не менялся** — он и был нормативным; синхронизированы §7.6/§9.3. |
| 5 | P1-I01-1: `ChatSummary.name` nullable или derived? `Chat` — новая схема? Rollout старых клиентов? | `name: [string,"null"]` (**nullable, не derived**; display name — клиентский fallback); `Chat`/`ChatCreateRequest` — **новые** схемы (`add`), `POST /workspaces/{id}/chats` — новый path; `DeviceRegistration` — ключи optional (all-or-none), без ключей → `201` legacy, Phase 2 — version floor. D-S4-01…03, §6.3.1. |
| 6 | P2-6: B3/B4 — добавить b64u или оставить hex с конверсией? Почему конвенция «never on the wire», если B4 = `prekey.signature`? | **B3/B4 `expected.signature` — wire-b64u64** (86 симв.), байтовый KAT — `signature_hex`; конвенция `meta.conventions.signature_encoding` исправлена (B3/B4 больше **не** в списке «internal hex»), F1 проверяет равенство. §8.3: Java DTO получает b64u. |
| 7 | P2-10: какой канал даёт `peer_has_e2ee_capable_device` для MANAGED-чата? | **`ChatSummary.peer_has_e2ee_capable_devices`** (derived EXISTS, boolean, без ключей), доступен и для MANAGED; `Chat` — то же поле. J3 остаётся нормативным и становится проводно-реализуемым. §6.2.8 п. 7, §6.3.1 (D-S4-06). |
| 8 | P2-1/P2-2: индексы envelopes — parent-only или child-only? Нужен ли `UNIQUE (message_id, recipient_device_id)` в v1? | **Parent-only:** child-индексы удалены из `ensure_partition`, партиция наследует 4 индекса (PK + 3), включая будущие. `UNIQUE (message_id, recipient_device_id)` в v1 **не вводится** (partition key `created_at` не даёт global unique): идемпотентность — app-level по `(message_id, recipient_device_id)` + повторный `GET` отдаёт не более одного конверта на устройство; тест — E7-B4. |
| 9 | P2-3/P2-4: FK/ownership `key_verifications` и workspace-check claim — или app-level? | **В схеме, не app-level:** composite FK `(verifier_user_id, verifier_device_id) → devices(user_id,id)`, FK `chat_id`/`target_device_id`/`workspace_id`, `BEFORE INSERT` trigger со строгим scope (ACTIVE-члены того же чата/workspace) + tenant-RLS для чтения/обновления; `auth.claim_one_time_prekey` требует `chats.workspace_id = ops.current_workspace_id()`. PG16 T06/T16–T22/T29–T30. |
| 10 | P2-17: когда уберут `ON CONFLICT … security_mode`? Часть E7-B1 или отдельный PR? | **Отдельный backend-PR до E7-B1** (условие GO #3): `DO NOTHING` для `security_mode`; спека фиксирует требование в §6.5 (комментарий у триггера) и §6.2.8. В зоне S4 кода нет. |
| 11 | P2-19: есть ли внешние consumers `identity_public_key`? | В Java-коде колонка не используется (grep по `backend/**` — нет чтения; V2 nullable). Внешние BI/read-model **вне зоны S4** и не проверялись: `DROP COLUMN` остаётся в V16, но E7-B1 обязан подтвердить отсутствие внешних consumers или вынести drop в отдельную миграцию после deprecation-периода (условие GO #4). |
| 12 | P2-11/14–18: кто и к какому этапу закрывает открытые P2? | **P2-11 закрыт в S4** (canonical cap 33040 в API+БД). Остальные: P2-14 (generation overflow), P2-15 (idle TTL/pending outbox), P2-16 (MKSKIPPED eviction), P2-12 (chat-scoped verification UX), P2-13 (wire budget max ids), P2-17 (upsert), P2-18 (repair — теперь §6.5.2), P2-20/21/22 (EXPLAIN, `vh_version` default, RLS-null-context) — **backlog E7-B7/v1.1**, не блокируют E7-B1; исключение — P2-17 (до B1) и P2-19 (условие B1). |

## 11. Предлагаемые ADR и изменения документов

### 11.1. ADR (предложения, не применены)

| ID | Решение | Альтернативы | Последствия |
|---|---|---|---|
| E2EE-ADR-01 | Раздельные Ed25519 (подпись) и X25519 (DH) identity-ключи; без XEdDSA; **обязательная самоподпись `IK_sig→IK_dh`** | libsignal/XEdDSA; WASM | Нативно в WebCrypto; две пары; fingerprint+binding; B5 |
| E2EE-ADR-02 | WebCrypto-only crypto stack в v1; без libsodium WASM | libsodium.js; гибрид | Меньше supply-chain/review; browser floor; non-extractable keys |
| E2EE-ADR-03 | E2EE только в E2EE-воркспейсе; в E7 только DIRECT; без plaintext system messages | E2EE в managed; группы | Честная граница; меньше смешанных режимов |
| E2EE-ADR-04 | Конверт на каждое устройство получателя + другие устройства отправителя; **без self-envelope**; **атомарная локальная копия+outbox до send** | self-envelope (лимит 10/11–12); один ключ пользователя | Fan-out ≤9, лимит 10; `client_message_id`; crash/replay; потеря кэша = честное `unavailable` (P0-4) |
| E2EE-ADR-05 | Safety number на пару устройств; **verified per verifier device**; сервер хранит hash + metadata | per-user safety number; cross-signing | Точнее; `verifier_device_id` в VH/DDL; 25 чисел при 5×5; cross-signing v2 (P0-1) |
| E2EE-ADR-06 | Сервер валидирует структуру, SPK-подпись и **identity binding**, не расшифровывает; coverage peer/self | Полный opaque blob без валидации | Защита от мусора/DoS; сервер не видит контент; binding — публичная операция |
| E2EE-ADR-07 | Prekey policy: SPK ротация 30d; **private retention current+2 = 3 в окне 90d**; OPK 100/target, 200 max, <20 replenish; 3DH fallback с warning | Без OPK; больше SPK | FS/UX компромисс; OPK DoS остаётся |
| E2EE-ADR-08 | **512 KiB wire**; конверт **64 KiB encoded** (canonical 44054 chars); inner body **32 KiB decoded** | 256 KiB; 16 KiB body; decoded-счётчик | 9 конвертов = 396 KiB, 10 = 440 KiB; P1-3/D-06 |
| E2EE-ADR-09 | `security_mode` чата/воркспейса **неизменяем**; смена = новый чат/воркспейс | UPDATE/API-смена | Триггер + 409; клиентский пиннинг; plaintext никогда не отправляется (P0-3) |
| E2EE-ADR-10 | **TOFU-пиннинг identity по `device_id`** при первом prekey-контакте | доверять серверу; KT v1 | TOFU-окно честно признано; mismatch блокирует сессию/отправку (P0-2) |
| E2EE-ADR-11 | **R-15 reset** — зашифрованный `content_type=2`, не WS-событие | `chat.session.reset` WS | Аутентификация reset; rate limit; новый `client_message_id` (P1-1) |
| E2EE-ADR-12 | `client_message_id` scope `(chat_id, sender_id, client_message_id)` | `(chat_id, client_message_id)`; глобально | Replay только своим; cross-user → 409 (P1-10/D-07) |

### 11.2. Изменения существующих документов (не применены)

| Документ | Что изменить | Причина |
|---|---|---|
| `docs/SYSTEM-ANALYSIS.md` §6.4 | `auth.devices.identity_public_key` → `identity_signing_key` + `identity_dh_key`; `device_prekeys` + retired_at | E2EE-ADR-01 |
| §6.8 | «Identity key Ed25519 на устройство» → две пары; `key_generation` семантика; safety number per-device | Синхронизация |
| §7.2 API-05..08 | `POST /devices` keys; `GET /devices`; `DELETE`; prekeys; claim `chat_id`; `unavailable[]` | §6 |
| API-26/34/35/37 | `key_epoch` null для DIRECT; `crypto` в Message; `client_message_id`; envelopes; `envelope_coverage` | §6 |
| §8.2 | Диаграмма: подпись преамбула, fan-out на свои устройства, coverage | §3–5 |
| §9.6 | Состояние устройства: ключи/generation, revoke | §5 |
| §11.2 | Диаграмма ключей: две identity-пары; private storage | §2 |
| §11.3 | Non-goals: KT v2, backup v1, self-envelope, per-device SN | §9 |
| §17.1 | ADR-04: уточнить X3DH-подобный + две identity; ADR-06: fan-out включает свои устройства | Решения |
| `docs/CONCEPT.md` §8.2 | «identity key Ed25519» → две пары; safety number per-device; 512 KiB | Синхронизация |
| `contracts/openapi.yaml` | §6.3 diff + **§6.3.1 handoff (D-S4-01…06)** | Контракт I-01: `Chat`/`ChatCreateRequest` add, `name` nullable, keys optional, `peer_has_e2ee_capable_devices`, `ciphertext.maxLength 44054` |
| `contracts/ws-protocol.md` | `crypto`, `chat.keys.changed`, `device.list.changed` | §6.4 |
| `docs/TASKS-E7.md` | E7-S → DONE; E7-S2/S3/S4 → DONE (spec/vectors); уточнить AC/оценки (AC-09..15) и гейт «B1 после backfill-теста» | Процесс |
| `docs/TASKS.md` §6 | E7-B/E7-F статусы/оценки; E7-S3 | Процесс |
| `backend/**` | `MessageEntity.crypto_scheme` как единственный режим; убрать `security_mode` из upsert workspace; prekeys/claim/verification per device; wire-limit до parse | P1-4/P0-1/P0-3 |
| `frontend/**` | mode pinning, TOFU pin, outbox/local copy, R-15, per-device verified; `schema.d.ts` regenerate | P0/P1 |
| `contracts/openapi.yaml` | §6.3 S2 diff: binding, ciphertext 363/65536, coverage peer/self, verification verifier_device_id, error codes | P1-6/P1-3/P0-1 |

### 11.3. Что этот spike **не** решает

- Backup v1 (key bundle, Argon2id/WebAuthn PRF, recovery UX) — отдельный spike.
- Key transparency v2 (KT log, gossip, Merkle proofs).
- E2EE-группы/sender keys/MLS, файлы, стикеры, звонки.
- Cross-signing устройств, per-user identity.
- Модерация/жалобы в E2EE (клиентские жалобы с приложением plaintext — отдельный UX/legal).
- Совместимость с libsignal/Signal Protocol wire format (мы не обещаем interop).
- Аудит/пентест implementation — после кода.
- **Self-envelope** — отклонён PM; спека не проектирует его и не обещает восстановление своих сообщений после очистки профиля.
- **At-rest шифрование профиля/passphrase unlock** — не в v1; `K_storage` не даёт этой гарантии.
- **Автоматическое разрешение TOFU-mismatch / KT v1** — нет; только явное подтверждение + safety number.
- **Гарантия, что malicious-сервер не попытается понизить режим** — нет; есть клиентский запрет отправлять plaintext и серверный trigger для честной БД.

---

## 12. Чек-лист реализации

### 12.1. Backend (E7-B)

- [ ] `POST /devices`: обязательные IK/IKB/SPK; verify SPK+binding; лимит 5; identity-idempotency priority; legacy → 422; глобальная уникальность; понятные 409/422.
- [ ] `GET /devices`, `DELETE /devices/{id}`: status/generation/last_seen; revoke в одной транзакции; WS close; events.
- [ ] `POST /devices/{id}/prekeys`: SPK rotation, OPK insert, TTL, limits, idempotency, conflicts.
- [ ] `POST /keys/claim`: обязательный `chat_id`, member/own check, atomic OPK consume, `unavailable[]` (NO_KEYS/NO_SPK; `NOT_MEMBER` удалён), no idempotency, rate limit; один 422 для unknown/not-member.
- [ ] `GET /chats/{id}/keys`: только ACTIVE+capable; binding; `verifier_device_id`; verified per this device; self null; aggregate count; MODE_NOT_SUPPORTED.
- [ ] `PUT verification`: verifier device из `X-Device-Id`, VH v2, generation check, 409/410/422, unique (verifier_device,target,chat), reset target on revoke; u8(1) rows untrusted.
- [ ] `POST /workspaces/{id}/chats`: DIRECT/E2EE, `direct_key` unique, no system messages, mode immutable, flag-off 409.
- [ ] `POST /messages`: wire 512 KiB **до** parse; envelopes validation (base64/decoded 272..33040/encoded 363..44054 + form guard 65536/ranges/duplicates/membership/generation/`recipient.e2ee_capable` → 422 `E2EE_LEGACY_DEVICE`); plaintext forbidden; coverage **только capable**; 0 peer → 409; legacy-only → 422/409, не 201.
- [ ] Reset: принять `content_type=2` поля `failed_chain_dh`/`failed_n`/`retry_of_client_message_id` (клиентская часть), не логировать их значения; сервер их не интерпретирует.
- [ ] V16: backfill/CHECK `direct_key` по инварианту §6.5; прогон на degraded DIRECT, duplicate pair и corrupt-DIRECT; runbook §6.5.2 в E7-B1.
- [ ] `GET /messages`: crypto only for X-Device-Id; null otherwise; `client_message_id` echo.
- [ ] WS: crypto selection, `chat.keys.changed`, `device.list.changed`; **нет** `chat.session.reset`.
- [ ] Storage: envelopes/verifications/prekeys (CREATE), `crypto_scheme` CHECK, `direct_key`, mode triggers, sender-scoped `client_message_id` index; RLS; partitioning; migration V1–V15 test.
- [ ] Tests: opaque storage, no plaintext logs, revoke, fan-out, claim race, idempotency, search 409, ArchUnit.
- [ ] Feature flag `e2ee.enabled=false` до review.

### 12.2. Frontend (E7-F)

- [ ] Feature detect X25519/Ed25519/AES-GCM/HKDF; browser floor; честный «E2EE недоступен».
- [ ] Generate IK_sig/IK_dh/SPK/OPK + `identity_binding_signature`; non-extractable; IndexedDB; `K_storage`; no localStorage.
- [ ] Register device, upload/replenish prekeys (<20), rotate SPK (30d), retain **3** SPK privates (current+2 previous, window 90d), destroy older; legacy не апгрейдить.
- [ ] Claim bundles, verify SPK+binding locally, **TOFU-пин по device_id**, key-change detection; pin без TTL.
- [ ] X3DH (4DH/3DH), preamble/signature, session init; all KATs.
- [ ] Double Ratchet send/receive/skipped/limits; persist-before-send; Web Locks; crash recovery.
- [ ] Multi-device fan-out incl. own other devices; **своя копия+outbox до send**; coverage peer/self warning.
- [ ] Envelope build/parse; inner payload framing/padding; `content_type=2 SESSION_RESET`; `client_message_id`; **атомарная локальная копия**; crash/replay.
- [ ] Safety number/QR; **per-device verified**; key-change/TOFU warning; **mode pinning/alert**; device list/revoke; history-unavailable UX.
- [ ] Retry exact bytes; 409/422/413 handling; no plaintext fallback.
- [ ] Tests: all vectors, tamper, property, E2E two browsers, a11y, i18n, no plaintext in logs/network.

### 12.3. Security/Process

- [ ] Crypto-review #1 (design) — эта спека/векторы.
- [ ] Crypto-review #2 (implementation) — код, state machine, storage.
- [ ] Threat model review; DPA/UI text.
- [ ] Log scrubber test; CSP/SRI; dependency/SBOM review.
- [ ] Feature flag off в prod до G4.
- [ ] Incident runbook: revoke всех устройств, отключение E2EE, коммуникация.

---

## Приложение A. Быстрые формулы (справочник)

```
F           = 0xFF × 32
SK          = HKDF(F || DH1 || DH2 || DH3 [|| DH4], 0×32, "Krug/E2EE/v1/x3dh", 32)
session_id  = HKDF(SK, 0×32, "Krug/E2EE/v1/session-id", 16)
RK', CK     = HKDF(dh_out, RK, "Krug/E2EE/v1/dr-root", 64)
MK, CK'     = HMAC(CK, 0x01), HMAC(CK, 0x02)
K_enc       = HKDF(MK, 0×32, "Krug/E2EE/v1/aead-key", 32)
N           = HKDF(MK, 0×32, "Krug/E2EE/v1/aead-nonce", 12)
FP          = SHA-256("Krug/E2EE/v1/fingerprint" || IK_sig || IK_dh)
SN          = decimal(SHA-512("Krug/E2EE/v1/safety-number" || 01 || u32(2) || e1 || e2) mod 10^60)
entry       = user_id(16) || device_id(16) || FP(32)
VH          = SHA-256("Krug/E2EE/v1/verification" || 02 || chat(16) || verifier_user(16) ||
                      verifier_device(16) || target_device(16) || u32(generation) || ascii(digits60))
IKB         = Ed25519(IK_sig, "Krug/E2EE/v1/ik-binding" || 01 || IK_dh(32) || IK_sig(32))   // 88 B msg
AD          = "Krug/E2EE/v1/ad"(15) || 01 || flags || chat(16) || sender_dev(16) ||
              u32(sender_gen) || recipient_dev(16) || u32(recipient_gen) ||
              session_id(16) || preamble_hash(32) || header(42)
header      = 01 || 00 || u32(pn) || u32(n) || dh(32)
preamble    = "Krug/E2EE/v1/prekey"(19) || 01 || chat(16) || sender_dev(16) ||
              recipient_dev(16) || IK_A_sig(32) || IK_A_dh(32) || EK_A(32) ||
              IK_B_dh(32) || IK_B_sig(32) || u16(L) || spk_id(L) || SPK_B(32) ||
              opk_present || u16(M) || opk_id(M) || OPK_B(32|zeros) || session_id(16)
SPK_msg     = "Krug/E2EE/v1/spk-signature"(26) || 01 || u16(L) || key_id(L) || SPK(32)
payload     = "Krug/E2EE/v1/payload"(20) || 01 || content_type || u32(body_len) ||
              body || zero-pad to 256
limits      = body 32768 -> raw 32794 -> padded 33024 -> ct 33040 -> 44054 b64u (43.0 KiB)
              9 env + wrapper = 405098 B (395.6 KiB); 10 = 450099 B (439.5 KiB); wire limit 524288 B
reset       = payload with content_type=2: {failed_session_id, failed_chain_dh, failed_n, reason, retry_of_client_message_id}
```

## Приложение B. Трассировка «одно сообщение»

1. A: `GET /chats/{id}/keys` → устройства B (и свои другие).
2. A: `POST /keys/claim` → bundle B1 (SPK+OPK).
3. A: verify SPK signature → X3DH → SK/SID → preamble → sign → DR init.
4. A: verify binding/TOFU pin for B1 (first contact → create pin, `verified=false`).
5. A: build envelope (prekey) → **one IndexedDB tx: state + exact bytes + idempotency key + client_message_id + local plaintext/ciphertext copy** → `POST /messages {envelopes}`.
6. Server: check wire ≤512 KiB before parse → validate structure/rights/generations/coverage → seq → store opaque → outbox; 0 peer capable → 409.
7. WS: `message.created` B1 (crypto для B1), A2 (crypto для A2), A1 (`crypto:null`; копия локально).
8. B1: verify preamble/signature + binding + **TOFU pin** → X3DH → DR receive → AEAD decrypt on a copy → one tx state+plaintext copy → UI.
9. B1: safety number compare (QR/Manual) → `PUT verification` (VH v2, `X-Device-Id`); L2 sees `null`.
10. B1: reply → new DR chain → envelope to A1 + other devices of B.
11. A1: decrypt; on key change/event — refresh keys, warning; on SPK deleted/decrypt fail → encrypted SESSION_RESET → new claim → resend new `client_message_id`.
12. Crash between send and cache-write: outbox resends same bytes; server replay same seq; no re-encryption.

---

*Конец спецификации. Изменения — только через новую версию (`envelope.v`) и ADR; молчаливые правки wire format запрещены.*

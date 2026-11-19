# E2EE-S3-CHANGELOG — remediation по E2EE-REVIEW-02 (G1: GO WITH CONDITIONS)

> **Роль:** автор E2EE-спеки «Совы». **Зона S3:** `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md`, этот файл. `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, ревью — **не изменялись**.
> **Вход:** [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>) — 415 строк, 2 P0 + 6 P1 partially, I-01, P2-1…P2-19.
> **Выход:** спека S3 (3124 строки), vectors v3 (**43 вектора / 17 секций / 273 checks, 0 failures**), S3-генератор и верификатор в notes §10, PG16-smoke для §6.5.
> **Wire format:** `envelope.v=1`, `header.v=1`, AD 163 B, преамбул `313+L+M` — **не менялись**. `VH` остаётся v2; кодировка binding в I1/I2 исправлена (hex → b64u64), это не wire-изменение.

---

## Статус

**DONE (S3 remediation).** Все блокирующие пункты review-02 исправлены в зоне S3; векторы перегенерированы и независимо проверены; DDL §6.5 проверен на PostgreSQL 16 под ролью `krug_app`.

Вне зоны S3 и поэтому **не закрыто автором**:
- **I-01** — контракт (`contracts/openapi.yaml`, `ws-protocol.md`, `schema.d.ts`) должен применить PM по точному handoff §6.3.1; в S3 контракт не менялся.
- **E7-B1/B3/B5/F3** — реализация и Testcontainers/E2E-тесты (G1–G4). S3 даёт спеку, DDL, векторы и smoke, но не production-код.
- **G2/G3/G4** — браузерные KAT, E2E двух браузеров, внешний review реализации/пентест.

---

## 1. Что изменено по каждому P0/P1 review-02

| ID | Строка/раздел спеки | Что изменено | Вектор/тест |
|---|---|---|---|
| **P0-2b** prekey↔registered identity | §3.3.1 (387), §3.3.2 (438), §3.3.3 (453), §4.1 (~770), §4.7 п. 4a (926) | Введён нормативный «источник истины»: `prekey.sender_identity_signing_key/dh_key` обязаны побайтово совпадать с `auth.devices.identity_*` и claim-bundle/`GET /keys`; binding проверяется **над этими же** ключами; сервер отвергает `422 INVALID_ENVELOPE_FORMAT` (при сдвиге generation — `409 KEY_CHANGED`), клиент — `KEY_HANDSHAKE_INVALID` без сессии/OPK/display. Чек-лист §3.3.1 перенумерован (п. 2 — равенство, п. 7 — TOFU). | **I3-prekey-sender-identity-mismatch** (wire-валидный конверт, валидная подпись/binding Mallory, но bundle/`auth.devices` честные); integration «токен без ключей не выдаёт себя за устройство» |
| **P1-A** DDL V16 не исполним | §6.5 (1959), §6.5.1 (2337) | `GRANT` для `krug_app` на `auth.device_prekeys`, `auth.key_verifications`, `message.message_envelopes` (+ каждая партиция); RLS prekeys (owner + chat-peer read, claim через `SECURITY DEFINER auth.claim_one_time_prekey`); RLS envelopes `workspace_id`; **отдельная** `p_devices_chat_peer` для чтения устройств собеседника (self не ломается); `ensure_partition()` создаёт `message_envelopes_YYYY_MM` с индексами/RLS/grant + стартовые партиции; `reply_to_id` CHECK; `sender_id/sender_device_id NOT NULL` для E2EE; `vh_version`; grants на `key_verifications`. | PG16 smoke: V1–V15 + §6.5 одной транзакцией; claim/RLS/partitions/CHECK под `krug_app` (§10.4.1 notes); Testcontainers E7-B1 |
| **P1-E** I1/I2 hex | §8.1/§8.2 (2490+), vectors | `presented_identity_binding_signature` и `pinned_identity_binding_signature` — **b64u64, 86 символов, 64 B** (I1/I2); добавлена конвенция `meta.conventions.signature_encoding`; верификатор проверяет 86/b64u/64 B и отсутствие 128-hex в wire-полях. | I1, I2, I3; 273/0 verifier |
| **P1-B** `peer_covered==0` | §4.2 (770), §4.7 (926), §5.2, §4.8 | `peer_devices` — только кандидаты; `peer_covered==0` → `409 E2EE_NO_PEER_ENVELOPE` **до** `Message`/`seq`; partial → `201` + `warning=PEER_DEVICE_UNCOVERED`; self-warning отдельно; клиентский pre-check «нет peer-bundle — не отправлять». | **M1-peer-coverage-zero-rejected**, **M2-peer-partial-coverage-warning** |
| **P1-C** reset одного сообщения | §3.3.3 (453), §5.5 (1079), §1.3 | Reset — свойство **сессии**: отправитель перешифровывает **все** pending/неподтверждённые сообщения `failed_session_id` в порядке отправки; каждому новый `client_message_id`/`Idempotency-Key`/bytes; `MAX_RESET_BATCH=20`; остаток `retry_pending` + явный UI; одна группа retry, 0 дублей; пустой outbox — no-op; метрика `e2ee_reset_batch_size`. | **L3-session-reset-multi-message**; E2E «5 сообщений, 0 дублей» |
| **P1-D** FS 60 vs 60–90 | §1.3, §2.3 (232), §3.4.2 (~485), §3.4.5.1 (550), §5.5, §10.7 Q-09 | Выбрана одна семантика: **`SPK_RETAIN_PRIVATE = 3` (current + 2 previous), `SPK_RETAIN_WINDOW = 90 дней`**; «2 total/60» объявлено недействительным. Добавлен нормативный §3.4.5.1: OPK private — сразу после AEAD; старый `DHs_priv` — сразу после ratchet; SPK — по окну; MKSKIPPED TTL/лимиты; PCS только после ответного DH; `SESSION_IDLE_TTL` — не FS-граница; zeroization best-effort. | **S1-fs-pcs-key-destruction**; property/storage-scan E7-F2/F7 |
| **P1-G** fresh-device mode | §6.2.8 (1440), §7.6 (2477), §9.3 | Bootstrap режима: без локального пина серверный `MANAGED` не принимается молча; при признаках E2EE (peer capable/история/workspace) — `BLOCK_SEND_SECURITY_ALERT`/`REQUIRE_MODE_CONFIRMATION`, `plaintext_messages_sent=0`; явное подтверждение/новый чат; серверного кода нет (сервер, отдавший MANAGED, принял бы plaintext); честный остаточный риск (нет server-signed attestation v1). | **J3-fresh-device-managed-mode-blocked**; Playwright fresh context |
| **P1-F** `reply_to_id` | §4.2 (770), §4.7 (926), §6.5 | Верхнеуровневый `reply_to_id` в E2EE → `422 E2EE_PLAINTEXT_FORBIDDEN` (`details.field`), DB CHECK `ck_messages_e2ee_no_reply_to_id`; разрешён только внутри inner payload; **не входит в AD** (wire не меняется). | **R1-e2ee-reply-to-id-rejected**; contract/DB-тест |
| **P1-H** `ChatSummary.peer_id` | §6.3 (1523), §6.3.1 (1908) | В `ChatSummary` добавлен `peer_id: [string,null] uuid` (DIRECT; null для GROUP), derived из `chat_members`; в `Chat` уже был. | contract-тест `GET /chats`; PM применяет §6.3.1 |
| **P1-5** DIRECT uniqueness | §6.2.8, §6.5 | `direct_key`/partial unique/backfill остаются; исправлен реальный SQL-дефект бэкфилла (`min(uuid)`/`max(uuid)` не существуют в PG) → `min(user_id::text)||':'||max(user_id::text)`. `peer_id` теперь и в `ChatSummary`. | PG16 smoke (backfill применился); race-тест E7-B1 |
| **P1-6** POST /devices | §2.5, §3.1, §6.2.1, §6.2.2, §4.6 | Приоритет идемпотентности: REVOKED-check → IK → Idempotency; `E2EE_LEGACY_DEVICE` сделан достижимым на `POST /devices/{id}/prekeys`; `NO_KEYS` оставлен только claim/unavailable; **P2-5**: тот же IK после REVOKED → `410 DEVICE_REVOKED`, без реактивации. | **N1-revoked-identity-replay**, **N2-legacy-device-prekeys-rejected** |

### 1.1. I-01 — точный handoff, контракт не изменён

§6.3.1 (строка 1908) содержит пофайловый список: какие схемы `openapi.yaml` добавить/изменить (включая `ChatSummary.peer_id`, `VerificationRequest.vh_version`, `UnavailableDevice` без `NOT_MEMBER`, `EnvelopeCoverage.warning`), какие `paths`/статусы, какие события `ws-protocol.md`, команду `cd frontend && npm run api:types`, порядок применения и contract-тесты. **`contracts/**` в S3 не редактировались**; I-01 в closure matrix — **open** (зона PM).

### 1.2. P2, закрытые/уточнённые в S3

| ID | Что сделано | Где |
|---|---|---|
| P2-1 | `verified_count` = только `verifier_device_id = X-Device-Id`; добавлен `verified_by_other_devices_count`; L2 видит 0/null | §6.2.6, §6.3, §6.5.1 |
| P2-2 | `vh_version` в запросе + колонка, только 2; иначе `422 VH_VERSION_UNSUPPORTED` | §6.2.7, §6.5, §6.3 |
| P2-3 | `NOT_MEMBER` удалён; не-участник → `422 UNKNOWN_DEVICE` на весь claim | §3.2, §6.2.5, §6.3 |
| P2-4 | `E2EE_LEGACY_DEVICE` достижим на prekeys; `NO_KEYS` — claim | §2.5, §3.1, §6.2.1, §6.2.2 |
| P2-5 | REVOKED + тот же IK → 410, без реактивации | §2.5, §3.1, §4.6, §6.2.1 |
| P2-6 | Явно записан остаточный риск squatting; challenge-response — v1.1 | §2.5 |
| P2-8 | `meta.generator.verify_command` = 273, синхронизирован с `meta.checks` | vectors meta |
| P2-9 | `meta.conventions.signature_encoding`; schema-check в верификаторе | vectors meta, §10.3 |
| P2-10 | Исправлен backfill `direct_key` (`min/max` по text); repair-скрипт остаётся задачей E7-B1 | §6.5 |
| P2-12 | CHECK `sender_id/sender_device_id NOT NULL` для E2EE | §6.5 |
| P2-13 | Клиент игнорирует server `text`/`reply_to_id` при `crypto:null`; alert+метрика | §4.3 |

Не входили в блокирующий объём S3 и остаются P2: 11 (form cap vs canonical), 14 (chat-scoped verification UX), 15 (ENVELOPE_WIRE_BUDGET с max ids), 16 (generation overflow), 17 (idle TTL), 18 (MKSKIPPED eviction), 19 (contract — это I-01).

---

## 2. Векторы v3

### 2.1. Состав

- **17 секций, 43 вектора**, `vector_set_version=3`; 16 нормативных + `H-sender-key` informative.
- Новые: **I3**, **J3**, **M1**, **M2**, **L3**, **N1**, **N2**, **R1**, **S1**.
- Исправлены: I1/I2 `presented_*`/`pinned_identity_binding_signature` → b64u64 (86 символов, 64 B).
- `meta.checks.verifier_checks = 273`, `meta.generator.verify_command` = 273 (P2-8).
- `meta.conventions.signature_encoding` — wire-подписи только b64u64; hex — только внутренние `*_hex`.
- Envelope wire format не менялся (`protocol_envelope_version=1`).

### 2.2. Команды и результат

```bash
# 1) S2-генератор (notes §9.1) → docs/E2EE-TEST-VECTORS.json (34/13)
python3 gen_e2ee_vectors_s2.py

# 2) S3-патч (notes §10.2) → перезапись (43/17, v3)
python3 gen_e2ee_vectors_s3.py
# S3 patch written; vectors: 43 sections: 17
# I1 binding: 611ZRX0_…gdNCAA (86 chars, 64 bytes)

# 3) независимый верификатор (notes §10.3), не использует код генератора
node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json
# 273 checks, 0 failures

# 4) детерминизм (повтор 1–2 в чистой директории)
cmp docs/E2EE-TEST-VECTORS.json /tmp/repro/docs/E2EE-TEST-VECTORS.json   # IDENTICAL
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8
```

### 2.3. Что проверяет верификатор (273)

A1–A4 (RFC 7748/8032/5869, NIST AES-GCM), B1–B5 (X3DH, SPK-подпись, преамбул 323 B, binding 88 B), C1–C3, D1–D3, E1 (полная DR-симуляция, включая `r2`), E2, F1–F2, G1–G5 (FP/SN/VH v2/per-device), I1–I3 (AEAD-расшифровка «валидного, но чужого» конверта; TOFU mismatch; prekey↔registered mismatch), J1–J3, K1–K2, L1–L3, M1–M2, N1–N2, R1, S1, `meta.limits` (405098/450099 B, 524288 wire, form cap ≠ budget), все b64u-длины и structural-инварианты. Отдельные проверки: все wire-sourced `*_signature` — 86 b64u, decode = 64 B, ни одного 128-hex среди них; внутренние KAT/meta-значения остаются hex by design.

### 2.4. PG16 smoke для P1-A

V1–V15 + §6.5 применились **одной транзакцией**; под `krug_app`: peer devices 2 / non-peer 0; peer prekeys 3 / non-peer 0; claim OPK → `opk-1`, второй → `NULL`; чужой чат → `UNKNOWN_DEVICE`; envelope в партицию → 1; cross-tenant envelope/verification → RLS violation; `reply_to_id`/NULL sender → CHECK fail; `UPDATE security_mode` → `MODE_CHANGE_FORBIDDEN`; `vh_version=1` → CHECK fail; 3 партиции envelopes. Полный лог — notes §10.4.1. Найден и исправлен дефект `min(uuid)` (PostgreSQL не имеет `min(uuid)`/`max(uuid)`) в backfill `direct_key`; backfill отдельно проверен на БД с существовавшим до V16 DIRECT-чатом из двух ACTIVE-участников — `direct_key` заполнен, unique-индекс применён.

---

## 3. Отчёт по формату `docs/TASKS.md` §5

> `docs/TASKS*.md` в S3 не изменялись (зона S3 их запрещает). Отчёт приведён здесь в формате §5.

## Статус
**DONE** — S3 remediation в зоне `docs/E2EE-*`; I-01 и implementation-гейты (E7-B1/B3/B5, G2–G4) остаются внешними зависимостями.

## Сделано
- P0-2b: prekey↔`auth.devices`/bundle, серверная и клиентская проверка, I3.
- P1-A: grants/RLS/partitions/CHECK в §6.5; PG16 smoke; исправлен backfill `direct_key`.
- P1-E: I1/I2 binding → b64u64; schema-конвенция и проверки.
- P1-B/C/D/F/G/H: coverage, multi-message reset, FS 3/90, `reply_to_id`, fresh-device mode, `ChatSummary.peer_id`.
- P1-5/P1-6 + P2-1/2/3/4/5/6/8/9/10/12/13.
- I-01: точный handoff §6.3.1 (контракт не изменён).
- Векторы v3: 43/17, 273/0, детерминизм, sha256.

## Файлы
- `docs/E2EE-SPEC.md` (3124 строки; S3)
- `docs/E2EE-TEST-VECTORS.json` (1457 строк; v3)
- `docs/E2EE-SPIKE-NOTES.md` (S3-генератор/верификатор §10, PG16 smoke §10.4.1)
- `docs/E2EE-S3-CHANGELOG.md` (этот файл)

## Проверки
- `python3 gen_e2ee_vectors_s2.py && python3 gen_e2ee_vectors_s3.py` → `43 sections: 17`.
- `node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json` → `273 checks, 0 failures`.
- `cmp` повторной генерации → `IDENTICAL`; sha256 `1fa70ac1…1cd8`.
- PG16: V1–V15 + §6.5 (`psql -1`) → без ошибок; RLS/grants/partitions/CHECK под `krug_app` → см. §2.4.
- Покрытые сценарии: binding/TOFU/mode/coverage/reset/FS/registration/reply; tamper и negative — в §8.4 спеки.

## Контракт
- Отклонений от `contracts/openapi.yaml` нет **в коде**, потому что контракт не менялся. Delta зафиксирована текстом: §6.3 (предложение) и §6.3.1 (точный handoff для PM). I-01 open до применения PM.

## DDD
- Не применимо: S3 — только docs/vectors, кода нет. Пакеты/ArchUnit не менялись.

## Риски и вопросы
- I-01 не применён: backend/frontend не стартуют с новыми DTO до PM-PR (§6.3.1).
- PG16 smoke — не Testcontainers E7-B1: нет конкурентной гонки claim и реальных исторических данных.
- P2-6 (squatting), P2-11/P2-14..19 — приняты/отложены; см. §4.
- Fresh-device без server-signed mode attestation — остаточный риск, честно записан.
- TOFU-окно первого контакта и malicious server остаются в модели угроз.

## Что дальше
1. PM: применить I-01 (§6.3.1) одним PR + `npm run api:types` + contract-check.
2. Backend: E7-B1 по §6.5 (Testcontainers V1–V15, роль `krug_app`), затем B3/B4/B5.
3. Frontend: E7-F2 (storage/уничтожение ключей), F4 (TOFU+prekey equality), F5 (multi-reset/coverage).
4. G2 (браузерные KAT), G3 (E2E два браузера), G4 (внешний review реализации) — до включения E2EE.
5. Повторный review S3: проверить §3.3.1/§4.7/§6.5/§6.3.1 и vectors v3.

---

## Artifacts

| Артефакт | Путь | Метрика |
|---|---|---|
| Спека S3 | [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) | 3124 строки; §0.2 карта S3; §3.4.5.1; §6.3.1; §6.5; §10.10 |
| Векторы v3 | [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) | 43 вектора / 17 секций / `vector_set_version=3`; 273 checks, 0 failures; sha256 `1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8` |
| S3-генератор (патч) | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §10.2 | детерминирован; `gen_e2ee_vectors_s3.py` |
| S3-верификатор | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §10.3 | `verify_e2ee_vectors_s3.mjs`; 273/0 |
| PG16 smoke | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §10.4.1 | V1–V15 + §6.5; RLS/grants/partitions/CHECK под `krug_app` |
| Этот отчёт | [`docs/E2EE-S3-CHANGELOG.md`](<E2EE-S3-CHANGELOG.md>) | closure matrix, artifacts, residual risks |

Команды воспроизведения:

```bash
python3 gen_e2ee_vectors_s2.py
python3 gen_e2ee_vectors_s3.py
node verify_e2ee_vectors_s3.mjs docs/E2EE-TEST-VECTORS.json   # 273 checks, 0 failures
shasum -a 256 docs/E2EE-TEST-VECTORS.json                    # 1fa70ac1…1cd8
```

---

## Closure matrix

Статусы: **closed** — исправлено в зоне S3 и подтверждено вектором/проверкой; **partial** — исправлено в спеке, но требует внешнего применения/реализации; **open** — не входит в зону S3 или не исправлено.

### P0

| ID | S2 (review-02) | S3 | Доказательство / остаток |
|---|---|---|---|
| P0-1 per-device verification | closed | **closed** | DDL/API/VH v2/G5 сохранены; регрессий нет |
| P0-2 TOFU pin | partial | **closed** | §3.3.1 п. 2/7, §4.7 п. 4a; **I3**; I1/I2 wire-valid |
| P0-2b prekey↔registered/bundle | open | **closed** | §3.3.1, §3.3.2 3a, §3.3.3, §4.1, §4.7 п. 4a; **I3**; integration — E7-B3 |
| P0-3 mode immutability | partial | **closed** | §6.2.8 bootstrap, §7.6/§9.3; **J3**; trigger в §6.5; E2E fresh context — G3 |
| P0-4 own copy | closed | **closed** | не менялось; crash-recovery property — E7-F2/F7 |

### P1

| ID | S2 (review-02) | S3 | Доказательство / остаток |
|---|---|---|---|
| P1-1 R-15 | partial | **closed** | §5.5 multi-message reset; **L3**; E2E — G3 |
| P1-2 IK binding | closed | **closed** | B5; клиент/сервер проверяют; I3 усиливает |
| P1-3 limits | closed | **closed** | `meta.limits`; 273-verifier; boundary — E7-B7 |
| P1-4 DDL vs V1–V15 | partial | **closed** | §6.5 + PG16 smoke; Testcontainers — E7-B1 |
| P1-5 DIRECT uniqueness | partial | **closed** (spec) | §6.5 backfill исправлен; `ChatSummary.peer_id` §6.3; контракт — I-01 |
| P1-6 POST /devices | partial | **closed** (spec) | §2.5/§3.1/§6.2.1/§6.2.2; **N1/N2**; контракт — I-01 |
| P1-7 coverage 0 peer | partial | **closed** | §4.2/§4.7/§5.2; **M1/M2**; E7-B4 |
| P1-8 FS window/destruction | partial | **closed** | §1.3/§3.4.5.1; **S1**; storage-scan — E7-F2 |
| P1-9 DHs_A | closed | **closed** | без изменений |
| P1-10 client_message_id | closed | **closed** | без изменений; K1/K2 |
| P1-11 K_storage | closed | **closed** | без изменений |
| P1-12 flag-off | closed | **closed** | J1/J2; §10.4 |

### I-01 / P2

| ID | Статус | Комментарий |
|---|---|---|
| **I-01** contract | **open** | `contracts/**` не менялись по зоне S3; точный handoff §6.3.1; PM должен применить + regenerate `schema.d.ts` |
| P2-1 `verified_count` | **closed** | §6.2.6/§6.5.1, `verified_by_other_devices_count` |
| P2-2 `vh_version` | **closed** | §6.2.7/§6.5; CHECK `vh_version=2` проверен на PG16 |
| P2-3 `NOT_MEMBER` | **closed** | удалён; 422 `UNKNOWN_DEVICE` |
| P2-4 `E2EE_LEGACY_DEVICE` | **closed** | достижим на prekeys; N2 |
| P2-5 REVOKED idempotency | **closed** | 410 до IK-replay; N1 |
| P2-6 ownership challenge | **partial** | остаточный риск записан; challenge — v1.1, контракт меняет PM |
| P2-7 SPK expiry подпись | open | не входило в блокирующий объём S3 |
| P2-8 meta 160/189 | **closed** | 273 синхронизировано |
| P2-9 JSON-schema конвенции | **closed** | `signature_encoding` + schema-check |
| P2-10 backfill repair | **partial** | `min(uuid)` исправлен; repair-скрипт — E7-B1 |
| P2-11 form cap vs canonical | open | P2, документировано; не блокирует |
| P2-12 NULL sender | **closed** | CHECK + PG16 smoke |
| P2-13 server-forged plaintext | **closed** | §4.3: игнорировать `text`/`reply_to_id` при `crypto:null` |
| P2-14 chat-scoped verification | open | P2 UX; не блокирует |
| P2-15 wire budget max ids | open | P2; не блокирует |
| P2-16 generation overflow | open | P2; не блокирует |
| P2-17 idle TTL | open | P2; не блокирует |
| P2-18 MKSKIPPED eviction | open | P2; не блокирует |
| P2-19 contract delta | **open** | = I-01 |

**Итог:** P0 — **все 4 (P0-1…P0-4) closed**, включая новый P0-2b; P1 — **12/12 closed в спеке** (6 были partial; контрактная часть P1-5/P1-6 — I-01 open); I-01 — open для PM; блокирующие P2 (1/2/3/4/5/8/9/12/13) закрыты, P2-6/P2-10 partial, остальные P2 — вне S3.

---

## Residual risks (честно)

1. **I-01 не применён**: до PM-PR backend/frontend несовместимы с новыми DTO; S3 даёт точный список, но не контракт.
2. **PG16 smoke ≠ Testcontainers E7-B1**: не проверены конкурентная гонка claim, реальные исторические данные, `EXPLAIN`, поведение Flyway.
3. **P2-6 squatting**: глобальная уникальность не доказывает владение; challenge-response — v1.1.
4. **Fresh-device без mode attestation**: клиент блокирует plaintext, но не может доказать «чат был E2EE»; server-signed attestation — v2.
5. **TOFU-окно первого контакта** и malicious server остаются; safety number обязателен.
6. **PCS не мгновенный**, FS ограничена окном SPK 90 дней; `SESSION_IDLE_TTL` — GC, не FS.
7. **Zeroization в JS** — best-effort; кража профиля/диска/XSS остаётся вне модели.
8. **P2-11/P2-14..18** не исправлены: не блокируют E7-B1/B3, но должны попасть в backlog.
9. **F1/F2/I1/I2** — по-прежнему не browser-KAT: G2 обязателен.

---

*Конец E2EE-S3-CHANGELOG. Изменены только `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md` и создан этот файл. `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, reviews не изменялись.*

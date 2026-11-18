# E2EE-S4-CHANGELOG — targeted remediation по E2EE-REVIEW-03 (G2: GO WITH CONDITIONS)

> **Роль:** автор E2EE-спеки «Круга». **Зона S4:** `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md`, этот файл. `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, ревью — **не изменялись**.
> **Вход:** [`docs/E2EE-REVIEW-03.md`](<E2EE-REVIEW-03.md>) — GO WITH CONDITIONS: P0 4/4 closed; P1-A/B/C/G partial; P1-I01 partial; 12 вопросов; P2-1…P2-22.
> **Выход:** спека S4 (3 449 строк), vectors v4 (**45 векторов / 17 секций / 345 checks, 0 failures**), S4-генератор/верификатор и PG16-smoke в notes §11, `docs/E2EE-S4-CHANGELOG.md`.
> **Wire format:** `envelope.v=1`, `header.v=1`, AD 163 B, преамбул `313+L+M` — **не менялись**. Изменились: wire-кодировка `B3/B4.expected.signature` (hex → b64u64) и inner payload `content_type=2` (добавлен `failed_chain_dh`; это inner JSON, не конверт).

---

## Статус

**DONE (S4 targeted remediation).** Все 6 блокирующих/требуемых пунктов review-03 закрыты в зоне S4: P1-A-1 (degraded DIRECT), P1-I01-1 (handoff), P1-B-1 (coverage), P1-C-1 (reset-дубли), P1-G-1 (in-place), P2-набор (B3/B4, `key_verifications`, claim workspace, индексы, safety number, cap). Векторы перегенерированы (v4) и независимо проверены; DDL §6.5 проверен на PostgreSQL 16.16 на **normal и degraded DIRECT**, а также на corrupt/duplicate данных.

Вне зоны S4 и поэтому **не закрыто автором**:
- **I-01** — контракт (`contracts/openapi.yaml`, `ws-protocol.md`, `schema.d.ts`) применяет PM по handoff §6.3.1 (в S4 — только текст, контракт не менялся).
- **E7-B1** — реализация/Testcontainers/гонка claim/реальные исторические объёмы; S4 даёт спеку, DDL и smoke.
- **P2-17/P2-19** — backend-PR до B1 (`ON CONFLICT … security_mode`; consumers `identity_public_key`) — вне зоны docs.
- **G2/G3/G4** — браузерные KAT, E2E двух браузеров, внешний review реализации/пентест.

---

## 1. По каждому P1 review-03: раздел/строка, что изменено, вектор/тест

Строки — по итоговому `docs/E2EE-SPEC.md` S4.

| ID | Раздел/строки | Что изменено | Вектор/тест |
|---|---|---|---|
| **P1-A-1 / P1-5-1** backfill degraded DIRECT | §6.5 (**2419–2500**: 5a preflight, 5b backfill, 5c fail-fast, 5d duplicate preflight, 5e `NOT VALID`+`VALIDATE`), §6.5.1 (**2576+**), §6.5.2 (**2598–2649**, runbook), §6.2.8 (**1486+** — инвариант), §0.3 (стр. 37) | (1) **Инвариант:** `direct_key = least(A,B)::text \|\| ':' \|\| greatest(A,B)::text` по **множеству различных `chat_members.user_id` независимо от `status`** (REMOVED/INVITED — участники пары; deleted DIRECT тоже получает ключ, иначе CHECK упадёт). (2) Backfill больше не `HAVING count(*)=2` по ACTIVE, а `count(DISTINCT user_id)=2` по **всем** строкам. (3) `DIRECT_KEY_UNRESOLVED` preflight **до** изменения схемы (id чатов в `DETAIL`) + повторный fail-fast после backfill. (4) CHECK добавляются **`NOT VALID`**, затем `VALIDATE CONSTRAINT` — ошибка называет constraint. (5) Новый `ck_chats_direct_key_format`: два UUID и `least < greatest` (закрывает обход unique через `B:A`). (6) `DIRECT_PAIR_DUPLICATE` preflight + runbook §6.5.2 (soft-delete более нового чата: partial unique по `deleted_at IS NULL`, данные не удаляются). | **PG16 smoke (notes §11.4.1):** V1–V15 + seed + §6.5 → **exit 0**; degraded DIRECT (1 ACTIVE + 1 REMOVED) → `…001:…003`; deleted DIRECT → `…001:…002`; GROUP → NULL; corrupt (1 member) → `DIRECT_KEY_UNRESOLVED` + id; duplicate pair → `DIRECT_PAIR_DUPLICATE`, после runbook V16 применяется, живых дублей 0. Testcontainers-тест — E7-B1 (условие GO #1). |
| **P1-I01-1** handoff | §6.3 (**1573–1963**: `Chat`, `ChatCreateRequest`, `ChatSummary.name`, capability, patterns, `maxLength`), §6.3.1 (**1964–2064**: D-S4-01…06 + A–F), §6.6 (**2651–2695**), §6.2.1 (semantics/rollout), §3.1 (legacy-путь) | 6 решений PM (D-S4-01…06) и пофайловый handoff: `Chat`/`ChatCreateRequest` — **add** (в контракте отсутствуют), `POST /workspaces/{id}/chats` — **add** (сейчас только GET); `ChatSummary.name` → `[string,"null"]` (D-S4-02); `DeviceRegistration` — ключи **optional в схеме, all-or-none в семантике**, без ключей → `201` legacy, Phase 2 — version floor (D-S4-03); `MessageCreateResult.envelope_coverage` — optional в схеме, **нормативно обязателен для E2EE** (D-S4-04); `PrekeyBlock.spk_id/opk_id` — pattern `^[A-Za-z0-9._-]+$`, `ciphertext.maxLength: 44054` (D-S4-05); `ChatSummary`/`Chat.peer_has_e2ee_capable_devices` (D-S4-06); `peer_id` (P1-H). Точный порядок: openapi → ws-protocol → `npm run api:types` → `contract:check` → backend DTO → frontend; всё одним PR. Точные paths/статусы/коды — таблица §6.3.1 B; 13 contract-тестов — §6.3.1 E; критерий «I-01 применён» — §6.3.1 F. | Contract-тесты (§6.3.1 E): `GET /workspaces/{id}/chats` DIRECT `name=null`; legacy `POST /devices` → 201 `e2ee_capable=false`; partial keys → 422; E2EE `MessageCreateResult` с coverage; managed — без; `vh_version:1` → 422; claim не-участником → 422; E2EE `reply_to_id` → 422; legacy-envelope → 422; no peer envelope → 409; idempotent chat create → 200. |
| **P1-B-1** legacy в coverage | §4.2 (**800–880**: target capable, coverage только capable, `uncovered`), §4.5 (**926+**), §4.7 (**957–1020**: шаг 4/7, pseudocode, новый абзац), §4.8 (**1022+**: `E2EE_LEGACY_DEVICE` расширен, `ENVELOPE_TOO_LARGE`), §5.2 (**1076+**) | `peer_devices`/`self_devices`/`peer_covered`/`self_covered` — **только `e2ee_capable`**; каждый `recipient_device_id` обязан быть capable, иначе `422 E2EE_LEGACY_DEVICE` (`details.field="envelopes[i].recipient_device_id"`) **до** `Message`/`seq`, без partial fan-out; legacy не кандидат и не в `uncovered_device_ids`; fallback-гейт (если target-check пропущен) — `409 E2EE_NO_PEER_ENVELOPE`. | **M3-peer-legacy-not-coverage**: вариант A (envelope на legacy) → 422 `E2EE_LEGACY_DEVICE`, `message_created=false`, `seq_allocated=false`, `peer_covered=0`, legacy не coverage/не candidate/не uncovered, fallback 409; вариант B (capable-only) → 201, `peer_covered=1=peer_devices`, `warning=null`. Backend integration — E7-B4. |
| **P1-C-1** reset-дубли | §3.5.1 (**617–670**: схема `content_type=2`), §5.5 (**1117–1150**: окно и дедуп), §1.3 (**127+**: cap), §8.4 (tamper-строка) | Reset несёт `failed_session_id`, **`failed_chain_dh`** (`header.dh` неудачного сообщения), **`failed_n`** (`header.n`), `reason`, `retry_of_client_message_id` (якорь). Отправитель перешифровывает **только сообщения от якоря и позже** (локальный send index ≥ индекса якоря; fallback `(chain,n)`), каждому — новый `client_message_id` + `retry_of_client_message_id` в inner payload; уже расшифрованное не повторяется. Получатель дедуплицирует по `retry_of_client_message_id` (вторая линия при ошибке окна): без UI-дубля, unread, уведомления. Метрика `e2ee_reset_duplicates`. | **L3b-session-reset-partial-delivery-dedup**: `delivered_before_reset=3`, resend ровно `[m4,m5]`, `not_resent=[m1,m2,m3]`, `duplicates_in_ui=0`, dedup key `retry_of_client_message_id`, guard-кейс (m3 переслан ошибочно) → `discarded=1`, `duplicates_in_ui=0`, `unread=0`; **L1** теперь = точный wire-фрейминг этого reset (body 217 B → padded 256, 13 нулей, sha256 `1e6a4d98…f4fe`). E2E «B расшифровал 2 из 5 → reset → 0 дублей» — E7-F5/G3. |
| **P1-G-1** in-place MANAGED | §6.2.8 (**1486–1530**: п. 3(а)/(б), п. 7 capability), §7.6 (**2771+**), §9.3 (**3013+**), §6.3/§6.3.1 (capability) | В §6.2.8 п. 3(б) «явно подтвердить MANAGED» заменено на **«новый managed-чат»**; разрешены ровно два исхода — `E2EE_ONLY` (сессия/новый E2EE-чат) или **новый** managed-чат; **in-place downgrade запрещён** (текущий чат остаётся E2EE/заблокированным). Синхронизированы §7.6/§9.3. J3 не менялся (он и был нормативным). Критерий «признаки E2EE» стал проводным: `ChatSummary.peer_has_e2ee_capable_devices` вместо недоступного для MANAGED `GET /keys` (P2-10). | **J3** (без изменений: `allow_after_user_confirmation = "E2EE_ONLY (or a NEW managed chat; never an in-place downgrade)"`, `plaintext_messages_sent=0`) + contract-тест `peer_has_e2ee_capable_devices` + Playwright fresh context (E7-F5). |
| **P2-6** B3/B4 signatures | §8.1–§8.4 (**2786–2938**), §6.3.1 (A), vectors B3/B4, `meta.conventions.signature_encoding` | `B3.expected.signature` и `B4.expected.signature` — **wire-b64u64** (86 символов, 64 B); байтовый KAT — `expected.signature_hex` (в wire не попадает). `F1.prekey.signature == B4.signature` проверяется. Конвенция исправлена: B3/B4 больше не в списке «internal hex». §8.3: Java DTO подаёт `signature`, а не hex. | Verifier: 86 b64u, decode 64 B, `b64u(signature_hex)==signature`, Ed25519-verify по hex, F1==B4; `meta.checks` 345. |
| **P2-3** `key_verifications` ownership/FK | §6.5 (**2344–2417**: таблица 4 + INSERT-триггер), §6.5.1 | Composite FK `(verifier_user_id, verifier_device_id) → auth.devices(user_id, id)` (V2 уже имеет `UNIQUE (user_id, id)`); FK `chat_id → chat.chats`, `workspace_id → workspace.workspaces`, `target_device_id → auth.devices`; строгий scope — `BEFORE INSERT` триггер `auth.check_key_verification_scope()` (ACTIVE-членство verifier и target, чат текущего workspace, не удалён) → `VERIFICATION_SCOPE_MISMATCH`/`23514`. RLS оставлен **tenant-границей**, а не `WITH CHECK` по членству: `WITH CHECK` переоценивается на `UPDATE`, и revoke (`revoked_at`) после выхода target из чата или soft-delete чата был бы заблокирован (регрессия; T29/T30). | PG16 T16–T22, T29/T30: валидная строка = 1; чужой verifier → `23503`; target не участник → `23514`; чат другого workspace → `23514`; cross-tenant SELECT = 0; `vh_version=1` → `23514`; revoke после REMOVED/soft-delete → ok. |
| **P2-4** claim workspace | §6.5 (**2194–2249**: `claim_one_time_prekey`), §6.5.1 | В membership-`EXISTS` добавлен `JOIN chat.chats c ON c.id = me.chat_id AND c.deleted_at IS NULL AND c.workspace_id = ops.current_workspace_id()`. | PG16 T06: claim в чате W2 при `app.workspace_id=W1` → `22023 UNKNOWN_DEVICE` (OPK не сожжён); T07/T08: свой чат → `opk-1`, `opk-2`. |
| **P2-1** 7 индексов vs 4 | §6.5 (**2273–2338**: `ensure_partition`, таблица envelopes), §6.5.1 | Из `ensure_partition` убраны три `CREATE INDEX` для `message_envelopes_*`: parent-индексы `ix_envelopes_*` наследуются автоматически (включая будущие партиции). У `messages` child-индексы оставлены (unique нельзя создать на parent без partition key). | PG16: на каждой партиции envelopes **4** индекса (PK + 3), включая новую `message_envelopes_2027_02`, созданную вызовом `ensure_partition`. |
| **P2-5** safety number 80→64 | §7.2 (**2696–2712**), vectors G2/G3 | `entry = user_id(16) \|\| device_id(16) \|\| fingerprint(32)` = **64 байта** (было ошибочно «80»); формула/значения G2/G3 не менялись, note исправлен. | Verifier: entry ровно 64 B для G2/G3; G2 sha512/digits/display/qr совпадают. |
| **P2-11** form cap vs canonical | §1.3 (**127–175**), §3.5.1 (**617+**), §4.1, §4.5, §4.7, §4.8, §6.3, §6.5 (**2541–2556**: CHECK), §6.5.1, §8.4 | Приём — **канонический** 33040 decoded / 44054 encoded (API `413 ENVELOPE_TOO_LARGE`, `details.reason="canonical"`; DB CHECK `16..33040`). `65536` encoded — только **form guard до base64-decode** (`details.reason="form"`), не обещание доставки; контракт `maxLength: 44054`. | PG16 T11/T12: 33041 → `23514`, 33040 → принят. Verifier: `meta.limits.db_ciphertext_max_decoded_bytes == max_ciphertext_decoded_bytes == 33040`, form guard 65536 > 44054. Boundary-тесты — E7-B7. |
| **P2-7/8/9/10** контракт | §6.3, §6.3.1 (D-S4-02/03/05/06), §6.6 | `ChatSummary.name` nullable (не derived); `Chat`/`ChatCreateRequest` add; prekey id patterns; legacy `DeviceRegistration` rollout; `peer_has_e2ee_capable_devices` для J3. | Contract-тесты §6.3.1 E; schema regen. |

### 1.1. I-01 — что именно применяет PM (без изобретений)

§6.3.1 фиксирует: 6 решений (**D-S4-01…06**), полную таблицу схем (add/extend + поля/required/паттерны), таблицу paths (метод, статус, коды), WS-события, **точный порядок** `openapi.yaml → ws-protocol.md → npm run api:types → contract:check → backend DTO → frontend`, 13 обязательных contract-тестов и критерий «I-01 применён» (F). `contracts/**` в S4 **не редактировались**; I-01 остаётся **open для PM**.

### 1.2. P2, закрытые/уточнённые в S4

| ID | Что сделано | Где |
|---|---|---|
| P2-1 | envelopes: parent-only индексы, 4 на партиции | §6.5, §6.5.1 |
| P2-3 | `key_verifications`: composite FK ownership + FK + RLS scope | §6.5, §6.5.1 |
| P2-4 | claim: workspace-check | §6.5, §6.5.1 |
| P2-5 | safety number entry 64 B | §7.2, vectors |
| P2-6 | B3/B4 wire b64u64 + `signature_hex` | §8, vectors, meta |
| P2-7 | `ChatSummary.name` nullable; `Chat`/`ChatCreateRequest` add | §6.3, §6.3.1 |
| P2-8 | prekey id patterns | §6.3, §6.3.1 |
| P2-9 | legacy `DeviceRegistration` rollout (Phase 1/2) | §6.2.1, §3.1, §6.3.1 |
| P2-10 | `peer_has_e2ee_capable_devices` (J3 реализуем) | §6.2.8, §6.3, §6.3.1 |
| P2-11 | canonical cap 33040 в API+БД; 65536 — form guard | §1.3, §4, §6.3, §6.5 |
| P2-2 | **не вводится** в v1: global `UNIQUE (message_id, recipient_device_id)` невозможен на partitioned-таблице (partition key `created_at`); идемпотентность app-level + тест E7-B4 (ответ на вопрос 8 review-03) | §6.5.1, §10.11 |
| P2-17/P2-19 | вне зоны S4 (backend-код/внешние consumers); зафиксированы как условия GO #3/#4 | §6.5 (комментарий), §10.11 |

Не входили в зону S4 и остаются P2: 12 (chat-scoped verification UX), 13 (wire budget max ids), 14 (generation overflow), 15 (idle TTL с outbox), 16 (MKSKIPPED eviction), 20 (EXPLAIN), 21 (`vh_version` default), 22 (RLS-null-context). Все — backlog E7-B7/v1.1 (§10.11 п. 12).

---

## 2. Векторы v4

### 2.1. Состав

- **17 секций, 45 векторов**, `vector_set_version=4`; 16 нормативных + `H-sender-key` informative.
- Новые: **M3-peer-legacy-not-coverage**, **L3b-session-reset-partial-delivery-dedup**.
- Пересчитаны: **L1** (`failed_chain_dh` в теле, framing 217→243→256, 13 нулей, sha256 `1e6a4d98…f4fe`), **B3/B4** (`signature` → b64u64, `signature_hex` — KAT).
- Только note: **G2** (64-byte entries).
- `meta.checks.verifier_checks = 345`, `meta.generator.verify_command` синхронизирован; `meta.normative_invariants` (7 инвариантов), `meta.limits.db_ciphertext_max_decoded_bytes = 33040`; `meta.review = review-03` + `addressed_in_this_set`.
- Envelope wire format не менялся (`protocol_envelope_version=1`).

### 2.2. Команды и результат (полная цепочка с нуля)

```bash
# 0) v3 из notes §9.1 + §10.2
python3 gen_e2ee_vectors_s2.py     # vectors: 34 sections: 13
python3 gen_e2ee_vectors_s3.py     # vectors: 43 sections: 17
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 1fa70ac1e9f5f043365471a0fc0a4d44d1936d6272e25b3a5badd235fc0f1cd8  (= S3/hash review-03)

# 1) S4-патч (notes §11.2)
python3 gen_e2ee_vectors_s4.py     # vectors: 45 sections: 17
# B3 wire: wjk09AvS…_WdDw
# L1 padded: 256 sha256: 1e6a4d9880c710c9c1c4faae0913e78244d08c036a077b7fdae000e1cb87f4fe
shasum -a 256 docs/E2EE-TEST-VECTORS.json
# 2d69c941f892a2f1ed4469d6f1a7b0ccabbf678c07faf44a949b9ed19a0a9c26
cmp docs/E2EE-TEST-VECTORS.json <repo>/docs/E2EE-TEST-VECTORS.json
# IDENTICAL

# 2) независимый верификатор (notes §10.3 + §11.3)
node verify_e2ee_vectors_s4.mjs docs/E2EE-TEST-VECTORS.json
# 345 checks, 0 failures
```

Проверено, что источник в notes §11.2 исполним **сам по себе**: извлечённый из notes генератор на извлечённом из notes v3 даёт файл, **байт-в-байт** совпадающий с закоммиченным v4; извлечённый из notes верификатор даёт те же **345/0**. Это не «значения из головы»: вся цепочка `§9.1 → §10.2 → §11.2` воспроизводится.

### 2.3. Что проверяет дельта (72 проверки)

B3/B4: 86-b64u, decode 64 B, `b64u(signature_hex)`, Ed25519-verify, `B4.signature == F1.prekey.signature`. G2/G3: entry 64 B. L1: пересчёт body/raw/padded/нулей/sha256 + `failed_chain_dh` b64u32. M3: legacy 422, `peer_covered=0`, не candidate/не uncovered, fallback 409, variant B 201/covered=1/warning=null, embedded envelope wire-valid v1 без prekey. L3b: resend от `failed_n`, m1–m3 не перешифрованы, 0 дублей, dedup key, guard-кейс, `superseded`, nothing lost. meta: 7 инвариантов, DB cap = canonical 33040 ≠ 65536, review-03, `verifier_checks` = факт.

### 2.4. PG16 smoke для §6.5 (normal + degraded DIRECT)

PostgreSQL **16.16** (Docker `postgres:16`), отдельная БД на сценарий; V1–V15 как есть, seed **до** V16, §6.5 — одной транзакцией.

| Что | Ожидание | Факт |
|---|---|---|
| V1–V15 + seed + §6.5 (normal + degraded + deleted DIRECT) | exit 0 | **exit 0** |
| `krug_app` conformance T01–T30 | 30/30 | **30/30, 0 failures** |
| `direct_key` degraded (1 ACTIVE + 1 REMOVED) | заполнен | `…001:…003` |
| `direct_key` deleted DIRECT | заполнен | `…001:…002` |
| `direct_key` GROUP | NULL | NULL |
| индексы партиции envelopes | 4 (было 7) | **4**, в т.ч. новая партиция |
| `krug_app` conformance (30 проверок: RLS, claim, cap, CHECK, ownership, direct_key format, revoke-регрессия) | 30/30 | **30/30, 0 failures** |
| corrupt DIRECT (1 member) | понятная ошибка | `DIRECT_KEY_UNRESOLVED` + id |
| duplicate live pair | понятная ошибка | `DIRECT_PAIR_DUPLICATE` + pair |
| runbook §6.5.2 → повтор V16 | применяется | exit 0, живых дублей 0 |

Полный лог/команды — notes **§11.4.1**. Это не Testcontainers E7-B1 (нет Flyway, гонки claim, реальных объёмов) — smoke доказывает исполнимость на вырожденных данных, а миграционный тест остаётся условием GO #1/#2.

---

## 3. Отчёт по формату `docs/TASKS.md` §5

> `docs/TASKS*.md` в S4 не изменялись (зона S4 их запрещает). Отчёт приведён здесь в формате §5.

## Статус
**DONE** — S4 targeted remediation в зоне `docs/E2EE-*`; I-01 и implementation-гейты (E7-B1/B3/B4/B5, G2–G4) остаются внешними зависимостями.

## Сделано
- P1-A-1: инвариант `direct_key` (участники независимо от status), backfill, `NOT VALID`+`VALIDATE`, format CHECK, duplicate preflight, runbook §6.5.2.
- P1-I01-1: §6.3.1 — D-S4-01…06, схемы/пути/статусы, порядок файлов, 13 contract-тестов, критерий приёмки.
- P1-B-1: coverage только по `e2ee_capable`, legacy-target → 422; M3.
- P1-C-1: reset-окно (`failed_chain_dh`/`failed_n`/`retry_of_client_message_id`) + дедуп на получателе; L3b; L1 пересобран.
- P1-G-1: только `E2EE_ONLY`/новый managed-чат, in-place запрещён; §7.6/§9.3 синхронизированы; capability-канал для J3.
- P2-1/3/4/5/6/7/8/9/10/11 — см. §1.2.
- Векторы v4: 45/17, 345/0, полная воспроизводимость цепочки, sha256.
- PG16 smoke: normal + degraded + corrupt + duplicate; 30/30 conformance (включая revoke-регрессию).

## Файлы
- `docs/E2EE-SPEC.md` (3 449 строк; S4)
- `docs/E2EE-TEST-VECTORS.json` (v4; 45 векторов / 17 секций)
- `docs/E2EE-SPIKE-NOTES.md` (§11: генератор, верификатор-дельта, воспроизведение, PG16 smoke)
- `docs/E2EE-S4-CHANGELOG.md` (этот файл)

## Проверки
- `python3 gen_e2ee_vectors_s2.py && python3 gen_e2ee_vectors_s3.py && python3 gen_e2ee_vectors_s4.py` → `45 sections: 17`; v3 sha256 `1fa70ac1…1cd8`, v4 sha256 `2d69c941…9c26`; `cmp` → IDENTICAL.
- `node verify_e2ee_vectors_s4.mjs docs/E2EE-TEST-VECTORS.json` → **345 checks, 0 failures**.
- PG16.16: V1–V15 + seed + §6.5 → exit 0; 30/30 conformance (T01–T30); 4 индекса на партиции (включая новую); corrupt/duplicate → коды + runbook.
- Покрытые сценарии: degraded DIRECT, legacy coverage, partial reset, in-place mode, contract delta, B3/B4 wire, ownership, claim workspace, canonical cap.

## Контракт
- Отклонений от `contracts/openapi.yaml` **в коде нет**, потому что контракт не менялся. Delta зафиксирована текстом: §6.3 (diff) и §6.3.1 (точный handoff + D-S4-01…06). I-01 open до PR PM.

## DDD
- Не применимо: S4 — только docs/vectors, кода нет. Пакеты/ArchUnit не менялись.

## Риски и вопросы
- I-01 не применён: backend/frontend несовместимы с новыми DTO до PM-PR (§6.3.1).
- PG16 smoke — не Testcontainers E7-B1: нет Flyway/гонки claim/реальных объёмов; repair runbook должен быть частью B1.
- P2-17 (`ON CONFLICT … security_mode`) и P2-19 (`identity_public_key` consumers) — вне зоны docs, но условия GO #3/#4.
- Reset-дубли закрыты протокольно (окно + дедуп), но E2E «2 из 5 → 0 дублей» ещё не прогонялся (E7-F5/G3).
- J3-capability теперь проводной, но требует derived-поля в backend — part of I-01.
- Fresh-device без server-signed mode attestation — остаточный риск (v2).
- TOFU-окно первого контакта и malicious server остаются в модели угроз.

## Что дальше
1. PM: применить I-01 (§6.3.1) одним PR + `npm run api:types` + contract-check + 13 тестов.
2. Backend: E7-B1 — V16 на реальном снимке V1–V15 (normal/degraded/duplicate), затем B3/B4/B5; предусловия P2-17/P2-19.
3. Frontend: E7-F2 (storage/уничтожение), F4 (TOFU+prekey equality), F5 (reset-окно/дедуп + fresh-device mode).
4. G2 (браузерные KAT), G3 (E2E два браузера), G4 (внешний review реализации) — до включения E2EE.
5. Повторный review S4: §6.5/§6.5.2, §4.7, §5.5, §6.3.1 и vectors v4.

---

## Artifacts

| Артефакт | Путь | Метрика |
|---|---|---|
| Спека S4 | [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) | 3 449 строк; §0.3 карта S4; §3.5.1; §4.2/§4.7; §5.5; §6.3/§6.3.1; §6.5/§6.5.1/§6.5.2; §10.11 |
| Векторы v4 | [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) | 45 векторов / 17 секций / `vector_set_version=4`; 345 checks, 0 failures; sha256 `2d69c941f892a2f1ed4469d6f1a7b0ccabbf678c07faf44a949b9ed19a0a9c26` |
| S4-генератор | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §11.2 | `gen_e2ee_vectors_s4.py`; детерминирован; воспроизводит v4 байт-в-байт |
| S4-верификатор | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §11.3 | §10.3 + 5 правок + блок; 345/0 |
| PG16 smoke | [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §11.4.1 | V1–V15 + §6.5; normal/degraded/corrupt/duplicate; 30/30 |
| Этот отчёт | [`docs/E2EE-S4-CHANGELOG.md`](<E2EE-S4-CHANGELOG.md>) | отчёт §5, closure matrix, artifacts |

---

## Closure matrix

Статусы: **closed** — исправлено в зоне S4 и подтверждено вектором/проверкой; **partial** — исправлено в спеке, но требует внешнего применения/реализации; **open** — не входит в зону S4 или не исправлено.

### P0 (review-03: 4/4 closed — регрессий нет)

| ID | review-03 | S4 | Доказательство / остаток |
|---|---|---|---|
| P0-1 per-device verification | closed | **closed** (без изменений) | DDL/API/VH v2/G5 сохранены; `key_verifications` усилен ownership (P2-3) |
| P0-2 TOFU pin | closed | **closed** (без изменений) | §3.3.1, §4.7 п. 4a; I1–I3 |
| P0-2b prekey↔registered/bundle | closed | **closed** (без изменений) | I3; legacy-путь `DeviceRegistration` не ослабляет: keys → полная проверка |
| P0-3 mode immutability | closed (P1-G text) | **closed** (P1-G-1 исправлен) | §6.2.8 3(б): только E2EE_ONLY/новый managed; J1–J3; trigger проверен (T28) |
| P0-4 own copy | closed | **closed** (без изменений) | §3.4.6/§5.2 |

### P1

| ID | review-03 | S4 | Доказательство / остаток |
|---|---|---|---|
| P1-A DDL | partial (P1-A-1) | **closed (spec/DDL)** | §6.5; PG16 normal+degraded exit 0; 30/30; Testcontainers — E7-B1 |
| P1-A-1 degraded DIRECT | open (blocker) | **closed (spec/DDL)** | инвариант/backfill/NOT VALID+VALIDATE/runbook; PG16 degraded + deleted + corrupt + duplicate |
| P1-B coverage | partial | **closed** | target capable (422), coverage only capable; **M3** |
| P1-B-1 legacy | open | **closed** | §4.2/§4.7/§4.8/§5.2; M3 |
| P1-C reset | partial | **closed** | окно + дедуп; **L3b**; L1 |
| P1-C-1 duplicates | open | **closed** | L3b guard-кейс; E2E — E7-F5 |
| P1-D FS 3/90 | closed | **closed** (без изменений) | S1 |
| P1-E wire encoding | closed | **closed** (+B3/B4) | I1–I3, B3/B4, F1 |
| P1-F `reply_to_id` | closed | **closed** (без изменений) | R1; DB CHECK (T13) |
| P1-G fresh-device | partial | **closed** | §6.2.8 3(a)/(б)+п. 7; §7.6/§9.3; J3 |
| P1-G-1 in-place | open | **closed** | только новый managed-чат; trigger T28 |
| P1-H `peer_id` | closed | **closed** (handoff уточнён) | §6.3/§6.3.1; contract — I-01 |
| P1-1 R-15 | partial | **closed** | L3b + §5.5 |
| P1-5 DIRECT uniqueness | partial | **closed (spec/DDL)** | §6.5 5a–5e; T23–T26 |
| P1-6 POST /devices | closed | **closed** (+legacy rollout) | §6.2.1/§3.1; N1/N2; D-S4-03 |
| P1-7 coverage 0 peer | closed | **closed** | M1/M2 + M3 |
| P1-8 FS window | closed | **closed** (без изменений) | S1 |
| P1-9 DHs_A | closed | **closed** | E1/§3.4.2 |
| P1-10 client_message_id | closed | **closed** | K1/K2 |
| P1-11 K_storage | closed | **closed** | §2.3 |
| P1-12 flag-off | closed | **closed** | J2/§10.4 |
| **P1-I01-1** handoff | partial | **closed (spec)** | §6.3.1 D-S4-01…06 + A–F; контракт не применён |

### I-01 / P2

| ID | Статус | Комментарий |
|---|---|---|
| **I-01** contract | **open (PM)** | §6.3.1 — точный handoff; `contracts/**` не менялись; критерий приёмки — §6.3.1 F |
| P2-1 indexes 7→4 | **closed** | parent-only; PG16 = 4 |
| P2-2 envelope unique | open (by design v1) | app-level идемпотентность; §10.11 п. 8 |
| P2-3 key_verifications ownership | **closed** | FK + INSERT-trigger + tenant-RLS; T16–T22, T29/T30 |
| P2-4 claim workspace | **closed** | T06 |
| P2-5 safety number 64 | **closed** | §7.2; verifier |
| P2-6 B3/B4 b64u | **closed** | §8.3; vectors; verifier |
| P2-7 ChatSummary.name / Chat | **closed (spec)** | §6.3/§6.3.1; contract — PM |
| P2-8 prekey id patterns | **closed (spec)** | §6.3; contract — PM |
| P2-9 legacy DeviceRegistration | **closed (spec)** | D-S4-03; contract — PM |
| P2-10 capability channel | **closed (spec)** | D-S4-06; contract — PM |
| P2-11 form cap vs canonical | **closed** | API+DB 33040; T11/T12 |
| P2-12/13/14/15/16/20/21/22 | open | backlog E7-B7/v1.1; не блокируют B1 |
| P2-17 upsert `security_mode` | open (backend) | условие GO #3; вне зоны docs |
| P2-18 repair duplicates | **closed (runbook)** | §6.5.2 + preflight |
| P2-19 `identity_public_key` | open (backend/BI) | условие GO #4 |

**Итог матрицы.** P0: **4/4 closed** (без регрессий). P1-A/B/C/G: **4/4 closed в зоне спеки** (A/B/C — spec+DDL+smoke; G — текст/J3), остальные P1 — без регрессий. I-01 — **closed (spec)**, open для PM (контракт). P2: 10 закрыто/уточнено (1,3,4,5,6,7,8,9,10,11,18), 2 — by design/backlog, 2 — backend-условия (17,19).

---

## Residual risks (честно)

1. **I-01 не применён**: до PM-PR backend/frontend несовместимы с новыми DTO; S4 даёт точный handoff, но не контракт.
2. **PG16 smoke ≠ Testcontainers E7-B1**: нет Flyway, гонки claim, реальных исторических объёмов, `EXPLAIN`. Repair runbook §6.5.2 должен быть частью B1.
3. **`ON CONFLICT … security_mode` (P2-17)** и **consumers `identity_public_key` (P2-19)** — вне docs-зоны; до их закрытия trigger/`DROP COLUMN` в B1 рискованны.
4. **Reset-дедуп — протокол, не доказательство E2E**: L3b фиксирует семантику; нужен E2E «2 из 5 → 0 дублей» и метрика `e2ee_reset_duplicates`.
5. **J3-capability требует backend-поля** `peer_has_e2ee_capable_devices` (I-01) — до него fresh-device опирается на локальный пин/workspace-признак.
6. **Legacy-регистрация (D-S4-03)** намеренно оставляет окно: старый клиент создаёт legacy-устройство; Phase 2 (version floor) должна быть запланирована, иначе legacy-устройства будут накапливаться.
7. **P2-6 squatting**, **TOFU-окно**, **fresh-device без mode attestation**, **zeroization best-effort**, **PCS не мгновенный** — остаются как в S3 (§10.6/§9.3).
8. **P2-11**: 33040 — предел канонического v1; увеличение inner body потребует нового фрейминга/лимитов (не менять без версии).
9. **S4 не проверяет браузерный WebCrypto/IndexedDB** — G2/G3 вне зоны S4.

---

*Конец E2EE-S4-CHANGELOG. Изменены только `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md` и создан этот файл. `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, reviews не изменялись.*

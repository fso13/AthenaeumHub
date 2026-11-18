# E2EE-S2 — changelog remediation по E2EE-REVIEW-01

> **Статус:** DONE (spec + vectors + notes). Production-код не писался; `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, `docs/E2EE-REVIEW-01.md` не изменялись.
> **Вход:** [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>) — **GO WITH CONDITIONS**, 4 P0, 12 P1, 14 вопросов.
> **Выход:** [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) (редакция S2), [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) (`vector_set_version=2`: 34 вектора, 13 секций, 189 проверок), [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) (§9: генератор/верификатор S2).
> **Вердикт S2:** все 4 P0 и 12 P1 **закрыты в спеке/векторах**; envelope wire format **не менялся** (`envelope.v=1`). Условия GO считаются выполненными для перехода к E7-B1/B2, при сохранении G4 (внешний review реализации) до включения E2EE.
> **Ограничение зоны:** отчёт по формату `docs/TASKS.md` §5 находится в §11 этого файла, потому что `docs/TASKS*.md` менять запрещено.

---

## 0. Итог

| Метрика | Было (v1) | Стало (S2) |
|---|---|---|
| P0 закрыто | 0/4 | **4/4** |
| P1 закрыто | 0/12 | **12/12** |
| Векторы | 24 в 9 секциях | **34 в 13 секциях** |
| Проверки | 88 | **189, 0 failures** |
| `verification_hash` | u8(1), без устройства | **u8(2), `verifier_device_id`** |
| Envelope wire | v1 | **v1 (без изменений)** |
| `messages` режим | новый `security_mode` (ошибка) | **существующий `crypto_scheme='E2EE_PAIRWISE'`** |
| Своя копия | не гарантирована | **атомарная копия + outbox до send** |
| Self-envelope | обсуждался | **отклонён PM** |

Ключевые решения PM, реализованные в S2: **D-05** (`chat_id` в claim), **D-06** (512 KiB wire / 64 KiB encoded на конверт / 32 KiB decoded body), **D-07** (`client_message_id` в `Message`, scope по отправителю), **D-17** (legacy не апгрейдится in-place), **две identity-пары с самоподписью**, **self-envelope отклонён**.

---

## 1. Что именно изменено (карта файлов)

| Файл | Изменения |
|---|---|
| `docs/E2EE-SPEC.md` | §0.1 (карта P0/P1), §1.2–1.4 (VH v2, D_IKBIND, лимиты), §2.1–2.5 (binding, K_storage, legacy), §3.1–3.6 (IKB, TOFU, R-15, DHs, FS, локальная копия), §4.1–4.8 (wire/лимиты/ошибки/coverage), §5.1–5.7 (multi-device, reset, TOFU), §6.1–6.6 (API/OpenAPI/DDL/flag-off), §7.1–7.6 (per-device verification), §8 (34 вектора, 189 проверок), §9 (threat model), §10 (план/риски/ответы), §11 (ADR), §12 (чек-лист), Приложения A/B. |
| `docs/E2EE-TEST-VECTORS.json` | `vector_set_version=2`; G4 пересчитан; G5, B5, I1–I2, J1–J2, K1–K2, L1–L2; `meta.limits`, `meta.checks`, `meta.review`; E1/E2 header + `v` (байты не изменились). |
| `docs/E2EE-SPIKE-NOTES.md` | §9: полный генератор S2, полный независимый verifier S2, арифметика, решения, handoff; §4 помечен как исторический. |
| `docs/E2EE-S2-CHANGELOG.md` | этот файл. |
| `backend/**`, `frontend/**`, `contracts/**` | **не менялись**; delta — только предложения в §6 спеки. |

---

## 2. Версии и совместимость

- **Envelope wire format не менялся:** `envelope.v=1`, `header.v=1`, AD 163 B, преамбул `313+L+M`, домены `Krug/E2EE/v1/*` (кроме нового `ik-binding`).
- **`VH` перешёл на v2** (`u8(2)` + `verifier_device_id`). Это не поле конверта, а server-side attestation; старые значения `u8(1)` **недоверенны** и не переносятся. Векторы G4 обновлены; G5 добавлен.
- **`identity_binding_signature`** — новое поле `POST /devices`, `claim`, `GET /keys`; не входит в envelope, поэтому не требует bump `envelope.v`. Домен `Krug/E2EE/v1/ik-binding`, сообщение 88 B.
- **`client_message_id`** уже был в `MessageCreate`/БД; добавлен в `Message` (nullable), scope изменён на `(chat_id, sender_id, client_message_id)`.
- **DDL:** миграции V16+ (forward-only) против фактических V1–V15; старый DDL из §6.5 v1 (`messages.text`, `security_mode` на messages) **не применять**.
- **API breaking changes** (осознанно, до реализации): `POST /devices` требует `IK_sig`/`IK_dh`/binding/SPK; `verified` per device; `security_mode` read-only/immutable; `ciphertext` OpenAPI 363/65536; coverage split peer/self.

---

## 3. P0 — закрытие

### P0-1. Verification per-device (verifier device, не user)

**Дефект ревью:** `key_verifications` уникальна по `(verifier_user_id, target_device_id, chat_id)`, а safety number — на пару устройств. Второе устройство пользователя наследовало «verified», ничего не сверяя.

**Что изменено:**

- DDL: `auth.key_verifications.verifier_device_id uuid NOT NULL`; уникальность `(verifier_device_id, target_device_id, chat_id)`; `verifier_user_id` — денормализация для аудита (§6.5).
- API: `GET /chats/{id}/keys` возвращает `verifier_device_id`, `verified`/`verified_at`/`method` только для пары с устройством из `X-Device-Id`, `verified_count`/`devices_total` как агрегат; для себя `null` (§6.2.6).
- `PUT /chats/{id}/keys/verification`: verifier device берётся из `X-Device-Id` (не из body), response эхоит `verifier_device_id`; нельзя аттестовать с чужого устройства (§6.2.7).
- `VH` v2: `SHA-256(D_VER || u8(2) || chat || verifier_user || verifier_device || target_device || u32(gen) || digits60)` (§7.4).
- UI/UX: `verified` не рисуется замком; «сверено на другом устройстве» — информационная строка; локальная сверка — источник истины (§7.5, P2-5).
- Миграция: строки без известного `verifier_device_id` не переносятся/не считаются verified (backfill не угадывается).

**Векторы/тесты:**

- **G4-verification-hash** пересчитан: `6badfd8f…772c` (b64u `a639j3e3…Ldyw`).
- **G5-verification-per-device**: L1 и L2 (второе устройство Alice, `…012`) имеют разные device-pair digits и разные VH; `server_verified_for_l1=true`, `server_verified_for_l2=null`; `hashes_differ=true`.
- Интеграционный тест: L1 сделал `PUT`, L2 делает `GET /keys` → `verified=null`; L2 не может «перезаписать» чужую сверку.
- DB: partial/regular unique `(verifier_device_id,target_device_id,chat_id)`; revoke target сбрасывает только строки target.

**Остаточный риск:** malicious-сервер может врать о `verified`; клиент обязан игнорировать серверный флаг как доказательство (принято, §7.6).

---

### P0-2. TOFU-пиннинг identity отправителя по `device_id`

**Дефект ревью:** §3.3.1 перечислял проверки, но не требовал сравнения identity отправителя с локальным пином; подмена пары для существующего `device_id` проходила (валидная подпись/AD/AEAD).

**Что изменено:**

- §3.3.1 — **исчерпывающий** чек-лист: подпись → **binding IK_sig→IK_dh** → recipient keys/SPK/OPK/session/chat/devices → **TOFU-пин** `(user_id, device_id) → {IK_sig, IK_dh, fingerprint, identity_binding_signature, key_generation}`.
- Пиннинг **по `device_id`**, не по `user_id`; первый контакт: пин создаётся **после** проверок и **до** отображения/создания сессии; `verified=false`, warning.
- Mismatch: `KEY_CHANGE_DETECTED`; не отображать, не создавать/перезаписывать сессию, не расходовать OPK, блокировать отправку до явного подтверждения, сбросить verified для этого устройства.
- §3.3.2/§3.3.3: те же проверки на A и B; §5.6/§7.5 — UX/серверный audit `IDENTITY_KEY_CHANGED`.
- Binding-подпись приходит из `GET /keys`/claim (не из envelope), проверяется клиентом; отсутствие binding для нового устройства → отказ.

**Векторы/тесты:**

- **I2-tofu-identity-mismatch** (negative): сервер подменил пару для существующего `device_id`. Конверт wire-валиден, подпись Mallory валидна, recipient keys/session_id/AD/AEAD проходят, binding Mallory валидна — но `pin_mismatch=true`, `decision=KEY_CHANGE_DETECTED`, `session_created=false`, `opk_consumed=false`, `send_blocked_until_confirmation=true`.
- **I1-tofu-first-contact-no-pin**: пин создаётся, `verified=false`; честно фиксируется TOFU-окно (подмена при первом контакте не детектируется).
- E2E-AC-09; интеграционный тест «key change блокирует отправку до подтверждения»; тест «пин не исчезает по TTL».

**Остаточный риск:** TOFU-окно первого контакта и отсутствие KT v1 — приняты (Q-15); safety number обязателен для закрытия.

---

### P0-3. Immutability `security_mode` и запрет downgrade

**Дефект ревью:** один `UPDATE chat.chats SET security_mode='MANAGED'` выключал E2EE; клиент начинал отправлять plaintext.

**Что изменено:**

- Сервер: `security_mode` чата и воркспейса **неизменяем**; `ops.forbid_security_mode_change()` + triggers `trg_chats_security_mode_immutable`, `trg_workspaces_security_mode_immutable` → `409 MODE_CHANGE_FORBIDDEN` (§6.5).
- `WorkspaceRepositoryAdapter` не должен делать `ON CONFLICT DO UPDATE SET security_mode`; onboarding-upsert не меняет режим (§6.5, §6.6).
- API: нет endpoint смены режима; `Chat.security_mode` readOnly; смена = новый чат/воркспейс (ADR-23/ADR-09).
- Клиент: пиннит `chat_id → security_mode` при создании/первом открытии; если сервер прислал MANAGED для E2EE — **не отправляет plaintext**, security alert, требует явного решения и нового чата; plaintext-fallback запрещён (§9.3).
- `J2`: flag-off не понижает существующий E2EE и не принимает plaintext.

**Векторы/тесты:**

- **J1-security-mode-downgrade-rejected**: server `409 MODE_CHANGE_FORBIDDEN`, `mode_changed=false`, client `BLOCK_SEND_SECURITY_ALERT`, `plaintext_messages_sent=0`.
- **J2-e2ee-creation-with-flag-off**: `409 E2EE_DISABLED`, `badge_shown=false`, existing E2EE plaintext → `422 E2EE_PLAINTEXT_FORBIDDEN`.
- Backend integration: `UPDATE`/upsert → exception/409; Playwright: «сервер сказал MANAGED → отправка заблокирована, alert».

**Остаточный риск:** malicious-сервер может врать; клиент предотвращает отправку plaintext, но не может запретить серверу менять свою БД. Честно описано (§7.6/§9.3).

---

### P0-4. Своя копия: атомарная персистенция до send, без self-envelope

**Дефект ревью:** без self-envelope собственное сообщение могло быть потеряно навсегда, если вкладка падала до записи plaintext-кэша.

**Решение PM:** self-envelope **отклонён**; вместо него — обязательная атомарная локальная копия.

**Что изменено:**

- §3.4.6: одна IndexedDB-транзакция `sessions + outbox + local_messages` записывает **новое состояние сессии + точные bytes конвертов + Idempotency-Key + client_message_id + локальную копию plaintext/ciphertext**; только после commit — сеть.
- Таблица crash/replay: до commit → не отправлено; после commit до сети → outbox шлёт те же bytes; после сети до `sent` → replay с тем же `seq`; после `sent` → копия источник; очистка кэша → `unavailable`, но факт отправки виден.
- Запрещено перешифровывать после падения; новая шифровка = новый `client_message_id` + новый `Idempotency-Key`.
- §5.2: fan-out остаётся ≤9, лимит 10; свои другие устройства — обычный fan-out; своё текущее — копия.
- §2.3: копия/outbox шифруются `K_storage`; `K_storage` не at-rest (P1-11).
- UI: «недоступно на этом устройстве» вместо пустого текста; локальная копия — не backup.

**Тесты:**

- Property/E2E crash-recovery: убить вкладку в каждой точке §3.4.6; после reload сообщение читается, дубля нет.
- Отдельно: очистить кэш → сообщение помечено `unavailable`, факт отправки/`client_message_id` виден.
- Вектора нет (это state/persistence, не KAT); E2E-AC-11.

**Остаточный риск:** очистка профиля уничтожает копию; восстановления нет (backup v1 вне E7). Принято.

---

## 4. P1 — закрытие (все 12)

| P1 | Что изменено | Где | Вектор/тест |
|---|---|---|---|
| **P1-1** R-15: нет сигнала «не расшифровал» | `content_type=2 SESSION_RESET` в **новом prekey-конверте**; не WS-событие; rate limit 1/300 с; отправитель удаляет сессию, claim, новое сообщение с новым `client_message_id`; метрика `e2ee_prekey_undecrypted_24h` | §3.5.1, §3.6, §4.4, §5.5 | L1, L2; E2E-AC-12 |
| **P1-2** IK_sig↔IK_dh не связаны | `identity_binding_signature = Ed25519(IK_sig, D_IKBIND\|\|01\|\|IK_dh\|\|IK_sig)`; сервер проверяет при регистрации, клиент — при claim/keys/смене; `422 INVALID_IDENTITY_BINDING` | §1.4, §2.2, §3.1, §3.2, §6.5 | B5; negative B5 |
| **P1-3** decoded/wire/per-envelope/OpenAPI | 512 KiB **wire** до parse; per-envelope **64 KiB encoded**; body **32 KiB decoded**; canonical 33040 B/44054 chars; OpenAPI 363/65536; 9=405098 B, 10=450099 B; прокси тот же 413 | §1.3, §3.5.1, §4.5, §4.7, §6.3 | `meta.limits`; boundary 363/44054/65536/524288; 9/10 конвертов |
| **P1-4** DDL против V1–V15 | `crypto_scheme='E2EE_PAIRWISE'` вместо нового `security_mode`; `body_ciphertext`/`sticker_id`/`content_meta`; **нет `text`**; `device_prekeys`/`key_verifications` — `CREATE`; `identity_public_key` drop; партиционные индексы | §6.5 | Testcontainers V1–V15 + INSERT/UPDATE checks |
| **P1-5** DIRECT uniqueness | `direct_key = least(uuid)\|\|':'\|\|greatest(uuid)` + partial unique `(workspace_id,direct_key)`; `peer_id` из `chat_members`; race → select | §6.2.8, §6.5 | повторный create → тот же чат; гонка |
| **P1-6** POST /devices breaking | binding, `identity_key_alg`, приоритет identity→Idempotency, global unique, legacy→422, `Device`/`DeviceView` поля, `schema.d.ts` regen | §2.5, §3.1, §6.2.1, §6.6 | contract/integration; повтор/лимит/legacy |
| **P1-7** coverage при 0 устройствах | `409 E2EE_NO_ACTIVE_DEVICES` для peer=0; split `peer_devices/peer_covered/self_devices/self_covered`; `devices.minimum:0`; warning при self uncovered | §4.2, §4.7, §6.3 | 0 peer → 409; B 2 устройства, покрыто 1 → warning |
| **P1-8** удаление ratchet-ключей/окно FS | OPK private — сразу после AEAD; старый `DHs_priv` — сразу после ratchet; `MKSKIPPED` TTL 30 д/2000; SPK private 2×30 д; окно FS/PCS оцифровано | §3.4.5, §9.2 | property: нет старых DHs; удаление SPK → отказ/reset |
| **P1-9** DHs_A = EK? | Явно: `DHs_A` — свежая пара после `SK`; запрещены `EK`/`IK_dh`/`SPK`; assert `alice-ratchet-0 ≠ alice-ek` | §3.3.2, §3.4.2 | assert в генераторе + negative implementation test |
| **P1-10** client_message_id scope | `(chat_id, sender_id, client_message_id)`; replay только своим; cross-user → `409 CLIENT_MESSAGE_ID_CONFLICT`; не в AD | §4.2, §4.6, §6.5 | K1, K2 |
| **P1-11** K_storage/STORAGE_LOCKED | Честно: не at-rest; `STORAGE_LOCKED` удалён; `KEY_STORAGE_UNAVAILABLE` для битого хранилища; DPA/UI без обещаний | §2.3, §3.6, §9.3, §9.9 | UI/DPA review; отсутствие `STORAGE_LOCKED` в коде/спеке |
| **P1-12** flag-off закрывает E2EE | Флаг запрещает **новые** E2EE workspace/chat (`409 E2EE_DISABLED`), бейдж не показывается; существующий E2EE не понижается, plaintext → 422 | §6.2.8, §6.6, §10.4 | J2; feature-flag matrix |

### Детали по P1, где были неоднозначности

**P1-3 (единицы).** `MAX_ENVELOPE_CIPHERTEXT_ENCODED_CHARS=65536` — это **form cap** именно в encoded-символах; канонический клиент ограничен 44054. `meta.limits` фиксирует: body 32768 → raw 32794 → padded 33024 → ciphertext 33040 → 44054 b64u; 9 конвертов = 405098 B (395.6 KiB), 10 = 450099 B (439.5 KiB); slack 119190/74189 B. Измерение ревью 405129 B отличается на 31 B (длина обёртки/ids), обе величины < 524288. Старый decoded-счётчик (`699051` chars ≈683 KiB) удалён.

**P1-4 (факты V1–V15).** В `message.messages` нет `text`; есть `crypto_scheme` (`NONE|MANAGED|E2EE_PAIRWISE|E2EE_SENDER_KEY`), `body_ciphertext`, `content_meta`, `client_message_id`; `sticker_id` добавлен V14; V10 уже снял CHECK `TEXT→body_ciphertext` (attachments-only). Поэтому §6.5 добавляет **не** `security_mode`/`text`, а CHECK-и: E2EE → `body_ciphertext IS NULL`, `sticker_id IS NULL`, `content_meta='{}'`, `type='TEXT'`. `device_prekeys` и `key_verifications` в V1–V15 отсутствуют → `CREATE TABLE`. `identity_public_key` в коде не используется → `DROP COLUMN`.

**P1-8 (окно FS/PCS, числа).** OPK private уничтожается сразу после успешного AEAD; старый `DHs_priv` — сразу после DH-ratchet; `MKSKIPPED` — TTL 30 дней/2000 ключей/1000 skip; SPK private — текущий + 2 предыдущих, ≥30 дней каждый (окно до 60–90 дней); `SESSION_IDLE_TTL=90 дней`. Forward secrecy для prekey-сообщения ограничена окном хранения SPK (до 60–90 дней); после DH-ratchet старые цепочки невосстановимы; PCS — только после ответного ratchet, не мгновенный. Честно записано в §3.4.5.

**P1-10 (replay).** Повтор **тем же** отправителем с теми же bytes → `201` + `Idempotent-Replay:true` + тот же `id/seq`. Повтор с тем же id и другим body → `409 CLIENT_MESSAGE_ID_CONFLICT`. Другой отправитель с тем же UUID → `409 CLIENT_MESSAGE_ID_CONFLICT`, **не** replay и **не** возврат чужого сообщения. `client_message_id` не входит в AD и не является аутентификатором прав.

---

## 5. Векторы: что добавлено/пересчитано

Новый файл: `vector_set_version=2`, 13 секций, 34 вектора, 189 проверок. Команды — §7.

| Вектор | Секция | Что фиксирует | Ожидание |
|---|---|---|---|
| **B5-identity-binding-signature** | B | Самоподпись `IK_sig→IK_dh` (88 B) | Подписи Alice/Bob валидны; подмена `IK_dh`/другой signer → false |
| **G5-verification-per-device** | G | VH v2 для L1 vs L2 | Разные hash/digits; L1 verified, L2 null |
| **G4-verification-hash** (пересчитан) | G | VH v2 c `verifier_device_id` | `6badfd8f…772c` / `a639j3e3…Ldyw` |
| **I1-tofu-first-contact-no-pin** | I | Первый контакт, пина нет | Пин создаётся, `verified=false`, TOFU-окно честно |
| **I2-tofu-identity-mismatch** | I | Валидный wire/подпись/AD/AEAD, но чужая пара для существующего `device_id` | `KEY_CHANGE_DETECTED`; нет сессии/OPK/display; отправка blocked |
| **J1-security-mode-downgrade-rejected** | J | `UPDATE`/API downgrade | `409 MODE_CHANGE_FORBIDDEN`; клиент не шлёт plaintext |
| **J2-e2ee-creation-with-flag-off** | J | flag off + существующий E2EE | `409 E2EE_DISABLED`; existing plaintext → 422 |
| **K1-client-message-id-same-sender-replay** | K | повтор своим | replay 201, тот же id/seq; scope по sender; не в AD |
| **K2-client-message-id-cross-user-conflict** | K | тот же UUID другим | `409 CLIENT_MESSAGE_ID_CONFLICT`, не replay |
| **L1-session-reset-payload** | L | `content_type=2` framing | raw 179, padded 256; hidden; prekey transport |
| **L2-session-reset-state-machine** | L | R-15 | 1 reset/300 c; новый claim; новый `client_message_id`; нет WS reset |

**Что не изменилось:** A1–A4, B1–B4, C1–C3, D1–D3, E1 (значения), E2, F1–F2, G1–G3, H1–H2 — байты прежние (кроме G4 и добавления `"v":1` в header-объекты E1/E2, что не меняет байты). Это проверено regenerate-and-diff по криптозначениям.

**Проверки:** 189 checks, 0 failures. Покрытие: RFC/NIST KAT; X3DH/DR/AEAD/envelope; IK binding; VH v2/per-device; TOFU negative с полной расшифровкой «валидного, но чужого» конверта; reset framing; арифметика лимитов; structural-инварианты J/K/L.

---

## 6. Ответы на 14 вопросов ревью

### 1. P0-1. Почему `key_verifications` привязана к `verifier_user_id`, если safety number — на пару устройств?

Это был недосмотр (не осознанный UX-компромисс): DDL/API унаследовали пользовательский уровень, хотя §6.2.6 уже говорил «для пользователя и его устройства». Исправлено: `verifier_device_id NOT NULL`, уникальность `(verifier_device_id,target_device_id,chat_id)`, `VH` v2 с устройством, `verified` читается для `X-Device-Id`. Устройство-верификатор узнаёт «свою» сверку именно по `verifier_device_id`; L2 видит `null` (G5). `verifier_user_id` оставлен только для аудита.

### 2. P0-2. §3.3.1 — исчерпывающий чек-лист? Как B отличает новое устройство peer от подмены ключей для существующего `device_id`?

Да, §3.3.1 теперь исчерпывающий: пункт 6 требует TOFU-сравнения `(sender_user_id, sender_device_id) → IK_sig/IK_dh/fingerprint/binding/generation`. Новый `device_id` = новое устройство (пин создаётся, `verified=false`, отдельный safety number); тот же `device_id` с другими ключами = `KEY_CHANGE_DETECTED` (сессия не создаётся, OPK не расходуется, отправка блокируется). Пиннинг по `user_id` запрещён. I2 — полный негативный вектор: подпись/AD/AEAD валидны, ловит только пин.

### 3. P0-3. Что будет, если сервер пришлёт `security_mode=MANAGED` для существующего E2EE-чата?

Клиент пиннит `chat_id → security_mode`; при расхождении **не отправляет plaintext**, показывает security alert и требует явного решения/нового чата. Серверный инвариант: `security_mode` неизменяем (trigger + `409 MODE_CHANGE_FORBIDDEN`), API смены нет. J1 фиксирует: `mode_changed=false`, `plaintext_messages_sent=0`, `client_decision=BLOCK_SEND_SECURITY_ALERT`. Понижение режима — атака, а не конфигурация (§9.3).

### 4. P1-1/R-15. Каким сообщением/событием B говорит A «я не смог расшифровать»?

Зашифрованным `content_type=2 SESSION_RESET` внутри **нового prekey-конверта** (не неаутентифицированное WS-событие). Тело: `{failed_session_id, failed_n, reason, retry_of_client_message_id}`. B отправляет при `SPK_DELETED`/`KEY_HANDSHAKE_INVALID`/`DECRYPT_FAILED` для prekey-конверта, rate limit 1/300 с. A удаляет неудачную сессию, делает claim, новый handshake и повтор с **новым** `client_message_id` (старый id уже занят старым ciphertext). L1/L2; E2E-AC-12; метрика `e2ee_prekey_undecrypted_24h`.

### 5. P1-9. `DHs` в §3.4.2 — это `EK` или отдельная пара?

Отдельная, **свежая** X25519-пара, сгенерированная после `SK`; запрещено использовать `EK`, `IK_dh`, `SPK` или любой ключ, уже входящий в IKM. Иначе первый root step вырождается в известный DH (например, `DH(EK,SPK)=DH3`). В генераторе есть assert `alice-ratchet-0 ≠ alice-ek`; нужен негативный тест реализации.

### 6. P1-3. 512 KiB — decoded или wire? Почему per-envelope 64 KiB, если фрейминг даёт 33040 B? Прокси?

**512 KiB — wire** (байты HTTP body до парсинга). Per-envelope — **64 KiB encoded** (65536 b64u-символов, form cap; D-06); канонический максимум 33040 B decoded = 44054 chars (43.0 KiB). 9 конвертов = 405098 B (395.6 KiB), 10 = 450099 B (439.5 KiB). Прокси/ingress обязан иметь тот же 512 KiB и тот же `413`. Старый decoded-счётчик, пропускавший ~683 KiB, удалён. OpenAPI: `minLength:363`, `maxLength:65536` (не 24/87384).

### 7. P1-4. §6.5 ссылается на `messages.text` и CHECK со `sticker_id`; колонки `text` нет, CHECK блокирует E2EE-TEXT. Миграция проверялась против V1–V15?

Старая §6.5 была эскизом и **не** проверялась. Новая §6.5 написана против фактических V1–V15: в `message.messages` нет `text`; есть `crypto_scheme`, `body_ciphertext`, `content_meta`, `sticker_id` (V14), `client_message_id`; V10 уже снял CHECK `TEXT→body_ciphertext` (attachments-only). Поэтому: `crypto_scheme='E2EE_PAIRWISE'` (не новый `security_mode`), CHECK-и на отсутствие managed-полей у E2EE, `device_prekeys`/`key_verifications` — `CREATE TABLE`, `identity_public_key` — `DROP COLUMN`. Тест на Testcontainers поверх V1–V15.

### 8. P1-5. Как обеспечивается уникальность DIRECT-пары без `direct_key`? Где `peer_id`?

`chat.chats.direct_key text` = `least(user_a,user_b) || ':' || greatest(...)`, partial unique `(workspace_id,direct_key) WHERE type='DIRECT' AND deleted_at IS NULL`; backfill только для DIRECT ровно с двумя ACTIVE-участниками; битые чаты чинятся до `VALIDATE`. `peer_id` вычисляется из `chat_members` (не хранится). Гонка: unique violation → select существующего. §6.2.8/§6.5.

### 9. P1-8. Кто и когда уничтожает старые `DHs_priv`, OPK/SPK private? Каково окно FS (числа)?

OPK private — сразу после успешного AEAD; старый `DHs_priv` — сразу после DH-ratchet (хранится только текущий); `MKSKIPPED` — TTL 30 дней/2000/1000; SPK private — текущий + 2 предыдущих, ≥30 дней каждый (окно до 60–90 дней); `SESSION_IDLE_TTL=90 дней`. Prekey-сообщение с удалённым SPK не восстанавливается → `KEY_HANDSHAKE_INVALID` + reset. FS ограничена окном SPK; PCS — после ответного ratchet, не мгновенный. §3.4.5.

### 10. P1-11. Что разблокирует пользователь в `STORAGE_LOCKED`? Как это соотносится с T-E2EE-06?

Ничего: в v1 нет passphrase/WebAuthn-PRF unlock. Поэтому `STORAGE_LOCKED` **удалён**; `K_storage` — не at-rest защита, а сегрегация/защита от извлечения raw key JS-кодом. Введён `KEY_STORAGE_UNAVAILABLE` для отсутствующего/битого хранилища. DPA/UI не обещают защиту от кражи профиля. §2.3/§3.6/§9.9; тест: `STORAGE_LOCKED` отсутствует в коде и спеке.

### 11. P1-10. `client_message_id` уникален в чате или у отправителя? Что вернёт сервер, если Bob пришлёт id, уже использованный Alice?

Scope — `(chat_id, sender_id, client_message_id)`. Повтор своим отправителем с теми же bytes → replay (201, тот же id/seq). Другой пользователь с тем же id → `409 CLIENT_MESSAGE_ID_CONFLICT`; сервер **не** возвращает чужое сообщение и не создаёт idempotency-строку на чужое. Replay-ветка обязана фильтровать `sender_id=caller`. K1/K2.

### 12. P0-4. При 5+5 устройствах и self-envelope максимум = 10; какой лимит тогда и почему §4.7 запрещает `recipient == sender`?

Self-envelope **отклонён** (решение PM), поэтому максимум остаётся 9 (5 получателя + 4 своих других), лимит 10 не меняется; §4.7 по-прежнему запрещает `recipient == sender`. Вместо self-envelope — атомарная локальная копия+outbox до send (§3.4.6): падение между commit и send/после send не теряет сообщение; очистка кэша даёт честное `unavailable`, но не восстановление. Если бы self-envelope приняли, лимит пришлось бы поднять до 11–12 — это описано как альтернатива, но не выбрано.

### 13. P2-5. «Сервер не знает digits» неверно; можно ли заменить на «не хранит» и убрать серверный `verified` из UI как индикатор доверия?

Да, заменено на «сервер **не хранит** digits» (но может пересчитать из публичных ключей); `verified` — attestation, не источник истины; в UI не рисовать замком; клиент — источник истины. §7.4, §9.1; `verified` per device.

### 14. P2-3. Почему в E1/E2 `header` без `v`, хотя §4.1 требует `[v,dh,pn,n]`?

Это была неполная внутренняя структура в векторах, а не wire-объект. В S2 в `expected_steps`/`expected.messages` добавлен `"v":1`; байты header/AD не изменились. F1/F2 уже были полными wire-объектами. §8.1/§8.6.

---

## 7. Проверки (команды и результаты)

```bash
# генерация векторов S2 (полный исходник — E2EE-SPIKE-NOTES.md §9.1)
python3 gen_e2ee_vectors_s2.py
# written; vectors: 34 sections: 13
# SK: bbaf23763ebebc2d1bc558bb9477e1b608e19d66282094873235b4f4d02bd9d5
# SID: 86c68f64d2c3be99fde4aabe857e1f5e
# safety digits: 966641447817221341546560580530883495084093893634094867501952

# независимый verifier S2 (Node.js; полный исходник — §9.3)
node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json
# 189 checks, 0 failures
```

Дополнительно проверено:

| Проверка | Результат |
|---|---|
| JSON parse + 34 уникальных id | OK |
| `meta.limits` пересчёт 33024/33040/44054/45001/405098/450099 | OK |
| G4/G5 hash v2 | OK |
| B5 binding verify/negative | OK |
| I2 полная расшифровка конверта Mallory (X3DH/преамбул/AD/AEAD) | OK |
| L1 framing/SHA-256 | OK |
| E1 полная DR-симуляция, включая r2 | OK |
| E2/D1–D3/F1–F2/G1–G3 | OK |
| 9/10 конвертов < 524288; 10×65536 > 524288 | OK |

Что **не** проверяется векторами (честно): WebCrypto non-extractable/structured clone/Safari-Firefox, IndexedDB crash-recovery, multi-tab, реальный Java Ed25519 verify, поведение прокси по 413. Это G1–G4.

---

## Отчёт по формату `docs/TASKS.md` §5

> `docs/TASKS.md` не изменялся (запрет зоны). Отчёт приведён здесь; PM может перенести его в §5.

## Статус

**DONE** — spec remediation S2 (P0/P1) + vectors v2 + notes. Production-код не писался.

## Сделано

- Закрыты 4 P0: per-device verification, TOFU-пиннинг, immutability `security_mode`, атомарная локальная копия (без self-envelope).
- Закрыты 12 P1: R-15, IK binding, лимиты wire/encoded/decoded, DDL против V1–V15, DIRECT uniqueness, POST /devices breaking, coverage 0 устройств, FS-окно, `DHs_A`, client_message_id scope, K_storage, flag-off.
- Векторы: G4 пересчитан, добавлены B5/G5/I1–I2/J1–J2/K1–K2/L1–L2; 34 вектора, 189 проверок, 0 failures.
- Ответы на 14 вопросов ревью — §6; на Q-01..Q-16 — §10.7/§10.9 спеки.

## Файлы

- [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) — редакция S2.
- [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) — v2.
- [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) — §9 (генератор/verifier S2).
- `docs/E2EE-S2-CHANGELOG.md` — этот отчёт.
- Не изменялись: `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, `docs/E2EE-REVIEW-01.md`.

## Проверки

- `python3 gen_e2ee_vectors_s2.py` → `written; vectors: 34 sections: 13`.
- `node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json` → **189 checks, 0 failures**.
- JSON: 34 уникальных id, 13 секций, 12 нормативных; `meta.limits` пересчитан.
- G4/G5/B5/I2/L1 проверены независимым Node-стеком; E1 включает r2.

## Контракт

- `contracts/**` **не изменялся**. Delta (binding, `verifier_device_id`, coverage peer/self, ciphertext 363/65536, error codes) — только предложение §6.3; требует I-01 и regeneration `schema.d.ts`.

## DDD

- Не применимо: изменялись только docs/JSON. Backend-задачи (E7-B1..B7) и границы слоёв не затрагивались.

## Риски и вопросы

- G4 (внешний review реализации) остаётся обязательным.
- TOFU-окно, отсутствие KT, backup v1, at-rest — принятые остаточные риски.
- Нужно решение PM: принимать ли `identity_binding_signature` в `DeviceRegistration` как обязательное поле уже для всех новых клиентов (breaking) — в S2 да (P1-6).
- Нужно подтвердить: 10 конвертов при 5+5 — I/O и лимит 512 KiB; S2 оставляет лимит 10 и max 9.

## Что дальше

1. I-01: обновить `contracts/openapi.yaml`/`ws-protocol.md` по §6.3/§6.4, перегенерировать `schema.d.ts`, contract-тесты.
2. E7-B1: миграции V16+ по §6.5 (не по старой редакции); создать `device_prekeys`/`key_verifications`, `direct_key`, mode-триггеры, envelopes.
3. E7-B2/B3: binding/legacy/idempotency, claim с `chat_id`, атомарный OPK.
4. E7-F2/F5: outbox/local copy до send, TOFU, R-15, per-device verified, mode pinning.
5. G2/G3/G4: браузерные KAT, E2E два браузера, внешний review/пентест; до G4 — flag off.

---

## Остаточные риски (приняты, не «закрыты»)

- **TOFU-окно:** подмена при самом первом контакте не детектируется; safety number/QR — единственная защита. KT v1 нет (v2).
- **Malicious server:** может врать о `verified`/ключах/режиме; клиент не отправляет plaintext при downgrade, но не может доказать честность сервера.
- **Нет backup v1:** потеря устройства/профиля = потеря истории и своей локальной копии; self-envelope отклонён.
- **`K_storage` не at-rest:** кража профиля/диска + JS в origin = доступ к ключам; unlock/passphrase не в v1.
- **R-15:** reset помогает только если отправитель онлайн/получит reset; при длительном офлайне обеих сторон сообщения могут остаться нерасшифрованными (честная метрика/UX).
- **PCS** в 1:1 — после ответного DH-ratchet; группы/sender keys вне E7.
- **G4:** реализация не проверена; векторы ловят регрессии, а не ошибки реализации.

---

## Артефакты

| Артефакт | Что содержит |
|---|---|
| [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) | Нормативная спека S2: протокол, wire, лимиты, API, DDL, threat model, ADR, чек-лист. |
| [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) | 34 вектора/13 секций/189 проверок; `vector_set_version=2`. |
| [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) | §9: полный генератор/verifier S2, арифметика, решения, handoff. |
| `docs/E2EE-S2-CHANGELOG.md` | этот отчёт: P0/P1, ответы, проверки, conditions closed. |
| [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>) | входное ревью (не изменялось). |

Не изменялись: `backend/**`, `frontend/**`, `contracts/**`, `docs/TASKS*.md`, `docs/E2EE-REVIEW-01.md`.

---

## Conditions closed

### P0

| Условие | Статус | Доказательство |
|---|---|---|
| P0-1 verifier device | **CLOSED** | §6.2.6/§6.2.7/§6.5/§7.4; G4/G5; integration «L1 verified → L2 null» |
| P0-2 TOFU pin | **CLOSED** | §3.3.1/§3.3.3/§5.6/§7.5; I1/I2; E2E-AC-09 |
| P0-3 mode immutability | **CLOSED** | §6.2.8/§6.5/§9.3; J1/J2; E2E-AC-10 |
| P0-4 own copy | **CLOSED** | §3.4.6/§5.2; crash/replay matrix; E2E-AC-11 |

### P1

| Условие | Статус | Доказательство |
|---|---|---|
| P1-1 R-15 | **CLOSED** | §3.5.1/§5.5; L1/L2; E2E-AC-12 |
| P1-2 IK binding | **CLOSED** | §3.1/§3.2/§6.5; B5 |
| P1-3 limits | **CLOSED** | §1.3/§4.5/§4.7/§6.3; `meta.limits`; boundary tests |
| P1-4 DDL | **CLOSED** | §6.5; Testcontainers V1–V15 |
| P1-5 DIRECT | **CLOSED** | §6.2.8/§6.5; race test |
| P1-6 POST /devices | **CLOSED** | §2.5/§3.1/§6.2.1/§6.6; contract tests |
| P1-7 coverage | **CLOSED** | §4.2/§4.7/§6.3; 409 tests |
| P1-8 FS window | **CLOSED** | §3.4.5/§9.2; destruction property tests |
| P1-9 DHs_A | **CLOSED** | §3.3.2/§3.4.2; assert/negative test |
| P1-10 client_message_id | **CLOSED** | §4.2/§4.6/§6.5; K1/K2 |
| P1-11 K_storage | **CLOSED** | §2.3/§3.6/§9.9; UI/DPA review |
| P1-12 flag-off | **CLOSED** | §6.2.8/§6.6/§10.4; J2 |

### Что это значит для GO

- Условия GO №1–6 (P0-1..4, P1-4/5/6, P1-3) закрыты **в спеке/векторах**; условие №7 (контракт I-01) ещё требует обновления `contracts/openapi.yaml`/`ws-protocol.md` — файлы `contracts/**` в этой зоне не меняются, delta предложена в §6.3/§6.4.
- Условия №8–13 (P1-1/2/10/8/9/11/12, P1-7) закрыты в спеке; реализация и тесты — E7-B/F.
- Условие №14 (G2/G3/G4) остаётся: G4 — внешний review реализации + пентест; без него E2EE в prod нельзя.
- **Рекомендация:** G0 считать выполненным после повторной проверки S2 внешним ревьюером; начинать E7-B1/B2 с `e2ee.enabled=false`.

---

*Конец changelog S2. Все изменения — в разрешённой зоне; wire format не менялся; production-код не писался.*

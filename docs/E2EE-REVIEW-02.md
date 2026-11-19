# E2EE-REVIEW-02 — G1 targeted re-review редакции S2

> **Роль:** независимый security/crypto-ревьюер «Совы». Спеку, векторы и S2-changelog писал не я; код не менял.
> **Объект:** [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>) (S2, 2788 строк), [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>) (`vector_set_version=2`, 34 вектора, 13 секций), [`docs/E2EE-S2-CHANGELOG.md`](<E2EE-S2-CHANGELOG.md>), [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>) §9, [`docs/TASKS-E7.md`](<TASKS-E7.md>), [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>).
> **Что проверено:** заявления S2 о закрытии 4 P0 и 12 P1; DDL §6.5 против фактических миграций `backend/src/main/resources/db/migration/V1–V15`; API/контрактные схемы; 14 ответов на вопросы review-01; независимая перепроверка **всех 13 секций** векторов (368 собственных проверок, 0 failures), tamper-набор, детерминизм генератора, JSON-структура.
> **Границы:** это design/conformance re-review, **не** implementation-review. Браузерные WebCrypto-особенности, IndexedDB/crash-recovery, реальный Java Ed25519, поведение прокси по 413 и G4 остаются вне доказанной зоны. Production-код, БД и Keycloak не запускались; wire format не изменялся. Изменён только этот файл.

---

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**GO WITH CONDITIONS.**

**Почему не NO-GO.** Криптографическое ядро S2 осталось корректным и воспроизводимым:

- Все 13 секций векторов независимо пересчитаны: A1–A4 (RFC 7748 / RFC 8032 / RFC 5869 / NIST AES-256-GCM), B1–B5 (X3DH 4DH/3DH, SPK-подпись, преамбул 323 B, IK binding 88 B), C1–C3, D1–D3 (фрейминг/padding, AD 163 B, AEAD), E1 (4 сообщения, 2 DH-ratchet turn, включая `r2`), E2 (skipped key), F1–F2, G1–G5 (FP, safety number, VH v2, per-device), H1–H2, I1–I2, J1–J2, K1–K2, L1–L2. Собственный верификатор: **368 checks, 0 failures**; авторский: **189 checks, 0 failures**; генератор детерминирован (байт-в-байт).
- P0-1 (verification per verifier device) действительно закрыт в DDL/API/VH/G5: `verifier_device_id`, уникальность `(verifier_device_id,target_device_id,chat_id)`, `VH` v2, L2 видит `null`.
- P0-4 (своя копия) закрыт в спеке: одна IndexedDB-транзакция `sessions + outbox + local_messages` до сети, точные bytes, crash/replay-матрица, запрет перешифрования.
- P1-2 (IK binding), P1-9 (`DHs_A`), P1-10 (scope `client_message_id`), P1-11 (`K_storage`/`STORAGE_LOCKED`), P1-12 (flag-off) закрыты; P1-3 арифметика лимитов сходится.
- Envelope wire format **не сломан**: `envelope.v=1`, `header.v=1`, AD 163 B, преамбул `313+L+M`, F1/F2 — 1310/756 B; изменился только server-side `VH` (v2), не поле конверта.

**Почему не GO.** Заявление S2 «4/4 P0 и 12/12 P1 закрыты» не подтверждается:

1. **P0-2 закрыт частично**: §3.3.1 не требует равенства `prekey.sender_identity_*` ключам зарегистрированного устройства/claim-bundle; §4.7 не проверяет это на сервере. Клиент, проверяющий binding/TOFU по bundle-ключам (естественное чтение §3.3.1), не увидит подмены sender-ключей в prekey-блоке. Это позволяет при краже bearer-токена (без приватных ключей устройства) выдать себя за `device_id` и установить сессию, которую жертва считает «сверенной» (P0-2b ниже).
2. **P0-3 закрыт частично**: клиентский пиннинг режима работает только при наличии локального пина; новое устройство/очищенный профиль пина не имеет и принимает `MANAGED` от сервера. Утверждение «plaintext никогда не отправляется» без этой оговорки неверно (P1-G ниже).
3. **P1-4 закрыт частично**: §6.5 в текущем виде не исполняется на V1–V15 — нет `GRANT` для `krug_app` на новые таблицы, нет RLS для `auth.device_prekeys`/`message.message_envelopes`, `auth.devices` RLS `p_devices_self` не даёт читать устройства собеседника (claim/keys/send блокируются), а `message.ensure_partition()` не создаёт партиции `message_envelopes`. Плюс `reply_to_id` в E2EE не отвергается ни псевдокодом §4.7, ни CHECK §6.5.
4. **P1-1 закрыт частично**: `SESSION_RESET` пересоздаёт/повторяет **одно** сообщение; остальные нерасшифрованные сообщения той же сессии остаются потерянными.
5. **P1-7 закрыт частично**: сервер отклоняет только `peer_devices==0`, но не `peer_covered==0`; можно отправить конверты только своим другим устройствам и получить `201` без доставки собеседнику.
6. **P1-8 закрыт частично**: числа окна FS противоречивы (`60` vs `до 60–90`), явного уничтожения старого `DHs_priv`/SPK в §3.4.5 нет; обещанная «оцифровка» в §3.4.5 отсутствует.
7. **I1/I2** содержат `presented_identity_binding_signature` в **hex (128 символов)**, а не `b64u64` (86 символов); b64u-декодирование даёт 96 B. Валидный по wire клиент отвергнет binding до TOFU, поэтому I2 не доказывает то, что заявляет.
8. **Контракт I-01** (`contracts/openapi.yaml`, `ws-protocol.md`, `schema.d.ts`) всё ещё не обновлён — S2 это и не скрывает; без него backend/frontend не стартуют.

Исправления — уровня спеки/DDL/векторов и одного нового негативного вектора; криптоядро переделывать не нужно. Поэтому **GO WITH CONDITIONS**, а не NO-GO, но условия 1–3 ниже блокируют E7-B1/B3/B5 и включение E2EE.

| Метрика S2 | Заявлено | Фактически по review-02 |
|---|---|---|
| P0 closed | 4/4 | **2 closed, 2 partially** (P0-2, P0-3) |
| P1 closed | 12/12 | **6 closed, 6 partially** (P1-1, P1-4, P1-5, P1-6, P1-7, P1-8) |
| Векторы | 34/13, 189/0 | 34/13, 189/0 и 368/0 — подтверждено; I1/I2 schema-дефект |
| Wire v1 | не изменён | подтверждено |
| DDL V16+ | готов к E7-B1 | **не исполним без grants/RLS/partitions** |

---

## P0 (блокирует)

### P0-2b. Prekey-блок не связан с зарегистрированными/claim-ключами отправителя

**Где.** §3.3.1 (строки 397–410, «исчерпывающий чек-лист»), §3.3.2 (412–424), §3.3.3 (426–436), §4.1 `prekey` (676–689), §4.7 валидация сервера (879–920), §6.2.6 `identity_binding_signature` (1279–1338).

**Сценарий.**
1. Устройство A `011` зарегистрировано с честными `(IK_sig, IK_dh)`; B имеет TOFU-пин на эти ключи и/или safety number.
2. Атакующий крадёт **только bearer-токен** A (без приватных ключей устройства), генерирует `IK_sig'`, `IK_dh'`, `EK'`, `DHs'`, собирает prekey-конверт с `sender_device_id=011` и `prekey.sender_identity_signing_key/dh_key` = новые ключи. Преамбул подписан `IK_sig'` — подпись валидна.
3. Сервер проверяет `sender_device_id == X-Device-Id`, `sender_key_generation`, recipient, дубли — и **не** сверяет `prekey.sender_identity_*` с `auth.devices.identity_*`. Запрос проходит.
4. B получает bundle для `011` (честные ключи), проверяет по нему binding и TOFU-пин — обе проверки проходят. Если реализация сравнивает пин с **bundle**-ключами (естественно: `identity_binding_signature` приходит только из bundle), а prekey-блок — с новыми ключами, то **равенство prekey-ключей и bundle-ключей нигде не проверяется**. B создаёт сессию с ключами атакующего, отображает сообщение; ответы B шифруются на `IK_dh'`/`DHs'` и доступны атакующему. Safety number и binding при этом «честные».

**Риск.** Обход P0-2/TOFU при краже токена без ключей устройства: имперсонация `device_id`, чтение ответов, ложное «сверено». Это не полный MITM честного устройства (скомпрометированное устройство и так вне модели), но это ровно тот класс, который должен ловить пиннинг: сессия устанавливается не с теми ключами, которые закреплены за `device_id`.

**Исправление.**
- Сервер (§4.7, п. 4/7): для каждого конверта с `prekey` требовать
  `prekey.sender_identity_signing_key == devices.get(sender_device_id).identity_signing_key` и
  `prekey.sender_identity_dh_key == devices.get(sender_device_id).identity_dh_key`; иначе `422 INVALID_ENVELOPE_FORMAT` (или `KEY_CHANGED`, если generation успела измениться). Это дешёвая публичная проверка, без секретов.
- Клиент (§3.3.1, п. 1–6): явно требовать `envelope.prekey.sender_identity_* == bundle.identity_* == TOFU-pin.IK_*`; binding проверять **над теми же** ключами, что и преамбул; при любом расхождении — `KEY_HANDSHAKE_INVALID`/`KEY_CHANGE_DETECTED`, без сессии/OPK/display.
- Зафиксировать в §3.3.1, что «source of truth» для identity — bundle/claim, а prekey-блок обязан с ним совпадать; это не «ещё одна рекомендация», а пункт чек-листа.

**Тест/вектор.** Новый негативный вектор **I3-prekey-sender-key-mismatch**: wire-валидный конверт, валидная подпись преамбула новыми ключами, валидный binding для новых ключей, но bundle/`auth.devices` — честные; ожидание: сервер `422`, клиент `KEY_HANDSHAKE_INVALID`/`KEY_CHANGE_DETECTED`, `session_created=false`, `message_displayed=false`, `opk_consumed=false`. Плюс интеграционный тест «устройство A с токеном, но без ключей, не может отправить prekey на B». Расширить E2EE-AC-09.

---

## P1 (до включения)

### P1-A. DDL §6.5 не исполним на V1–V15: grants, RLS, партиции, `reply_to_id`

**Где.** §6.5 (1829–2066): `auth.device_prekeys` (1875–1895), `auth.key_verifications` (1958–1982), `message.message_envelopes` (2029–2053), `message.ensure_partition` (1912–1956); §4.7 (901–913); §4.2 `reply_to_id` (750); §6.5 CHECK-и (1900–1908).

**Сценарий/факты (проверено по V1–V15).**
- В V1 нет `ALTER DEFAULT PRIVILEGES`; `krug_app` получает права только явными `GRANT`. В §6.5 **нет** `GRANT` для `auth.device_prekeys`, `auth.key_verifications`, `message.message_envelopes` (у последней только комментарий «GRANT krug_app — как у messages», строка 2052). Runtime-роль — `krug_app` (`application.yml:16`), значит запросы упадут с `permission denied`.
- `auth.devices` имеет `FORCE ROW LEVEL SECURITY` и политику `p_devices_self USING (user_id = ops.current_user_id())` (V2). `POST /keys/claim`, `GET /chats/{id}/keys` и валидация `recipient_device_id` в `POST /messages` читают устройства **другого** пользователя; под этой политикой они вернут 0 строк. В §6.5 политика не меняется и `SECURITY DEFINER`-резолвер не добавляется — E2EE-send/claim/keys не заработают.
- `auth.device_prekeys` создаётся **без RLS**; после выдачи grant `krug_app` увидит prekeys всех тенантов/пользователей. Ключи публичные, но это нарушает принятую в проекте модель RLS и даёт cross-tenant перечисление.
- `message.message_envelopes` — `PARTITION BY RANGE (created_at)`, но `message.ensure_partition()` создаёт только `message.messages_YYYY_MM` и индексы на `messages`; партиции `message_envelopes_YYYY_MM` не создаются ни в функции, ни в миграции. Первый `INSERT` в envelopes упадёт с «no partition of relation found for row».
- `message.messages` CHECK-и `ck_messages_e2ee_*` (1900–1908) не покрывают `reply_to_id`: §4.2 (750) запрещает верхнеуровневый `reply_to_id` в E2EE, но псевдокод §4.7 (899) делает `rejectIfPresent(text, sticker_id, attachment_ids)` **без** `reply_to_id`, а DB-проверки его не запрещают. Это plaintext-метаданные (на что отвечали), просочившиеся в E2EE-строку.
- `message.messages.sender_id`/`sender_device_id` в V4 nullable; для E2EE они обязательны (иначе `client_message_id`-индекс с NULL sender допускает дубли и ломает cross-user replay). В CHECK §6.5 это не зафиксировано.

**Риск.** E7-B1 применится, но B3/B4/B5 не смогут читать/писать; либо (если кто-то выдаст grant вручную) появится cross-tenant чтение prekeys и рассинхрон RLS. `reply_to_id` — утечка метаданных и нарушение обещания «в E2EE нет plaintext-полей». Это блокирует первую миграцию и первый E2EE-запрос, а не только «до включения».

**Исправление.**
- Явные `GRANT SELECT, INSERT, UPDATE, DELETE` на `auth.device_prekeys`, `auth.key_verifications`, `message.message_envelopes` (и на каждую партицию envelopes — в `ensure_partition`/аналоге).
- RLS: `auth.device_prekeys` — owner-write + чтение через `SECURITY DEFINER` `claim`-функцию с проверкой membership; `message.message_envelopes` — `USING (workspace_id = ops.current_workspace_id())`, `FORCE ROW LEVEL SECURITY`; `auth.key_verifications` — уже есть, добавить grant.
- `auth.devices`: либо `SECURITY DEFINER`-функция `auth.devices_for_chat(chat_id)` (проверяет, что вызывающий — член чата, возвращает только устройства участников), либо аккуратная policy с `EXISTS` по `chat_members`; не расширять `p_devices_self` «на весь workspace».
- `message.ensure_partition` дополнить созданием `message_envelopes_YYYY_MM` (RLS, policy, grant, индексы `(recipient_device_id, created_at)`, `(message_id, created_at)`), либо отдельная функция, вызываемая тем же job.
- CHECK: `crypto_scheme <> 'E2EE_PAIRWISE' OR reply_to_id IS NULL`; `crypto_scheme <> 'E2EE_PAIRWISE' OR (sender_id IS NOT NULL AND sender_device_id IS NOT NULL)`; в §4.7 добавить `reply_to_id` в `rejectIfPresent`.
- Тест: Testcontainers V1–V15 + два пользователя в DIRECT-чате; claim/keys/send под `krug_app`; `INSERT` envelope в текущую партицию; `INSERT` E2EE с `reply_to_id`/NULL sender → fail; DB-скан cross-tenant.

**Тест/вектор.** J2/K2 не покрывают RLS; нужен новый integration/DB-тест (E7-B1/B7). Для `reply_to_id` — контрактный тест `POST /messages` E2EE с `reply_to_id` → `422 E2EE_PLAINTEXT_FORBIDDEN`.

---

### P1-B. `peer_covered == 0` принимается: ложный coverage у получателя (P1-7 частично)

**Где.** §4.2 (785–789), §4.7 псевдокод (901–902, 919), §5.2 (995), `EnvelopeCoverage` (1744–1757).

**Сценарий.** У B есть 2 активных `e2ee_capable` устройства, но у обоих нет актуального SPK (истёк/`NO_SPK`) или A не смог получить bundle. `peer_devices=2`, `peer_covered=0`; A отправляет конверты только своим другим устройствам (self fan-out) или один конверт своему второму устройству. Сервер проверяет `peer_devices.count >= 1` — проходит; `uncovered_device_ids` содержит B, но `warning` выставляется только при `self_covered < self_devices`; A получает `201` и `envelope_coverage` без warning. B не получает ничего.

**Риск.** Это тот же класс, что review-01 P1-7: отправитель уверен в доставке, получатель не может прочитать; «coverage» не защищает, потому что проверяется только наличие устройств, а не покрытие. Молчаливая потеря сообщения + ложная уверенность.

**Исправление.** В §4.7 требовать `peer_covered >= 1` (хотя бы один конверт с `recipient_user_id == peer`), иначе `409 E2EE_NO_PEER_ENVELOPE`/`422 PEER_UNCOVERED` до создания `Message`; для `peer_covered < peer_devices` — `warning: PEER_DEVICE_UNCOVERED` (сейчас есть только `SELF_DEVICE_UNCOVERED`), UI «на устройствах собеседника недоступно». Не считать `peer_devices` «покрытием»: это только кандидаты.

**Тест/вектор.** Новый M1: B с capable-устройством без SPK → `409`; B с 2 устройствами, покрыто 1 → `201` + `warning=PEER_DEVICE_UNCOVERED`; B без capable → `409 E2EE_NO_ACTIVE_DEVICES` (уже). Расширить `EnvelopeCoverage.warning` enum.

---

### P1-C. `SESSION_RESET` повторяет одно сообщение, остальные теряются (P1-1 частично)

**Где.** §3.3.3 шаг 7 (434), §5.5 (1024–1028), §3.6 `SESSION_RESET_REQUIRED` (649), L2.

**Сценарий.** A отправил m1..m5 в одной сессии; B офлайн дольше окна SPK; B не расшифровывает **ни одно** из них (первое prekey + последующие ratchet в несуществующей сессии). B отправляет один `SESSION_RESET` с `retry_of_client_message_id` = m5 (или m1), `failed_session_id`, `failed_n`. A удаляет сессию, делает claim, новый handshake и повторяет **одно** сообщение с новым `client_message_id`. m1..m4 остаются у A как `sent`, у B отсутствуют; повторной попытки нет. L2 проверяет только `resend_uses_new_client_message_id` и «одну запись retry», а не весь набор.

**Риск.** R-15 «no silent loss» выполняется только для одного сообщения; для остальных — тихая потеря, ровно та, которую P1-1 должен был закрыть. Пользователь видит «отправлено», собеседник — ничего.

**Исправление.** Определить reset как свойство **сессии**, а не сообщения: A при получении reset выбирает **все** сообщения этой `failed_session_id` из локальной копии/outbox (в порядке `client_message_id`/времени), перешифровывает их в новую сессию (каждому — новый `client_message_id` и, при необходимости, новый `Idempotency-Key`), помечает старые как `retry_pending`/`superseded`, UI показывает одну группу retry без дублей. Ограничить batch (например, 20 сообщений/1 reset) и сохранить rate limit 1/300 с; если сообщений больше — явный статус «часть не отправлена, повторить». `failed_n`/`retry_of_client_message_id` оставить как указатель, но не как единственный объект.

**Тест/вектор.** L2b: 3 сообщения в одной сессии, SPK удалён, reset → все 3 доставлены ровно один раз, порядок сохранён, UI — одна группа; 0 дублей; метрика. Property: reset при пустом outbox — no-op.

---

### P1-D. Окно FS/PCS: противоречивые числа и отсутствие явного уничтожения ключей (P1-8 частично)

**Где.** §1.3 (109 `SPK_RETAIN_PRIVATE`, 118 `SPK_RETAIN_WINDOW`), §2.3 (212), §3.4.2 (464), §3.4.5 (506–521), §5.5 (1024), §9.2 T-E2EE-05 (2374), changelog строка 170.

**Факты.**
- §1.3: `SPK_RETAIN_PRIVATE = последние 2 SPK, не менее 30 дней`; `SPK_RETAIN_WINDOW = 60 дней (2 предыдущих SPK × 30 дней)`.
- §2.3: «хранить 2 **предыдущих** приватных SPK ≥30 дней» — это current + 2 previous = 3 SPK, окно до 90 дней.
- §5.5: «окно `SPK_RETAIN_WINDOW` = 2 SPK × 30 дней» — 60 дней.
- Changelog: «текущий + 2 предыдущих, ≥30 дней каждый (окно до 60–90 дней)».
- В §3.4.5 (таблица состояния) **нет** ни правила уничтожения старого `DHs_priv`, ни SPK, ни честной формулировки FS/PCS с числами; есть только поля. §9.2 ограничивается «PCS не мгновенный». Утверждение changelog «окно FS/PCS оцифровано в §3.4.5» не соответствует тексту.
- OPK private уничтожается после AEAD (§2.3/§3.3.3) — это единственное полностью явное правило; MKSKIPPED TTL/лимиты есть в §3.4.4/§1.3.

**Риск.** Два реализатора выберут 60 или 90 дней и оба будут «по спеке»; FS-окно в threat model нельзя проверить; старый `DHs_priv`, сохранённый «на всякий случай», ослабляет FS; R-15/офлайн-ожидания расходятся с фактическим окном.

**Исправление.** Выбрать одну семантику (рекомендую current + 2 previous = 3 SPK, окно **90** дней; либо 2 total = 60) и синхронизировать §1.3, §2.3, §3.4.2, §5.5, §10.7 Q-09, changelog. В §3.4.5 добавить короткий нормативный подраздел «FS/PCS window»:
- OPK private — уничтожать сразу после успешного AEAD;
- старый `DHs_priv` — уничтожать/zeroize сразу после DH-ratchet (хранится только текущая пара);
- SPK private — хранить current + N previous, уничтожать по окну; сессии, использовавшие уничтоженный SPK, → `KEY_HANDSHAKE_INVALID` + reset;
- MKSKIPPED — TTL 30 д/2000/1000;
- честно: FS prekey-сообщения ограничена окном SPK; PCS — только после ответного DH-ratchet, не мгновенный; `SESSION_IDLE_TTL=90 д` — не FS-граница.
- Property-тест: после N ratchet в storage нет старых DHs; после удаления SPK старое prekey-сообщение отклоняется/reset; storage-scan.

**Тест/вектор.** Вектора нет (state/storage); property/E2E-AC-12. `meta.limits` не покрывает.

---

### P1-E. I1/I2: `identity_binding_signature` в hex, а не `b64u64` — негативный вектор не wire-валиден (P0-2/P1-2)

**Где.** `docs/E2EE-TEST-VECTORS.json` I1 (строка 836) и I2 (881), `presented_identity_binding_signature`/`pinned_identity_binding_signature`; §6.3 `Base64Url64` (1505–1512), §6.2.6 `identity_binding_signature` (1298), §3.1 binding (289–300).

**Факт.** Поле содержит 128 символов `[0-9a-f]` (hex), а не 86 символов b64u. `b64u`-декодирование даёт **96 байт**, не 64. Спека требует `Base64Url64` (`^[A-Za-z0-9_-]{86}$`); сервер/клиент по wire-схеме отвергнут длину. Авторский verifier декодирует hex, поэтому 189/0 проходит; мой верификатор тоже декодировал hex, иначе I2 не проверить.

**Риск.** I2 заявляет «binding Mallory валидна, ловит только пин», но по wire-схеме binding невалидна по длине; conforming-клиент вернёт `INVALID_IDENTITY_BINDING`/`KEY_HANDSHAKE_INVALID` **до** TOFU. Тест не доказывает P0-2; можно получить зелёный 189/0, не выполнив negative-сценарий. Это же расхождение между «inputs» (hex-конвенция) и wire-полем (b64u).

**Исправление.** В I1/I2 (и любых wire-sourced `*_signature`) отдавать b64u (86 символов) либо явно назвать поле `*_hex`, но тогда добавить отдельный wire-валидный I2. Обновить авторский verifier на b64u; добавить schema-check «все `presented_*signature` — 86 b64u». Перегенерировать; expected-значения не меняются, меняется только кодировка поля.

**Тест/вектор.** I2 с b64u binding: клиент парсит, binding проходит, затем TOFU mismatch → `KEY_CHANGE_DETECTED`, no session/display/OPK. JSON-schema тест.

---

### P1-F. `reply_to_id` в E2EE: правило есть, принуждения нет

**Где.** §4.2 (750: «верхнеуровневый `reply_to_id` в E2EE запрещён»), §4.7 псевдокод (899: `rejectIfPresent(text, sticker_id, attachment_ids)`), §6.5 CHECK-и (1900–1908).

**Сценарий.** Клиент отправляет E2EE-сообщение с `reply_to_id` на уровне `MessageCreate`; сервер отклоняет `text`/`sticker`/`attachments`, но `reply_to_id` не проверяет и сохраняет в `message.messages.reply_to_id`; DB-проверки не запрещают. В `GET /messages` поле уходит клиенту. Это plaintext-метаданные о том, на что отвечали (и связь с `message_id`), которые спека обещала не создавать.

**Риск.** Утечка метаданных и логическая несовместимость: E2EE-конверт не содержит `reply_to_id`, а серверный `Message` — содержит; клиент может показать reply-ссылку, которой нет в inner payload. P1-4 был про «plaintext не просачивается»; это прямой остаток.

**Исправление.** Добавить `reply_to_id` в `rejectIfPresent` §4.7 и в `MessageCreate`-валидацию; DB CHECK `crypto_scheme <> 'E2EE_PAIRWISE' OR reply_to_id IS NULL`; тест `POST /messages` E2EE с `reply_to_id` → `422 E2EE_PLAINTEXT_FORBIDDEN`; контрактное правило.

**Тест/вектор.** Негативный backend/contract-тест; K1/K2 не покрывают.

---

### P1-G. P0-3: на новом устройстве/после очистки профиля пина режима нет — plaintext возможен

**Где.** §6.2.8 (1393–1401), §7.6 (2186–2194), §9.3 (2392–2411), J1.

**Сценарий.** Пользователь открывает существующий E2EE-чат на **новом устройстве** или после очистки IndexedDB. Локального пина `chat_id → security_mode` нет. Malicious/compromised server возвращает `security_mode=MANAGED`; клиент не имеет локального свидетельства, что чат был E2EE, и по §6.2.8 просто фиксирует текущий режим. Отправка идёт plaintext. Серверный trigger защищает только честную БД; §7.6 говорит «клиент увидит расхождение с пином», но пина нет.

**Риск.** Утверждение «plaintext никогда не отправляется» неверно для fresh-device/cleared-cache; P0-3 закрыт только при наличии пина. Это тот же downgrade, но через новый профиль.

**Исправление.** Ввести правило fresh-device: если воркспейс/DIALOG имеет E2EE-историю или у собеседника есть `e2ee_capable` устройства, клиент по умолчанию **не** отправляет plaintext, а требует явного выбора режима/подтверждения; либо server-signed mode attestation (mode + epoch, подписанный ключом, который клиент может проверить), либо локальный пин, переносимый при device pairing (v2). Минимум — честно записать остаточный риск в §7.6/§9.3 и добавить тест «fresh context + server says MANAGED → plaintext_messages_sent=0».

**Тест/вектор.** J1 расширить: `client_has_pin=false` → `BLOCK_SEND_SECURITY_ALERT` или `REQUIRE_MODE_CONFIRMATION`; Playwright fresh context.

---

### P1-H. P1-5: `peer_id` есть в `Chat`, но не в `ChatSummary`

**Где.** §6.2.8 (1398: `peer_id` из `chat_members`), §6.3 `Chat` (1775–1787), текущий `contracts/openapi.yaml` `ChatSummary` (1059–1078), §6.6 (2081).

**Сценарий.** `GET /chats` возвращает `ChatSummary`, в котором нет `peer_id`; для DIRECT-чата клиент не может понять, кто собеседник, пока не сделает дополнительный запрос. S2 добавляет `peer_id` только в `Chat` (ответ создания) и `ChatCreateRequest`, но не в `ChatSummary`; changelog говорит «peer_id вычисляется из chat_members» без указания, где он отдаётся.

**Риск.** P1-5 закрыт по уникальности, но не по API-потребителю: список чатов неполон, frontend может показывать неверного/пустого собеседника; дополнительный запрос не описан. Это не security, но API-несовместимость.

**Исправление.** Добавить `peer_id: [string,null]` в `ChatSummary` (derived из `chat_members`, только для DIRECT) или явно описать `GET /chats/{id}`; контрактный diff + `schema.d.ts`.

**Тест/вектор.** Contract-тест: `GET /chats` для DIRECT содержит `peer_id`; для GROUP — null.

---

## P2

| # | Где | Finding | Риск | Исправление | Тест |
|---|---|---|---|---|---|
| P2-1 | §6.2.6 (1331–1338), G5 | `verified_count`/`devices_total` — «агрегат», но не сказано, для какого verifier device. L2 с `verified=null` может увидеть «1 из 2 сверено», если count считает строки L1 | Агрегат возвращает ту же ложную уверенность, что P0-1, только в UX | Определить `verified_count` как count строк с `verifier_device_id = X-Device-Id`; отдельно `verified_by_other_devices_count` | G5 расширить: L2 `verified_count=0`; integration |
| P2-2 | §6.2.7 (1366–1370), `VerificationRequest` (1723–1730) | Версия `VH` (u8(2)) внутри хэша; сервер не может отличить v1-запись и не проверяет digits. «u8(1) — untrusted» неисполнимо на API | Buggy/old client может записать v1-хэш как verified; сервер не заметит | Добавить `vh_version` в запрос (и колонку) или пересчитывать VH v2 из публичных ключей; отклонять v1 | PUT с v1 → 422; G4/G5 |
| P2-3 | §3.2 (336), §6.2.5 (1270–1275), `UnavailableDevice` (1666–1671) | `NOT_MEMBER` в `unavailable[]` противоречит «не-участник → 422 UNKNOWN_DEVICE, весь запрос» | Два взаимоисключающих контракта; реализатор выберет одно, клиент — другое | Убрать `NOT_MEMBER` или вернуть `unavailable` без 422; зафиксировать один код | Claim non-member → 422; claim member no SPK → unavailable |
| P2-4 | §6.2.1 (1139–1147), §4.8 (955) | `422 E2EE_LEGACY_DEVICE` («докинуть» ключи в legacy) недостижим: в `POST /devices` нет `device_id`, natural key больше не ключ | Мёртвый код/неясная миграция; клиент не знает, как получить этот код | Либо убрать код, либо задать способ адресации (например, `Idempotency-Key`/явный `device_id` в отдельном endpoint) | Contract/integration |
| P2-5 | §6.2.1 (1143), §3.1 (298) | Идемпотентность по IK-ключам не учитывает `status=REVOKED`: повтор тех же ключей после revoke может вернуть revoked-устройство | Клиент получает мёртвое устройство вместо нового/410 | Уточнить: revoked + те же IK → `410 DEVICE_REVOKED` или новое устройство (global unique допускает) | Integration |
| P2-6 | §2.5 (261), §3.1 (293–295), §6.2.1 (1145) | Глобальная уникальность IK не доказывает владение: публичный bundle + валидные binding/SPK-подписи можно **скопировать** в другой аккаунт первым; сервер примет. Повтор потом даёт 409 (squatting/DoS) | Подмена fingerprint/блокировка регистрации; ложное «ключи нельзя копировать» | Challenge-response (nonce, подписанный IK_sig) при `POST /devices`; либо честно записать остаточный риск и алерт | Integration: copy bundle → 409 после первого; challenge |
| P2-7 | §3.1 (277–287) | SPK-подпись не покрывает `created_at`/`expires_at`; TTL полностью серверный | Сервер может продлить/подменить срок SPK; клиент не видит | Включить expiry в подписываемое сообщение или документировать как политику сервера (P2-8 review-01) | B3 + expiry tamper |
| P2-8 | Vector meta line 12 vs `meta.checks` | `generator.verify_command` говорит «expected: 160 checks»; `meta.checks`/спека/changelog/авторский verifier — 189 | Противоречие в артефакте; автоматизация может ждать 160 | Исправить строку генератора на 189; перегенерировать meta | `node verify...` → 189/0; grep 160 |
| P2-9 | Vector I1/I2; нет `$schema` | Нет формальной JSON Schema для векторов; hex/b64u конвенции для `*_signature` не заданы | Тесты могут «пройти» на неверной кодировке (см. P1-E) | Добавить `meta.schema`/JSON Schema или явные конвенции полей; schema-тест в CI | JSON Schema validation |
| P2-10 | §6.5 (1987–1999, 2061) | Backfill `direct_key` падает, если есть DIRECT-чат не ровно с 2 ACTIVE-участниками; «repair before VALIDATE» без скрипта | V16 не применится на реальной БД с историческими/битыми DIRECT | Repair-скрипт/диагностический запрос до миграции; либо `NOT VALID` + отдельная проверка | Testcontainers с битым DIRECT |
| P2-11 | §1.3 (97–99), §6.5 (2042) | `MAX_ENVELOPE_CIPHERTEXT_ENCODED_CHARS=65536` (form cap) соответствует 49152 decoded, а канонический максимум — 33040; сервер принимает 33041..49152, получатель отвергнет | DoS/UX: валидный по форме, но невалидный по фреймингу конверт | Явно назвать form cap и добавить клиентский/серверный canonical cap для v1 или документировать, что получатель отвергает | Boundary 33040/33041/49152 |
| P2-12 | §6.5 (1900–1908) | Нет CHECK на `sender_id`/`sender_device_id IS NOT NULL` для `E2EE_PAIRWISE`; V4 допускает NULL | NULL sender ломает sender-scoped unique/replay и cross-user 409 | CHECK + NOT NULL для E2EE | DB insert NULL → fail |
| P2-13 | §4.3 (824), §9.3 (2404) | Не сказано явно, что клиент в E2EE-чате обязан игнорировать `Message.text`/`reply_to_id`, если `crypto:null`; сервер может подсунуть plaintext-строку | Malicious server может «нарисовать» plaintext от имени собеседника; UI покажет | Правило: E2EE chat → `text`/`reply_to_id`/`sticker` от сервера не рендерятся; только `crypto`/локальная копия; security alert | Contract/E2E forged plaintext |
| P2-14 | §7.2 (2111–2115), `key_verifications` | Verification scoped по `chat_id`, а safety number — по паре устройств; одна и та же пара требует повторной сверки в каждом чате | UX/ложные «не сверено»; удаление чата теряет verification | Либо scope `(verifier_device,target_device)` (SN не зависит от чата), либо явно обосновать chat-scope и показать «сверено в другом чате» | G5 + два чата |
| P2-15 | §1.3 (101), notes §9.5 | `ENVELOPE_WIRE_BUDGET=45056`/`max_envelope_wire_bytes=45001` посчитаны для `spk-1`/`opk-1` (5 символов); max `spk_id`/`opk_id` 64 добавляет ~118 B | Бюджет занижен; 10 конвертов всё ещё <512 KiB, но расчёт «budget» неверен | Пересчитать с max id или явно назвать оценкой | Boundary max ids |
| P2-16 | §1.3 (115–116), §4.5 (858–859) | `MAX_KEY_GENERATION`/`MAX_HEADER_COUNTER` overflow: для header есть `CHAIN_EXHAUSTED`, для generation — нет | Неопределённое поведение на 2^31 | Явно `422 KEY_GENERATION_EXHAUSTED`/новая регистрация | Boundary |
| P2-17 | §1.3 (117), §3.4.5 | `SESSION_IDLE_TTL=90d` может удалить сессию с in-flight сообщениями; P2-13 review-01 не закрыт | Потеря нерасшифровываемых сообщений | Документировать/метрика; не удалять сессию с pending outbox | Property |
| P2-18 | §3.4.4 (500–501), P2-19 review-01 | `MKSKIPPED` eviction самых старых — тихая потеря; DoS старых сообщений | Пропущенные сообщения не расшифруются | Предупреждение/метрика; не тихое удаление | E2/E2 property |
| P2-19 | `contracts/openapi.yaml` (819–825, 1059–1078, 1088–1131) | Контракт не обновлён: `DeviceRegistration` без ключей, `Device` без полей, `Message` без `crypto`/`client_message_id`, `ChatSummary` без `peer_id`, `MessageCreate` без `envelopes` | I-01 остаётся открытым; backend/frontend не стартуют с новыми DTO | Применить §6.3/§6.4, regenerate `schema.d.ts`, contract-tests | CI contract |

---

## P0/P1 closure matrix (closed/partially/open + evidence)

| ID | Заявление S2 | Статус | Доказательство / остаток |
|---|---|---|---|
| **P0-1** per-device verification | CLOSED | **closed** | DDL `verifier_device_id`/unique `(verifier_device_id,target_device_id,chat_id)` §6.5 (1958–1982); API §6.2.6 (1331–1338), §6.2.7 (1366–1370); `VH` v2 §7.4 (2157–2164); G4/G5 пересчитаны — мой verifier сошёлся; L2 `null`. Остаток P2-1/P2-2 (count/version), не P0. |
| **P0-2** TOFU pin | CLOSED | **partially** | §3.3.1 п.6 (404–408), §3.3.3 (426–436), §5.6 (1030–1038), I1/I2 — есть; но **P0-2b**: нет обязательного равенства `prekey.sender_identity_*` ↔ `auth.devices`/bundle; сервер §4.7 это не проверяет. I2 binding hex (P1-E). |
| **P0-3** mode immutability | CLOSED | **partially** | Триггеры/409 §6.5 (2009–2027), §6.2.8 (1396), J1/J2; но fresh-device/cleared-cache без пина принимает MANAGED — **P1-G**. |
| **P0-4** own copy | CLOSED | **closed** | §3.4.6 (523–553): одна транзакция `sessions+outbox+local_messages`, commit→network, crash/replay-матрица, запрет перешифрования; §5.2 (989–994). Вектора нет by design; E2E-AC-11. Остаток P2: terminal 4xx/outbox. |
| **P1-1** R-15 | CLOSED | **partially** | `content_type=2` в prekey-конверте §3.5.1 (583), §5.5 (1024–1028), L1/L2; но reset повторяет **одно** сообщение — **P1-C**. |
| **P1-2** IK binding | CLOSED | **closed** | Домен `D_IKBIND` §1.4 (157), §2.2 (203–205), §3.1 (293), §3.2 (334), B5; binding verify/negative сошлись. Остаток P1-E (кодировка в I1/I2). |
| **P1-3** limits | CLOSED | **closed** | §1.3 (128–136), §3.5.1 (587–589), §4.5 (848–864), §4.7 (883–888), §6.3 (1581–1583); арифметика 33024/33040/44054/45001/405098/450099/119190/74189 пересчитана; 9/10 < 524288; form cap 10×65536 > 524288. Остаток P2-11 (49152 vs 33040). |
| **P1-4** DDL vs V1–V15 | CLOSED | **partially** | Факты подтверждены: V4 `messages` без `text`, `crypto_scheme`, `content_meta`; V10 снял CHECK TEXT→body; V14 `sticker_id`; `device_prekeys`/`key_verifications` отсутствуют; `identity_public_key` в коде не используется. **Но** P1-A: нет GRANT/RLS/partitions; P1-F `reply_to_id`. |
| **P1-5** DIRECT uniqueness | CLOSED | **partially** | `direct_key`/partial unique/backfill §6.5 (1984–2007), §6.2.8 (1398); уникальность и гонка описаны. **Но** `ChatSummary.peer_id` отсутствует — P1-H; backfill fail-fast P2-10. |
| **P1-6** POST /devices breaking | CLOSED | **partially** | §2.5 (243–267), §3.1 (289–300), §6.2.1 (1139–1147), §6.6 (2072–2079): binding, alg, idempotency priority, global unique, legacy 422; `identity_public_key` drop. **Но** контракт I-01 не применён (P2-19), `E2EE_LEGACY_DEVICE` недостижим (P2-4), revoked-idempotency (P2-5). |
| **P1-7** coverage 0 peer | CLOSED | **partially** | `409 E2EE_NO_ACTIVE_DEVICES` для `peer_devices==0` §4.2 (788), §4.7 (902), split peer/self, `devices.minimum:0`; но `peer_covered==0` принимается — **P1-B**. |
| **P1-8** FS window/destruction | CLOSED | **partially** | OPK immediate §2.3 (213)/§3.3.3 (435); MKSKIPPED TTL/limits §3.4.4/§1.3; но 60 vs 90 (P1-D), нет явного уничтожения старого DHs/SPK, нет FS/PCS-подраздела в §3.4.5. |
| **P1-9** DHs_A | CLOSED | **closed** | §3.3.2 п.7 (420), §3.4.2 (466); assert `alice-ratchet-0 ≠ alice-ek`/`IK_dh` — мой verifier подтвердил; негативный implementation-тест. |
| **P1-10** client_message_id | CLOSED | **closed** | §4.2 (751), §4.6 (877), §6.5 (1910–1956): scope `(chat_id,sender_id,client_message_id)`, старый индекс удалён, replay по sender; K1/K2. Остаток P2-12 (NULL sender). |
| **P1-11** K_storage | CLOSED | **closed** | §2.3 (219–225): не at-rest, `STORAGE_LOCKED` удалён, `KEY_STORAGE_UNAVAILABLE` §3.6 (648), §9.9 (2462); UI/DPA без обещаний. |
| **P1-12** flag-off | CLOSED | **closed** | §6.2.8 (1401), §6.6 (2087–2092), §10.4 (2527–2539), J2; существующий E2EE не понижается, plaintext 422, badge off. Остаток: контракт I-01. |

**Итог матрицы:** P0 — 2 closed, 2 partially; P1 — 6 closed, 6 partially. Заявление S2 «4/4 + 12/12 closed» — **не подтверждено**; корректная формулировка: «все 4 P0 и 12 P1 адресованы, 2 P0 и 6 P1 требуют доработки».

### 14 вопросов review-01 → статус ответа S2

| # | Вопрос review-01 | Ответ S2 | Оценка review-02 |
|---|---|---|---|
| 1 | P0-1: почему verification на `verifier_user_id`? | Недосмотр; добавлен `verifier_device_id`, `VH` v2, G5 | **closed** (остаток P2-1/P2-2) |
| 2 | P0-2: §3.3.1 — исчерпывающий чек-лист? | Да, TOFU-пункт 6, pin по `device_id`, I1/I2 | **partially**: P0-2b (prekey↔bundle), P1-E (кодировка) |
| 3 | P0-3: что если сервер пришлёт MANAGED? | Клиент пиннит режим, не шлёт plaintext; trigger + 409 | **partially**: fresh-device без пина — P1-G |
| 4 | P1-1/R-15: каким сигналом B говорит A? | `content_type=2` в новом prekey-конверте, не WS; L1/L2 | **partially**: multi-message — P1-C |
| 5 | P1-9: `DHs` = `EK`? | Нет, свежая пара; assert/negative | **closed** |
| 6 | P1-3: 512 decoded или wire? Почему 64 KiB? | Wire 512 KiB; 64 KiB encoded form cap; 32 KiB decoded; OpenAPI 363/65536 | **closed** (P2-11 form cap) |
| 7 | P1-4: §6.5 против V1–V15? | Нет `text`; `crypto_scheme`; V10 снял CHECK; `CREATE` таблиц | **partially**: grants/RLS/partitions/`reply_to_id` — P1-A/P1-F |
| 8 | P1-5: direct pair без `direct_key`? | `direct_key` + partial unique; `peer_id` из members | **partially**: `ChatSummary.peer_id` — P1-H |
| 9 | P1-8: кто/когда уничтожает ключи, окно FS? | OPK сразу; старый DHs сразу; MKSKIPPED 30д/2000; SPK 2×30д | **partially**: 60 vs 90, нет DHs/SPK destruction — P1-D |
| 10 | P1-11: что разблокирует `STORAGE_LOCKED`? | Ничего; состояние удалено; `KEY_STORAGE_UNAVAILABLE` | **closed** |
| 11 | P1-10: scope `client_message_id`? | `(chat_id,sender_id,client_message_id)`; cross-user 409 | **closed** (P2-12 NULL sender) |
| 12 | P0-4: self-envelope и лимит 10? | Self-envelope отклонён; атомарная копия+outbox; max 9/10 | **closed** (P2 terminal 4xx) |
| 13 | P2-5: «сервер не знает digits»? | Заменено на «не хранит»; `verified` — attestation | **closed** |
| 14 | P2-3: `header.v` в E1/E2? | Добавлен `v:1`; байты не изменились | **closed** (E1/E2 header — hex, внутреннее представление) |

---

## Проверка векторов (команды, результаты)

### Команды

```bash
# 1) авторский верификатор S2 (извлечён из docs/E2EE-SPIKE-NOTES.md §9.3; запускался вне репозитория)
node verify_e2ee_vectors_s2.mjs docs/E2EE-TEST-VECTORS.json
# 189 checks, 0 failures

# 2) независимый верификатор review-02 (написан по §1–§7 спеки, не по коду генератора; вне репозитория)
python3 review_verify.py docs/E2EE-TEST-VECTORS.json
# 368 independent checks, 0 failures

# 3) детерминизм: генератор S2 из §9.1, output перенаправлен во временный файл
python3 gen_e2ee_vectors_s2.py     # written; vectors: 34 sections: 13
cmp docs/E2EE-TEST-VECTORS.json generated.json
# IDENTICAL; sha256 8e803df66d0b4e3b9ea1944adec4be3dcd948fc5e54187ecf53d9c1c364a5baa
# повторный запуск → снова identical
```

Скрипты не добавлялись в репозиторий (зона: только `docs/E2EE-REVIEW-02.md`); они лежали в `/tmp/e2ee_review2`. Авторский верификатор использовался только как **один из** источников: 368 проверок ниже не импортируют его код и не читают `gen.py`.

### Что именно перепроверено (все 13 секций)

| Секция | Что пересчитано | Результат |
|---|---|---|
| A1–A4 | RFC 7748 (pub/shared), RFC 8032 TEST 1 (pub/sig/verify), RFC 5869 TC1 (HKDF extract/expand вручную), NIST AES-256-GCM zero key/IV/empty | 0 failures |
| B1–B5 | DH1–DH4, IKM `F‖…`, SK, session_id; 3DH; SPK-сообщение 66 B + подпись; преамбул 323 B + SHA-256 + подпись; binding 88 B + verify/negative | 0 failures |
| C1–C3 | session_id, `RK'||CK` (L=64), три `MK/CK'` | 0 failures |
| D1–D3 | framing 51→77→256 (179 нулей), AD 163 B из полей, AEAD key/nonce, decrypt + re-encrypt, tamper | 0 failures |
| E1 | полная DR-симуляция: A init, B init через SPK, 4 сообщения, 2 turn, `pn`; **включая `r2` на стороне A** | 0 failures |
| E2 | chain key 0..2, AD, decrypt, delivery `0,2,1`, skipped n=1, `Nr=3`, состояние после m2 | 0 failures |
| F1–F2 | JSON 1310/756 B, canonical b64u, header/AD/preamble из полей, prekey signature, ciphertext = D2/E1 m2, `prekey` отсутствует в F2 | 0 failures |
| G1–G5 | FP, SHA-512/digits/display/QR, key change, VH v2, L2 digits/VH/`verified=null` | 0 failures |
| H1–H2 | sender key chain и AEAD (informative) | 0 failures |
| I1–I2 | Mallory X3DH→Bob, преамбул/подпись, binding, AD/AEAD (decrypt/re-encrypt), FP, safety number, pin/mismatch | 0 failures (binding декодирован как hex — см. P1-E) |
| J1–J2 | mode immutability/flag-off структурные инварианты | 0 failures |
| K1–K2 | scope/replay/cross-user структурные инварианты | 0 failures |
| L1–L2 | `content_type=2` framing 179→256, SHA-256, state-machine инварианты | 0 failures |

### Tamper/negative (сверх JSON)

| Подмена | Ожидание | Факт |
|---|---|---|
| 1 байт ciphertext D2 | AEAD fail | reject |
| AD D2: `chat_id` (offset 20) | AEAD fail | reject |
| AD D2: `session_id` (offset ~70) | AEAD fail | reject |
| AD D2: `header.n` (offset 121+6) | AEAD fail | reject |
| Преамбул B4: 1 байт | подпись fail | reject |
| Binding B5: `IK_dh` | verify fail | reject |
| I2: pin fingerprint ≠ presented | `KEY_CHANGE_DETECTED` | mismatch=true; AEAD при этом валиден (подтверждено) |

### JSON schema / структура

- 34 уникальных `id`, 13 секций, 12 нормативных + 1 informative; `vector_set_version=2`; `protocol_envelope_version=1`.
- F1/F2/I1/I2 `envelope_json` разобраны: обязательные поля `CryptoEnvelope`, `header` ровно `{v,dh,pn,n}`, `additionalProperties` нет, `session_id` 16 B, `dh` 32 B, `ciphertext >=272` B, `recipient != sender`, `prekey` только с полями схемы, `signature` 64 B.
- **Нарушение:** `presented_identity_binding_signature`/`pinned_identity_binding_signature` в I1/I2 — 128 hex-символов, b64u-декодирование = 96 B вместо 64 (P1-E). Формальной `$schema` в файле нет; структурная проверка выполнена вручную (P2-9).
- `meta.limits` пересчитан: 32768 body → 32794 raw → 33024 padded → 33040 ct → 44054 b64u; 9 = 405098 B, 10 = 450099 B; slack 119190/74189; `45056*10+89=450649 < 524288`; 11 canonical fit, 7 form-cap fit. Всё сходится.
- `meta.checks`: 189/0 — подтверждено авторским verifier; **`meta.generator.verify_command` говорит «expected: 160»** — противоречие (P2-8).

### Что векторами не проверяется (честно)

WebCrypto non-extractable/structured clone/Safari-Firefox, IndexedDB-транзакции/crash-recovery, multi-tab, реальный Java Ed25519 verify, поведение прокси/ingress по 413, RLS/grants на реальном Postgres. Это G2–G4 и E7-B/F.

---

## Остаточные риски

1. **TOFU-окно первого контакта** — подмена при самом первом контакте не детектируется; KT v1 нет. Принято, но safety number обязателен; UI должен это говорить.
2. **Malicious server** — может врать о `verified`, ключах, режиме, coverage; клиент не отправляет plaintext при наличии пина, но не может доказать честность сервера.
3. **Fresh-device/cleared-cache mode** — без локального пина сервер может сказать `MANAGED`; P1-G. До исправления нельзя утверждать «plaintext никогда».
4. **P0-2b** — сессия может быть установлена не с теми ключами, что закреплены за `device_id`; P0, блокирует.
5. **R-15 multi-message** — reset чинит одно сообщение; остальные могут потеряться (P1-C).
6. **FS/PCS window** — числа 60/90 противоречивы, уничтожение старых ключей не нормативно (P1-D).
7. **DDL/RLS** — V16+ без grants/RLS/partitions не заработает; либо cross-tenant prekeys; P1-A.
8. **Global unique identity keys** — не доказывает владение; копия публичного bundle возможна первым регистратором; squatting/DoS (P2-6).
9. **No backup v1** — потеря профиля/устройства = потеря истории и своей копии; self-envelope отклонён; принято.
10. **`K_storage` не at-rest** — кража профиля/диска + JS в origin = доступ; принято, DPA/UI не должны обещать.
11. **PCS** — только после ответного DH-ratchet; не мгновенный; группы/sender keys вне E7.
12. **G4** — реализация не проверена; векторы ловят регрессии, а не ошибки реализации; без G4 E2EE в prod нельзя.
13. **Контракт I-01** — `openapi.yaml`/`ws-protocol.md`/`schema.d.ts` не обновлены; backend/frontend не стартуют с новыми DTO.
14. **Векторы** — I1/I2 binding hex; meta 160/189; формальной схемы нет.
15. **Server-forged plaintext** — клиент должен игнорировать `text`/`reply_to_id` при `crypto:null` в E2EE-чате; иначе malicious server может «нарисовать» сообщение (P2-13).

---

## Условия GO

### Блокирующие (до E7-B1/B3/B5; без них — NO-GO на реализацию)

1. **P0-2b**: сервер проверяет `prekey.sender_identity_* == auth.devices.identity_*`; клиент — `== bundle == TOFU pin`; binding — над теми же ключами; новый негативный вектор I3 и integration-тест.
2. **P1-A**: §6.5 исправить до первой миграции: `GRANT` на `device_prekeys`/`key_verifications`/`message_envelopes`; RLS для `device_prekeys`/`envelopes`; `auth.devices` — `SECURITY DEFINER`/policy для claim/keys; `ensure_partition` создаёт партиции envelopes; CHECK `reply_to_id IS NULL` и `sender_id/sender_device_id NOT NULL` для E2EE.
3. **I-01**: применить §6.3/§6.4 к `contracts/openapi.yaml`/`ws-protocol.md`, перегенерировать `schema.d.ts`, contract-тесты в CI. Без этого E7-B3/B4/B5/F3 не стартуют.
4. **P1-E**: I1/I2 binding — b64u64 (86 символов) или отдельный wire-валидный вектор; schema-тест; перегенерировать 34 вектора (значения не меняются).

### До включения E2EE (G2–G4)

5. **P1-B**: `peer_covered >= 1` иначе 409/422; `PEER_DEVICE_UNCOVERED` warning; M1.
6. **P1-C**: reset перешифровывает все pending/undelivered сообщения failed-сессии; L2b; 0 дублей.
7. **P1-D**: выбрать 60 или 90 дней; синхронизировать §1.3/§2.3/§3.4.2/§5.5/§10.7; нормативный FS/PCS-подраздел; property/storage-тесты.
8. **P1-G**: fresh-device правило/UX; J1 расширить; честный §7.6/§9.3.
9. **P1-F**: `reply_to_id` reject + DB CHECK + тест.
10. **P1-H**: `peer_id` в `ChatSummary` (или `GET /chats/{id}`).
11. P2-1/P2-2 (`verified_count`, `vh_version`), P2-3 (`NOT_MEMBER`), P2-6 (ownership challenge) — до G3/G4; P2-8 (meta 160/189) — сразу.
12. **G2**: KAT в реальном браузере + Node; **G3**: E2E два браузера (safety number, key change, revoke, reset); **G4**: внешний review реализации + пентест. Без G4 — flag off в prod.

### Что можно начинать сейчас (flag off)

- E7-B1 — **только после** P1-A (иначе миграция не рабочая).
- E7-B2 — можно (VO/identity binding), контракт §6.3 согласован.
- E7-B3 — после P0-2b + I-01 (claim/keys RLS).
- E7-B4/B5 — после I-01 + P1-A; P1-B — до включения.
- E7-F1/F2 — можно (KAT/WebCrypto/storage), векторы v2.
- E7-F4 — после G0 (P0-2b) и P1-D.
- Включение E2EE/реальные ключи/бейдж — **нет** до G4.

---

## Вопросы

1. **P0-2b.** Подтверждаете, что `prekey.sender_identity_signing_key/dh_key` обязаны совпадать с `auth.devices`/claim-bundle, и что сервер должен это проверять? Если нет — как клиент отличает «новую пару в prekey» от смены ключей, если binding проверяется по bundle?
2. **P1-A.** Какой механизм доступа к устройствам собеседника выбран: `SECURITY DEFINER`-функция, policy по `chat_members` или отдельная роль? Кто выдаёт `GRANT` на новые таблицы и партиции? Где создаются партиции `message_envelopes`?
3. **P1-B.** Какой код/статус для `peer_covered==0` — `409 E2EE_NO_PEER_ENVELOPE`, `422 PEER_UNCOVERED` или warning? Должен ли сервер требовать покрытие **всех** peer-устройств или хотя бы одного?
4. **P1-C.** При reset A повторяет **одно** сообщение или все pending этой сессии? Если все — каков лимит batch и как избежать дублей в UI?
5. **P1-D.** `SPK_RETAIN_PRIVATE=2` — это 2 total (60 дней) или 2 previous + current (90)? Кто и когда уничтожает старый `DHs_priv`/SPK? Где записан честный FS/PCS-window?
6. **P1-E.** I1/I2 binding — hex или b64u? Если hex — почему поле, приходящее из `GET /keys`, не в wire-кодировке? Можно ли перегенерировать векторы с b64u?
7. **P1-G.** Что должен делать клиент на новом устройстве/после очистки профиля, если сервер говорит `MANAGED` для чата, который был E2EE? Блокировать отправку до подтверждения или разрешить plaintext?
8. **P1-H.** `peer_id` будет в `ChatSummary` или отдельным `GET /chats/{id}`? Как frontend отличает DIRECT-собеседника в списке?
9. **P2-4.** `422 E2EE_LEGACY_DEVICE` — как он достижим, если natural key больше не ключ и в `POST /devices` нет `device_id`? Убрать или задать адресацию?
10. **P2-3.** `NOT_MEMBER` в `unavailable[]` или `422 UNKNOWN_DEVICE` для не-участника? Сейчас в спеке оба.
11. **P2-2.** Будет ли `vh_version` в `VerificationRequest`/колонке, или сервер пересчитывает VH v2 из публичных ключей? Без этого «u8(1) untrusted» неисполнимо.
12. **P2-1.** `verified_count` — только строки текущего `verifier_device_id` или все верификаторы? Если все, как UI не покажет «1 из 2» на L2?
13. **P2-8.** Почему `meta.generator.verify_command` говорит 160, а verifier/спека/changelog — 189? Это stale-строка генератора?
14. **P2-6.** Готовы ли принять challenge-response (nonce, подписанный `IK_sig`) при `POST /devices`, или global unique + 409 считается достаточным, несмотря на копирование публичного bundle и squatting?

---

*Конец review-02. Замечания адресованы автору спеки/PM; изменений в `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, `docs/E2EE-SPIKE-NOTES.md`, `docs/TASKS*.md`, `contracts/**`, `backend/**`, `frontend/**` не вносилось.*

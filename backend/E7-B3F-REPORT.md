# E7-B3F — закрытие G4 P0/P1/P2 (E2EE-REVIEW-06)

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, минимальные правки
> `contracts/**`, регенерация `frontend/src/api/schema.d.ts`, необходимая правка
> `docs/E2EE-SPEC.md` (§4.1/§4.2/§4.4/§4.5/§4.7) и этот отчёт. Остальной
> `frontend/**`, `design/**` и прочие `docs/**` не менялись. Git-репозитория в
> workspace по-прежнему нет, поэтому diff/one-PR подтвердить нельзя.

## Статус

**DONE по P0-01, P1-01, P1-02, P2-01, P2-02, P2-03, P2-04, P2-05.**
**PARTIAL по P2-08:** гонка лимита OPK закрыта (сериализация upload), retention
`auth.device_prekeys` остаётся B4-долгом (см. «Остаточные риски»).

Это не включает E2EE-флаг: `krug.e2ee.enabled` / `KRUG_E2EE_ENABLED` остаётся
**false** по умолчанию. G2 (браузерные KAT) и внешний G4 crypto-review остаются
предусловиями GO для E7-F, как и требовал review-06.

Полный прогон: **324/324** (baseline 314 + 10 новых), ArchUnit **10/10**,
`contract:check` зелёный (33 operations / 58 schemas / types in sync).

## P0/P1/P2 closure

| Finding | Статус | Что сделано | Доказательство |
|---|---|---|---|
| **P0-01** percent-encoded path bypass `DeviceBindingFilter`; чужой envelope через GET | **closed** | Единый decoded-path helper `ApiRequestPath`; фильтр матчит/валидирует по нормализованному пути; `X-Device-Id` валидируется **всегда**, если присутствует; defense-in-depth в `MessageQueryHandler.withCrypto`, `RealtimeChatHistoryAdapter` и SQL `findForDevice` (owner + ACTIVE + chat member). | real-HTTP: encoded и canonical GET с чужим `X-Device-Id` → `401`; encoded GET своим устройством → `200`, `crypto:null`; encoded `GET .../keys` с чужим device → `401`; `findForDevice` возвращает 0 строк при чужом device. |
| **P1-01** percent-encoded path bypass `PayloadLimitFilter` | **closed** | Тот же нормализованный путь; тело читается bounded независимо от `Content-Length` (chunked/streaming тоже), `>512 KiB` → `413 PAYLOAD_TOO_LARGE` до JSON-парсинга; сообщение/`seq` не создаются. | real-HTTP: canonical, `%6Dessages` и `%63hats` с 600 KiB → `413`; число сообщений не изменилось. |
| **P1-02** ciphertext floor 16 B vs контрактные 363 символа | **closed** | Floor поднят до **272 decoded B / 363 b64u** в `CryptoEnvelope`/`EnvelopeLimits`/`EnvelopeCodec`; миграция **V18** `ck_envelopes_ciphertext_min CHECK (272..33040) NOT VALID`; §4.1/§4.5/§4.7 спеки исправлены; контракт `minLength: 363` сохранён. | 16 B (22 chars) и 271 B (362 chars) → `422 INVALID_ENVELOPE_FORMAT/ciphertext_too_short`; 272 B (363 chars) → `201`; GET проходит `CONTRACT.assertValid("CryptoEnvelope")`; прямой INSERT 271 B отклонён V18. |
| **P2-01** replay coverage `peer_devices=0` vs `minimum: 1` | **closed** | Выбран минимально безопасный вариант: контракт `EnvelopeCoverage.peer_devices.minimum: 0` + описание; новый send по-прежнему требует `peer_devices >= 1` (`409 E2EE_NO_ACTIVE_DEVICES`); replay честно отдаёт 0 после revoke. §4.2 дополнена семантикой replay. | send → revoke единственного peer-устройства → replay по `Idempotency-Key` и по `client_message_id` → `201` с `peer_devices=0`, `CONTRACT.assertValid("MessageCreateResult")`. |
| **P2-02** race-replay без `envelope_coverage` | **closed** | Новый `MessageReplayCoverageService` (`@Transactional(readOnly=true)` + `tenantContext.activate`) пересчитывает coverage в tenant-scope; `SendMessageUseCase` больше не глотает исключение; `MessageApiMapper.toCreateResponse` fail-closed (E2EE + coverage == null → 5xx, не schema-invalid 201). | Два конкурентных POST с одним `client_message_id` (unique-index race воспроизведён в логе): каждый `201` содержит `envelope_coverage` и проходит контракт; создано ровно одно сообщение. |
| **P2-03** flag off не гейтит WS replay и `Idempotency-Key` replay | **closed** | Проверка флага перенесена **до** `idempotency.reserve`; replay E2EE при flag off → `409 E2EE_DISABLED`; `RealtimeChatHistoryAdapter` не отдаёт E2EE-сообщения/конверты при flag off; live-listener также не публикует E2EE-кадры; managed не затронут. §4.4/§4.2 и `contracts/ws-protocol.md` дополнены. | E2EE send при flag on → flag off: replay по тому же ключу `409`, REST `409`, WS reconnect/replay не получает `message.created`; managed replay — `201` + `Idempotent-Replay: true`. |
| **P2-04** неканонические UUID и duplicate JSON keys | **closed** | `EnvelopeCodec` требует `uuid.toString().equals(value)` (lower-case 8-4-4-4-12); глобальный `STRICT_DUPLICATE_DETECTION` через `JacksonConfig`; duplicate keys → `400 VALIDATION_FAILED`. | `1-1-1-1-1` и upper-case UUID → `422 INVALID_ENVELOPE_FORMAT`; duplicate `client_message_id` → `400`, сообщение не создано; канонические UUID — `201`. |
| **P2-05** расхождение capability-предиката | **closed** | `Device.isE2eeCapable()` зеркалит `auth.device_is_e2ee_capable`: ACTIVE + Ed25519+X25519 + IK_sig(32)/IK_dh(32)/binding(64)/**fingerprint(32)**. | unit `DeviceCapabilityTest` (3/3); в IT SQL-функция для зарегистрированного capable-устройства = true; E2EE fan-out/coverage/GET keys используют тот же предикат. |
| **P2-08** prekey cap race/retention | **PARTIAL** | Гонка закрыта: `PrekeyUploadService` берёт `lockOwner` до чтения `available`, поэтому два конкурентных upload не могут вместе превысить 200 OPK. Retention `device_prekeys` (expired cleanup job) — явный B4-долг. | Конкурентные upload по 150 OPK: ровно один `200`, второй `422 PREKEY_LIMIT_EXCEEDED`, в БД ≤200 доступных OPK. |

## Сделано

### 1. P0-01 — path normalization и per-device binding

* Новый `shared/infrastructure/web/ApiRequestPath`: single-pass decode
  (без повторного decode, без `+`→space), запрет `;`, `\`, NUL/control,
  `.`/`..`-сегментов и `//`. Один и тот же путь используют
  `DeviceBindingFilter` и `PayloadLimitFilter`.
* `DeviceBindingFilter`:
  * `shouldNotFilter`/`requiresDevice` работают по decoded path;
  * malformed/traversal path → `401` (не доходит до MVC);
  * `X-Device-Id` валидируется при **любом** наличии: на device-required
    операциях ошибка → `401`, на остальных → `403` (сохранён контракт
    `RealtimeTicketIT`, где чужое устройство = `403`);
  * E2EE message routes (`/api/v1/chats/**`) всегда device-required.
* `KeycloakDeviceBinding`: header присутствует → всегда `isActiveDeviceOfUser`;
  отсутствует и не требуется → `deviceId=null`.
* `DevDeviceBinding`: header присутствует → всегда равен signed `device_id`
  claim; больше нельзя подсунуть произвольный UUID на необязательной операции.
* Defense-in-depth:
  * `MessageQueryHandler.withCrypto` проверяет `deviceDirectory.findDevice`:
    устройство существует, ACTIVE и принадлежит `principal.userId()`, иначе
    `403` (не отдаёт чужой конверт);
  * `MessageEnvelopeRepositoryAdapter.findForDevice` дополнительно требует
    `auth.devices` (owner = `ops.current_user_id()`, ACTIVE) и ACTIVE
    membership в `chat.chat_members`;
  * `RealtimeChatHistoryAdapter` проверяет устройство соединения и при
    невалидном/чужом device отдаёт `crypto:null`, не читая envelopes.

### 2. P1-01 — payload limit на нормализованном пути

`PayloadLimitFilter` больше не использует raw `getRequestURI()`:
`POST .../messages` распознаётся после decode; тело читается bounded
(`limit + 1`) независимо от `Content-Length`, поэтому chunked/streaming не
обходят лимит. Невалидный путь отклоняется до чтения тела. `413` отдаётся
контрактным `Error`-конвертом; запись сообщения не происходит.

### 3. P1-02 — канонический ciphertext floor 272 B / 363 chars

* `CryptoEnvelope.MIN_CIPHERTEXT_BYTES = 272`, сообщение об ошибке
  `"ciphertext must be 272..33040 bytes"`.
* `EnvelopeLimits.MIN_CIPHERTEXT_ENCODED = 363`; `EnvelopeCodec` проверяет
  encoded floor до decode и decoded floor после.
* V18: `ck_envelopes_ciphertext_min CHECK (octet_length(ciphertext) BETWEEN 272
  AND 33040) NOT VALID` — новые INSERT/UPDATE (включая все партиции)
  проверяются; старые короткие строки не ломают rollout (и не отдаются новым
  клиентам, потому что API их больше не принимает).
* `docs/E2EE-SPEC.md`: §4.1 (272 = 256 padding + 16 tag), §4.5, §4.7 и
  acceptance-таблицы синхронизированы; контракт `minLength: 363` не менялся.

### 4. P2-01/P2-02 — replay coverage

* Контракт: `peer_devices.minimum: 0` + описание «новый send ≥1, replay может
  честно вернуть 0 после revoke; не клампится».
* `E2eeEnvelopeValidator.validate` сохраняет инвариант нового send:
  `peerDevices.isEmpty()` → `409 E2EE_NO_ACTIVE_DEVICES` до `Message`/`seq`.
* `MessageReplayCoverageService` — отдельный read-only сервис с
  `tenantContext.activate`, `chatAccess.requireActiveChat`,
  `chatContext.require` и пересчётом coverage. `SendMessageUseCase` вызывает
  его в catch-ветке `client_message_id` race и **не превращает** сбой в
  `201` без coverage.
* `MessageApiMapper.toCreateResponse` fail-closed: E2EE-ответ без
  `envelope_coverage` — исключение (5xx), а не schema-invalid `201`.

### 5. P2-03 — flag off как kill-switch для replay

* `MessageSubmissionHandler.submit`: chat access и проверка флага выполняются
  до `idempotency.reserve`; replay E2EE при flag off → `409 E2EE_DISABLED`
  (и в `replay()` есть вторая проверка).
* `RealtimeChatHistoryAdapter`: при flag off E2EE-строки не попадают в replay,
  envelopes не читаются; managed-история не затронута.
* `RealtimeMessageCreatedListener`: E2EE live-кадр не публикуется при flag off.
* `contracts/ws-protocol.md` и §4.4/§4.2 описывают поведение.

### 6. P2-04 — strict wire canonicalization

* Все UUID в envelope (chat/sender/recipient) принимаются только в
  канонической lower-case форме 8-4-4-4-12.
* Глобальный `JsonParser.Feature.STRICT_DUPLICATE_DETECTION` для HTTP
  `ObjectMapper`; duplicate keys → `400 VALIDATION_FAILED` (Jackson
  `HttpMessageNotReadableException`), не last-wins.

### 7. P2-05 — единый capability predicate

`Device.isE2eeCapable()` теперь проверяет `fingerprint != null` и точные длины
всех четырёх ключевых полей (32/32/64/32), как V17 SQL-функция.
`DeviceRepositoryAdapter.findActiveByUserIds` уже требовал fingerprint; домен
больше не расходится с ним. Уже применённые миграции V16/V17 не изменялись
(Flyway checksum), floor вынесен в новую V18.

### 8. P2-08 — prekey cap race (retention — долг)

`PrekeyUploadService.upload` вызывает `deviceRepository.lockOwner(userId)`
перед чтением `available`/записью OPK. Это сериализует конкурентные upload
одного пользователя и закрывает race `available + newKeys > 200`. Retention
истёкших `auth.device_prekeys` не добавлен: это отдельный B4-долг, требующий
scheduler/политики, а не part of this P0/P1.

## Файлы

### Backend — main

* `shared/infrastructure/web/ApiRequestPath.java` (new)
* `shared/infrastructure/web/PayloadLimitFilter.java`
* `shared/infrastructure/security/DeviceBindingFilter.java`
* `shared/infrastructure/security/KeycloakDeviceBinding.java`
* `shared/infrastructure/security/DevDeviceBinding.java`
* `shared/infrastructure/config/JacksonConfig.java` (new)
* `message/application/usecase/MessageQueryHandler.java`
* `message/application/usecase/MessageSubmissionHandler.java`
* `message/application/usecase/SendMessageUseCase.java`
* `message/application/service/EnvelopeCodec.java`
* `message/application/service/EnvelopeLimits.java`
* `message/application/service/MessageReplayCoverageService.java` (new)
* `message/domain/model/CryptoEnvelope.java`
* `message/api/mapper/MessageApiMapper.java`
* `message/api/MessageController.java`
* `message/infrastructure/persistence/MessageEnvelopeRepositoryAdapter.java`
* `realtime/infrastructure/adapter/RealtimeChatHistoryAdapter.java`
* `realtime/infrastructure/event/RealtimeMessageCreatedListener.java`
* `auth/domain/model/Device.java`
* `auth/application/usecase/PrekeyUploadService.java`
* `db/migration/V18__e2ee_ciphertext_floor.sql` (new)

### Backend — tests

* `integration/E2eeMessageIT.java`: +4 теста (ciphertext floor, replay после
  revoke, race coverage, canonical UUID/duplicate keys).
* `integration/E2eeMessageRealtimeIT.java`: +2 теста (real-HTTP encoded path /
  payload, flag-off idempotency+WS replay); `@MockBean E2eeSettingsPort` для
  переключения флага.
* `integration/E2eeDeviceKeyIT.java`: +1 конкурентный prekey-cap тест.
* `unit/DeviceCapabilityTest.java` (new, 3).
* `integration/E2eeQueryPlanIT.java`, `integration/E2eeMessageIT.java`:
  ciphertext в прямых INSERT поднят до 272 B (V18).
* `integration/OutboxIT.java`: стабилизирован известный flake `publishPending()`
  (проверяется `published_at`, а не кто выиграл гонку с scheduler'ом другого
  cached-контекста).

### Contracts / frontend / docs

* `contracts/openapi.yaml` — `EnvelopeCoverage.peer_devices.minimum: 0` +
  семантика replay; `ciphertext.minLength: 363` без изменений.
* `contracts/ws-protocol.md` — flag-off replay и floor 272/363.
* `frontend/src/api/schema.d.ts` — регенерирован `npm run api:types`
  (`contract:check` подтверждает sync).
* `docs/E2EE-SPEC.md` — §4.1/§4.2/§4.4/§4.5/§4.7 (floor, replay coverage,
  kill-switch).
* `backend/README.md` — синхронизирован floor ciphertext (272 B / 363 chars).

## Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd backend
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 324, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit: Tests run: 10, Failures: 0, Errors: 0
# E2EE IT: E2eeMessageIT 16, E2eeMessageRealtimeIT 3, E2eeDeviceKeyIT 8,
#          E2eeLimitsIT 10, E2eeMessageFlagOffIT 1, E2eeFlagOnIT 1,
#          E2eeRealtimeIT 2, E2eeClaimRateLimitIT 1, E2eeQueryPlanIT 1,
#          E2eeMigrationIT 6

mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMessageIT,E2eeMessageRealtimeIT,E2eeDeviceKeyIT,RealtimeTicketIT' test
# Tests run: 31, Failures: 0

cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.

npm run --silent api:types
# ../contracts/openapi.yaml → src/api/schema.d.ts
```

Ключевые regression-сценарии:

* **P0-01 real HTTP** (не MockMvc): `GET /api/v1/%63hats/{id}/%6Dessages` +
  чужой `X-Device-Id` → `401`; canonical + чужой → `401`; encoded + своё
  устройство → `200`, `crypto:null`; encoded `GET .../keys` + чужой → `401`.
* **P1-01 real HTTP**: 600 KiB на canonical, `%6Dessages`, `%63hats` → `413`;
  количество сообщений не изменилось.
* **P1-02**: 16 B/22 chars → `422`, 271 B/362 chars → `422`, 272 B/363 chars →
  `201`; GET `CryptoEnvelope` валиден по контракту; прямой INSERT 271 B → V18.
* **P2-01**: send → revoke peer device → replay по `Idempotency-Key` и
  `client_message_id` → `201`, `peer_devices=0`, контракт валиден.
* **P2-02**: два конкурентных POST с одним `client_message_id` (unique-index
  race) → каждый `201` с coverage, контракт валиден, одно сообщение.
* **P2-03**: flag on → E2EE send → flag off → replay `409`, REST `409`, WS
  replay без `message.created`; managed replay `201`.
* **P2-04**: `1-1-1-1-1`, upper-case UUID, duplicate JSON keys → отказ.
* **P2-05**: unit-предикат + SQL capability для зарегистрированного устройства.
* **P2-08**: конкурентные OPK upload → один `200`, один `422`, ≤200 в БД.

## Contract / spec

* `EnvelopeCoverage.peer_devices` — `minimum: 0`; `peer_covered`/`self_*` уже
  были `minimum: 0`. Это отражает выбранную семантику: coverage не хранится,
  replay пересчитывает её по текущим устройствам; новый send имеет отдельный
  инвариант `peer_devices >= 1`.
* `CryptoEnvelope.ciphertext` — без изменений: `minLength: 363`,
  `maxLength: 44054`; серверный floor теперь совпадает с контрактом.
* `MessageCreateResult.envelope_coverage` остаётся optional в JSON Schema
  (managed-ответ не содержит поля), но для E2EE mapper fail-closed.
* `contracts/ws-protocol.md`: E2EE-кадры не публикуются при flag off; floor
  ciphertext 272..33040 B / 363..44054 b64u.
* `frontend/src/api/schema.d.ts` регенерирован, `contract:check` зелёный.

## DDD / границы

```
shared/infrastructure/web     ApiRequestPath, PayloadLimitFilter
shared/infrastructure/security DeviceBindingFilter + strategies
shared/infrastructure/config  JacksonConfig (strict duplicate keys)
message/application/service   MessageReplayCoverageService (read-only coverage)
message/application/usecase   MessageQueryHandler (device guard), SendMessageUseCase
message/infrastructure        findForDevice SQL device/membership guard
realtime/infrastructure       per-device replay + flag-off gating
auth/domain                   Device.isE2eeCapable == V17 SQL predicate
```

ArchUnit 10/10: новых нарушений слоёв нет; application зависит только от
портов/application/shared, API не видит domain/infrastructure.

## Остаточные риски / долги

* **P2-08 retention:** `auth.device_prekeys` не чистится по `expires_at`.
  Нужен retention-job/политика (B4 debt). Гонка cap закрыта.
* **OutboxIT flake:** причина — scheduler из cached Keycloak/profile-контекста
  публикует outbox-строки в общей тестовой БД. Тест стабилизирован проверкой
  `published_at`; в полном прогоне 324/324 зелёный. `FileContractIT` в одном
  из промежуточных прогонов дал известный timing-flake (423 vs 200), в финальном
  прогоне — зелёный.
* **Git/one-PR:** репозитория нет; изменение нельзя подтвердить как один PR.
* **G2/G4:** браузерные KAT и внешний crypto-review не заменены этим отчётом;
  `KRUG_E2EE_ENABLED=false` остаётся.
* **Retention конвертов** (`message.message_envelopes`) и multi-node WS fan-out —
  прежние E3/B4-долги, не входившие в P0/P1.
* **P2-08 prekey retention** и **client_message_id per-partition uniqueness** —
  прежние остаточные риски review-06; не ухудшены.

## Что дальше

1. E7-F (клиентский X3DH/Double Ratchet, локальная копия, безопасный рендер) —
   только после G2/G4 и явного решения включить флаг.
2. P2-08 retention: job очистки истёкших OPK/SPK.
3. Durable/multi-node realtime fan-out (E3) и retention конвертов.
4. Git/one-PR процесс и стабилизация оставшихся timing-flake.

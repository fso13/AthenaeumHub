# E2EE-REVIEW-07 — G4b targeted pentest после E7-B3F

> **Рецензент:** независимый security/pentest-ревьюер. Автор E7-B3F в подготовке этого документа не участвовал.
> **Дата:** 2026-11-17. **Вход:** `docs/E2EE-REVIEW-06.md`, `backend/E7-B3F-REPORT.md`,
> `docs/E2EE-SPEC.md` (§4.1/§4.5/§4.7), `contracts/openapi.yaml`, `contracts/ws-protocol.md`,
> код `ApiRequestPath`, `DeviceBindingFilter`, `PayloadLimitFilter`, `MessageQueryHandler`,
> `EnvelopeCodec`, `MessageReplayCoverageService`, `MessageSubmissionHandler`,
> `RealtimeChatHistoryAdapter`, V16–V18.
> **Зона:** создан только этот файл; код, контракты, спека, векторы и `docs/TASKS*` не изменялись.
> Временные harness'ы и PoC лежат вне репозитория (`/tmp/e2ee-g4b`). Git-репозитория в workspace
> по-прежнему нет, поэтому diff/one-PR не проверяемы; проверялось фактическое дерево и поведение.
>
> **Что именно проверялось.** Не только MockMvc/unit-тесты B3F, а **реальный HTTP** на встроенном
> Tomcat 10.1.40 (Spring Boot 3.4.5, Java 21) в **профиле `keycloak`** (production-путь
> `KeycloakDeviceBinding`, а не dev/test `DevDeviceBinding`), с PostgreSQL 16 и реальными
> Keycloak-токенами. E2EE-флаг включался/выключался двумя экземплярами приложения на одной БД
> (18080 — `KRUG_E2EE_ENABLED=true`, 18081 — `false`). Устройства регистрировались через API
> с настоящими Ed25519/X25519-ключами, чат создавался через API; членство Bob в E2EE-workspace
> добавлялось SQL-фикстурой (публичного invite-эндпоинта в слайсе нет) — это единственная
> «непубличная» часть setup, на проверяемые границы она не влияет.

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**GO WITH CONDITIONS.**

**P0-01 (encoded-path bypass `X-Device-Id`) закрыт реально, а не только тестами.** На реальном
HTTP в keycloak-профиле канонический, `%63hats`, `%6Dessages`, `%63hats/.../%6Dessages`, `%6d`
lower-case, query-encoded и trailing-slash варианты с чужим `X-Device-Id` дают `401/403/400/404`
и **никогда** не отдают envelope чужого устройства. Своё устройство получает `200` и только
свой конверт; второе устройство того же пользователя получает только свой. Defense-in-depth
`MessageQueryHandler.withCrypto` + SQL `findForDevice` (owner + ACTIVE + membership) проверен
отдельно: при подменённом principal `app.user_id=Alice`, `recipient_device_id=Bob` SQL возвращает
0 строк, при своём устройстве — 2. `GET .../keys`, `PUT .../verification`, `POST .../read` на
encoded-путях с чужим device также отказывают.

**P1-01 (обход 512 KiB) закрыт.** 600 KiB на canonical, `%6Dessages`, `%63hats` и обоих encoded
вариантах даёт `413 PAYLOAD_TOO_LARGE` до JSON-парсинга; сообщение/`seq` не создаются. Граница
524288 B принимается, 524289 B — `413`. Chunked без `Content-Length` (600 KiB) — `413`;
chunked с валидным малым телом — `201`. Заголовок `Content-Length` не является доверенным.

**P1-02 (floor 16 B vs контрактные 363) закрыт.** 16 B/22 символа и 271 B/362 символа → `422
INVALID_ENVELOPE_FORMAT/ciphertext_too_short`; 272 B/363 → `201`; 33040 B/44054 → `201`;
33041 B/44055 → `413 ENVELOPE_TOO_LARGE/reason=canonical`. `GET` минимального и максимального
конвертов проходит `CryptoEnvelope` контракта; прямой INSERT 271 B и 33041 B отклоняется V18,
272 B/33040 B принимается. §4.1/§4.5/§4.7 и контракт синхронизированы.

**P2-01/P2-02/P2-03/P2-04/P2-05 подтверждены** (детали ниже): replay после revoke честно отдаёт
`peer_devices=0` и проходит контракт; 12/12 конкурентных пар с одним `client_message_id` дали
два `201` с `envelope_coverage` (в логе 12 unique-violation, создано по одному сообщению);
flag off гейтит REST/идемпотентный replay/WS replay, managed не затронут; envelope-UUID и
duplicate JSON keys строгие; capability domain/SQL/API совпадает.

**НО: найден новый P1-03, условный (upgrade-only).** V18 намеренно `NOT VALID`, но read-path
`MessageEnvelopeRepositoryAdapter.toDomain` всё ещё конструирует `CryptoEnvelope`, который
требует 272 B. Поэтому на БД, где E2EE включался до B3F и остались конверты 16..271 B, `GET
/chats/{id}/messages` (и WS replay — тот же `findForDevice`/`toDomain`; отдельный WS-PoC к
legacy-строке не запускался) отдаёт **500 INTERNAL** для устройства, которому адресован
такой старый конверт. Это воспроизведено на реальном HTTP. Для **чистой БД** P1-03 недостижим,
но для **in-place upgrade** это блокер.

Итого:

* **Чистая БД / новый деплой:** GO WITH CONDITIONS для `KRUG_E2EE_ENABLED=true` и старта E7-F —
  после P2-06/P2-07 (низкий риск) и внешних G2/G4; P0/P1-01/P1-02 закрыты.
* **In-place upgrade БД, где E2EE уже включался:** **NO-GO** до V19-очистки legacy-конвертов
  (или толерантного read-path) и `VALIDATE CONSTRAINT`; иначе история/replay будут падать в 500.
* **P2-06 (строгая канонизация request-UUID) и P2-07 (defense-in-depth в `ChatKeysService`)**
  не являются bypass'ами при текущем фильтре, но должны быть закрыты или явно приняты PM до
  E7-F.

## P0

### P0-01. Percent-encoded путь обходит `DeviceBindingFilter` — **закрыт; открытых P0 нет**

* **Файл/строка:**
  * `backend/src/main/java/ru/krug/backend/shared/infrastructure/web/ApiRequestPath.java:35-75` —
    единый decoded-path helper: single-pass `UriUtils.decode`, запрет `;`, `\`, NUL/control,
    `.`/`..` сегментов и `//`;
  * `.../security/DeviceBindingFilter.java:62-73,76-114,123-136` — `shouldNotFilter`/`requiresDevice`
    работают по decoded path; malformed path → `401`; `X-Device-Id` валидируется **всегда**,
    если присутствует;
  * `.../security/KeycloakDeviceBinding.java:42-55` — при наличии заголовка всегда
    `isActiveDeviceOfUser`; отсутствие на device-required → `401`;
  * `.../security/DevDeviceBinding.java:25-39` — header обязан совпадать с signed `device_id`;
  * `.../message/application/usecase/MessageQueryHandler.java:182-203` — defense-in-depth:
    `findDevice` + `active` + `userId == principal.userId()` до чтения envelopes;
  * `.../message/infrastructure/persistence/MessageEnvelopeRepositoryAdapter.java:76-119` —
    SQL дополнительно требует `auth.devices` (owner, ACTIVE) и ACTIVE membership;
  * `.../realtime/infrastructure/adapter/RealtimeChatHistoryAdapter.java:61-95` — device
    проверяется до `findForDevice`.
* **Сценарий (воспроизведён, real HTTP, keycloak):** Alice (A1) — участник E2EE DIRECT-чата;
  Bob имеет активные B1/B2; в чате есть сообщение с конвертами B1 и A2. Запросы:
  `GET /api/v1/chats/{id}/messages` и encoded-варианты с `Authorization: Alice`,
  `X-Device-Id: B1/B2` → `401 UNAUTHENTICATED`; ни в одном ответе нет `crypto` чужого device.
  Своё A1 → `200`, `crypto:null` (у отправителя нет self-envelope); A2 → `200` и **только**
  конверт A2; Bob B1/B2 → `200` и только свой конверт. См. таблицу PoC.
* **Риск (закрыт):** до фикса encoded path давал `200` с конвертом чужого устройства. Сейчас
  авторизационная граница per-device удерживается на фильтре и продублирована в сервисе/SQL.
* **Исправление:** уже в дереве; ничего переписывать не требуется. Рекомендуется сохранить
  реальные HTTP-тесты (не MockMvc) как постоянные regression-тесты, включая `%6d` lower-case,
  query-encoded и trailing-slash варианты.
* **Тест:** real HTTP keycloak, 30 path-вариантов; `GET`/`POST`/`PUT verification`/`read`/`keys`;
  свой/второй свой/чужой/без заголовка; SQL-симуляция подменённого principal (foreign 0, own 2);
  WS live cross-device (A1 null, A2 только A2, B2 только B2). Всё зелёное.

## P1

### P1-01. Обход 512 KiB percent-encoded путём — **закрыт**

* **Файл/строка:** `PayloadLimitFilter.java:37,53-77,89-102` — `MESSAGE_SEND` матчится по
  `ApiRequestPath.normalized`; тело читается bounded (`limit + 1`) независимо от
  `Content-Length`; `413` до JSON-парсинга; `CachedBodyHttpServletRequest` для дальнейшего
  чтения.
* **Сценарий (воспроизведён):** 600 KiB JSON (`envelopes[]` + `pad`) на canonical,
  `/api/v1/chats/{id}/%6Dessages`, `/api/v1/%63hats/{id}/messages`,
  `/api/v1/%63hats/{id}/%6Dessages` → все `413 PAYLOAD_TOO_LARGE`, число сообщений не меняется.
  `chunked` без `Content-Length` на canonical/encoded → `413`; валидное chunked-тело → `201`.
  Границы: 524288 B → `201`, 524289 B → `413`.
* **Риск (закрыт):** memory/CPU-DoS и обход §4.5. Сейчас лимит применяется к decoded-пути и
  фактическому потоку.
* **Исправление:** уже в дереве. Не полагаться на `Content-Length`; при добавлении новых
  message-роутов добавлять их в `MESSAGE_SEND`/общий предикат.
* **Тест:** 600 KiB на 4 вариантах пути, chunked, границы 524288/524289, счётчик сообщений до/после;
  всё `413`/`201` как ожидается.

### P1-02. Floor ciphertext 16 B vs контрактные 363 — **закрыт**

* **Файл/строка:** `CryptoEnvelope.java:52-55` (`MIN_CIPHERTEXT_BYTES = 272`);
  `EnvelopeLimits.java:16-23` (`MIN_CIPHERTEXT_ENCODED = 363`);
  `EnvelopeCodec.java:105-123` (encoded floor до decode, decoded floor после);
  `V18__e2ee_ciphertext_floor.sql:12-17` (`CHECK 272..33040 NOT VALID`); контракт
  `contracts/openapi.yaml:1575-1579` (`minLength: 363`, `maxLength: 44054`);
  `docs/E2EE-SPEC.md:744,933-934,963`.
* **Сценарий (воспроизведён):** 16 B/22 символа и 271 B/362 → `422
  INVALID_ENVELOPE_FORMAT/ciphertext_too_short`; 272 B/363 → `201`; 33040 B/44054 → `201`;
  33041 B/44055 → `413 ENVELOPE_TOO_LARGE/reason=canonical`. `GET` как B2: ciphertext 363 и
  44054; оба конверта прошли `OpenApiContract.assertValid("CryptoEnvelope")`. Прямой INSERT:
  271 B и 33041 B — CHECK violation партиции `message_envelopes_2026_11`; 272 B и 33040 B —
  accepted.
* **Риск (закрыт):** сервер больше не производит schema-invalid `201`/`GET` с коротким
  ciphertext; контракт/спека/БД совпадают.
* **Исправление:** уже в дереве. **См. P1-03:** `NOT VALID` сохраняет старые короткие строки,
  и текущий read-path не умеет их читать — это отдельный upgrade-риск, а не откат P1-02.
* **Тест:** 16/271/272/33040/33041; GET-контракт на min/max; DB CHECK на 271/272/33040/33041.

### P1-03 (новый, upgrade-only). Legacy-конверт 16..271 B → 500 на `GET` (и на том же read-path WS replay)

* **Файл/строка:**
  * `backend/src/main/resources/db/migration/V18__e2ee_ciphertext_floor.sql:12-17` — CHECK
    добавлен `NOT VALID`; существующие строки не проверяются и не удаляются;
  * `backend/src/main/java/ru/krug/backend/message/infrastructure/persistence/MessageEnvelopeRepositoryAdapter.java:139-148`
    — `toDomain` конструирует `new CryptoEnvelope(...)` для **любой** прочитанной строки, без
    фильтра по длине;
  * `backend/src/main/java/ru/krug/backend/message/domain/model/CryptoEnvelope.java:52-55` —
    конструктор бросает `IllegalArgumentException` для `< 272` B;
  * `MessageQueryHandler.java:197`, `RealtimeChatHistoryAdapter.java:84-88` — вызывают
    `findForDevice`, который маппит старую строку;
  * `MessageEnvelopeRepositoryAdapter.java:122-137` — `findByMessage` (replay/fingerprint) также
    маппит без фильтра.
* **Сценарий (воспроизведён на real HTTP):** в БД, прошедшей V17→V18, остаётся 16 B (или 271 B)
  конверт, принятый до B3F (review-06 P1-02 это прямо воспроизводил). Я смоделировал ровно это
  состояние: временно снял V18-CHECK, вставил 16 B строку для существующего сообщения и
  устройства A2, вернул CHECK как `NOT VALID` (та же `convalidated=f`-семантика, что после
  миграции). `GET /api/v1/chats/{id}/messages` с `X-Device-Id: A2` → **500**
  `{"code":"INTERNAL"}`; тот же запрос с A1 (у которого нет такой строки) → `200`; после
  удаления строки A2 снова `200`. В логе:
  `InvalidDataAccessApiUsageException: ciphertext must be 272..33040 bytes` →
  `CryptoEnvelope.<init>` → `MessageEnvelopeRepositoryAdapter.toDomain` →
  `MessageQueryHandler.withCrypto`. V18 при этом `convalidated = f` (4 constraint-записи:
  parent + 3 партиции). WS replay использует тот же `findForDevice` → `toDomain` в
  `RealtimeChatHistoryAdapter`; отдельный WS-клиент к legacy-строке не подключался, но
  код-путь идентичен.
* **Риск:** (а) in-place upgrade установки, где E2EE включался в B3/B4, ломает историю и WS
  replay для затронутого устройства — это availability/upgrade-регрессия, не утечка; (б)
  сообщение B3F «старые короткие строки не ломают rollout и не отдаются новым клиентам» неверно:
  API их **читает** и падает; (в) `NOT VALID` + отсутствие cleanup означает, что
  `VALIDATE CONSTRAINT` когда-нибудь упадёт; (г) клиент получает `500` на страницу/кадр, а не
  `crypto:null`/явный `409`, и может уйти в retry-петлю. На чистой БД не воспроизводится.
* **Исправление (выбрать одно, PM/security):**
  1. **V19-очистка:** архивировать/кваранитинить `octet_length(ciphertext) < 272` (например,
     в `message.message_envelopes_quarantine` с `reason='legacy_short'`), затем
     `ALTER TABLE ... VALIDATE CONSTRAINT`; для партиций — тот же проход. Это сохраняет
     расследование и делает `NOT VALID` действительно временным.
  2. **Толерантный read-path (interim):** в `findForDevice`/`findByMessage` добавить
     `AND octet_length(ciphertext) BETWEEN 272 AND 33040`; `toDomain` не должен бросать на
     legacy-строке. Для replay лучше явный `409 LEGACY_ENVELOPE`/`422`, чем 500.
  3. **Fail-closed, но не 500:** перехватывать `IllegalArgumentException` в `toDomain` и
     возвращать `crypto:null` + метрику/лог `legacy_envelope_skipped`; не отдавать страницу
     целиком.
  Нельзя просто «клампить»/дописывать padding: это изменило бы байты и сломало бы проверку
  fingerprint/подписи.
* **Тест:** upgrade-IT: схема на V17, INSERT 16 B и 271 B в партицию, миграция V18 → `GET` и WS
  replay как устройство-адресат: **не 500**, а `200 crypto:null` (вариант 2/3) или явный `409`
  (вариант 2 для replay); после V19 — `VALIDATE CONSTRAINT` успешен, `pg_constraint.convalidated=t`;
  в `E2eeMigrationIT`/`E2eeMessageIT` добавить legacy-row+GET.

## P2

### P2-01. Replay coverage `peer_devices=0` — **закрыт (контракт изменён осознанно)**

* **Файл/строка:** `contracts/openapi.yaml:1771-1779` (`minimum: 0` + описание);
  `E2eeEnvelopeValidator.java:222-265` (`replayCoverage` по текущим устройствам);
  `MessageSubmissionHandler.java:316-333`; `MessageReplayCoverageService.java:45-55`.
* **Сценарий:** send → revoke единственного peer-устройства B1 → replay по `Idempotency-Key` и
  по `client_message_id` → `201`, `peer_devices=0`, `peer_covered=0`, `warning=SELF_DEVICE_UNCOVERED`;
  `MessageCreateResult` прошёл `OpenApiContract`. Новый send в этом состоянии → `409
  E2EE_NO_ACTIVE_DEVICES`.
* **Риск:** schema-invalid `201` устранён; semantics «replay = текущее состояние» явно
  задокументирована. Остаточный продуктовый вопрос: клиент не должен трактовать 0 как ошибку.
* **Исправление:** уже в дереве (минимально безопасный вариант); snapshot-coverage не вводился.
* **Тест:** replay после revoke (оба ключа) + contract; новый send 409.

### P2-02. Race-replay без `envelope_coverage` — **закрыт**

* **Файл/строка:** `SendMessageUseCase.java:81-99,240-249`;
  `MessageReplayCoverageService.java:45-55` (`@Transactional(readOnly=true)` +
  `tenantContext.activate`); `MessageApiMapper.java:33-39` (fail-closed).
* **Сценарий:** 12 конкурентных пар POST с одним `client_message_id`, разными
  `Idempotency-Key`. В каждой паре оба ответа `201` и **оба** содержат `envelope_coverage`;
  в логе 12 `duplicate key value violates unique constraint
  "ux_messages_2026_11_chat_sender_client"` — то есть catch-ветка реально исполнялась, а не
  только pre-check. Создано ровно по одному сообщению на пару (проверено count и отсутствием
  дублей `client_message_id`).
* **Риск:** schema-invalid E2EE `201` без coverage устранён; при невозможности пересчитать
  coverage mapper отдаст 5xx, а не 201.
* **Исправление:** уже в дереве; желательно добавить в тест явную проверку, что race-ветка
  действительно срабатывала (счётчик unique-violation/лог), иначе тест может проходить по
  pre-check-пути.
* **Тест:** 12/12 пар, coverage true/true, одно сообщение на пару, контракт.

### P2-03. Flag off не гейтит replay — **закрыт**

* **Файл/строка:** `MessageSubmissionHandler.java:125-137,335-341` (флаг до
  `idempotency.reserve`); `RealtimeChatHistoryAdapter.java:61-95` (фильтр E2EE-строк и
  device guard); `RealtimeMessageCreatedListener.java:37-45` (live-кадры).
* **Сценарий:** E2EE send при флаге on → второй экземпляр на той же БД с
  `KRUG_E2EE_ENABLED=false`: replay по тому же `Idempotency-Key` (canonical и encoded) → `409
  E2EE_DISABLED`; REST GET → `409`; новый E2EE send → `409`; WS reconnect+subscribe
  (`last_seq=0`) → **ни одного** `message.created` (только `subscribed`); managed replay → `201`
  + `Idempotent-Replay: true`; managed GET → `200`.
* **Риск:** kill-switch для чтения консистентен с REST; E2EE-кадры не уходят.
* **Исправление:** уже в дереве. **Остаточный нюанс:** `SubscribedChat.server_last_seq` в
  flag-off-ответе всё ещё равен общему `last_seq` (в PoC — 22), хотя E2EE-события скрыты;
  клиент, сохранивший этот курсор, после повторного включения флага может не запросить
  скрытые seq. Это не утечка, но риск потери видимости — см. «Остаточные риски».
* **Тест:** flag on/off на одной БД, REST/идемпотентный replay/WS replay, managed control.

### P2-04. Неканонические UUID и duplicate JSON keys — **закрыт для envelope; см. P2-06**

* **Файл/строка:** `EnvelopeCodec.java:173-187` (`uuid.toString().equals(value)`);
  `JacksonConfig.java:16-19` (глобальный `STRICT_DUPLICATE_DETECTION`).
* **Сценарий:** `recipient_device_id: "1-1-1-1-1"` → `422 INVALID_ENVELOPE_FORMAT/reason=
  uuid_not_canonical`; upper-case UUID (recipient/chat) → `422`; duplicate top-level `type` и
  duplicate nested `ciphertext` → `400 VALIDATION_FAILED`; duplicate через `\u0065`-escape —
  тоже `400`; канонический UUID → `201`. **P2-06:** `client_message_id` upper-case → `201`
  (Jackson нормализует), `1-1-1-1-1` → `400` (Jackson), т.е. request-level UUID не канонизируется.
* **Риск:** parser differential для envelope/JSON устранён; остаётся низкий риск для
  request-level UUID (см. P2-06).
* **Исправление:** envelope/duplicate уже закрыты; для request UUID — см. P2-06.
* **Тест:** перечисленные payload'ы, real HTTP.

### P2-05. Расхождение capability-предиката — **закрыт**

* **Файл/строка:** `auth/domain/model/Device.java:271-288` (ACTIVE + alg +
  Ed25519/X25519 + IK_sig 32 + IK_dh 32 + binding 64 + fingerprint 32);
  `V17__e2ee_identity_hardening.sql:20-42` (`auth.device_is_e2ee_capable`);
  `DeviceRepositoryAdapter.java:176-195` (`findActiveByUserIds` + fingerprint).
* **Сценарий:** API `GET /devices` для Alice/Bob и SQL-функция для всех 5 устройств:
  legacy ACTIVE → `e2ee_capable=false`/SQL `f`; A1/A2/B2 ACTIVE keyed → `true`/`t`; B1 REVOKED →
  `false`/`f`. SQL truth table: ACTIVE+Ed25519+32/32/64/32 → `t`; `fingerprint NULL` → `f`;
  REVOKED → `f`; legacy → `f`; 31-byte IK_sig → `f`. Unit `DeviceCapabilityTest` 3/3.
* **Риск:** расхождение устранено; под V17-CHECK недостижимые комбинации не создаются.
* **Исправление:** уже в дереве; поддерживать один предикат при будущих миграциях.
* **Тест:** API/SQL parity + unit + truth table.

### P2-06 (открыт, low). Request-level UUID не канонизируется

* **Файл/строка:** `message/api/dto/MessageCreateRequest.java:10` (`UUID clientMessageId` —
  Jackson default `UUID` deserializer); `@PathVariable UUID chatId` в
  `MessageController.java:44,55`; `KeycloakClaims.java:29-38` (`X-Device-Id` — ленивый
  `UUID.fromString`); для контраста `EnvelopeCodec.java:173-187` уже strict.
* **Сценарий (воспроизведён):** `client_message_id` в upper-case → `201` (в ответе UUID уже
  lower-case); `client_message_id: "1-1-1-1-1"` → `400` (Jackson reject); upper-case path
  `chatId`/`X-Device-Id` принимаются ленивым `UUID.fromString` (для header — с последующей
  проверкой владельца, поэтому bypass'а нет). Envelope UUID'ы при этом strict (`422`).
* **Риск:** parser differential между сервером/аудитом/клиентом; в логах и idempotency-
  fingerprint один и тот же UUID может встречаться в разных строковых формах. Авторизацию это
  не обходит: `X-Device-Id` всё равно проверяется на владельца, `client_message_id` — это
  идентификатор клиента, а не граница доступа. Низкий.
* **Исправление:** либо распространить canonical UUID на request DTO/`@PathVariable`/header
  (`uuid.toString().equals(value.strip())`), либо явно задокументировать, что strict —
  только для envelope (§4.7), а request UUID нормализуются. Второй вариант дешевле и не ломает
  существующих клиентов.
* **Тест:** upper-case/lenient `client_message_id` и `X-Device-Id` → ожидаемый `400/422` или
  документированная нормализация; канонические — `201`.

### P2-07 (открыт, low, defense-in-depth). `ChatKeysService` доверяет `principal.deviceId`

* **Файл/строка:** `auth/application/usecase/ChatKeysService.java:84,103,111,212-216` —
  `requireCurrentDevice` проверяет только `null`, без `findById`/ACTIVE/owner; для контраста
  `PrekeyUploadService.java:58-68` и `DeviceRevocationService.java:52-60` owner-check уже есть.
* **Сценарий:** при **будущем** обходе `DeviceBindingFilter` (регрессия path-нормализации)
  `GET /chats/{id}/keys` с чужим `device_id` вернул бы `my_device_id`/`verifier_device_id`
  чужого устройства и выбрал бы `key_verifications` этого устройства. `PUT .../verification`
  на чужой device fail-closed на уровне БД: FK `(verifier_user_id, verifier_device_id)` и
  trigger V17 `VERIFICATION_SCOPE_MISMATCH` (вероятнее 500, чем аккуратный 403). Envelope-leak
  это не даёт: ключи участников и так доступны участнику, а конверты читает отдельный
  `MessageQueryHandler` с собственной проверкой.
* **Риск:** латентный; сегодня фильтр закрывает. Но review-06 условие №3 («аудит всех
  потребителей `principal.deviceId`») закрыто не полностью.
* **Исправление:** в `requireCurrentDevice` сделать
  `deviceRepository.findById(deviceId).filter(d -> d.status()==ACTIVE && d.userId().equals(principal.userId()))`,
  иначе `403`; аналогично проверить `getChatKeys`/`verifyDevice` на явный device-guard. Это
  defense-in-depth, не замена фильтру.
* **Тест:** unit/IT с principal `userId=Alice`, `deviceId=B2` → `403` на `GET keys`/`PUT
  verification`; encoded path + foreign header на real HTTP уже даёт `401` (см. P0-01).

### P2-08. Prekey retention/race — вне G4b

* **Файл/строка:** `PrekeyUploadService.java:56-150`; `auth.device_prekeys` retention.
* **Статус:** P2-08 в B3F закрыт **частично** (race cap; retention — B4-долг). В G4b
  целенаправленно не перепроверялся, кроме полного прогона `E2eeDeviceKeyIT` (8/8) и
  `E2eeClaimRateLimitIT`; отдельного PoC на retention нет. Это остаточный долг, не регрессия
  B3F.

## PoC results (encoded paths, payload, floor)

### Окружение

* Backend jar из текущего дерева (`mvn -o -Dmaven.repo.local=.m2repo -DskipTests package`),
  Spring Boot 3.4.5, Tomcat 10.1.40, Java 21.0.10.
* PostgreSQL 16.15 (свежий контейнер), Flyway до V18; приложение в профиле `keycloak`,
  Keycloak 26.2 (`aud=krug-api`, `azp=krug-web`), E2EE on (18080) / off (18081).
* E2EE devices: A1, A2 (Alice), B1, B2 (Bob) — реальные Ed25519/X25519, `e2ee_capable=true`;
  B1 позже revoke. Чат — E2EE DIRECT, сообщения с envelopes B1/A2 и B2/A2.
* `KRUG_RATE_LIMIT_ENABLED=false` для probe-инстансов; outbox/retention/schedulers выключены,
  чтобы не влиять на счётчики. Это не меняет path/payload/floor-логику.

### Encoded paths (real HTTP, keycloak, Alice token, чужой `X-Device-Id`)

| # | Путь | Device | HTTP | `crypto` |
|---|---|---|---|---|
| 1 | `/api/v1/chats/{chat}/messages` (canonical) | B1 (чужой) | **401** | нет |
| 2 | `/api/v1/%63hats/{chat}/messages` | B1 | **401** | нет |
| 3 | `/api/v1/chats/{chat}/%6Dessages` | B1 | **401** | нет |
| 4 | `/api/v1/chats/{chat}/%6dessages` (lower) | B1 | **401** | нет |
| 5 | `/api/v1/%63hats/{chat}/%6Dessages` | B1 | **401** | нет |
| 6 | `/api/v1/%2563hats/{chat}/messages` (double) | B1 | **400** | нет |
| 7 | `/api/v1/chats/{chat}/%256Dessages` (double) | B1 | **400** | нет |
| 8 | `/api/v1/Chats/{chat}/messages` (mixed case) | B1 | **403** (header validation; route для own — 404) | нет |
| 9 | `/api/v1/chats/{chat}/Messages` | B1 | **401** | нет |
| 10 | `/api/v1/chats/{chat}/messages;foo` | B1 | **400** | нет |
| 11 | `/api/v1/chats;foo/{chat}/messages` | B1 | **400** | нет |
| 12 | `/api/v1/chats/{chat}/%6Dessages%3Bfoo` | B1 | **400** | нет |
| 13 | `/api/v1/chats/{chat}/../messages` | B1 | **400** | нет |
| 14 | `/api/v1/chats/{chat}/%2e%2e/messages` | B1 | **400** | нет |
| 15 | `/api/v1/chats/{chat}/messages/` (trailing) | B1 | **401** (own — 404) | нет |
| 16 | `/api/v1/chats/{chat}/messages?after_seq=0` | B1 | **401** | нет |
| 17 | `/api/v1/chats/{chat}/%6Dessages?x=%2e%2e&y=%6D` | B1 | **401** | нет |
| 18 | `/api/v1/chats/{chat}/messages%3Fafter_seq=0` | B1 | **401** | нет |
| 19 | `/api/v1/chats/{chat}%2F/messages` (encoded `/`) | B1 | **400** | нет |
| 20 | `/api/v1/chats/{chat}/%6Dessages%5C..` | B1 | **400** | нет |
| 21 | `/api/v1/chats/{chat}/messages%00` | B1 | **400** | нет |
| 22 | без `X-Device-Id` | — | **401** | нет |
| 23 | canonical, own A1 | A1 | **200** | `null` (sender self) |
| 24 | encoded both, own A1 | A1 | **200** | `null` |
| 25 | encoded both, own A2 (сообщение имеет envelope A2) | A2 | **200** | **A2 only** (`ef1250eb…`) |
| 26 | canonical, Bob B1 (легитимно) | B1 | **200** | **B1 only** (`ed505241…`) |
| 27 | `GET .../%63hats/{chat}/keys` | B1 | **401** | — |
| 28 | `PUT .../%63hats/{chat}/keys/verification` | B1 | **401** | — |
| 29 | `POST .../%63hats/{chat}/read` | B1 | **401** | — |
| 30 | `POST .../%63hats/{chat}/%6Dessages` (валидный body) | B1 | **401**, сообщений не создано | — |

**Вывод:** ни один чужой/encoded вариант не отдал envelope; `%2563`/`;`/`..`/`%2F`/`%5C`/NUL
блокируются на Tomcat/Spring Security до или на фильтре; trailing slash не маршрутизируется
(404 для own), query не меняет path. Единственный `200` с чужим B1 — когда токен **Bob** и
device **B1** (легитимный доступ), либо свой A2 со своим конвертом.

### Payload (real HTTP)

| # | Тело/путь | HTTP | Сообщений до→после |
|---|---|---|---|
| 1 | 600 KiB, canonical | **413 PAYLOAD_TOO_LARGE** | 1→1 |
| 2 | 600 KiB, `.../%6Dessages` | **413** | 1→1 |
| 3 | 600 KiB, `/%63hats/.../messages` | **413** | 1→1 |
| 4 | 600 KiB, `/%63hats/.../%6Dessages` | **413** | 1→1 |
| 5 | 524288 B, canonical | **201** | 1→2 |
| 6 | 524289 B, canonical | **413** | 2→2 |
| 7 | 600 KiB, chunked (no `Content-Length`), canonical | **413** | 2→2 |
| 8 | 600 KiB, chunked, `%6Dessages` | **413** | 2→2 |
| 9 | валидное малое тело, chunked | **201** | — |

`413`-конверт: `{"code":"PAYLOAD_TOO_LARGE","details":{"reason":"wire","limit":524288}}`.
`Content-Length` не использовался как доверенная граница.

### Floor / DB CHECK

| Вход | HTTP | encoded len | decoded len | Примечание |
|---|---|---|---|---|
| 16 B | **422** `INVALID_ENVELOPE_FORMAT/ciphertext_too_short` | 22 | 16 | — |
| 271 B | **422** то же | 362 | 271 | — |
| 272 B | **201** | 363 | 272 | GET `CryptoEnvelope` valid |
| 33040 B | **201** | 44054 | 33040 | GET `CryptoEnvelope` valid |
| 33041 B | **413** `ENVELOPE_TOO_LARGE` (`reason=canonical`) | 44055 | 33041 | — |
| DB INSERT 271 | CHECK violation | — | — | `ck_envelopes_ciphertext_min`, партиция `2026_11` |
| DB INSERT 272 | accepted | — | — | — |
| DB INSERT 33040 | accepted | — | — | — |
| DB INSERT 33041 | CHECK violation | — | — | — |

`GET` по B2 для min/max: `ciphertext` 363/44054; оба прошли `OpenApiContract` (`CryptoEnvelope`).
`V18` в БД: `convalidated=f` (намеренно `NOT VALID`, parent + 3 партиции).

### P2 PoC

| Кейс | Результат |
|---|---|
| replay после revoke B1, `Idempotency-Key` | `201`, `peer_devices=0`, `peer_covered=0`, `MessageCreateResult` valid |
| replay после revoke, `client_message_id` | `201`, coverage 0, тот же message id |
| новый send после revoke | `409 E2EE_NO_ACTIVE_DEVICES` |
| race 12 пар (один `client_message_id`, разные ключи) | 24/24 ответа `201`; coverage true в каждом; 12 unique-violation в логе; по 1 сообщению на пару |
| flag off: E2EE replay canonical/`%6D`/`%63` | `409 E2EE_DISABLED` |
| flag off: REST GET E2EE | `409 E2EE_DISABLED` |
| flag off: новый E2EE send | `409 E2EE_DISABLED` |
| flag off: WS replay `last_seq=0` | только `subscribed`; `message.created` = 0 |
| flag off: managed replay | `201`, `Idempotent-Replay: true`; managed GET `200` |
| strict: envelope `1-1-1-1-1` / upper-case | `422 INVALID_ENVELOPE_FORMAT/uuid_not_canonical` |
| strict: duplicate top-level/nested keys, в т.ч. `\u0065` escape | `400 VALIDATION_FAILED` |
| strict: `client_message_id` upper-case | **`201`** (P2-06); `1-1-1-1-1` → `400` |
| capability: API vs SQL для 5 устройств | полное совпадение (legacy/revoked `false`, keyed ACTIVE `true`) |
| managed smoke: `/me`, `/devices`, `/sync`, chats, messages, read, send/replay | `200/201/204`, replay header `true` |
| E2EE DB plaintext | `body_ciphertext IS NULL`, `content_meta={}` для всех E2EE-строк |
| WS live cross-device | A1 `crypto:null`; A2 только A2; B2 только B2; чужих id в кадре нет |
| fuzz 500 мутаций envelope | 422×412, 201×55, 413×33, **5xx=0** |
| legacy 16 B row в V18-БД | `GET` как A2 → **500 INTERNAL** (P1-03); A1 → 200; после удаления — 200 |

## Проверки

Все команды — в текущем дереве, `JAVA_HOME=JDK 21`, Maven offline (`-Dmaven.repo.local=.m2repo`).
Git-репозитория нет; проверялось фактическое дерево.

```bash
# 1. Полный прогон backend (заявленные B3F 324/0)
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 324, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit: Tests run: 10, Failures: 0, Errors: 0

# 2. Контракт/типы
cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.

# 3. Сборка текущего jar для real HTTP
cd ../backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo -DskipTests package
# BUILD SUCCESS

# 4. Real HTTP: keycloak-профиль, PG16, Tomcat 10.1.40
#   18080: KRUG_E2EE_ENABLED=true; 18081: false; одна БД; Keycloak 26.2.
#   Все PoC — /tmp/e2ee-g4b/*.py (вне репозитория).

# 5. Контрактная валидация захваченных real-HTTP ответов (OpenApiContract)
# OK page_b2 -> MessagePage
# OK replay_body -> MessageCreateResult
# OK managed_body -> MessageCreateResult
# OK msg_... (272 B) -> CryptoEnvelope
# OK msg_... (33040 B) -> CryptoEnvelope

# 6. DB
# V18: convalidated=f; CHECK 272..33040 на parent + 3 партиции
# INSERT 271/33041 -> violation; 272/33040 -> accepted
# capability: API GET /devices == auth.device_is_e2ee_capable для всех 5 устройств
# legacy: INSERT 16 B (V18 временно снят, затем восстановлен NOT VALID) -> GET A2 500

# 7. Fuzz
# 500 мутаций envelope по real HTTP: 0 ответов 5xx; unexpected Throwable не наблюдались.

# 8. Логи
# grep -ic "managed hello\|managed 3\|managed replay" app-on.log -> 0
# В E2EE-строках БД body_ciphertext IS NULL / content_meta={} -> 0 нарушений.
# В логе нет ciphertext/envelope-байтов; есть только имя constraint/migration и текст
# IllegalArgumentException "ciphertext must be 272..33040 bytes" (P1-03).
```

**Ограничения проверки:**

* Нет Git/one-PR, поэтому нельзя подтвердить, что все правки — один PR и нет скрытых
  изменений; проверялось поведение дерева.
* G2 (браузерные KAT) и внешний G4 crypto-review не заменяются этим отчётом.
* E2EE-флаг на 18080/18081 переключался **двумя процессами**, а не runtime-тумблером; для
  kill-switch это эквивалентно, но hot-reload флага не проверялся.
* Членство Bob в E2EE-workspace создавалось SQL-фикстурой (нет invite-API); это не влияет на
  path/device/envelope-границы.
* Legacy-строка P1-03 моделировалась снятием/восстановлением V18-CHECK (эквивалентное
  `NOT VALID`-состояние), а не полным V17→V18 Flyway-прогоном на отдельной БД; `convalidated=f`
  и поведение read-path воспроизведены.
* Rate limit на probe-инстансах выключен; отдельного rate-limit регрессионного прогона в G4b нет.

## Условия GO для E7-F/флага

1. **P0-01/P1-01/P1-02 — сохранить как блокирующие regression-тесты.** Нужны real-HTTP тесты
   (не MockMvc) на `%63`/`%6D`/`%6d`, `%2563`, `;`, `..`, trailing slash, query, chunked,
   границы 524288/524289 и 272/363/33040/33041; текущие B3F-тесты покрывают не все варианты
   (в частности, `%2563`, trailing slash и chunked).
2. **P1-03 — обязательное условие для in-place upgrade.** До включения флага на БД, где E2EE
   уже использовался, нужен V19: архивировать/удалить `octet_length(ciphertext) < 272`,
   затем `VALIDATE CONSTRAINT`, **или** толерантный read-path (`crypto:null`/`409`, не 500) +
   upgrade-IT. Без этого — NO-GO для upgrade.
3. **P2-06 — решить и зафиксировать:** либо canonical UUID для request DTO/header, либо явно
   записать в §4.7/контракте, что strict-канонизация относится только к envelope. Не оставлять
   «молчаливую» нормализацию upper-case `client_message_id`.
4. **P2-07 — добавить defense-in-depth в `ChatKeysService.requireCurrentDevice`** (active +
   owner) или письменно принять, что единственная граница — `DeviceBindingFilter`; при текущем
   фильтре bypass'а нет, но это ровно тот класс регрессии, который уже был в P0-01.
5. **G2/G4** — браузерные KAT и внешний crypto-review остаются предусловиями flag-on; это
   ревью их не заменяет. `KRUG_E2EE_ENABLED` остаётся `false` по умолчанию.
6. **Git/one-PR** — инициализировать репозиторий или приложить patch-bundle; без diff
   «одним PR» и отсутствие скрытых правок не проверяемы.
7. **Тесты/наблюдаемость:** добавить log-capture тест на отсутствие ciphertext/plaintext и
   ограничить логирование SQL `DETAIL` (см. остаточные риски); повторить full `mvn test`,
   ArchUnit 10/10 и `contract:check` 33/58 на финальном дереве.

## Остаточные риски

* **P1-03 legacy-конверты:** `V18 NOT VALID` + строгий `toDomain` → 500 на upgrade-БД; до V19
  это блокер in-place upgrade, но не чистой установки.
* **`%2563`/double-decode зависит от контура.** На нашем Tomcat/Spring Security `%2563` даёт
  `400` (firewall/коннектор), и `ApiRequestPath` single-pass видит `%63hats`, а не `chats`.
  Если перед приложением появится прокси, который декодирует один раз и передаст `%63` дальше,
  или будет отключён firewall, возможен рассинхрон «фильтр видит `%63`, dispatcher — `chats`».
  Рекомендуется явно отклонять `%` в decoded path (легитимных `%` в API-путях нет) и добавить
  e2e-тест с прокси/`ALLOW_ENCODED_SLASH`-конфигурацией.
* **Flag-off WS cursor:** `server_last_seq` в `subscribed` считается по всем сообщениям, включая
  скрытые E2EE; клиент, сохранивший этот seq, после re-enable может пропустить E2EE-сообщения
  до полного reload. Это не утечка, но продуктовый риск kill-switch semantics.
* **`client_message_id` per-partition uniqueness** (review-06): глобального индекса нет; повтор
  через границу месяца может дать 2 строки/`IncorrectResultSizeDataAccessException`. Не
  воспроизведено end-to-end (нужен переход месяца), но статически реально.
* **`X-Device-Id`/request-UUID ленивость** (P2-06): upper-case/`1-1-1-1-1` header проходит
  `UUID.fromString`, но ownership-check не даёт bypass'а; для аудита/логов остаётся
  неканоническая форма.
* **`ChatKeysService` defense-in-depth** (P2-07): при будущей регрессии фильтра `GET keys`
  использует чужой `device_id`; запись verification fail-closed на FK/trigger V17 (вероятно 500).
* **Prekey retention** (`auth.device_prekeys`) — B4-долг; OPK/SPK не чистятся по `expires_at`.
* **WS multi-node fan-out** (E3) отсутствует; `chat.keys.changed`/`device.list.changed` не
  durable; offline-клиент узнаёт об изменениях только на reconnect.
* **Retention конвертов** (`message.message_envelopes`) не реализован; ciphertext/метаданные
  хранятся бессрочно.
* **SQL/stack-trace логи:** `GlobalExceptionHandler.handleUnexpected` логирует stack trace, а
  `SqlExceptionHelper` может логировать `DETAIL` строки при CHECK/unique violation (в нашем
  race — только имя constraint; при прямом DB-нарушении V18 в psql виден hex ciphertext). Нужен
  log-capture тест и ограничение `DETAIL` до релиза.
* **Dev/test профиль:** `DevDeviceBinding` не проверяет устройство в БД, только signed claim;
  отозванное устройство в dev/test может читать старые конверты (в prod `KeycloakDeviceBinding`
  даёт 401). Defense-in-depth в history (P0-01) это закрывает, но dev-поведение отличается.
* **FileContractIT/timing-flake:** в этом прогоне 324/324 зелёный; отдельного стресс-прогона на
  flake не было.
* **Нет Git/one-PR** и **G2/G4** — процессные риски, не код.

## Вопросы

1. **P1-03:** in-place upgrade БД с legacy-конвертами входит в план E7-F? Если да — выбираем
   V19-очистку (quarantine + `VALIDATE`) или толерантный read-path? Нужен ответ PM/security,
   потому что от него зависит «GO для upgrade» и объём миграции §6.5.
2. **P2-06:** канонизировать все request UUID (DTO/path/header) или зафиксировать в §4.7, что
   strict относится только к envelope? Второй вариант дешевле, но тогда upper-case
   `client_message_id` — документированная нормализация, а не «строгий wire».
3. **P2-07:** достаточно ли `DeviceBindingFilter` как единственной границы для
   `ChatKeysService`, или добавляем defense-in-depth (active+owner) в сервис? Рекомендую добавить.
4. **`%2563`/proxy:** какой контур перед backend в prod (nginx/ingress)? Есть ли гарантия, что
   он не декодирует путь повторно? Нужен e2e-тест с конкретной конфигурацией, а не только
   встроенный Tomcat.
5. **P2-01 semantics:** подтверждает ли PM, что replay с `peer_devices=0` — «текущее состояние»,
   и клиент не должен трактовать 0 как ошибку? Контракт уже `minimum: 0`; это надо закрепить в
   клиентском E7-F.
6. **Flag-off WS cursor:** нужно ли исключать скрытые E2EE-seq из `server_last_seq`/слать
   `resume.gap`, чтобы после re-enable клиент не пропускал сообщения? Это решение по
   kill-switch UX/безопасности.
7. **G2/G4/git:** когда браузерные KAT, внешний crypto-review и one-PR? Без них flag-on и E7-F
   не должны стартовать даже после P0/P1-01/P1-02.

---

**Статус G4b: DONE.** P0-01/P1-01/P1-02 закрыты и подтверждены real HTTP (keycloak/Tomcat/PG16);
P2-01/P2-02/P2-03/P2-04(envelope)/P2-05 подтверждены. Открыты: **P1-03** (upgrade-only legacy
500 — блокер in-place upgrade), **P2-06** (request UUID canonicalization, low), **P2-07**
(defense-in-depth `ChatKeysService`, low). Итоговый вердикт: **GO WITH CONDITIONS** для чистой БД;
**NO-GO для in-place upgrade** до P1-03. Код/контракты/спека/векторы/docs/TASKS не изменялись;
создан только этот файл.

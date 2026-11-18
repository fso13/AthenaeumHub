# E2EE-REVIEW-04 — G3 implementation review E7-B1 + I-01 (flag off)

> **Рецензент:** независимый security/backend-ревьюер. Автор B1 в подготовке этого документа не участвовал.
> **Дата:** 2026-11-16. **Вход:** `backend/E7-B1-REPORT.md`, `docs/E2EE-SPEC.md` (§3.1, §4.8, §6.2.x, §6.3.1, §6.5, §7),
> `docs/E2EE-REVIEW-03.md`, `docs/E2EE-S4-CHANGELOG.md`, `contracts/openapi.yaml`, `contracts/ws-protocol.md`,
> код и миграция B1, тесты `E2ee*`/`DeviceKeyCryptoTest`/`ArchitectureTest`.
> **Зона:** создан только этот файл; код, контракты, спека и векторы не изменялись. Git-репозитория в workspace нет,
> поэтому аудит по diff невозможен — проверялось фактическое состояние дерева и поведение.

## Вердикт (GO / GO WITH CONDITIONS)

**GO WITH CONDITIONS.**

**P0 нет.** На поставляемой поверхности (`krug.e2ee.enabled=false`) не найдено: обхода tenant-границы (RLS, claim в текущем
workspace), plaintext-fallback в E2EE-чате, приёма E2EE-контента без реализации, серверного crypto сверх публичной проверки
Ed25519/SHA-256, либо пути записи plaintext в `crypto_scheme='E2EE_PAIRWISE'`. Ключевые инварианты §6.5 реально исполняются на PG16
(миграция, grants/RLS/партиции, `direct_key`, CHECK'и, preflight-коды), device-lifecycle и flag-off-гейты подтверждены тестами
(282/0, полный прогон выполнен ревьюером).

B1 принимается **в границах flag-off**. Условия GO — §«Условия GO для B3/B4»: до B3/B4/включения флага обязательны
**P1-01…P1-06**, а также P2-01/P2-02/P2-03/P2-04/P2-05/P2-07. Отдельно: **I-01 по критерию §6.3.1 F остаётся PARTIAL**, а не
«applied» — контрактная часть (A–D) выполнена, поведенческая (E/F-5) в B1 нереализуема, а F-3 («закоммитить одним PR»)
физически невыполним без git. Формулировка отчёта «I-01 применён» завышена и должна быть исправлена в `docs/TASKS.md`
при следующем касании (в зоне B1 это невозможно).

## P0

Нет.

Что проверялось на P0-уровень (все — без finding'ов):

| Проверка | Результат |
|---|---|
| Plaintext в E2EE: `text`/`reply_to_id`/`sticker_id`/`attachment_ids` в E2EE-чате | `409 E2EE_DISABLED` до любых записей; `message.messages` E2EE-CHECK'и отвергают body/sticker/SYSTEM/без sender (DB-проба) |
| Чтение E2EE-истории | `GET /chats/{id}/messages` в E2EE → `409 E2EE_DISABLED`; отдельного пути чтения конвертов нет |
| Кросс-тенант prekeys/claim | claim-функция проверяет membership **в текущем workspace**; проба: чат W2 при `app.workspace_id=W1` → `UNKNOWN_DEVICE`, при W2 → ровно один OPK |
| RLS `auth.devices` для peer | `krug_app`: peer ACTIVE виден только при общем неудалённом чате в текущем workspace; REVOKED peer не виден никогда; без workspace — только свои |
| RLS `message_envelopes` (партиции) | вставка конверта в чужой workspace → `new row violates row-level security policy`; в свой — ok |
| Серверный crypto | только `Ed25519 verify` + `SHA-256` (`DeviceKeyCrypto`), приватных ключей/расшифровки нет |
| `POST /devices` чужими ключами | запись чужого устройства невозможна (RLS + уникальные индексы); cross-user replay даёт 404 (P1-02) или 500/409 (P2-07), но не создаёт строку |
| Device revoke → доступ | в prod каждый запрос проходит `KeycloakDeviceBinding.isActiveDeviceOfUser` → 401 после revoke; WS — см. P1-03 |

## P1

### P1-01. `POST /keys/claim` не ограничен rate limit → истощение one-time prekeys (downgrade forward secrecy)

* **Файл/строка:** `backend/src/main/java/ru/krug/backend/auth/application/usecase/KeyClaimService.java:68-147`
  (`claim`, вызов `prekeyRepository.claimOneTime` — `:124`); `ops/application/port/RateLimitPort.java` (единственный метод —
  `checkMessageSend`), используется только в `message/application/usecase/MessageSubmissionHandler.java:104`;
  `ops/infrastructure/ratelimit/InMemoryRateLimiter.java`.
* **Сценарий:** любой ACTIVE-участник чата (в т.ч. MANAGED-чата, при выключенном флаге) вызывает `POST /keys/claim` на устройство
  собеседника N раз. Каждый вызов атомарно расходует один OPK; после ~200 вызовов у жертвы `otp_exhausted=true` для всех, кто с ней
  начинает сессию. Дополнительно каждый вызов возвращает публичный bundle (identity keys, SPK, OPK) — бесплатный оракул «устройство
  живо/legacy».
* **Риск:** §3.2 спеки прямо возлагает защиту неидемпотентного claim на «rate limit и membership-проверку». Membership есть, rate
  limit отсутствует. Итог — дешёвый DoS на forward secrecy (все новые сессии падают на 3DH), рост нагрузки на БД (SKIP LOCKED-скан) и
  «мигание» `otp_exhausted` у честных клиентов. Работает уже сейчас, до включения флага.
* **Исправление:** добавить в `RateLimitPort` политику `checkPrekeyClaim(principal, chatId, targetDeviceId)` (например,
  N вызовов/мин на `(user, chat)`, M/мин на IP) и вызывать её до цикла claim; отдельный лимит на общее число claim в час; метрика
  `e2ee_claim_total{exhausted}` + алерт на «OPK пул стремительно падает». Redis-реализация — по общей линии `SYSTEM-ANALYSIS §7.3`.
* **Тест:** интеграционный: два участника, 201-й claim за окно → `429`; OPK жертвы не израсходован лишний раз; метрика
  `otp_exhausted` не растёт; claim одним и тем же устройством дважды подряд не даёт один и тот же OPK (уже покрыто).

### P1-02. Разрешение identity-пары в `POST /devices` не ограничено `user_id` (латентный кросс-тенант)

* **Файл/строка:** `auth/infrastructure/persistence/DeviceRepositoryAdapter.java:106-118` (`findByPositioningIdentityKeys`),
  `:119-131` (`findRevokedByIdentityKeys`), `:132-142`/`:143-…` (`findByIdentityDhKey`/`findByIdentitySigningKey`) — ни один запрос не
  фильтрует по `user_id`; вызывается из `auth/application/usecase/DeviceRegistrationService.java:93-106, 138-166`.
* **Сценарий:** dev-токен содержит claim `workspace_id` (`shared/infrastructure/security/JwtService.java:79`,
  `PrincipalArgumentResolver` его читает), поэтому `POST /devices` выполняется с активным `app.workspace_id`, а политика
  `p_devices_chat_peer` показывает ACTIVE-устройства собеседника. Пользователь B копирует публичный bundle устройства A (он публичен:
  claim/`GET /chats/{id}/keys`: identity keys + binding signature + текущий SPK с подписью) и отправляет его как свой `POST /devices`.
  `findByPositioningIdentityKeys` находит устройство A → `RegisterDeviceUseCase` делает `query.findById(principal, A.device)` →
  фильтр по `user_id` → **`404 NOT_FOUND`** на `POST /devices` (код не документирован контрактом) вместо `409 IDENTITY_KEY_CONFLICT`.
  В `prod`-профиле Keycloak-токен не содержит `workspace_id`, поэтому путь недостижим; в `dev`/`test` — достижим.
* **Риск:** (а) оракул «эта пара ключей зарегистрирована и это устройство вам видно»; (б) неверный статус/код на security-эндпоинте;
  (в) латентная многотенантность: если завтра Keycloak-токен (или e2e/dev) получит workspace-контекст, `registerWithKeys` вернёт
  `DeviceView.from(device)` чужого устройства любому вызывающему до enrich-фильтра — те же запросы будут использоваться fan-out'ом B3.
* **Исправление:** добавить `AND user_id = :userId` во все четыре запроса (`findByPositioningIdentityKeys`, `findRevoked…`,
  `findByIdentityDhKey`, `findByIdentitySigningKey`), `userId` брать из `principal`; глобальная уникальность остаётся за
  `ux_devices_identity_sig/dh` (это единственный корректный межпользовательский guard). Дополнительно: не активировать
  workspace-контекст на `POST /devices` (эндпоинт device-scoped, workspace ему не нужен) — это закрывает и случай, когда токен
  приносит `workspace_id`.
* **Тест:** A и B в одном чате; B отправляет **валидный** bundle A в `POST /devices` → `409 IDENTITY_KEY_CONFLICT` (после P2-07;
  до него возможен 500), устройство A не изменено, `GET /devices` B не содержит A; тот же сценарий без общего чата → `409`.

### P1-03. Revoke/verification не публикуют `chat.keys.changed`/`device.list.changed`, WS-сессия отозванного устройства не закрывается проактивно

* **Файл/строка:** `auth/application/usecase/DeviceRevocationService.java:44-57` (только `status/REVOKED`, `key_generation++`, prekeys,
  verifications; ни одного события); `auth/application/usecase/ChatKeysService.java:94-130` (verification без события);
  в main-коде строк `chat.keys.changed`/`device.list.changed` нет (grep — только `ErrorCode.KEY_CHANGED` и `WsFrameCodec`).
  WS-закрытие — ленивое: `realtime/application/usecase/SubscriptionService.java:62,122,136,149-153` проверяет `isActiveDeviceOfUser`
  только на `subscribe`/`typing`/`presence`.
* **Сценарий:** пользователь отзывает устройство через `DELETE /devices/{id}` (эндпоинт уже в проде). Другие клиенты не получают
  `chat.keys.changed(reason=DEVICE_REVOKED)`/`device.list.changed`, не перечитывают `GET /chats/{id}/keys`, продолжают шифровать на
  отозванное устройство (в B3/B4 это конверт в никуда / ошибка). Само отозванное устройство с открытым WS продолжает получать
  `message.created` до первого собственного кадра; `session.revoked` + close 4403 не отправляется.
* **Риск:** §5.4(2-3) и §6.3 C требуют событий и закрытия WS. Это не «утечка» (HTTP-доступ уже отзывается binding-проверкой), но
  нарушение контракта revoke и окно, в котором отозванное устройство видит новые сообщения. Для E2EE-клиентов B3 это блокер
  (нельзя безопасно исключить устройство из fan-out без сигнала остальным).
* **Исправление:** публиковать оба события **после commit** (outbox, как `message.created`), в payload — только метаданные
  (`chat_id/reason/device_id/key_generation`; `device_id/status/key_generation`); на revoke — `session.revoked` + close 4403
  всем сессиям отозванного устройства (реестр сессий/`RealtimeSessionRevokedException` уже есть). События не replay-ить (C).
* **Тест:** revoke → в WS-канале владельца `device.list.changed`, в каждом E2EE-чате пользователя `chat.keys.changed`
  `reason=DEVICE_REVOKED`, `key_generation` = 2; отозванное устройство получает `session.revoked` и close 4403; `GET /chats/{id}/keys`
  после события не содержит target; повторный revoke событий не дублирует.

### P1-04. I-01: критерий §6.3.1 F выполнен частично; «I-01 применён» — завышенная формулировка

* **Файл/строка:** `backend/E7-B1-REPORT.md:8-12` («I-01 применён»), `:107-118` (сознательные отклонения), `:162-170`;
  `docs/E2EE-SPEC.md` §6.3.1 E/F (E — стр. 2031, F — стр. 2049), `docs/TASKS-E7.md:12,14`.
* **Сценарий:** B1 закрывает A (схемы), B (пути), C (WS-контракт), D (порядок/schema.d.ts) — это подтверждено. Но F-5 требует
  «все тесты E зелёные», а 4 из 13 строк E нереализуемы без E2EE-send: `201 MessageCreateResult` с `envelope_coverage`, envelope на
  legacy → `422 E2EE_LEGACY_DEVICE`, отсутствие peer-конверта → `409 E2EE_NO_PEER_ENVELOPE`, `reply_to_id` в E2EE →
  `422 E2EE_PLAINTEXT_FORBIDDEN`. F-3 требует «schema.d.ts перегенерирован и **закоммичен** вместе с контрактом» — коммита нет.
* **Риск:** PM/следующие сессии прочитают «I-01 применён» как «критерий F закрыт» и начнут B3/B5/F3, считая контрактно-поведенческий
  handoff завершённым; расхождение контракт↔поведение (задокументированные коды, которые сервер не отдаёт) станет «нормой».
* **Исправление:** в `docs/TASKS.md` зафиксировать `I-01: contract-side DONE (A–D), behavior-side PARTIAL (E: 4/13 → B3/B4), F-3
  unverifiable (no git)`; E-тесты для отложенных строк добавить вместе с B3/B4 и держать их красными до реализации (skip с причиной —
  осознанно, но лучше tracked TODO в тестовом коде).
* **Тест:** после B3/B4 — полный набор E-строк §6.3.1 зелёный; contract-тесты на `MessageCreateResult.envelope_coverage`,
  `E2EE_LEGACY_DEVICE`, `E2EE_NO_PEER_ENVELOPE`, `E2EE_PLAINTEXT_FORBIDDEN`.

### P1-05. V16 исполнима только ролью с superuser/BYPASSRLS: при non-superuser owner'е FORCE-RLS таблиц backfill `direct_key` — no-op

* **Файл/строка:** `backend/src/main/resources/db/migration/V16__e2ee_device_keys.sql:18-39` (`UPDATE auth.devices`, CHECK на
  `identity_key_alg`), `:283-353` (preflight/backfill/VALIDATE `direct_key`); `V3__chat.sql:56-60`, `V2__identity_and_workspace.sql:77-81`
  (FORCE RLS); `backend/src/test/.../support/IntegrationTestBase.java:45-46` (Flyway — superuser контейнера).
* **Сценарий:** в dev/compose `krug_migrator` — bootstrap-суперпользователь, поэтому V16 исполняется. На managed PG (V1: «krug_migrator
  owns schema objects; DBA pre-creates roles») Flyway может идти ролью-owner'ом без `BYPASSRLS`. Проба на PG16: owner FORCE-RLS таблиц
  без GUC видит `0` строк (`chat.chats`, `chat.chat_members`), `VALIDATE CONSTRAINT` при этом видит **все** строки. Значит
  `UPDATE auth.devices` не выполнится, backfill `direct_key` не выполнится, а `VALIDATE ck_chats_direct_key` упадёт (громко) при
  наличии DIRECT-чатов; при непустой истории устройств упадёт и `ADD CONSTRAINT ck_devices_identity_key_alg` (старые строки с
  `identity_key_alg='Ed25519'`).
* **Риск:** security-миграция блокирует деплой на managed PG с неинформативной ошибкой; либо (в вырожденном случае пустых таблиц)
  создаёт ложное впечатление успеха. Тихая порча данных исключена (VALIDATE видит все строки), но rollout-риск реальный.
* **Исправление:** в начало V16 добавить fail-fast guard:
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION
  'V16 requires a superuser/BYPASSRLS migration role' USING HINT='run Flyway as krug_migrator with BYPASSRLS'; END IF; END $$;`
  и/или `SET LOCAL row_security = off;` — при non-bypass роли первый же RLS-запрос падает с явным
  `query would be affected by row-level security policy` (проверено). Задокументировать требование в
  `backend/README.md` (раздел миграций) и в runbook §6.5.2.
* **Тест:** отдельный Testcontainers-кейс: `CREATE ROLE mig2 NOLOGIN` + `ALTER TABLE ... OWNER TO mig2` (без BYPASSRLS) + Flyway от
  `mig2` → ожидаем понятную ошибку guard'а, а не «check constraint violated by some row»; с `BYPASSRLS` → V16 применяется (уже покрыто).

### P1-06. Отозванную identity-пару можно «воскресить» в другом аккаунте; комментарий V16 утверждает обратное

* **Файл/строка:** `V16__e2ee_device_keys.sql:41-48` (индексы `WHERE status <> 'REVOKED'`) и комментарий `:41-42`
  («so a revoked identity can never be "resurrected" by a new device» — неверно при таком предикате);
  `docs/E2EE-SPEC.md` §3.1 п. 8a («global unique partial index не должен позволять воскресить те же ключи») и §6.5 «P2-11»
  («публичные ключи нельзя копировать в другой аккаунт»); app-проверка `DeviceRegistrationService.java:93,138` слепа для чужих
  REVOKED-устройств (RLS: REVOKED peer не виден — подтверждено пробой).
* **Сценарий (подтверждён на PG16):** устройство A (user1) отозвано, ключи остались. user2 вставляет устройство с теми же
  `identity_signing_key`/`identity_dh_key` → **успешно** (индекс не содержит REVOKED-строку); при этом второй **не**-revoked дубль
  отвергается. Через API это проходит, если user2 знает публичный bundle A (он публичен для собеседников по чату): app-проверка
  `findRevokedByIdentityKeys` видит только свои устройства → 410 не срабатывает, а `findByIdentityDhKey`/`SigningKey` тоже не видят
  чужое revoke-устройство → остаётся только DB-индекс, который такой случай пропускает.
* **Риск:** нарушен заявленный инвариант глобальной уникальности identity-ключей и «revoked нельзя воскресить»; открыт key-squatting
  (чужой публичный identity-ключ закрепляется за новым аккаунтом/устройством). Прямой компромисс ключей невозможен (приватных ключей
  у атакующего нет; TOFU-пин идёт по `device_id`), поэтому практическая эксплуатируемость низкая — но это ровно тот инвариант,
  на который ссылаются §3.1/§7.5, и B3/B4 будут на него опираться.
* **Исправление (выбрать решение PM):** (а) убрать `status <> 'REVOKED'` из обоих partial-индексов (уникальность по **всем** строкам;
  ключи revoked-устройств остаются в таблице) — тогда cross-account resurrection упирается в unique violation → `409`; или
  (б) оставить предикат, но добавить `SECURITY DEFINER`-lookup `auth.find_revoked_identity(sig, dh)` для регистрации (обходит RLS) и
  вызывать его до insert. В любом случае исправить комментарий V16 и, если решение (б), — текст §3.1/§6.5. Миграция forward-only:
  новый V17.
* **Тест:** удалить/изменить предикат → user2 регистрирует пару revoked A → `409 IDENTITY_KEY_CONFLICT` (или `410`), строки user2 нет;
  self-replay revoked A → `410` (N1, уже есть); два ACTIVE-дубля → `409` (есть).

## P2

### P2-01. `ck_devices_keys_all_or_none` не является all-or-none: `NULL AND …` = `NULL`, CHECK пропускает

* **Файл/строка:** `V16__e2ee_device_keys.sql:30-39` (и тот же текст в `docs/E2EE-SPEC.md` §6.5 — дефект спеки унаследован).
* **Сценарий (подтверждён на PG16):** приняты три «невозможных» строки: (1) `identity_key_alg='Ed25519+X25519'`,
  `identity_signing_key=NULL`, dh/binding/fingerprint заданы; (2) то же без `fingerprint`; (3) без sig и dh, но с binding+fp.
  Причина: во второй ветке `octet_length(NULL)` → `NULL`, `NULL = 32` → `NULL`, `false OR NULL` → `NULL`, а CHECK проходит на `NULL`
  (та же дыра допускает и строку «sig есть, dh/binding NULL»).
* **Риск:** БД перестаёт быть источником истины, на который рассчитывают `isE2eeCapable`, claim, `GET /chats/{id}/keys` и будущий
  fan-out; такая строка либо ломает маппер (`Device.requireKeyInvariant` → 500), либо (вариант «нет fingerprint») проходит
  capability-SQL и даёт `fingerprint:null` в `DeviceKeyInfo` (контракт требует Base64Url32) → 500/contract violation.
* **Исправление:** сделать предикат трёхзначно-безопасным:
  `CHECK ((identity_signing_key IS NULL AND identity_dh_key IS NULL AND identity_binding_signature IS NULL AND fingerprint IS NULL
  AND identity_key_alg='LEGACY') OR (identity_key_alg='Ed25519+X25519' AND identity_signing_key IS NOT NULL AND identity_dh_key IS NOT NULL
  AND identity_binding_signature IS NOT NULL AND fingerprint IS NOT NULL AND octet_length(...)=…))` — т.е. явные `IS NOT NULL` до
  `octet_length`, либо `coalesce(octet_length(x), -1)`. Исправить и в §6.5 (S-сессия), т.к. B3 будет копировать DDL.
* **Тест:** три вставки выше (+ «sig есть, dh NULL») → `23514`; legacy и полный набор → ok; `UPDATE` «докинуть» один ключ к legacy →
  `23514` **после** исправления (сейчас проходит — это и есть баг).

### P2-02. Предикат `e2ee_capable` расходится между доменом и SQL (4 места, 3 разных предиката)

* **Файл/строка:** `auth/domain/model/Device.java:271-277` (ACTIVE + alg + sig + dh + binding; fingerprint не проверяется);
  `auth/infrastructure/persistence/DeviceRepositoryAdapter.java:70-79` (`countActiveE2eeCapable`: alg + sig);
  `chat/infrastructure/persistence/ChatRepositoryAdapter.java:121,334` (summary/`peerHasE2eeCapableDevices`: alg + sig).
* **Сценарий:** строка «sig задан, dh/binding NULL» (её пропускает CHECK — P2-01) считается capable в SQL-агрегатах
  (`GET /workspaces/{id}/chats` покажет `peer_has_e2ee_capable_devices=true`), но не в домене (`claim`/`keys` её не вернут) →
  J3-критерий «признаки E2EE» врёт. Строка «нет fingerprint» (тоже пропускается) считается capable и в SQL, и в домене, но
  `ChatKeysService.toInfo` вызывает `Base64Url.encode(null)` → 500 / contract violation на `GET /chats/{id}/keys`.
* **Риск:** рассинхронизация «единственного проводного критерия» (D-S4-06) и ключевых эндпоинтов; после B3 — неверный fan-out.
* **Исправление:** один SQL-предикат/`GENERATED`-колонка или view `auth.device_capability` и использовать его везде (включая домен через
  reconstitute-инвариант); после P2-01 расхождение станет недостижимым, но единый предикат всё равно нужен.
* **Тест:** строка с неполным набором ключей (если её всё же пустят) → `peer_has_e2ee_capable_devices=false` и `GET /chats/{id}/keys`
  не падает; property-тест «capable в SQL == `Device.isE2eeCapable`».

### P2-03. `key_verifications`: scope-триггер не проверяет статус/capability устройств (только членство пользователей)

* **Файл/строка:** `V16__e2ee_device_keys.sql:234-272` (`check_key_verification_scope`); API-проверки —
  `auth/application/usecase/ChatKeysService.java:110-122`.
* **Сценарий (подтверждён на PG16):** приняты (а) строка с `target_device_id` = REVOKED-устройство; (б) строка, где
  `verifier_device_id` — LEGACY-устройство (без ключей). API такие запросы отвергает (target: ACTIVE + `isE2eeCapable`; verifier
  приходит из `X-Device-Id` и в prod проверяется binding'ом), но БД-инвариант §6.5 (закрытие P2-3 review-03) заявлен строже
  («строгий scope»).
* **Риск:** defence-in-depth: будущий код/миграция/бэкфилл может создать строку, которая затем попадёт в `verified_count`/
  `verified_by_other_devices_count` и UI-«замочек». Не exploitable через API сегодня.
* **Исправление:** в триггере добавить проверки `target` ACTIVE + capable (`identity_key_alg='Ed25519+X25519' AND identity_signing_key
  IS NOT NULL`), `verifier` ACTIVE; либо задокументировать в §6.5, что device-статусы — app-level, и не называть триггер «строгим scope».
* **Тест:** те же две вставки → `23514 VERIFICATION_SCOPE_MISMATCH`; валидная пара ACTIVE+capable → ok; revoke target после вставки →
  `revoked_at` обновляется (регрессия T29/T30 сохраняется).

### P2-04. `verified` не сверяется с `target_key_generation`

* **Файл/строка:** `auth/infrastructure/persistence/KeyVerificationRepositoryAdapter.java:57-76` (`findByVerifierAndChat` фильтрует
  только `revoked_at IS NULL`); `auth/application/usecase/ChatKeysService.java:155-171` (`toInfo`: `verified=true` по факту строки).
* **Сценарий:** строка верификации хранит `target_key_generation`, но при чтении он не сравнивается с `device.keyGeneration()`.
  Сегодня `key_generation` меняется только на revoke, а revoke гасит строки (`revokeForTargetDevice`), поэтому живых stale-строк нет.
  Как только появится in-place rotation (v2) или любой другой путь `key_generation++`, UI покажет «verified» для изменившегося ключа —
  ровно то, что §7.5 запрещает.
* **Риск:** ложный «verified» после смены ключа (key-change warning не сработает).
* **Исправление:** в `findByVerifierAndChat` (или в `toInfo`) отбрасывать строки с `target_key_generation <> device.keyGeneration()`;
  `verified_count` считать по тому же предикату.
* **Тест:** вставить verification с `target_key_generation=1`, поднять устройству generation до 2 (SQL) → `verified` = null,
  `verified_count=0`; вернуть 1 → снова verified.

### P2-05. `409 KEY_CHANGED` и `Idempotency-Key` для verification задекларированы, но не реализованы

* **Файл/строка:** `contracts/openapi.yaml` (`/chats/{chatId}/keys/verification` → `409`; `IdempotencyKey` в параметрах),
  `docs/E2EE-SPEC.md` §6.2.7 («`409 KEY_CHANGED` — `key_generation` target изменилась», «повтор → та же запись»),
  `auth/api/DeviceKeyController.java:69-80` (ключ только валидируется, `IdempotencyPort` не используется),
  `ChatKeysService.java:94-130` (сравнения generation нет).
* **Сценарий:** сегодня `KEY_CHANGED` недостижим (revoked target → `422 UNKNOWN_DEVICE`; generation меняется только revoke'ом), а
  `Idempotency-Key` не даёт replay-семантики (upsert и так перезаписывает строку, но `verified_at`/`id` меняются).
* **Риск:** контракт обещает код, которого сервер не отдаёт; клиент B3/B5 будет обрабатывать несуществующую ветку.
* **Исправление:** либо реализовать (передавать `expected_key_generation`/сравнивать с claim-временем → `409 KEY_CHANGED`), либо убрать
  `409` из контракта отдельным PR и записать решение в §6.2.7; для `Idempotency-Key` — либо reserve/complete, либо явно задокументировать
  «required by contract, semantically natural upsert».
* **Тест:** claim → generation++ → verification с устаревшей generation → `409 KEY_CHANGED` (если реализуем); повтор того же
  `Idempotency-Key`+body → одинаковый `id`/`verified_at` (если реализуем).

### P2-06. Гонка `POST /workspaces/{id}/chats` (DIRECT) → 500; GROUP игнорирует `Idempotency-Key`

* **Файл/строка:** `chat/application/usecase/ChatCreateService.java:93-107`; `chat/infrastructure/persistence/ChatRepositoryAdapter.java:256-283`
  (`ON CONFLICT (id) DO NOTHING` не покрывает `ux_chats_direct_pair`).
* **Сценарий:** два параллельных запроса на одну DIRECT-пару: оба проходят `findLiveDirectByKey` (null), второй INSERT падает на
  `ux_chats_direct_pair` → `DataIntegrityViolationException` не перехвачен → `500 INTERNAL` вместо `200` с существующим чатом.
  GROUP: `Idempotency-Key` объявлен, но не резервируется → повтор после таймаута создаёт второй GROUP-чат.
* **Риск:** 500 на идемпотентном контрактом эндпоинте; дубли GROUP-чатов при retry.
* **Исправление:** ловить `DataIntegrityViolationException` вокруг `saveDirectChat` → перечитать `findLiveDirectByKey` → `200`;
  для GROUP — `IdempotencyPort` (или убрать ключ из контракта).
* **Тест:** два конкурентных DIRECT-запроса (ExecutorService) → один `201`, один `200`, `id` одинаковый, чат один; повтор GROUP с тем
  же `Idempotency-Key` → тот же чат.

### P2-07. `409 IDENTITY_KEY_CONFLICT` может превращаться в 500: `save()` не флашится внутри try/catch

* **Файл/строка:** `auth/application/usecase/DeviceRegistrationService.java:175-184` (`deviceRepository.save(device)` в try/catch, затем
  `savePrekeys`), `auth/infrastructure/persistence/DeviceRepositoryAdapter.java:27-49` (`persist`/`merge`, без flush).
* **Сценарий:** межпользовательский конфликт ловится только уникальным индексом (RLS скрывает чужую строку от app-проверок).
  `persist` лишь ставит INSERT в очередь; prekey-вставки — native-запросы (Hibernate не флашит перед ними), поэтому нарушение
  уникальности всплывает на commit, **вне** `try/catch` → `DataIntegrityViolationException` → `500` вместо `409 IDENTITY_KEY_CONFLICT`.
* **Риск:** контрактный код 409 недостижим в самом важном (межпользовательском) случае; 500 с шумом в логах; клиент не понимает,
  что ключи заняты.
* **Исправление:** `entityManager.flush()` (или `saveAndFlush`) **внутри** try до `savePrekeys`, и/или `@Transactional` + перехват
  `TransactionSystemException`/`DataIntegrityViolationException` на границе use case; маппить нарушение
  `ux_devices_identity_*` в `409`, `ck_devices_*` в `422 INVALID_KEY_FORMAT`.
* **Тест:** user2 с IK_dh от user1 (без общего чата) → `409 IDENTITY_KEY_CONFLICT` (а не 500); параллельные регистрации одной пары →
  ровно один `201`, второй `409`/replay, без 500.

### P2-08. Prekey upload: cap 200 не защищён от гонки и не чистит историю

* **Файл/строка:** `auth/application/usecase/PrekeyUploadService.java:107-132` (проверка `available + newKeys`, затем N+1 `find`+`save`);
  `V16:76-96` (нет COUNT-ограничения на `ONE_TIME`).
* **Сценарий:** два параллельных upload'а по 200 разных `key_id` оба видят `available=0` и оба проходят → >200 outstanding OPK
  (нарушен контрактный `PREKEY_LIMIT_EXCEEDED` и `one_time_prekeys_limit:200`). `consumed_at`/`retired_at`/истёкшие строки не удаляются
  никогда → неограниченный рост `auth.device_prekeys` на активное устройство.
* **Риск:** обход лимита (хранилище/скан claim), деградация claim-запроса со временем; не security-critical, но эксплуатация дешёвая.
* **Исправление:** проверять лимит в `SECURITY DEFINER`-функции/CTE с `FOR UPDATE` по устройству (или `INSERT ... SELECT` с
  `WHERE (SELECT count(*) …) < 200`), либо блокировать строку устройства на время upload; retention-джоб для
  `consumed_at/retired_at/expires_at < now()-…`.
* **Тест:** два конкурентных upload'а по 150 ключей → суммарно ≤200, второй → `422 PREKEY_LIMIT_EXCEEDED`; retention удаляет старые
  строки, claim не деградирует.

### P2-09. `check-contract.mjs`: правка вне заявленной зоны + «33 operations» — тавтология

* **Файл/строка:** `frontend/scripts/check-contract.mjs:441` — `check((Object.keys(operations).length = 33), '…')`: **присваивание**
  вместо `===`, выражение всегда истинно; guard не проверяет ничего. Отчёт сам признаёт правку вне зоны (`E7-B1-REPORT.md:34-36`).
* **Сценарий:** удаление/добавление операции в контракте не будет замечено guard'ом (28 путей и 58 схем проверяются по-настоящему);
  «зелёный contract-check» частично недоказуем.
* **Риск:** ложная уверенность в неизменности операционного набора; процессное нарушение зоны (файл вне `contracts/**`/`backend/**`
  менялся «механически»).
* **Исправление:** `check(Object.keys(operations).length === 33, …)`; прогнать; при желании — вынести guard-файл в разрешённую зону
  (PM/владелец frontend), а не править его из backend-сессии.
* **Тест:** `node scripts/check-contract.mjs` зелёный; временно удалить одну операцию из `operations` → красный (мутационная проверка).

### P2-10. Flag-on: default-чат E2EE-воркспейса создаётся как E2EE GROUP в обход `E2EE_GROUP_NOT_SUPPORTED`

* **Файл/строка:** `workspace/application/usecase/WorkspaceOnboardingService.java:85-86`;
  `chat/application/usecase/ChatProvisioningService.java:44-52`.
* **Сценарий:** при `krug.e2ee.enabled=true` создание E2EE-воркспейса проходит гейт и сразу создаёт «Общий чат» с
  `security_mode=E2EE` и `type=GROUP`. `ChatCreateService` такой GROUP отверг бы (`E2EE_GROUP_NOT_SUPPORTED`), но onboarding идёт
  другим путём.
* **Риск:** в E7 появляется E2EE GROUP, для которого нет ни send, ни fan-out, ни `GET /chats/{id}/keys`-семантики; нарушение §6.3.1
  (`E2EE_GROUP_NOT_SUPPORTED`) и «в E7 только 1:1». Сегодня недостижимо (флаг off), но станет дырой в момент включения флага до B3.
* **Исправление:** на flag-on onboarding либо не создавать default-чат для E2EE, либо создавать его MANAGED и требовать явный DIRECT
  (решение PM); централизовать проверку «E2EE ⇒ только DIRECT» в одном доменном правиле, используемом и onboarding'ом.
* **Тест:** flag-on + `POST /workspaces {security_mode:E2EE}` → default-чат отсутствует **или** MANAGED; ни одного E2EE GROUP в БД.

### P2-11. `one_time_prekeys: [null]` → NPE → 500; контракт `POST /devices` не содержит `400`

* **Файл/строка:** `auth/api/mapper/DeviceRequestMapper.java:55-61` (`item.keyId()` без null-проверки);
  `auth/api/DeviceController.java:56-69` (`@Valid` → `400 VALIDATION_FAILED`), `contracts/openapi.yaml` `/devices` post (нет `400`).
* **Сценарий:** JSON `{"one_time_prekeys":[null]}` → `NullPointerException` → `500 INTERNAL` (в `claim` такие элементы уже дают `422`);
  пустое `name`/`platform≠WEB` → `400`, который контракт не документирует.
* **Риск:** 500 на невалидном вводе; неполный контракт ошибок.
* **Исправление:** null-элемент → `422 INVALID_KEY_FORMAT`/`400` (как в claim); добавить `400` в `/devices` (и `400` в другие
  `@Valid`-эндпоинты) либо убрать bean-validation в пользу 422.
* **Тест:** `[null]` → 4xx (не 500); `name:""` → документированный код; контракт-тест на `400` для `/devices`.

### P2-12. Нет `EXPLAIN`-проверки индексов конвертов (остаток GO #2 review-03)

* **Файл/строка:** `docs/E2EE-REVIEW-03.md:389` (условие 2: «`EXPLAIN` на `(recipient_device_id, created_at)`»);
  `E2eeMigrationIT` проверяет наличие индексов, но не план.
* **Сценарий/риск:** на объёмах прод-партиций выборка «конверты для устройства» может пойти Seq Scan; B4 будет читать конверты этим
  путём. Не security, но заявленное условие GO не выполнено.
* **Исправление:** в `E2eeMigrationIT`/B4 добавить `EXPLAIN (FORMAT JSON)` на `SELECT … WHERE recipient_device_id=? AND created_at>=?`
  и assert `Index Scan` по `ix_envelopes_recipient`.
* **Тест:** как выше, на партиции с ≥10k строк (или `enable_seqscan=off` + план).

### P2-13. Тестовые пробелы B1 (заявленное «покрыто» шире фактического)

* **Файл/строка:** `backend/src/test/java/ru/krug/backend/integration/E2eeDeviceKeyIT.java` (7 тестов).
* **Не покрыто:** `409 IDENTITY_KEY_CONFLICT`; `409 DEVICE_LIMIT_REACHED` (6-е устройство); `unavailable[NO_SPK]` (истёкший SPK);
  повторный `POST /workspaces/{id}/chats` DIRECT → `200` с тем же `id` (строка E-таблицы); peer_id/capability в **ответе на создание**
  GROUP; cross-tenant claim (чат W2 при контексте W1 — проверено только на уровне SQL-функции, не через API); cross-user replay ключей
  (P1-02/P2-07); `key_verifications` scope-триггер через API (cross-chat); `[null]`-элементы.
* **Риск:** регрессии в самых «кодовых» ветках (409/410/лимиты) не ловятся; отчёт создаёт ложное впечатление полного покрытия.
* **Исправление:** добавить перечисленные кейсы в `E2eeDeviceKeyIT` (или отдельный `E2eeLimitsIT`), каждый — с проверкой БД-состояния.
* **Тест:** сами кейсы.

## Проверки (команды/результаты)

Все команды выполнены ревьюером в текущем дереве (`JAVA_HOME=JDK 21`, `mvn -o -Dmaven.repo.local=.m2repo`, Node 24).

```bash
# 1. targeted: B1-тесты + ArchUnit
mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeDeviceKeyIT,E2eeMigrationIT,DeviceKeyCryptoTest,ArchitectureTest' test
# Tests run: 23, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# (E2eeDeviceKeyIT 7, E2eeMigrationIT 3, DeviceKeyCryptoTest 3, ArchitectureTest 10)

# 2. полный прогон (заявленные 282)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 282, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS (22.9 s)
# ArchUnit 10/10; E2EE-тесты зелёные; «Migration ... to version 16 failed» в логах — ожидаемые
# негативные кейсы E2eeMigrationIT (corrupt/duplicate), а не падение набора.

# 3. контракт + типы
cd frontend && npm run contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields), generated types in sync.
npx tsc -p tsconfig.json --noEmit   # exit 0

# 4. независимый пересчёт контракта (node + yaml)
# paths 28, ops 33, schemas 58, parameters 10 — совпадает с отчётом.

# 5. V16 на чистом PG16 (postgres:16, psql -U postgres, ON_ERROR_STOP=1)
# V1..V16 = 16/16 rc=0. (Роль — суперпользователь контейнера; см. P1-05.)

# 6. DB-пробы (одноразовый контейнер, удалён после ревью)
#  - all-or-none CHECK: 3 «невозможные» строки ПРИНЯТЫ (P2-01)
#  - revoked identity pair: повторная регистрация другим user → ПРИНЯТА (P1-06);
#    второй не-revoked дубль → 23505 (ok)
#  - RLS как krug_app: peer ACTIVE виден только при общем чате в текущем workspace (1/0),
#    REVOKED peer не виден (0), без workspace — только свои
#  - claim: чат W2 при app.workspace_id=W1 → UNKNOWN_DEVICE; при W2 → один OPK; повтор → NULL;
#    consumed_at проставлен
#  - message.messages E2EE: body/sticker/SYSTEM/без sender → CHECK; валидная строка → ok
#  - message_envelopes: чужая workspace → RLS violation; своя → ok; на партиции 4 индекса (PK+3), RLS+FORCE
#  - key_verifications: target=REVOKED и verifier=LEGACY строки ПРИНЯТЫ триггером (P2-03)
#  - owner FORCE-RLS таблиц без GUC видит 0 строк; VALIDATE CONSTRAINT видит все строки (P1-05)
```

Ограничения проверки: нет git → нельзя подтвердить «одним PR» и отсутствие скрытых правок; `EXPLAIN` на объёмах не снимался (P2-12);
браузерные KAT/WebCrypto — вне G3 (G2/G4); prod-профиль Keycloak в этом прогоне не поднимался (RLS-поведение проверено на уровне БД и
`test`-профиля, где приложение ходит как `krug_app` — `IntegrationTestBase.java:39,68-76`).

## Contract/I-01

**Вердикт по I-01: contract-side DONE (A–D), behavior-side PARTIAL (E), F-3 unverifiable.**

Проверено фактически:

* **A (схемы §6.3.1):** все перечисленные схемы присутствуют и соответствуют handoff'у — `Base64Url16/32/64` (`contentEncoding:
  base64url`, patterns 22/43/86), `SignedPrekey`/`OneTimePrekey`/`CryptoHeader`/`PrekeyBlock`/`CryptoEnvelope`
  (`additionalProperties:false`, `spk_id`/`opk_id` pattern, `ciphertext` 363..44054), `DeviceRegistration` (`required` не изменён,
  ключи optional, all-or-none в описании), `Device` (+`name` nullable, `status`, `e2ee_capable`, `key_generation`, identity-поля,
  `fingerprint`, `signed_prekey`, `one_time_prekeys_available`, `last_seen_at`), `DeviceList`, `SignedPrekeyUpload`,
  `PrekeyUploadResult`, `KeyClaimRequest`/`PrekeyBundle`/`UnavailableDevice` (`[NO_SPK, NO_KEYS]`)/`KeyClaimResponse`, `DeviceKeyInfo`,
  `ChatKeysResponse`, `VerificationRequest` (`vh_version` enum `[2]`, `required` расширен)/`VerificationResponse`, `EnvelopeCoverage`
  (все required peer/self-поля, `warning` enum), `MessageCreateResult` (`allOf Message`, `envelope_coverage` optional),
  `Chat`/`ChatCreateRequest`, расширенные `Message` (`client_message_id`, `crypto`) и `MessageCreate` (`envelopes` 1..10),
  `ChatSummary` (`name` nullable, `peer_id`, `peer_has_e2ee_capable_devices`), `Error.code` description с кодами §4.8.
  **Выдуманных полей не найдено** (сверка с §6.3.1 A построчно; D-S4-01…06 соблюдены).
* **B (пути):** 5 новых путей (`/devices/{deviceId}`, `/devices/{deviceId}/prekeys`, `/keys/claim`, `/chats/{chatId}/keys`,
  `/chats/{chatId}/keys/verification`) и 7 новых операций (включая `GET /devices` и `POST /workspaces/{id}/chats`) + изменённые
  ответы `GET /workspaces/{id}/chats`, `POST/GET /chats/{id}/messages`; статусы/`X-Device-Id`/`Idempotency-Key` (`claim` — без ключа)
  совпадают с handoff'ом. Всего **28 paths / 33 operations / 58 schemas** (независимый пересчёт).
* **C (WS):** `chat.keys.changed` (reason enum, без `seq`) и `device.list.changed`; `chat.session.reset` явно **не** введён;
  `message.created` = `Message` с `crypto`; §8-оговорки на месте.
* **D:** `schema.d.ts` синхронен (`contract:check` перегенерирует in-memory и сравнивает); `tsc --noEmit` — 0. Файл вручную не
  правился (по содержимому соответствует генерации).
* **E:** 9 из 13 строк реализуемы и покрыты (`legacy 201`, `partial 422`, `full 201`, DIRECT `name=null`/`peer_id`, GROUP
  `peer_id=null`/capability `false`, managed `201` без coverage, `vh=1 → 422`, claim не-участником `422`, `managed+envelopes → 409`
  как задокументированное отклонение). **4 строки не реализуемы без E2EE-send** (см. P1-04) — отчёт это признаёт, но всё равно
  называет I-01 применённым.
* **F:** (1) схемы/пути есть; (2) WS-события есть; (3) «закоммичено вместе» — **невозможно** (git отсутствует, P1-04); (4)
  contract-check зелёный; (5) E-тесты — 9/13; (6) backend компилируется/стартует. Итог: **4 пункта выполнены, F-3 невыполним,
  F-5 частично (9/13)** → F не закрыт, I-01 = PARTIAL.

Замечания по guard'у: `frontend/scripts/check-contract.mjs` изменён вне разрешённой зоны (признано в отчёте) и содержит мёртвую
проверку «33 operations» (P2-09); 28/58 проверяются по-настоящему.

## V16/DDL

**Исполнимость:** V1→V16 на чистом PG16 — 16/16 `rc=0`; `E2eeMigrationIT` прогоняет реальный Flyway на V1–V15 + seed
(normal / degraded ACTIVE+REMOVED / deleted DIRECT, GROUP) → V16, и отдельные БД для corrupt (`DIRECT_KEY_UNRESOLVED`) и duplicate
(`DIRECT_PAIR_DUPLICATE`). Подтверждено: `direct_key` backfill по **любым** двум участникам независимо от статуса, включая deleted;
CHECK добавлены `NOT VALID` → `VALIDATE` (оба `convalidated=true`); `ux_chats_direct_pair` partial by `deleted_at IS NULL`;
`ck_chats_direct_key_format` требует порядок `least<greatest` (обход `B:A` закрыт); immutability-триггеры на `chat.chats` и
`workspace.workspaces` (`MODE_CHANGE_FORBIDDEN`); `WorkspaceRepositoryAdapter.save` больше не пишет `security_mode` (GO #3 закрыт).

**Grants/RLS/partitions:** `auth.device_prekeys`, `auth.key_verifications`, `message.message_envelopes` (parent) + `EXECUTE` на
`auth.claim_one_time_prekey` — `krug_app` имеет права (проверено `has_table_privilege` и вставками под `krug_app`);
`device_prekeys` — `ENABLE` без `FORCE` (осознанно, для SECURITY DEFINER claim), owner+chat-peer политики;
`key_verifications`/`message_envelopes` — `ENABLE+FORCE`; партиции envelopes создаются вместе с messages, у каждой RLS+FORCE+policy+grant
и **ровно 4 индекса** (PK + 3 parent, P2-1 подтверждён на новой партиции); `ensure_partition` создаёт обе партиции и
sender-scoped `client_message_id` индекс; старые `ux_*_client` удалены.

**Claim-функция:** `SECURITY DEFINER`, `search_path=pg_catalog,pg_temp`, все ссылки schema-qualified; membership проверяется **в
текущем workspace** (проба: W2-чат при `app.workspace_id=W1` → `UNKNOWN_DEVICE`); `FOR UPDATE SKIP LOCKED` + `consumed_at`;
истощение — `NULL`, не ошибка. `GRANT EXECUTE` есть.

**E2EE-инварианты сообщений:** `ck_messages_e2ee_no_managed_body/no_sticker/meta/type/no_reply_to_id/sender_required` — проба:
body/sticker/SYSTEM/`sender NULL` отвергнуты, валидная строка принята; на партициях (`messages_YYYY_MM`) CHECK наследуются.

**Найденное в DDL:** P2-01 (all-or-none CHECK пропускает NULL-комбинации), P1-06 (предикат уникальности исключает REVOKED →
resurrection), P2-03 (scope-триггер `key_verifications` не проверяет статус/capability устройств), P1-05 (требование
superuser/BYPASSRLS), P2-02 (расхождение предикатов capability). Всё остальное — соответствует §6.5.

## Device keys/prekeys/claim

**Подтверждено (код + тесты + пробы):**

* **Legacy/full/partial:** без ключей → `201`, `identity_key_alg=LEGACY`, `e2ee_capable=false`, prekeys не пишутся; частичный набор →
  `422 INVALID_KEY_FORMAT` до записи (проверяется по фактическому наличию полей, `DeviceRequestMapper:26-41`); полный набор → проверка
  `Ed25519` SPK-подписи и binding-подписи, `fingerprint = SHA-256(D_FP‖IK_sig‖IK_dh)`, `key_generation=1`, SPK+OPK в одной транзакции.
* **Крипто-формат:** `DeviceKeyCrypto` побайтово соответствует §3.1/§7.1 — SPK: `"Krug/E2EE/v1/spk-signature" ‖ u8(1) ‖ u16(len) ‖
  key_id ‖ spk_pub`; binding: `"Krug/E2EE/v1/ik-binding" ‖ u8(1) ‖ IK_dh ‖ IK_sig` (88 B); fingerprint — как в §7.1. KAT B3/B5/G1
  из `E2EE-TEST-VECTORS.json` зелёные; тест-суппорт подписывает независимо от верификатора (совпадают только домены).
* **Идемпотентность:** порядок §3.1 соблюдён — (0) revoked pair → `410`, (1) та же пара среди не-REVOKED → то же устройство
  (в т.ч. при лимите, до Idempotency-Key), (2) затем ключ идемпотентности; `Idempotency-Key` скоупится `(user, scope, key)`.
* **Revoke:** терминальный, `key_generation++` (с `LEAST(...,2147483647)`, без overflow), prekeys удалены, verifications target →
  `revoked_at`, повтор → `204`; чужое устройство → `404`; после revoke `e2ee_capable=false` в ответе.
* **Prekeys:** ротация SPK (retire активного + новый в одной транзакции, partial unique `(device_id) WHERE SIGNED AND
  retired_at IS NULL`), повтор с теми же bytes идемпотентен, тот же `key_id` с другими bytes → `409 PREKEY_ID_CONFLICT`,
  legacy-target → `422 E2EE_LEGACY_DEVICE` (N2), лимит 200 → `422 PREKEY_LIMIT_EXCEEDED`; `X-Device-Id` обязан совпадать.
* **Claim:** `chat_id` обязателен; membership в текущем workspace; target — ACTIVE-член чата; ровно один OPK на устройство атомарно;
  `otp_exhausted=true` при исчерпании; ни одного bundle → `409 NO_PREKEYS`; не-участник/чужое устройство → `422 UNKNOWN_DEVICE`
  (одинаково для «нет» и «не член»); >10 устройств → `422 TOO_MANY_DEVICES`; `Idempotency-Key` не принимается.
* **Chat keys/verification:** только E2EE-чат (`409 MODE_NOT_SUPPORTED`); только ACTIVE + `e2ee_capable`; `verified` строго по
  `(X-Device-Id, target, chat)`, для себя `null`, другое устройство пользователя `null`/`verified_count=0` (P0-1 подтверждён);
  `vh_version≠2` → `422 VH_VERSION_UNSUPPORTED` до записи; `safety_number_hash` — строгий b64u/32; upsert по
  `(verifier_device_id,target_device_id,chat_id)`; ownership — composite FK + INSERT-триггер.

**Найденное:** P1-01 (нет rate limit на claim), P1-02 (identity-запросы без `user_id`), P1-06 (revoked uniqueness),
P2-04 (`verified` без сверки generation), P2-05 (`KEY_CHANGED`/Idempotency), P2-07 (flush/409), P2-08 (гонка лимита/история),
P2-03 (триггер), P2-02 (capability), P2-13 (пробелы тестов).

## Flag off

* **E2EE workspace/chat:** `POST /workspaces {security_mode:E2EE}` → `409 E2EE_DISABLED` **до** записи (гейт в
  `WorkspaceOnboardingService:72-75`); `POST /workspaces/{id}/chats` в E2EE-воркспейсе → `409 E2EE_DISABLED`
  (`ChatCreateService:58-61`) — проверено тестом.
* **E2EE messages:** отправка в E2EE-чат → `409 E2EE_DISABLED` (`MessageSubmissionHandler:109-112`), чтение → `409 E2EE_DISABLED`
  (`MessageQueryHandler:69-73`); **любой** запрос с `envelopes` (даже в MANAGED-чат) → `409 E2EE_DISABLED` без парсинга тела;
  `messageCount(e2eeChat) == 0` в тесте. Plaintext-fallback отсутствует (нет ветки, пишущей managed-тело в E2EE-чат; DB CHECK — вторая
  линия).
* **Managed поведение не затронуто:** `201 MessageCreateResult` без `envelope_coverage`, `crypto:null`, `client_message_id` в ответе
  и в WS-payload; `GET /workspaces/{id}/chats` для DIRECT `name=null`/`peer_id`/capability, для GROUP `peer_id=null`,
  capability `false` — контракт-валидация проходит.
* **Ключи доступны при флаге off** — осознанное решение («onboarding primitives», §6.3.1 D-S4-03); риск: claim в MANAGED-чатах
  работает (контракт этого и ожидает) и попадает под P1-01 (rate limit).
* **Отклонения E-таблицы** (см. P1-04): `managed+envelopes → 409` вместо `422 ENVELOPES_NOT_ALLOWED` — задокументировано в отчёте и в
  `MessageCreate.description` контракта; приемлемо для flag-off, но должно стать `422` при флаге on (B3).

## Условия GO для B3/B4

1. **P1-01** — rate limit (и метрика/алерт) на `POST /keys/claim`; без него E2EE-сессии получают управляемый DoS на OPK.
2. **P1-03** — outbox-события `chat.keys.changed`/`device.list.changed` + проактивные `session.revoked`/close 4403 при revoke;
   тесты WS-кадров.
3. **P1-06** — решение PM по uniqueness: убрать `status <> 'REVOKED'` из индексов (V17) **или** `SECURITY DEFINER`-lookup;
   исправить комментарий; тест «cross-account resurrection → 409/410».
4. **P2-01/P2-02** — исправить all-or-none CHECK (и §6.5) и свести capability к одному предикату; иначе B3-fan-out будет считать
   «capable» по неполным строкам.
5. **P2-03/P2-04/P2-05** — scope-триггер (или явная документация), сверка `target_key_generation` в `verified`, решение по
   `KEY_CHANGED`/Idempotency для verification.
6. **P2-07** — flush внутри try/catch → `409 IDENTITY_KEY_CONFLICT` вместо 500; тест межпользовательского конфликта.
7. **P2-10** — E2EE-воркспейс не должен создавать E2EE GROUP (default-чат) при включении флага.
8. **§6.2.8:** `POST /workspaces/{id}/chats` при флаге on обязан возвращать `E2EE_NO_ACTIVE_DEVICES` (peer без capable устройств —
   код не реализован вовсе) и не обходить `E2EE_GROUP_NOT_SUPPORTED` через onboarding default-чата (P2-10).
9. **E-таблица §6.3.1:** реализовать 4 отложенные строки в B3/B4 и добавить contract-тесты (`coverage`, `E2EE_LEGACY_DEVICE`,
   `E2EE_NO_PEER_ENVELOPE`, `E2EE_PLAINTEXT_FORBIDDEN`); до этого I-01 = PARTIAL.
10. **Envelopes:** зафиксировать правило дедупликации (PK `(message_id, recipient_device_id, created_at)` не мешает двум конвертам
    одному устройству с разными `created_at`; B4 должен писать все конверты с одним `created_at` и/или проверять `DUPLICATE_ENVELOPE`
    на app-уровне) — иначе `422 DUPLICATE_ENVELOPE` из контракта останется недоказуемым.
11. **P2-12** — `EXPLAIN` на `(recipient_device_id, created_at)` (остаток GO #2 review-03).
12. **P1-05** — guard/документация по роли миграции до первого production-прогона V16; прогон runner'а §6.5.2 на prod-подобном
    снимке; подтвердить отсутствие внешних потребителей `identity_public_key` (GO #4 review-03).
13. **Git** — инициализировать репозиторий (или приложить patch-bundle) и провести I-01 «одним changeset» до старта B3, иначе
    ревью B3 не сможет отделить его изменения от B1.
14. **До включения флага:** G2 (браузерные KAT) и G4 (внешний crypto-review/пентест) — как и было; B1 их не заменяет.

## Вопросы

1. **P1-01:** rate limit на claim — это B1-недоделка или сознательно отложено в B3? §3.2 спеки считает его защитой, а сегодня
   единственный лимит — `checkMessageSend`.
2. **P1-06 / §3.1 п. 8a (P2-11 спеки):** является ли «публичные ключи нельзя копировать в другой аккаунт» жёстким инвариантом и для
   **revoked**-пар? Если да — нужен V17 с индексом без предиката; если нет — надо исправить §3.1 п. 8a и комментарий V16.
3. **P1-02:** считается ли dev-профиль (dev-токены с `workspace_id`) достижимым для недоверенных пользователей? От этого зависит,
   P2 это или P1 на практике; в любом случае запросы стоит скоупить по `user_id` до B3.
4. **P1-05:** кто на managed PG владеет схемами и запускает Flyway — `krug_migrator` с `BYPASSRLS`/superuser или обычный owner?
   Нужно зафиксировать в README/runbook.
5. **GO #4:** есть ли вне Java-кода (BI/read-model/аналитика) потребители `auth.devices.identity_public_key`, которых не видно в
   workspace? Ревьюер подтверждает только отсутствие в `backend/**` и миграциях.
6. **P2-04/P2-05:** `key_generation` в v1 меняется только revoke'ом; планируется ли in-place rotation в v2 и должен ли `KEY_CHANGED`
   появиться уже в B3 (контракт его обещает)?
7. **P2-02:** можно ли считать `identity_signing_key IS NOT NULL` достаточным SQL-предикатом capable, или канон — все четыре поля
   (как в домене)? Нужен один ответ, иначе B3 будет считать покрытие иначе, чем claim.
8. **P2-11:** `400` для `POST /devices` (bean validation) — добавляем в контракт или переводим валидацию в 422?

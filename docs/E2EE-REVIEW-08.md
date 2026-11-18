# E2EE-REVIEW-08 — G4c final backend check после E7-B3F2

> **Рецензент:** независимый security-ревьюер. Автор E7-B3F2 в подготовке этого документа не участвовал.
> **Дата:** 2026-11-17. **Вход:** `docs/E2EE-REVIEW-07.md` (P1-03/P2-06/P2-07 и условия GO),
> `backend/E7-B3F2-REPORT.md`, `MessageEnvelopeRepositoryAdapter`, V18/V19, `E2eeLegacyEnvelopeIT`,
> `E2eeMigrationIT`, `ChatKeysService`, `CanonicalUuidDeserializer`, `MessageCreateRequest`,
> `docs/E2EE-SPEC.md` §4.1/§4.5/§4.6/§4.7, `contracts/openapi.yaml`.
> **Зона:** создан только этот файл; код, контракты, спека, векторы и `docs/TASKS*` не изменялись.
> Проверялось фактическое дерево (Git-репозитория в workspace нет): полный backend-suite,
> ArchUnit, contract-check, реальный HTTP в `E2eeLegacyEnvelopeIT` (RANDOM_PORT/Tomcat + PG16
> Testcontainers), миграционные IT на PG16, плюс **независимый SQL-эксперимент на PG16.16** для
> семантики RLS/`VALIDATE` (временная БД/роль вне workspace, после проверки удалены).

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**GO WITH CONDITIONS.**

Backend-блокеров не осталось:

* **P1-03 закрыт на двух уровнях.** Толерантный read-path (`octet_length(ciphertext)` в
  `findForDevice`/`findByMessage` + `toDomainOrNull`) реально даёт `200 crypto:null` вместо
  `500` для legacy 16 B; V19 переносит невалидные строки в quarantine, валидирует
  `ck_envelopes_ciphertext_min` на parent и всех партициях и восстанавливает `FORCE RLS`.
  Проверено real HTTP + PG16 (`E2eeLegacyEnvelopeIT`), миграционным IT и независимым
  SQL-экспериментом (включая `NOSUPERUSER NOBYPASSRLS` и рекурсию `VALIDATE` в партиции).
* **P2-07 закрыт:** `ChatKeysService.requireCurrentDevice` требует ACTIVE + owner; guard
  вызывается до чтения и до записи ключей/verification.
* **P2-06 закрыт для своей главной цели** — `client_message_id` (и прочие UUID-поля
  `MessageCreateRequest`) явно канонизируются, idempotency/response используют lower-case
  `UUID`. Остаётся низкий residual: `X-Device-Id` и `@PathVariable` по-прежнему лениво
  принимают `UUID.fromString`-формы, и это не задокументировано (см. P2-06-residual).
* **Полный прогон на текущем дереве:** **332/332**, Failures 0, Errors 0, Skipped 0;
  ArchUnit **10/10**; contract **33 operations / 58 schemas**, generated types in sync.
* Новых P0/P1 нет; E2EE-флаг по-прежнему `false` по умолчанию; новых decrypt/plaintext-путей
  для E2EE нет.

Условия GO для E7-F — в основном процессные/документационные и не блокируют backend:
внешние **G2/G4**, **git/one-PR**, синхронизация спеки/README с V19 и фактическим
`crypto:null`, остаточная канонизация header/path (P2-06), rollout-ограничения V19
(maintenance window/backup) и политика retention/ACL quarantine, плюс несколько тестовых
пробелов (WS legacy replay e2e, log-capture, 271 B по HTTP).

## P0

**Открытых P0 нет.** P0-01 (percent-encoded path bypass `X-Device-Id`) в B3F2 не
переоткрывался: изменённые файлы не касаются `DeviceBindingFilter`/`ApiRequestPath`, полный
suite зелёный. Код/поведение границы device-binding не регрессировали.

## P1

**Открытых P1 нет. P1-03 (legacy envelope 16..271 B → 500) — закрыт.**

### P1-03. Legacy-конверт больше не роняет страницу/кадр — **закрыт**

* **Код:**
  * `MessageEnvelopeRepositoryAdapter.java:95,142` — `findForDevice` и `findByMessage`
    добавляют `AND octet_length(ciphertext) BETWEEN ?3 AND ?4`, где границы берутся из
    `CryptoEnvelope.MIN_CIPHERTEXT_BYTES/MAX_CIPHERTEXT_BYTES` (272/33040), а не из литералов;
  * `MessageEnvelopeRepositoryAdapter.java:161-169` — `toDomainOrNull` ловит
    `IllegalArgumentException | IllegalStateException` (битый header/prekey) и пропускает
    строку, логируя только `message_id`, `recipient_device_id` и причину; ciphertext не
    логируется;
  * `V19__e2ee_legacy_envelope_quarantine.sql:21-68` — `NO FORCE`-окно, quarantine-таблица,
    `INSERT ... SELECT` всех строк вне `272..33040`, `DELETE` ровно этих строк,
    `VALIDATE CONSTRAINT`, восстановление `FORCE`.
* **Real HTTP + PG16 (`E2eeLegacyEnvelopeIT.java:54-140`), подтверждено прогоном:**
  * в состоянии «V18 `NOT VALID` + 16 B legacy-строка для A2» `GET /chats/{id}/messages`
    как **A2 → `200`, `crypto:null`**, страница проходит `MessagePage` контракт;
  * `GET` как **B1 → `200` со своим валидным конвертом**, байты ciphertext совпадают
    (`E2eeLegacyEnvelopeIT.java:96-103`) — legacy-строка A2 не ломает страницу другого
    устройства;
  * replay по `Idempotency-Key` и по `client_message_id` → **`201`**, тот же `message id`
    (при наличии хотя бы одного валидного конверта у сообщения — см. P2-09);
  * после реального V19: legacy-строка удалена (`0`), валидная сохранена (`1`, байты
    совпадают), quarantine = `1` (`legacy_short`), `convalidated=t` у parent и всех
    партиций, `FORCE` восстановлен; `GET` A2 снова `200 crypto:null`, B1 — свой конверт.
* **Миграционный IT (`E2eeMigrationIT.java:367-438`):** V15→V17→V18→V19 на реальном PG16:
  16 B и 271 B → quarantine `legacy_short` (2), 272 B остаётся в live; `unvalidatedFloorConstraints == 0`;
  `FORCE` восстановлен; `krug_app` не имеет `SELECT` на quarantine
  (`E2eeMigrationIT.java:429-433`).
* **Non-superuser (`E2eeMigrationIT.java:440-514`):** роль `NOSUPERUSER NOBYPASSRLS` (owner)
  применяет V18→V19 над legacy-строкой; строка перенесена, constraint валидирован,
  `FORCE` восстановлен. Это доказывает, что `NO FORCE`-окно действительно нужно и работает
  для non-superuser owner.
* **Независимый PG16.16-эксперимент (не авторский тест):** на временной БД с
  partitioned-таблицей, `ENABLE`+`FORCE` RLS на parent и партициях, политикой
  `ws = current_setting('app.ws')`:
  * owner при `FORCE` и без `app.ws` видит `0` строк; после `ALTER TABLE parent NO FORCE`
    (только parent) видит все `3` строки; флаги партиций остаются `true`; прямой доступ к
    партиции по-прежнему `0` — то есть для DML через parent достаточно parent-only
    `NO FORCE`, как в V19;
  * `VALIDATE` при наличии 16 B в партиции **падает** с
    `check constraint "ck_ct" of relation "env_2026_11" is violated by some row` — это
    прямое доказательство рекурсии в партиции;
  * после copy/delete: quarantine `2`, live `1`, `convalidated=t` у parent и обеих
    партиций, `FORCE` восстановлен; новая партиция наследует уже валидированный constraint,
    и INSERT 16 B в неё отклоняется.
* **Ограничения проверки:** real-HTTP regression P1-03 идёт в профиле `test` (dev-JWT), а
  не `keycloak`; дефект находится в repository-маппинге и от профиля аутентификации не
  зависит, но отдельного keycloak-прогона именно этого сценария в B3F2 нет. HTTP-тест
  покрывает 16 B, не 271 B (271 B покрыт тем же SQL-предикатом `< 272` и миграционным IT;
  отдельного HTTP-кейса нет — см. P2-12). Отдельного WS-клиента к legacy-строке нет; путь
  общий (`findForDevice`), null-обработка в `RealtimeChatHistoryAdapter` проверена
  статически (см. P2-12).

**Итог по P1:** `500` на legacy-конверт устранён и на interim-уровне (read-path), и на
постоянном (V19); `NOT VALID` больше не является вечным обещанием. Блокер in-place upgrade,
найденный в G4b, снят.

## P2

### P2-06-residual. `X-Device-Id` и `@PathVariable` не канонизируются и не задокументированы

* **Статус:** основная часть P2-06 (idempotency-identity) **закрыта**; residual — low.
* **Что закрыто:** `CanonicalUuidDeserializer` (`CanonicalUuidDeserializer.java:35-52`)
  принимает только 8-4-4-4-12 в любом регистре, нормализует в lower-case; применён к
  `client_message_id`, `sticker_id`, `reply_to_id`, `attachment_ids`
  (`MessageCreateRequest.java:18-24`). `SendMessageUseCase.requestHash` хэширует `UUID`-объект
  (`SendMessageUseCase.java:168-190`), поэтому upper-case и lower-case одного значения дают
  один hash и одно сообщение; `MessageApiIT.canonicalizesClientMessageIdCaseAndKeepsIdempotencyConsistent`
  (10/10 в классе) проверяет replay по обоим ключам, `1-1-1-1-1 → 400`, count=1.
* **Residual:** `RequestHeaders.requireUuid` (`RequestHeaders.java:19-30`, `Idempotency-Key`)
  и `KeycloakClaims.parseUuid` (`KeycloakClaims.java:29-38`, `X-Device-Id`) по-прежнему
  используют `UUID.fromString`; на JDK 21 `UUID.fromString("1-1-1-1-1")` **успешно** даёт
  `00000001-0001-0001-0001-000000000001` (проверено отдельно). `@PathVariable UUID chatId`
  (`MessageController.java:44,55`) идёт через тот же ленивый конвертер. Bypass'а нет:
  заголовок всё равно проверяется на owner/ACTIVE (`KeycloakDeviceBinding`/`DevDeviceBinding`),
  path — на членство/существование; но parser differential для аудита/логов остаётся, и
  review-07 условие №3 («либо канонизировать, либо явно записать в §4.7/контракте») для
  header/path **не выполнено** — B3F2 не менял спеку и не канонизировал их.
* **Риск:** низкий; не граница доступа. Для E7-F клиент отправляет канонические UUID, так что
  практического impact нет.
* **Рекомендация:** либо распространить `CanonicalUuidDeserializer`/strict-parse на
  header/path/`Idempotency-Key`, либо одной строкой в §4.7/контракте зафиксировать, что
  strict-канонизация относится только к envelope, а request-level UUID нормализуются
  (и что `1-1-1-1-1` в header/path — не гарантированный wire-формат).

### P2-07. `ChatKeysService` defense-in-depth — **закрыт**

* `ChatKeysService.java:220-231`: `requireCurrentDevice` делает
  `findById` → `status == ACTIVE` → `userId == principal.userId`, иначе `403`; вызывается в
  `getChatKeys` (`:84`) и `verifyDevice` (`:111`) **до** чтения verifications/ключей и до
  записи. `findById` идёт под tenant-контекстом (`requireE2eeChat` активирует workspace), а
  RLS `p_devices_self` (`V2__identity_and_workspace.sql:79-80`) и так скрывает чужое
  устройство; явный `userId.equals` — вторая линия.
* `ChatKeysServiceDeviceGuardTest` 5/5: active own → ok; foreign ACTIVE / revoked own /
  unknown → `403`; `verifyDevice` foreign → `403` до записи. Полный suite (включая
  `E2eeMessageIT`/`E2eeMessageRealtimeIT`) зелёный; HTTP-путь с чужим `X-Device-Id` и раньше
  давал `401` на фильтре.
* **Остаточное (не дефект B3F2):** в `keycloak`-профиле токен не привязан к конкретному
  устройству: `KeycloakDeviceBinding` принимает любой **активный** `X-Device-Id` этого
  пользователя. То есть украденный токен без ключей устройства может выступать от имени
  другого своего устройства (получать публичные ключи, писать verification). Это
  pre-existing свойство модели (E2EE защищает контент приватными ключами, а не токеном);
  B3F2 его не ухудшил, но для E7-F это стоит явно проговорить. В `dev`/`test`
  `DevDeviceBinding` жёстче (header = signed claim), а `ChatKeysService` теперь требует
  реальную ACTIVE-строку в `auth.devices` — dev-токен с незарегистрированным device получит
  `403` (намеренное поведение).

### P2-09 (новый, low). Replay сообщения, у которого **не осталось ни одного валидного конверта**, даёт `422`/`409`, не `201`

* **Файл/строка:** `SendMessageUseCase.java:71-73,102-111` — `parseEnvelopes` через
  `EnvelopeCodec.parse` выполняется **до** `submissionHandler.submit`, поэтому повтор тех же
  16/271 B байтов отсекается кодеком (`422 INVALID_ENVELOPE_FORMAT/ciphertext_too_short`)
  ещё до replay-ветки. Если же клиент пришлёт валидные 272+ B байты, то:
  `replayByClientMessageId` (`MessageSubmissionHandler.java:284-289`) сравнит
  `EnvelopeFingerprint.of(storedEnvelopes(...))` (после фильтра `octet_length` в
  `findByMessage`; все stored-конверты legacy → пустой список) с fingerprint присланных
  конвертов → несовпадение → `409 CLIENT_MESSAGE_ID_CONFLICT`; а replay по
  `Idempotency-Key` с другим телом → `409 IDEMPOTENCY_KEY_REUSED` (requestHash включает
  fingerprint конвертов).
* **Сценарий (по коду; отдельного end-to-end PoC на legacy-only нет):** сообщение было
  принято до B3F с единственным 16/271 B конвертом (или после V19 все его конверты ушли в
  quarantine); клиент повторяет **тот же** `client_message_id`/`Idempotency-Key` и те же
  байты. Ожидание из отчётной таблицы B3F2 — `201`; по коду — `422` (те же короткие байты)
  или `409` (валидные, но другие байты). Это **не 500** и не потеря данных (сообщение
  существует; GET отдаёт `crypto:null`), и review-07 прямо допускал явный `409/422` вместо
  `500`. Но отчётное «replay … 201» верно только для сообщения, у которого есть хотя бы один
  валидный конверт (именно такой сценарий и проверяет `E2eeLegacyEnvelopeIT`: у сообщения
  есть валидный B1-конверт, и повтор идёт с валидным 300 B телом).
* **Рекомендация:** либо явно принять/задокументировать `422/409` для legacy-only (как
  review-07 и предлагал), либо ввести отдельный код `LEGACY_ENVELOPE`/`ENVELOPE_QUARANTINED`
  и тест на legacy-only replay, чтобы клиент не трактовал это как конфликт контента.

### P2-10 (новый, low, документация). Спека/README не описывают V19 и фактическое поведение legacy-строк

* `docs/E2EE-SPEC.md:2597` до сих пор утверждает: «V18 поднял floor 16 → 272 для
  существующих установок; **старые строки остаются читаемыми**». После B3F2 это неверно:
  V19 переносит их в `message.message_envelopes_quarantine`, а read-path отдаёт
  `crypto:null`; «читаемыми» они не остаются. Спека также не упоминает V19/quarantine/
  tolerant read и не фиксирует для клиента, что `crypto:null` — легитимный ответ на
  legacy/quarantined envelope (контракт `crypto: null` это допускает,
  `contracts/openapi.yaml:1409-1413`).
* `backend/README.md` содержит разделы V16/V17 (`:702`, `:735`), но не V18/V19; V19 —
  тяжёлая `ACCESS EXCLUSIVE`-миграция, и её rollout-ограничения (maintenance window,
  forward-only, backup) сейчас живут только в отчёте B3F2, не в runbook/README.
* **Риск:** E7-F-клиент или оператор могут неверно понять, что делать с `crypto:null` и
  когда запускать V19. B3F2 по своей зоне (`backend/**`) спеку не менял — это ожидаемо, но
  для GO нужно синхронизировать документы (см. условия).

### P2-11 (новый, low, hardening). Quarantine: owner-only работает, но нет RLS и нет retention; `DELETE` не проверяет факт копирования

* `V19:23-40` создаёт `message.message_envelopes_quarantine` без `ENABLE ROW LEVEL SECURITY`
  и без `GRANT` для `krug_app`. **Проверено:** `krug_app` не имеет `SELECT`
  (`E2eeMigrationIT.java:429-433`), в миграциях нет `ALTER DEFAULT PRIVILEGES`/`GRANT ON ALL
  TABLES`, поэтому сейчас runtime-роль доступа не имеет. Это соответствует паттерну
  `auth.identity_key_quarantine` из V17.
* **Residual:** (а) если в деплое `DB_USER == FLYWAY_USER` (runtime = owner) или появится
  широкий `GRANT ... ON ALL TABLES IN SCHEMA message`, quarantine станет читаемой для
  runtime-роли — RLS на ней нет; (б) таблица хранит ciphertext/metadata бессрочно, политики
  retention нет; (в) `DELETE FROM message_envelopes WHERE ...` (`V19:59-61`) удаляет строки,
  не проверяя, что каждая реально попала в quarantine: в штатной схеме PK совпадает и
  `ON CONFLICT DO NOTHING` недостижим, но для строгой lossless-гарантии лучше
  `DELETE ... WHERE EXISTS (SELECT 1 FROM quarantine q WHERE q.message_id = ... AND ...)`
  либо `INSERT ... RETURNING` + удаление по возвращённым ключам.
* **Рекомендация:** определить retention/ACL quarantine (owner-only + RLS или явный
  read-only forensics-роль), проверить, что runtime-роль не совпадает с migration-ролью;
  усилить `DELETE` до «удаляем только скопированное».

### P2-12 (новый, low, тестовые пробелы)

Не дефекты кода, а дыры в доказательствах, которые стоит закрыть до/во время E7-F:

* **WS legacy replay:** отдельного WS-клиента к legacy-строке нет; `RealtimeChatHistoryAdapter`
  использует тот же `findForDevice`, а `snapshot` корректно обрабатывает `envelope == null`
  (`RealtimeChatHistoryAdapter.java:105-110`) — проверено статически, но не e2e.
* **271 B по HTTP:** `E2eeLegacyEnvelopeIT` вставляет 16 B; 271 B покрыт SQL-предикатом
  `< 272` и миграционным IT, но не отдельным HTTP-кейсом.
* **`toDomainOrNull`:** в полном прогоне лог «Skipping unreadable envelope» не встречается
  (`grep` = 0), то есть defense-in-depth-ветка (валидная длина + битый header/prekey) не
  исполняется ни одним тестом. Плюс она ловит только `IllegalArgumentException |
  IllegalStateException`; `NullPointerException`/`ClassCastException` из неожиданной формы
  строки теоретически всё ещё дадут 500 (колонки `NOT NULL`, типы стабильны — риск низкий).
* **Log-capture:** review-07 условие №7 (тест на отсутствие ciphertext/plaintext в логах)
  так и не добавлено; новый `log.warn` в `toDomainOrNull` логирует только ids/reason, но
  тест-сторож отсутствует.
* **Byte-level lossless quarantine:** тесты проверяют counts/длины/reason, а не полное
  побайтовое равенство скопированной строки (копирование `INSERT ... SELECT` по построению
  lossless, но assertion'а нет).
* **P2-06 HTTP:** новый тест `MessageApiIT` — MockMvc, не real HTTP; для канонизации это
  эквивалентно (Jackson-слой), но в G4c-стиле лучше иметь real-HTTP кейс.
* **Review-07 условие №1** (постоянные real-HTTP regression-тесты на `%63`/`%6D`/`%6d`,
  `%2563`, `;`, `..`, trailing slash, query, chunked, 524288/524289, 272/363/33040/33041)
  B3F2 не добавлял — эти P0/P1 закрыты ранее, но условие остаётся открытым.

## Проверки

Все команды — на текущем дереве, `JAVA_HOME=JDK 21`, Maven offline
(`-Dmaven.repo.local=.m2repo`). Git-репозитория нет; проверялось фактическое дерево.

```bash
# 1. Полный backend suite (unit + integration, включая новые тесты B3F2)
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 332, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# Архив surefire: files=78, tests=332, failures=0, errors=0, skipped=0
# ArchUnit: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
# E2eeLegacyEnvelopeIT: 1/1; E2eeMigrationIT: 7/7; ChatKeysServiceDeviceGuardTest: 5/5;
# MessageApiIT: 10/10.

# 2. Contract / generated types
cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.

# 3. Real HTTP P1-03 (в составе suite): Spring Boot RANDOM_PORT/Tomcat + PG16 Testcontainers,
#    профиль test, krug.e2ee.enabled=true. 16 B legacy для A2:
#    GET A2 -> 200 crypto:null; GET B1 -> 200 свой конверт + байты совпадают;
#    replay Idempotency-Key/client_message_id -> 201; после V19 -> те же 200; 500 = 0.

# 4. V19 на PG16 (в составе E2eeMigrationIT):
#    V15->V17->V18->V19: 16/271 -> quarantine legacy_short; 272 остаётся;
#    convalidated=t parent+partitions; relforcerowsecurity=t;
#    krug_app has_table_privilege(..., 'SELECT') = false;
#    non-superuser owner NOSUPERUSER NOBYPASSRLS: V18->V19 успешно.

# 5. Независимый PG16.16 SQL-эксперимент (рецензент, вне repo; БД/роль удалены):
#    parent+partitions ENABLE+FORCE+policy; owner via parent без app.ws -> 0;
#    ALTER TABLE parent NO FORCE -> owner видит 3 (partition FORCE остаётся true);
#    VALIDATE с 16 B в партиции -> "check constraint ... of relation env_2026_11 is violated";
#    после copy/delete/validate -> quarantine=2, live=1, convalidated=t parent+2 partitions,
#    FORCE=true; новая партиция наследует validated CHECK и отвергает 16 B.

# 6. Статически:
#    - KRUG_E2EE_ENABLED default=false (application.yml:129), не менялся;
#    - новых E2EE decrypt/plaintext/crypto-библиотек нет (MessageCipher — managed, pre-existing);
#    - новый log.warn в toDomainOrNull логирует только message_id/recipient_device_id/reason;
#    - contracts/openapi.yaml, docs/E2EE-SPEC.md, docs/E2EE-TEST-VECTORS.json B3F2 не менял:
#      mtime 10:13 / 10:24 / 16 Nov 17:31 — до старта B3F2 (10:24:30+); B3F2-файлы 10:44-10:51;
#    - в B3F2-окне изменения B3F2 — backend/src main+test, V19, frontend/src/api/schema.d.ts
#      (regen) и отчёты; docs/спека/контракты — нет (frontend/src/e2ee/__tmp__ — другая
#      сессия E7-F1, см. «Ограничения проверки»).
```

**Замечание по артефактам:** `backend/target/krug-backend-0.1.0-SNAPSHOT.jar` имеет mtime
10:28, то есть **старше** правок B3F2 (10:44-10:51). Это не влияет на `mvn test` (тесты
компилируют актуальные классы), но если кто-то деплоит этот jar, он получит код **до**
P1-03/P2-06/P2-07. Для E7-F собирать jar заново на финальном дереве.

**Ограничения проверки:**

* Нет Git/one-PR — нельзя подтвердить, что все правки B3F2 — один PR и нет скрытых
  изменений; проверялось фактическое дерево и поведение. Параллельно в workspace есть
  `frontend/src/e2ee/__tmp__/smoke*.test.ts` (mtime 10:57) — это след другой сессии
  (E7-F1), не B3F2; атрибуция по mtime/содержимому, не по diff.
* P1-03 real HTTP — профиль `test` (dev-JWT), не `keycloak`; keycloak-прогон этого
  сценария не повторялся. Дефект — в repository-маппинге, профиль-независим.
* G2 (браузерные KAT) и внешний G4 crypto-review этим ревью не заменяются.
* Отдельного rate-limit probe-прогона в G4c нет; full suite (включая rate-limit IT) зелёный.

## Условия GO для E7-F

1. **P1-03/V19 — на целевой БД перед включением флага:** выполнить V19 в maintenance-window
   с backup (ACCESS EXCLUSIVE + полный `VALIDATE` на `message.message_envelopes`), затем
   проверить `pg_constraint.convalidated = t` для `ck_envelopes_ciphertext_min` на parent и
   всех партициях, `relforcerowsecurity = t`, quarantine содержит ровно удалённые строки,
   live — только `272..33040`. Прогнать `E2eeLegacyEnvelopeIT` и `E2eeMigrationIT` на
   release-candidate. V19 forward-only; откат — restore.
2. **P2-06-residual:** либо канонизировать `X-Device-Id`/`@PathVariable`/`Idempotency-Key`
   (strict 8-4-4-4-12 + lower-case), либо зафиксировать в §4.7/контракте, что strict
   относится только к envelope, а request-level UUID нормализуются; добавить тест на
   lenient header/path (`1-1-1-1-1`, upper-case).
3. **Синхронизация документов:** исправить `docs/E2EE-SPEC.md:2597` (убрать «старые строки
   остаются читаемыми»), описать V19/quarantine/tolerant read и `crypto:null` для
   legacy/quarantined envelope; добавить V19 в `backend/README.md`/runbook (maintenance
   window, forward-only, backup, retention quarantine). B3F2 по зоне спеку не менял — это
   задача PM/security до flag-on.
4. **P2-09:** принять и задокументировать `422/409` для legacy-only replay (тот же
   короткий body → `422`; валидный, но другой body → `409`) либо ввести явный код
   (`LEGACY_ENVELOPE`/`ENVELOPE_QUARANTINED`) и тест; не оставлять отчётное «replay → 201»
   без оговорки «при наличии хотя бы одного валидного конверта».
5. **Quarantine hardening:** определить retention и ACL (owner-only + RLS либо отдельная
   forensics-роль); убедиться, что runtime-роль (`DB_USER`) не равна migration-роли
   (`FLYWAY_USER`); усилить `DELETE` в V19 до «удаляем только реально скопированное».
6. **Тестовые пробелы:** WS legacy replay e2e; 271 B через HTTP; `toDomainOrNull` (битый
   header/prekey при валидной длине); log-capture на отсутствие ciphertext/plaintext
   (review-07 №7); byte-level lossless quarantine.
7. **Review-07 условие №1:** постоянные real-HTTP regression-тесты на encoded paths,
   chunked, границы 524288/524289 и 272/363/33040/33041 — всё ещё открыто; добавить до
   flag-on.
8. **Внешние предусловия:** G2 (браузерные KAT), G4 (внешний crypto-review), git/one-PR или
   patch-bundle. `KRUG_E2EE_ENABLED` остаётся `false` по умолчанию до выполнения 1-7.

## Остаточные риски

* **Внешние G2/G4** — не заменяются backend-ревью; flag-on без них не начинать.
* **Нет Git/one-PR** — происхождение и полнота правок не проверяемы; в workspace параллельно
  работают другие сессии (`frontend/src/e2ee/__tmp__/smoke*.test.ts`), поэтому «одним PR»
  и «нет скрытых правок» подтвердить нельзя.
* **V19 rollout:** `ACCESS EXCLUSIVE` + полный scan/`VALIDATE`; на большой таблице — окно
  блокировки чтения/записи, нужен maintenance-window и backup; forward-only.
* **Rolling deploy:** старые (strict) инстансы могут отдавать `500` на legacy-строках, пока
  V19 не завершён; новый tolerant-код безопасен и до V19. Деплой V19 вместе с новым кодом,
  старые инстансы — не держать дольше окна миграции.
* **Quarantine:** нет RLS и retention; owner-only сейчас достаточен, но при
  `DB_USER == FLYWAY_USER` или будущем широком `GRANT` ciphertext/metadata станут читаемы
  runtime-ролью; `DELETE` не проверяет факт копирования (теоретический lossless-edge).
* **P2-09:** legacy-only replay не даёт `201`: тот же короткий body → `422` (codec до
  replay), валидный, но другой body → `409` (`CLIENT_MESSAGE_ID_CONFLICT`/
  `IDEMPOTENCY_KEY_REUSED`); не `500`, не потеря данных, но семантика/отчётная таблица
  требует оговорки.
* **P2-06 residual:** `X-Device-Id`/`@PathVariable`/`Idempotency-Key` принимают
  `UUID.fromString`-lenient формы (`1-1-1-1-1`), ownership-check не даёт bypass'а, но
  audit/log-форма неканоническая и не задокументирована.
* **Спека/README stale:** `docs/E2EE-SPEC.md:2597` и отсутствие V19 в README/runbook.
* **WS legacy replay** не проверен e2e (общий `findForDevice`/null-обработка — статически).
* **271 B** не проверен отдельным HTTP-кейсом (SQL-предикат `< 272` и миграционный IT есть).
* **`toDomainOrNull`:** не покрыт тестом; ловит только `IllegalArgumentException |
  IllegalStateException`; NPE/ClassCast на экзотической форме строки теоретически → 500.
* **Log-capture** на ciphertext/plaintext отсутствует; `SqlExceptionHelper`/`DETAIL` и
  stack traces в `GlobalExceptionHandler` — pre-existing residual review-07.
* **Pre-existing, не входившие в B3F2:** `%2563`/proxy double-decode; flag-off WS cursor
  (`server_last_seq` включает скрытые E2EE); `client_message_id` per-partition uniqueness
  (переход месяца); prekey retention (B4-долг); envelope retention; dev/test
  `DevDeviceBinding`; Keycloak-токен не привязан к конкретному device (любой ACTIVE device
  пользователя); rate-limit regression не перепроверялся.
* **P1-03 real HTTP в `test`-профиле**, не `keycloak`; для G4c-финала желателен один
  keycloak-прогон того же сценария.
* **Тестовая изоляция:** `E2eeLegacyEnvelopeIT` временно снимает/возвращает V18-CHECK на
  общей БД; suite последовательный (Surefire parallel не настроен) и зелёный, но при
  параллельном запуске классов это может флакать.

## Вопросы

1. **P2-06-residual:** канонизировать header/path/`Idempotency-Key` или официально
   зафиксировать в §4.7/контракте, что strict — только для envelope, а request-level UUID
   нормализуются? Второй вариант дешевле и не ломает клиентов.
2. **P2-09:** согласен ли PM, что legacy-only replay — `422` (те же короткие байты) или
   `409` (валидные, но другие байты), а не `201`? Нужен ли отдельный код
   `LEGACY_ENVELOPE`/`ENVELOPE_QUARANTINED`, чтобы клиент не трактовал это как конфликт
   контента?
3. **V19 rollout:** входит ли in-place upgrade БД с legacy-конвертами в план E7-F? Если да —
   когда maintenance-window/backup и кто проверяет `convalidated=t`/`FORCE=t` на целевой БД?
4. **Quarantine:** какой retention и ACL? Owner-only достаточно, или нужна RLS/отдельная
   forensics-роль? Кто гарантирует `DB_USER != FLYWAY_USER` в prod?
5. **Тестовые пробелы:** добавляем WS legacy e2e, 271 B HTTP, `toDomainOrNull` и
   log-capture до flag-on или принимаем как известные ограничения с записью в TASKS?
6. **Review-07 условие №1:** когда появятся постоянные real-HTTP regression-тесты на
   encoded paths/chunked/floor? Они не входили в B3F2, но остаются условием GO.
7. **G2/G4/git:** когда браузерные KAT, внешний crypto-review и one-PR/patch-bundle?
8. **Синхронизация спеки/README:** кто и когда обновит §6.5/README под V19 и `crypto:null`?
   Без этого E7-F-клиент может неверно обработать legacy-сообщение.

---

**Статус G4c: DONE.** P1-03 закрыт (tolerant read-path + V19, real HTTP/PG16 + миграционные
IT + независимый PG16-эксперимент); P2-07 закрыт; P2-06 закрыт для idempotency-identity с
низким residual по header/path. Полный suite **332/0**, ArchUnit **10/10**, contract
**33/58**. Новых P0/P1 нет. Итоговый вердикт: **GO WITH CONDITIONS** для E7-F/флага;
условия — внешние G2/G4/git, синхронизация спеки/README, P2-06-residual, rollout/retention
V19 и тестовые пробелы. Код/контракты/спека/векторы/`docs/TASKS*` не изменялись; создан
только этот файл.

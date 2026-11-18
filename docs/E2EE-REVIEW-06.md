# E2EE-REVIEW-06 — G4 security review E2EE backend после B3/B4

> **Рецензент:** независимый security/pentest-ревьюер. Автор B3/B4 в подготовке этого документа не участвовал.
> **Дата:** 2026-11-17. **Вход:** `backend/E7-B3-B4-REPORT.md`, `docs/E2EE-SPEC.md` (§4, §4.8, §5, §6.3.1, §6.5),
> `docs/E2EE-REVIEW-04.md`, `backend/E7-B1-FIX-REPORT.md`, `contracts/openapi.yaml`, `contracts/ws-protocol.md`,
> код `message/**`, `realtime/**`, `chat/**`, `EnvelopeCodec`/`E2eeEnvelopeValidator`, тесты `E2eeMessage*`.
> **Зона:** создан только этот файл; код, контракты, спека, векторы и `docs/TASKS*` не изменялись.
> Временные harness'ы (codec/validator/contract probes, path/firewall probes, integration-проба) лежат **вне репозитория**
> (`/tmp/e2ee-g4`); в дерево репозитория они не добавлены. Git-репозитория в workspace нет, поэтому аудит по diff
> невозможен; проверялось фактическое состояние дерева и поведение.
>
> **Важно о состоянии дерева.** В рабочем дереве уже есть V17 и B1F-фиксы (`P1-02`, `P1-03`, `P2-01`, `P2-03`, `P2-09`
> review-04, `E2eeLimitsIT`/`E2eeRealtimeIT`/`E2eeClaimRateLimitIT`/`E2eeFlagOnIT`/`E2eeQueryPlanIT`). То есть это не
> «чистый B3/B4»: дерево опережает отчёт B3/B4 на B1F-слой. Ревью проверяет фактический код, а не только отчёт.

## Вердикт (GO / GO WITH CONDITIONS / NO-GO)

**NO-GO для включения `KRUG_E2EE_ENABLED` и для приёмки B3/B4 как базы E7-F.**

Найден **P0-01**: обход привязки `X-Device-Id` через percent-encoded путь (`/api/v1/%63hats/.../%6Dessages`)
позволяет участнику E2EE-чата получить `crypto`-конверт **чужого устройства** (включая устройство собеседника) через
`GET /chats/{id}/messages`. Это прямое нарушение §4.3/§5.2 («сервер не отдаёт конверты других устройств») и
авторизационной границы per-device; plaintext при этом не раскрывается (конверт E2EE), но раскрываются ciphertext,
`session_id`, `header`, `prekey` и факт адресации. Эксплуатация при flag-on тривиальна и воспроизведена (см. P0-01).

Текущий **flag-off** срез может оставаться развёрнутым: P0-01 при `krug.e2ee.enabled=false` недостижим, потому что
E2EE-чат не создаётся, а `GET` отвечает `409 E2EE_DISABLED` до выдачи `crypto`. Но и в flag-off есть **P1-01**
(обход 512 KiB на managed-сообщениях через encoded path), поэтому даже flag-off требует фикса P1-01.

После закрытия **P0-01, P1-01, P1-02** и **P2-01/P2-02/P2-03** (с тестами) вердикт может быть изменён на
**GO WITH CONDITIONS** для flag-on/E7-F.

## P0

### P0-01. Percent-encoded путь обходит `DeviceBindingFilter`; `GET /chats/{id}/messages` отдаёт конверт чужого устройства

* **Файл/строка:**
  * `backend/src/main/java/ru/krug/backend/shared/infrastructure/security/DeviceBindingFilter.java:99-112` —
    `requiresDevice()` матчит **сырой** `request.getRequestURI()` через `startsWith("/api/v1/chats/")`;
  * `.../security/KeycloakDeviceBinding.java:33-49` — при `deviceRequired=false` заголовок `X-Device-Id` **не проверяется**
    на принадлежность пользователю; возвращается `new AuthenticatedActor(user.userId(), headerDevice)`;
  * `.../security/DevDeviceBinding.java:20-31` — то же для dev/test: при `deviceRequired=false` берётся любой header;
  * `backend/src/main/java/ru/krug/backend/shared/api/PrincipalArgumentResolver.java:49` — `principal.deviceId` без
    дополнительной проверки;
  * `backend/src/main/java/ru/krug/backend/message/application/usecase/MessageQueryHandler.java:94-105,171-182` —
    `withCrypto()` передаёт `principal.deviceId()` в `envelopeRepository.findForDevice(...)` без проверки владельца/статуса;
  * `backend/src/main/java/ru/krug/backend/message/infrastructure/persistence/MessageEnvelopeRepositoryAdapter.java:76-108` —
    `findForDevice` фильтрует только `workspace_id`, `recipient_device_id` и `message_id IN (...)`;
  * `backend/src/main/resources/db/migration/V16__e2ee_device_keys.sql:453-457` — RLS `message.message_envelopes` только
    tenant-wide (`workspace_id = current_workspace_id()`), без привязки к вызывающему устройству.
* **Сценарий (воспроизведён):** Alice и Bob — участники E2EE DIRECT-чата; Alice знает `device_id` Bob'а из
  `GET /chats/{id}/keys` (контракт §6.2.6 отдаёт устройства участников; альтернативно — из
  `envelope_coverage.uncovered_device_ids` при частичном покрытии). Запрос:

  ```
  GET /api/v1/%63hats/{chatId}/%6Dessages
  Authorization: Bearer <Alice, device=A1>
  X-Device-Id: <B1>
  ```

  `DeviceBindingFilter.requiresDevice()` видит raw-path `/api/v1/%63hats/...` → `false`; `KeycloakDeviceBinding`/`DevDeviceBinding`
  не проверяют `X-Device-Id`; `Principal.deviceId = B1`; `MessageQueryHandler.withCrypto` вызывает `findForDevice(..., B1)`;
  RLS `message_envelopes` пропускает workspace; ответ `200` с `items[0].crypto.recipient_device_id = B1`.
  Контроль на каноническом пути с тем же `X-Device-Id: B1` даёт `401`, то есть разница именно в encoded path.

  Фактический вывод временной integration-пробы (MockMvc, `setRequestURI`, реальный Spring context + PG16):

  ```
  CONTROL canonical/own -> null
  CONTROL canonical/peer header -> HTTP 401
  PROBE encoded/peer header -> HTTP 200
  LEAK recipient=c742ed0e-... expected b1=c742ed0e-...
  ```

  Совместимость проверена отдельно: `PathPatternParser` матчит `/api/v1/%63hats/.../%6Dessages`; `StrictHttpFirewall`
  `%63`/`%6D` **пропускает** (`;` — блокирует, `%` — нет). Встроенный Tomcat 10.1.40 (реальный коннектор, не MockMvc)
  подтвердил расщепление: `getRequestURI() = /api/v1/%63hats/abc/%6Dessages`, а `getPathInfo() =
  /api/v1/chats/abc/messages`; то есть фильтры, матчащие `getRequestURI()`, видят encoded-форму, а MVC — декодированную.
* **Риск:** (а) нарушение §4.3/§5.2: сервер отдаёт не только «свой» конверт, но и конверт другого устройства, включая
  устройство собеседника и **другие устройства того же пользователя**; (б) утечка метаданных (`session_id`, `header`,
  `prekey`, `recipient_device_id`) и ciphertext; (в) это авторизационный bypass `X-Device-Id`, а не только ошибка чтения:
  тот же обход затрагивает другие потребители `X-Device-Id` (`GET /chats/{id}/keys` — `verified`/`my_device_id`,
  `PUT .../verification` — verifier device, `markRead` и т.п.); (г) в связке с компрометацией ключей другого устройства
  (backup/украденный keychain) это даёт расшифровку сообщений, адресованных этому устройству, без его участия.
  Plaintext сам по себе не раскрывается, но граница per-device и заявленная приватность метаданных сломаны.
* **Исправление:**
  1. В `DeviceBindingFilter` не матчить сырой URI: использовать нормализованный/декодированный путь (`PathPattern`,
     `UrlPathHelper`, `ServletRequestPathUtils`) **или** отклонять запросы с `%` в API-путях (все id — UUID, легитимного
     percent-encoding в этих путях нет). Дополнительно: если заголовок `X-Device-Id` присутствует, валидировать его
     принадлежность **всегда**, независимо от `deviceRequired`; при `deviceRequired=false` и непроверенном заголовке
     возвращать `deviceId=null`, а не произвольный UUID.
  2. Defense-in-depth в B4: `MessageQueryHandler.withCrypto` (и `RealtimeChatHistoryAdapter`) обязаны проверить
     `deviceId` через порт (`findDevice` + `active` + `userId == principal.userId()`) **до** выдачи `crypto`; иначе
     `crypto:null` или `401/403`. Это закрывает утечку даже при будущем обходе фильтра.
  3. Провести аудит всех потребителей `principal.deviceId` (`ChatKeysService`, `DeviceKeyController`, `markRead`,
     `PrekeyUploadService`, `DeviceRevocationService`) на независимую проверку владельца.
* **Тест:** добавить в `E2eeMessageIT`:
  * `GET /api/v1/%63hats/{chatId}/%6Dessages` + `X-Device-Id: B1` от Alice → `401` (или `crypto:null`, но **не** конверт B1);
  * тот же encoded path + `X-Device-Id: A2` (своё второе устройство) → `crypto:null`/401;
  * канонический путь + `X-Device-Id: B1` → `401` (уже воспроизводится);
  * `GET /chats/{id}/keys` и `PUT .../verification` на encoded path с чужим device → отказ;
  * real-socket тест (не только MockMvc), потому что баг зависит от raw-URI Tomcat.

## P1

### P1-01. Лимит тела 512 KiB обходится percent-encoded путём; тело >512 KiB принимается и создаёт сообщение

* **Файл/строка:** `backend/src/main/java/ru/krug/backend/shared/infrastructure/web/PayloadLimitFilter.java:33,43-45` —
  `MESSAGE_SEND = ^/api/v1/chats/[^/]+/messages$` и `matches(request.getRequestURI())`; `DeviceBindingFilter.java:99-112` —
  та же сырая матчилка (общий корень с P0-01).
* **Сценарий (воспроизведён):** `POST /api/v1/chats/{chatId}/%6Dessages` с телом >512 KiB (валидный JSON, `envelopes[]`
  + большой `pad`-объект) и обычным `X-Device-Id: A1`: `PayloadLimitFilter.shouldNotFilter()` возвращает `true`
  (regex не матчит `%6Dessages`), тело читается и парсится Jackson без границы; `MessageCreateRequest` игнорирует `pad`;
  сообщение создаётся (`201`). На каноническом пути тот же body даёт `413 PAYLOAD_TOO_LARGE`.
  Временная проба: `HUGE canonical -> HTTP 413`, `HUGE encoded -> HTTP 201`, `message count after huge = 2`.
* **Риск:** (а) документированный лимит §4.5 (`524288 B wire, до парсинга`) не исполняется; (б) аутентифицированный
  пользователь может прислать тело произвольного размера на `/messages` и вызвать memory/CPU-DoS (Jackson парсит всё
  дерево, `EnvelopeCodec` отвергает >10 конвертов уже **после** парсинга); (в) контрактное поведение `413` недостижимо
  на этом варианте пути; (г) обход не зависит от E2EE-флага (работает и для managed-сообщений), то есть актуален уже
  в текущем flag-off деплое.
* **Исправление:** применять лимит по **нормализованному** пути или по префиксу (`POST` + path starts with
  `/api/v1/chats/` + suffix `/messages` после декодирования), а не по точному raw-regex; лучше — отдельный
  `HandlerInterceptor`/обёртка до `@RequestBody`, либо отказ от `%`-encoded API-путей на уровне firewall. Полезно
  также настроить верхний предел размера запроса на коннекторе (defense-in-depth) и не полагаться на `Content-Length`.
* **Тест:** `POST /api/v1/chats/{id}/messages` (канон) + 600 KiB → `413 PAYLOAD_TOO_LARGE`; encoded
  `/api/v1/chats/{id}/%6Dessages` + 600 KiB → `413`; `%63hats/...` + 600 KiB → `413`; ни одного сообщения/`seq` не создано;
  реальный HTTP-сокет.

### P1-02. `CryptoEnvelope.ciphertext.minLength: 363` vs серверный floor 16 B: сервер отдаёт schema-invalid ответ

* **Файл/строка:**
  * `contracts/openapi.yaml:1575-1579` — `ciphertext.minLength: 363`, `maxLength: 44054`;
  * `docs/E2EE-SPEC.md:744` — «decoded 16..33040 B = 363..44054 символа» (арифметически неверно: 16 B ↔ 22 b64u-символа;
    363 ↔ 272 B);
  * `backend/src/main/java/ru/krug/backend/message/application/service/EnvelopeCodec.java:105-120` — принимает
    `decoded.length >= 16`, `encoded <= 44054`;
  * `.../EnvelopeLimits.java:16-21`, `.../domain/model/CryptoEnvelope.java:24-25` — floor 16 B;
  * `V16__e2ee_device_keys.sql:437` — DB CHECK `ciphertext BETWEEN 16 AND 33040`;
  * тесты `E2eeMessageIT.java:305-311` (15 B → 422; **16 B не тестируется**), `:420` (используется 300 B = 400 символов,
    поэтому `CONTRACT.assertValid("CryptoEnvelope", ...)` проходит).
* **Сценарий (воспроизведён на unit/contract-уровне):** Alice отправляет конверт с `ciphertext` 16 B (22 b64u-символа);
  `EnvelopeCodec.parse` принимает, `E2eeEnvelopeValidator` принимает, БД принимает, `201`; Bob в `GET`/WS получает
  `crypto.ciphertext` из 22 символов. Прогон `OpenApiContract.assertValid("CryptoEnvelope", ...)` на таком ответе даёт
  `$.ciphertext: длина должна быть не менее 363 символов`, то есть **сервер производит ответ, не проходящий собственный
  контракт**. Sweep codec: `15 -> INVALID`, `16 -> OK (22 chars)`, `271 -> OK (362)`, `272 -> OK (363)`,
  `33041 -> ENVELOPE_TOO_LARGE/canonical`.
* **Риск:** контрактно-поведенческое расхождение на security-чувствительном wire; клиент, который валидирует ответ по
  `CryptoEnvelope` (а D-S4-04 уже требует от клиента отвергать E2EE-ответ без `envelope_coverage`), может отвергнуть
  всю страницу/кадр (`INVALID_RESPONSE`) из-за одного «короткого» конверта, присланного отправителем — client-side DoS
  на историю/канал получателя. Также это подрывает заявленную каноничность v1 (272 B padded) и затрудняет приёмку E7-F.
  Замечание к отчёту B3/B4: риск №1 сформулирован как «эхо-конверт отправителю»; фактически POST-ответ отправителю
  содержит `crypto:null`, а короткий конверт получатель видит через `GET`/WS — это не отменяет finding, но уточняет
  сценарий.
* **Исправление (выбрать одно, PM/security):**
  * **(A) канонический floor 272 B/363 chars:** в `EnvelopeCodec`/`EnvelopeLimits`/`CryptoEnvelope`/DB CHECK поднять
    минимум до 272 B (363 chars), ошибка — `422 INVALID_ENVELOPE_FORMAT` (не 413; 413 — верхняя граница), синхронизировать
    §4.1/§4.5/§4.7 и контракт (уже 363) и добавить тест 271/272;
  * **(B) принимать 16 B:** изменить контракт `minLength` на 22 и исправить арифметику §4.1 (`16..33040 B = 22..44054
    символа`), оставить DB/сервер как есть; клиент обязан принимать короткие конверты и не валить страницу, а помечать
    сообщение undecryptable.
  Рекомендуется **(A)**, если «канонический padded v1» — нормативное требование; тогда 363 в контракте становится
  действительно нижней границей, а не «случайным» ограничением.
* **Тест:** `ciphertext` 271 B → ожидаемый код (422 при A; 201 при B), 272 B → 201; `GET` с коротким конвертом (при B)
  Contract-valid; при A — `422` и сообщение не создано; `E2eeMessageIT` должен вызывать
  `CONTRACT.assertValid("CryptoEnvelope", ...)` на **минимальном** принятом конверте, а не только на 300 B.

## P2

### P2-01. Идемпотентный replay может вернуть `envelope_coverage.peer_devices = 0`, нарушая `minimum: 1`

* **Файл/строка:** `contracts/openapi.yaml:1766-1772` (`peer_devices: minimum: 1`); `E2eeEnvelopeValidator.java:222-264`
  (`replayCoverage` считает по **текущим** устройствам); `MessageSubmissionHandler.java:315-329` (`replay` по
  `Idempotency-Key`); `MessageSubmissionHandler.java:283-301` (`replayByClientMessageId`); `SendMessageUseCase.java:244-261`.
* **Сценарий (unit-проба воспроизведена):** A отправляет B сообщение (B1 — единственное capable-устройство B), затем B
  отзывает B1. Повтор с тем же `Idempotency-Key` (или тем же `client_message_id` + байтами) даёт `201` с
  `peer_devices=0, peer_covered=0, self_devices=1, warning=null`. `OpenApiContract.assertValid("EnvelopeCoverage", ...)`
  отвергает: `$.peer_devices: минимальное значение должно быть 1`. При этом новый send в этом состоянии дал бы
  `409 E2EE_NO_ACTIVE_DEVICES` — то есть replay «успешен», хотя доставки сейчас нет.
* **Риск:** сервер производит schema-invalid 201 (D-S4-04/клиент может отвергнуть replay); идемпотентный retry после
  revoke peer-устройства ломается; coverage на replay не отражает ни момент отправки, ни текущую возможность доставки.
* **Исправление:** хранить `envelope_coverage` на момент отправки (новая колонка/таблица; потребует миграции, которой
  §6.5 сейчас не предусматривает) и возвращать snapshot на replay; либо явно изменить контракт (`peer_devices >= 0` +
  описание «replay отражает текущее состояние»), но тогда клиент не должен трактовать 0 как ошибку. «Клампить» до 1
  нельзя — это ложь. Решение PM зафиксировать в §4.2/§6.5.
* **Тест:** send → revoke peer device → replay по `Idempotency-Key` и по `client_message_id`; `CONTRACT.assertValid`
  `MessageCreateResult`/`EnvelopeCoverage`; ожидаемое поведение — snapshot или документированный 0, но не schema-invalid.

### P2-02. Race-replay по `client_message_id` возвращает E2EE `201` без `envelope_coverage` (D-S4-04)

* **Файл/строка:** `SendMessageUseCase.java:85-103` — catch `RuntimeException` → `lookupExistingQuietly` → `sameContent`
  → `new SendMessageResult(201, existing, true, replayCoverage(...))`; `SendMessageUseCase.java:244-261` —
  `replayCoverage` ловит любой `RuntimeException` и возвращает `null`; `MessageChatContextAdapter.java` (adapter не
  активирует tenant); `V1__schemas_roles_and_helpers.sql:40-42` (`current_workspace_id()` = NULL при незаданном GUC);
  `MessageQueryHandler.java:94-105` (обычный путь активирует tenant, catch-путь — нет).
* **Сценарий:** два конкурентных POST с одним `client_message_id`, но разными `Idempotency-Key`: оба проходят pre-check,
  один падает на unique-индексе при commit; `SendMessageUseCase` ловит `RuntimeException`, находит существующее
  сообщение, сравнивает fingerprint и пытается пересчитать coverage. Но `submit` уже завершил транзакцию (rollback), а
  `chatContext.require` в `replayCoverage` выполняется вне транзакции/без `app.workspace_id`; `chat.chats` RLS не видит
  строку → `DomainException` → catch → `null` → `MessageResponse.envelopeCoverage` отсутствует. Даже если конкретная
  реализация пула «замаскирует» отсутствие GUC, контракт метода всё равно не гарантирует coverage: любой сбой в
  `replayCoverage` молча превращается в schema-invalid E2EE 201.
* **Риск:** нарушение D-S4-04 («backend всегда отдаёт `envelope_coverage` для E2EE; клиент отвергает ответ без него»);
  редкий, но реальный race превращает успешный replay в `INVALID_RESPONSE` у клиента; retry-петля.
* **Исправление:** пересчёт coverage делать в отдельном `@Transactional(readOnly=true)` сервисе с `tenantContext.activate`,
  либо перенести логику в `MessageSubmissionHandler`/`MessageQueryHandler`, где tenant-контракт явный; не глотать
  `RuntimeException` — при невозможности пересчитать coverage отвечать `5xx`/`409`, но **не** 201 без coverage; лучше —
  хранить coverage snapshot (см. P2-01). `MessageApiMapper` можно сделать fail-closed: E2EE + `coverage == null` →
  исключение, а не omission.
* **Тест:** конкурентные POST с одним `client_message_id` (ExecutorService) → оба ответа `201` и оба с
  `envelope_coverage` (или один `409`, но не 201 без coverage); `CONTRACT.assertValid("MessageCreateResult", ...)`.

### P2-03. Flag off не гейтит replay-пути: WS replay отдаёт E2EE `crypto`, `Idempotency-Key` replay отдаёт E2EE `201`

* **Файл/строка:** `MessageSubmissionHandler.java:123-141` — `idempotency.reserve`/`replay` **до** проверки
  `E2EE_DISABLED`; `RealtimeChatHistoryAdapter.java:55-72` — `after()` не знает про `E2eeSettingsPort` и всегда грузит
  envelopes через `findForDevice`; `SubscriptionService.java:92-118` — replay не проверяет флаг; для контраста
  `MessageQueryHandler.java:87-92` (REST GET) флаг проверяет.
* **Сценарий:** E2EE-сообщение отправлено при флаге on; оператор выключает `krug.e2ee.enabled`; клиент переподключает WS
  и `subscribe` с `last_seq=0` → `message.created` приходит с `payload.crypto` (конверт этого устройства), хотя
  `GET /chats/{id}/messages` отвечает `409 E2EE_DISABLED`. Аналогично POST с сохранённым `Idempotency-Key` возвращает
  `201` E2EE-сообщение (+coverage), минуя флаг-гейт.
* **Риск:** kill-switch непоследователен: E2EE-контент продолжает доставляться по WS, хотя REST-чтение запрещено;
  клиент/оператор считает, что E2EE выключен, а конверты идут. Утечки чужому устройству нет (сессия валидна), но
  политика «флаг off ⇒ E2EE read 409» нарушена; при инцидентном выключении флага это нежелательное поведение.
* **Исправление:** проверять `e2eeSettings.enabled()` до replay в `submit` (или явно задокументировать исключение для
  идемпотентного replay); в `RealtimeChatHistoryAdapter` инжектировать `E2eeSettingsPort` и для E2EE при флаге off
  отдавать `crypto:null`/не отдавать E2EE-сообщения; в `SubscriptionService` — отклонять/помечать E2EE-чат при flag off
  (по аналогии с REST). Решение о semantics kill-switch — PM.
* **Тест:** flag on → send E2EE → flag off → WS reconnect+subscribe: `crypto:null` или событие не приходит; POST с тем же
  `Idempotency-Key` → `409 E2EE_DISABLED`; REST GET → 409; нет новых конвертов.

### P2-04. Строгая канонизация wire неполна: UUID принимается в неканонической форме; duplicate JSON keys — last-wins

* **Файл/строка:** `EnvelopeCodec.java:170-177` (`UUID.fromString` — ленивый: принимает короткие группы и upper-case);
  `MessageCreateRequest.java`/Jackson (глобальный `ObjectMapper` без `STRICT_DUPLICATE_DETECTION`).
* **Сценарий (воспроизведено):**
  * `recipient_device_id: "1-1-1-1-1"` → `UUID.fromString` даёт `00000001-0001-0001-0001-000000000001`, codec принимает
    (`OK size=1`); upper-case UUID тоже принимается. Контракт `format: uuid` и «canonical»-дух §4.7 этого не обещают.
  * `{"v":1,"v":1}` / `{"ciphertext":"A","ciphertext":"B"}` → Jackson оставляет последнее значение; `additionalProperties`
    это не ловит; сервер валидирует/хранит последнее, а внешний аудит/WAF, читающий первое, увидит другое.
* **Риск:** parser differential между сервером и любым вторым парсером (прокси, аудит, будущий клиентский валидатор);
  неканонические UUID могут давать разные строковые представления в fingerprint/логах; практически — низкий, но это ровно
  тот класс «контрабанды формы», от которого §4.7 защищается `additionalProperties:false`.
* **Исправление:** после `UUID.fromString` требовать `uuid.toString().equals(value)` (lower-case, ровно 36 символов,
  группа 8-4-4-4-12); включить `JsonParser.Feature.STRICT_DUPLICATE_DETECTION` (или strict `ObjectMapper`) для
  `/messages`; тесты на `1-1-1-1-1`, upper-case, duplicate `ciphertext`/`recipient_device_id`.
* **Тест:** перечисленные payload'ы → `422 INVALID_ENVELOPE_FORMAT`/`400`; канонические UUID/поля → 201.

### P2-05. Расхождение предиката `e2ee_capable`: домен не проверяет `fingerprint`, SQL/V17 — проверяет

* **Файл/строка:** `auth/domain/model/Device.java:271-277` — `isE2eeCapable()` = ACTIVE + alg + sig + dh + binding,
  **без** `fingerprint`; `auth/infrastructure/persistence/DeviceRepositoryAdapter.java:176-194` (`findActiveByUserIds`)
  требует `fingerprint IS NOT NULL`; `V17__e2ee_identity_hardening.sql:14-25` — SQL-функция с `fingerprint` и комментарий
  «domain mirror is Device.isE2eeCapable() — keep them in sync»; `MessageDeviceDirectoryAdapter.java:40-46` строит
  `MessageDeviceView.e2eeCapable` из домена.
* **Сценарий:** строка с `identity_signing_key/dh/binding`, но `fingerprint = NULL` (теоретически возможна при будущей
  миграции/ручном ремонте; V17 CHECK сейчас её блокирует) считается capable в домене (sender проходит validator), но
  исключается из `activeE2eeDevices`/claim/`GET keys`; `self_devices`/coverage расходятся, `GET keys` может упасть на
  `Base64Url.encode(null)`. Сейчас DB CHECK делает строку недостижимой, поэтому это latent/defense-in-depth.
* **Риск:** «единственный проводной критерий» снова расходится (review-04 P2-02), V17-комментарий вводит в заблуждение;
  при ослаблении CHECK/новой миграции coverage/claim/keys разъедутся.
* **Исправление:** добавить `fingerprint != null` (и точную длину) в `Device.isE2eeCapable()` **или** использовать одну
  SQL-функцию/`GENERATED`-колонку везде (включая `findActiveByUserIds` и домен через reconstitute-инвариант); поправить
  комментарий V17.
* **Тест:** property-тест «`Device.isE2eeCapable` == `auth.device_is_e2ee_capable(...)` на всех комбинациях полей»;
  строка с null fingerprint → не capable и не ломает `GET keys`/coverage.

## Проверки (команды/результаты)

Все команды — в текущем дереве, `JAVA_HOME=JDK 21`, `mvn -o -Dmaven.repo.local=.m2repo`, Node 24. Git-репозитория нет.

```bash
# 1. Полный прогон (заявленные 314)
mvn -o -Dmaven.repo.local=.m2repo test
# Прогон #1: Tests run: 314, Failures: 1, Errors: 0 — упал FileContractIT.quarantinedDownloadErrorMatchesErrorSchema
#            (expected 423, was 200), не E2EE; изолированно и на повторном полном прогоне — зелёный (известный flake
#            асинхронного scan-status, к B3/B4 не относится).
# Прогон #2: Tests run: 314, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS.
# ArchUnit: Tests run: 10, Failures: 0 — 10/10.
# E2eeMessageIT: 12/12; E2eeMessageRealtimeIT: 1/1; E2eeMessageFlagOffIT: 1/1.

# 2. Targeted
mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMessageIT,E2eeMessageRealtimeIT,E2eeMessageFlagOffIT,FileContractIT' test
# Tests run: 16, Failures: 0, Errors: 0, Skipped: 0.

# 3. Контракт/типы
cd frontend && npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields), generated types in sync.

# 4. Внешние unit/property probes (вне репозитория, /tmp/e2ee-g4)
# EnvelopeCodec size sweep: 15 -> INVALID_ENVELOPE_FORMAT; 16 -> OK(22 chars); 271 -> OK(362); 272 -> OK(363);
# 33041 -> ENVELOPE_TOO_LARGE/reason=canonical.
# Validator probes: duplicate -> DUPLICATE_ENVELOPE; self -> INVALID; third-user capable -> UNKNOWN_DEVICE;
# legacy peer -> E2EE_LEGACY_DEVICE; revoked -> UNKNOWN_DEVICE; no peer envelope -> E2EE_NO_PEER_ENVELOPE;
# prekey signing/dh mismatch -> INVALID_ENVELOPE_FORMAT; stale sender gen -> KEY_CHANGED.
# replayCoverage без peer-устройств -> peer_devices=0 (контракт: minimum 1 — violation).
# OpenApiContract: 22-char ciphertext -> REJECT (minLength 363); EnvelopeCoverage(peer_devices=0) -> REJECT (minimum 1).
# Fuzz: 30 000 мутированных конвертов -> ok=841, INVALID=29028, UNSUPPORTED=118, TOO_LARGE=13, unexpected=0 (2.1 s).
# Path/firewall: PathPattern %63/%6D -> MATCH; StrictHttpFirewall %63/%6D -> ALLOWED, ';' -> REJECTED.

# 5. Временная integration-проба (MockMvc + реальный Spring context + PG16; файл вне репозитория)
# CONTROL canonical/own -> crypto:null
# CONTROL canonical/peer header -> HTTP 401
# PROBE encoded/peer header -> HTTP 200, crypto.recipient_device_id = b1  <-- P0-01
# HUGE canonical body (>512 KiB) -> HTTP 413
# HUGE encoded body (>512 KiB)  -> HTTP 201, message count 2                <-- P1-01

# 6. Логи
grep -icE "ciphertext|envelope" /tmp/e2ee-full-test2.log   # 0
# => в логах полного прогона нет ciphertext/envelope; отдельного log-capture теста в репозитории нет.
```

Ограничения проверки: P0-01/P1-01 воспроизведены на MockMvc с `setRequestURI`; дополнительно реальный встроенный
Tomcat 10.1.40 подтвердил, что `getRequestURI()` сохраняет `%63`/`%6D`, а `getPathInfo()` декодирует путь, и что
`PathPattern`/firewall пропускают такие запросы. Полный real-socket прогон **приложения** (с auth/фильтрами) всё равно
надо добавить в рамках фикса и regression-теста. Git отсутствует → «одним PR»/скрытые правки не проверяемы. Браузерные KAT
(G2) и внешний crypto-review (G4) этим ревью не заменяются.

## Adversarial cases

| # | Кейс | Фактический результат | Оценка |
|---|---|---|---|
| 1 | `ciphertext` 15 B | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 2 | `ciphertext` 16 B | `201`, GET отдаёт 22-char конверт | **P1-02** |
| 3 | `ciphertext` 33041 B | `413 ENVELOPE_TOO_LARGE/canonical` | ok |
| 4 | encoded ciphertext 70000 | `413 ENVELOPE_TOO_LARGE/form` | ok |
| 5 | тело >512 KiB, канонический путь | `413 PAYLOAD_TOO_LARGE`, сообщения нет | ok |
| 6 | тело >512 KiB, `%6Dessages`/`%63hats` | `201`, сообщение создано | **P1-01** |
| 7 | 11 конвертов | `422 TOO_MANY_ENVELOPES` | ok |
| 8 | дубль `recipient_device_id` | `422 DUPLICATE_ENVELOPE` | ok |
| 9 | self-envelope (`recipient == sender`) | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 10 | конверт на capable-устройство третьего пользователя | `422 UNKNOWN_DEVICE` | ok |
| 11 | конверт на legacy-устройство peer | `422 E2EE_LEGACY_DEVICE` + `details.field` | ok |
| 12 | конверт на revoked peer device | `422 UNKNOWN_DEVICE` | ok |
| 13 | stale `sender_key_generation`/`recipient_key_generation` | `409 KEY_CHANGED` + expected/actual | ok |
| 14 | `prekey.sender_identity_signing_key`/`..._dh_key` ≠ registered | `422 INVALID_ENVELOPE_FORMAT` + точный field | ok |
| 15 | `prekey` отсутствует у второго сообщения сессии / `prekey:null` | принимается (структурная проверка) | ok (клиентская логика) |
| 16 | `prekey.opk_id` без `opk_public` | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 17 | `header.extra` / `prekey.extra` / envelope extra | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 18 | `v=1.0` (не integral) | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 19 | padded/non-canonical b64u (`=`) | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 20 | `session_id` не 16 B | `422 INVALID_ENVELOPE_FORMAT` | ok |
| 21 | `recipient_device_id: "1-1-1-1-1"` / upper-case | принимается | **P2-04** |
| 22 | duplicate JSON keys (`v`, `ciphertext`) | last-wins, без ошибки | **P2-04** |
| 23 | нет peer-конверта (только self) | `409 E2EE_NO_PEER_ENVELOPE`, сообщения/seq нет | ok |
| 24 | у peer 0 capable-устройств | `409 E2EE_NO_ACTIVE_DEVICES`, сообщения нет | ok |
| 25 | `text`/`sticker_id`/`attachment_ids`/`reply_to_id`/`type=STICKER` в E2EE | `422 E2EE_PLAINTEXT_FORBIDDEN` | ok |
| 26 | `envelopes` в managed-чате (flag on) | `422 ENVELOPES_NOT_ALLOWED` | ok |
| 27 | flag off: E2EE create/send/read | `409 E2EE_DISABLED` | ok |
| 28 | flag off: WS replay E2EE | отдаёт `message.created` с `crypto` | **P2-03** |
| 29 | replay после revoke peer device | `201` с `peer_devices=0` | **P2-01** |
| 30 | race двух POST с одним `client_message_id` | E2EE 201 без coverage (статически) | **P2-02** |
| 31 | канонический GET + чужой `X-Device-Id` | `401` | ok |
| 32 | encoded GET + чужой `X-Device-Id` | `200` с конвертом чужого устройства | **P0-01** |
| 33 | cross-tenant envelopes | RLS: 0 строк / violation при INSERT | ok |
| 34 | revoke устройства | `session.revoked` + close 4403, `chat.keys.changed`/`device.list.changed`, без повторов | ok |
| 35 | повтор WS replay после reconnect | конверт устройства сессии, у третьего устройства `crypto:null` | ok |
| 36 | 30k fuzz-мутаций конвертов | 0 неожиданных Throwable | ok (устойчивость формата) |

## Contract/spec gaps

| # | Гэп | Где | Что делать |
|---|---|---|---|
| 1 | `ciphertext.minLength: 363` vs серверный floor 16 B; §4.1 арифметика «16..33040 = 363..44054» неверна | `contracts/openapi.yaml:1575-1579`; `docs/E2EE-SPEC.md:744`; `EnvelopeCodec:105-120`; `V16:437` | выбрать A/B из P1-02; синхронизировать контракт/§4.1/§4.5/§4.7/DB и тесты |
| 2 | `EnvelopeCoverage.peer_devices: minimum: 1`, а replay может дать 0 | `contracts/openapi.yaml:1771`; `E2eeEnvelopeValidator.replayCoverage` | хранить coverage snapshot или изменить контракт/семантику (P2-01) |
| 3 | `MessageCreateResult.envelope_coverage` optional в схеме, но нормативно обязателен для E2EE (D-S4-04); race-replay его теряет | `contracts/openapi.yaml:1782-1787`; `SendMessageUseCase:244-261` | fail-closed в mapper/сервисе + тест; либо persist snapshot |
| 4 | WS «per-device crypto» vs формулировка задания «always-null» | `docs/E2EE-SPEC.md` §4.4; `contracts/ws-protocol.md:59-71`; `WsFrameCodec.event(event, deviceId)` | гэпа нет: реализация соответствует §4.4/ws-protocol; «always-null» был бы изменением wire-контракта, а не багом. Зафиксировать решение PM |
| 5 | `KEY_GENERATION_MISMATCH` (422) и `KEY_CHANGED` (409) описаны в §4.8; сервер использует `KEY_CHANGED` | `docs/E2EE-SPEC.md` §4.8; `E2eeEnvelopeValidator.requireGeneration` | оставить `KEY_CHANGED` (соответствует §4.7), а `KEY_GENERATION_MISMATCH` пометить deprecated/убрать из §4.8 |
| 6 | flag off + `envelopes` в managed → `409 E2EE_DISABLED`, а §4.2 говорит `422 ENVELOPES_NOT_ALLOWED` | `MessageSubmissionHandler:137-149`; `MessageCreate.description` | в контракте уже оговорено; при flag-on — 422 (проверено); зафиксировать в §4.2 как «flag-off приоритет 409» |
| 7 | `E2EE_LEGACY_DEVICE` для **sender** — расширение относительно §4.2 (там только recipient/legacy target) | `E2eeEnvelopeValidator:63-67` | задокументировать в §4.8/§4.7 или использовать `E2EE_PLAINTEXT_FORBIDDEN`/`UNKNOWN_DEVICE`; сейчас код разумнее спеки |
| 8 | `MessageCreate` не `additionalProperties:false`: неизвестные top-level поля (`pad`) молча игнорируются | `contracts/openapi.yaml:1416-1438`; `MessageCreateRequest` | это позволило P1-01 раздуть тело; либо strict DTO/`FAIL_ON_UNKNOWN_PROPERTIES`, либо оставить, но тогда 512 KiB обязателен |
| 9 | `CryptoEnvelope` canonical b64u не выражается JSON Schema (`contentEncoding` не проверяет canonical) | `contracts/openapi.yaml:1570-1579` | оставить серверную проверку; в контракте описать, что canonical — серверное правило; contract-тест на padded/неканонический |
| 10 | `Message.client_message_id` uniqueness per `(chat, sender)` не выражена глобально: индексы per-partition | `V16:476-480`; `MessageJpaRepository:20-30` | см. «Остаточные риски»; при необходимости — отдельная таблица/idempotency-ключ |

## Условия GO для E7-F/включения флага

1. **P0-01** — закрыть обход `X-Device-Id`: нормализованный путь/запрет `%`-encoding + валидация header при любом
   наличии + defense-in-depth в `MessageQueryHandler`/`RealtimeChatHistoryAdapter`; regression-тесты на encoded path,
   чужой device, своё второе устройство; real-socket тест.
2. **P1-01** — лимит 512 KiB должен применяться к нормализованному пути/префиксу и к encoded-вариантам; тест 600 KiB
   на `%6Dessages`/`%63hats` → 413, сообщение не создано; верхний предел на коннекторе как вторая линия.
3. **P1-02** — решение PM/security по нижней границе ciphertext (272 B canonical или 16 B) и синхронизация
   контракт/спека/код/DB; тесты 271/272 и `CONTRACT.assertValid` на минимальном принятом конверте.
4. **P2-01/P2-02** — coverage на replay: snapshot или явная семантика; E2EE 201 всегда с `envelope_coverage`;
   тесты replay после revoke peer, race одного `client_message_id`.
5. **P2-03** — kill-switch: flag off должен гейтить WS replay и `Idempotency-Key` replay (или это должно быть явно
   задокументировано как исключение); тесты.
6. **P2-04/P2-05** — strict UUID/duplicate keys; единый capability-предикат (домен = SQL = V17); тесты/property-тест.
7. **Тесты:** добавить в `E2eeMessageIT`/`E2eeMessageRealtimeIT`/`E2eeMessageFlagOffIT` кейсы encoded path, forged
   `X-Device-Id`, 16/271/272 B, replay coverage, flag-off WS, duplicate keys, strict UUID; log-capture тест на отсутствие
   ciphertext/plaintext; fuzz/property-тест `EnvelopeCodec` (внешний fuzz уже 30k/0 unexpected).
8. **Прогоны:** полный `mvn test` ≥314 зелёный (устранить/задокументировать flake `FileContractIT`), ArchUnit 10/10,
   `contract:check` 33/58, targeted 16/16; повторить на real HTTP/Tomcat, не только MockMvc.
9. **Git/one PR** — инициализировать репозиторий или приложить patch-bundle; без diff нельзя подтвердить «одним PR» и
   отсутствие скрытых правок (F-3 review-04 остаётся unverifiable).
10. **G2/G4** — браузерные KAT и внешний crypto-review остаются предусловиями flag-on; это ревью их не заменяет.
    E7-F может начинаться только после P0-01/P1-01/P1-02 и с контрактно-синхронизированным backend.

## Остаточные риски

* **In-process WS hub** (E3): multi-node fan-out отсутствует; `chat.keys.changed`/`device.list.changed` не durable;
  offline-клиент узнаёт об изменениях только на reconnect. Для E2EE multi-device это operational риск, не утечка.
* **Retention конвертов**: `message.message_envelopes` не имеет retention/удаления; ciphertext и метаданные хранятся
  бессрочно (по партициям). Нужен retention-джоб до прод-объёмов; сейчас это storage-growth/комплаенс-риск.
* **Dev/test профиль**: `DevDeviceBinding` не проверяет устройство в БД; отозванное устройство в dev/test может читать
  старые конверты (в prod `KeycloakDeviceBinding` даёт 401). Defense-in-depth в history (P0-01 fix) закроет и это.
* **Stale WS-подписка**: `publish` не перепроверяет membership на каждом событии; удалённый из чата участник с живой
  сессией может получать `message.created` до disconnect. Для E2EE DIRECT membership обычно неизменяем, но это
  общий E3-долг; нужен per-event access check или close при `chat.member.changed`.
* **`client_message_id` per-partition uniqueness**: уникальный индекс создаётся в каждой месячной партиции
  (`V16:476-480`), глобального индекса нет; повтор того же `(chat, sender, client_message_id)` через границу месяца
  может дать 2 строки, а `Optional`-запросы (`MessageJpaRepository:20-30`) — `IncorrectResultSizeDataAccessException`
  → 500 вместо replay/409. Не воспроизведено end-to-end (нужен переход месяца), но статически реально. Fix: отдельная
  таблица idempotency/client-id или запрос с `LIMIT 2` и явной обработкой.
* **SQL/stack-trace логи**: `GlobalExceptionHandler.handleUnexpected` логирует stack trace; при CHECK/уникальном
  нарушении Postgres `DETAIL` может содержать значения строки (включая ciphertext в hex). В текущем прогоне ciphertext
  в логах не найден (grep 0), но log-capture тест отсутствует; стоит ограничить логирование SQL-detail.
* **Нет key transparency/backup** (v2/non-goal); TOFU-пиннинг и safety number — клиентская часть E7-F, сервер это не
  закрывает.
* **`KeyClaim` rate limit** уже есть (B1F, `E2eeClaimRateLimitIT`), но OPK-истощение/retention prekey (P2-08 review-04)
  остаётся долгом; на B3/B4 send это влияет через неудачный claim.
* **Flake `FileContractIT`** в полном прогоне (unrelated): 423 vs 200 из-за асинхронного scan-status; не B3/B4, но
  «314/314» нестабильно; зафиксировать/стабилизировать до релиза.
* **MockMvc vs real Tomcat**: P0-01/P1-01 зависят от raw-URI; framework-probe'ы подтверждают, но real-socket тест
  обязателен (см. условия GO).

## Вопросы

1. **P1-02:** канонический floor — 272 B/363 chars (вариант A) или 16 B/22 chars (вариант B)? Если A — меняем код/DB/
   §4.5; если B — контракт `minLength: 22` и арифметику §4.1, а клиент обязан не валить страницу на коротком конверте.
2. **P2-01/P2-02:** coverage на replay — snapshot на момент отправки (новая колонка/миграция) или «текущее состояние»?
   Если snapshot, нужна ли миграция §6.5, которой сейчас нет?
3. **P2-03:** является ли flag off абсолютным kill-switch для **чтения** (WS replay/идемпотентный replay), или replay —
   документированное исключение? Нужно решение PM.
4. **P0-01:** должны ли E2EE-эндпоинты отвечать `401` на чужой `X-Device-Id` или отдавать `crypto:null`? Рекомендую
   401 (fail closed) и проверку владельца в history независимо от фильтра.
5. **P2-04:** нужен ли строгий UUID/duplicate-key режим глобально (включая managed-эндпоинты) или только для
   `/messages`? Глобальный strict может сломать существующих клиентов.
6. **P2-05:** какой предикат `e2ee_capable` канонический — домен (без fingerprint) или SQL/V17 (с fingerprint)? Нужен
   один ответ до E7-F.
7. **`client_message_id`:** нужна ли глобальная (межпартиционная) уникальность, или месячный partition-scope — осознанное
   решение? Если глобальная — нужна отдельная таблица/индекс.
8. **Процесс:** когда будет git/one-PR и когда G2/G4? Без них flag-on и E7-F не должны стартовать, даже после фиксов
   P0/P1.

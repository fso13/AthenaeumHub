# E7-B3F2 — закрытие P1-03 / P2-06 / P2-07 после E2EE-REVIEW-07

> **Сессия:** backend security-разработчик «Совы». **Вход:** `docs/E2EE-REVIEW-07.md`
> (G4b: GO WITH CONDITIONS для чистой БД, NO-GO для in-place upgrade из-за P1-03),
> `backend/E7-B3F-REPORT.md`, `docs/E2EE-SPEC.md` §4.1/§4.5/§4.7,
> `contracts/openapi.yaml`, V18, `MessageEnvelopeRepositoryAdapter`, `EnvelopeCodec`,
> `ChatKeysService`, `MessageQueryHandler`, `E2eeMessageIT`/`E2eeMigrationIT`.
>
> **Зона:** только `backend/**` (код, V19, тесты, этот отчёт). `contracts/**` не менялись;
> `frontend/src/api/schema.d.ts` регенерирован и побайтово совпал с committed-версией.
> Остальной `frontend/**`, `docs/**`, `design/**` не менялись. Git-репозитория в workspace
> нет, поэтому one-PR/diff подтвердить по-прежнему нельзя.
>
> **Флаг:** `krug.e2ee.enabled` / `KRUG_E2EE_ENABLED` остаётся **false** по умолчанию
> (`application.yml:129`). Новых decrypt/plaintext-путей нет; сервер по-прежнему не читает
> ciphertext и не логирует его.

## Статус

**DONE по P1-03, P2-06, P2-07.** Тестов не отключал, 500 не маскировал: legacy-строка
теперь вообще не конструируется в `CryptoEnvelope`, а GET отвечает `200` + `crypto:null`
для затронутого устройства; после V19 строки физически перенесены в quarantine, constraint
валидирован.

| Проверка | Результат |
|---|---|
| Полный backend suite | **332/332**, Failures 0, Errors 0, Skipped 0 (baseline 324 + 8 новых) |
| ArchUnit | **10/10** |
| Contract | **33 operations / 58 schemas**, generated types in sync |
| `schema.d.ts` regen | checksum до/после совпал (`cc936fdb…`), изменений нет |
| P1-03 real HTTP + PG16 | `GET` A2 → `200`, `crypto:null`; B1 → `200` со своим конвертом; **0 ответов 500** |
| V19 | legacy 16/271 B → quarantine `legacy_short`; валидный 272 B сохранён; `convalidated=t` на parent + всех партициях |
| V19 без superuser | прогон V18→V19 владельцем БД с `NOSUPERUSER NOBYPASSRLS` — успешно |
| P2-06 | upper-case `client_message_id` → тот же lower-case UUID; replay по обоим ключам; `1-1-1-1-1` → `400` |
| P2-07 | foreign/revoked/unknown device → `403` до чтения/записи ключей; active own device проходит |

**Вердикт по P1-03:** блокер in-place upgrade снят. Для чистой БД условия GO не меняются
(внешние G2/G4 и git/one-PR остаются предусловиями E7-F); для upgrade БД, где E2EE уже
включался, теперь есть и толерантный read-path (interim), и V19 (постоянное исправление).

## P1-03 — legacy envelope 16..271 B → GET 500

### Причина (подтверждена review-07)

`V18` добавил `ck_envelopes_ciphertext_min CHECK (272..33040) NOT VALID`, поэтому строки,
записанные до B3F, остались в `message.message_envelopes`. `findForDevice`/`findByMessage`
мапили **любую** строку через `new CryptoEnvelope(...)`, а конструктор бросал
`IllegalArgumentException` на `< 272` B. Исключение всплывало в `MessageQueryHandler.withCrypto`
(и в `RealtimeChatHistoryAdapter` — тот же репозиторий), превращая всю страницу/кадр в
`500 INTERNAL` для устройства, которому адресован legacy-конверт.

### Исправление A — толерантный read-path (interim, работает и до V19)

`backend/src/main/java/ru/krug/backend/message/infrastructure/persistence/MessageEnvelopeRepositoryAdapter.java`

* `findForDevice` (строка ~95) и `findByMessage` (~142) добавляют
  `AND octet_length(ciphertext) BETWEEN 272 AND 33040`; границы берутся из
  `CryptoEnvelope.MIN_CIPHERTEXT_BYTES/MAX_CIPHERTEXT_BYTES`, а не из литералов.
* `toDomainOrNull` (~161) — defense-in-depth: если строка всё же оказалась нечитаемой
  (legacy-длина, битый header/prekey), она **пропускается**, а не роняет запрос. Логируется
  только `message_id`, `recipient_device_id` и текст причины — **никогда не ciphertext**.
* Для `findForDevice` это даёт `crypto:null` только тому устройству, у которого нет валидного
  конверта; валидные конверты других устройств и другие сообщения не затрагиваются.
* Для `findByMessage` (внутренний replay/fingerprint) legacy-строка также не попадает в
  маппинг: replay отвечает `201`/`409`, но не `500`.

Это осознанно **не** клампинг и не padding: байты не меняются, fingerprint/подпись не
ломаются. Legacy-конверт не становится «валидным» — он просто не отдаётся и не конструируется.

### Исправление B — V19: quarantine + VALIDATE (постоянное)

`backend/src/main/resources/db/migration/V19__e2ee_legacy_envelope_quarantine.sql`

1. На время копирования/удаления снимается `FORCE ROW LEVEL SECURITY` с
   `message.message_envelopes` (владелец-мигратор должен видеть строки; `ENABLE` остаётся,
   `krug_app` сохраняет tenant-политику). Это тот же приём, что V16/V17.
2. Создаётся `message.message_envelopes_quarantine` — **точная копия** колонок envelope +
   `reason` + `quarantined_at`, `PRIMARY KEY (message_id, recipient_device_id, created_at)`.
   `GRANT` для `krug_app` нет: таблица owner-only, как `auth.identity_key_quarantine` из V17.
3. `INSERT ... SELECT` переносит **все** строки вне `272..33040` с reason
   `legacy_short` (`< 272`) или `legacy_out_of_range` (`> 33040`). `ON CONFLICT DO NOTHING`
   делает повторный запуск безопасным.
4. `DELETE` удаляет ровно те же строки из live-таблицы. Валидные строки не читаются и не
   меняются.
5. `VALIDATE CONSTRAINT ck_envelopes_ciphertext_min` выполняется, пока FORCE ещё снят, чтобы
   владелец видел все строки. На PG16 parent-VALIDATE рекурсивно валидирует все текущие
   партиции (проверено и в миграционном IT, и в real-HTTP IT).
6. `FORCE ROW LEVEL SECURITY` возвращается.
7. Вся миграция транзакционная (Flyway): при ошибке откатываются и NO FORCE, и копирование.

### Поведение после фикса

| Состояние БД | GET устройства с legacy-конвертом | GET устройства с валидным конвертом | 500 |
|---|---|---|---|
| V18 `NOT VALID`, legacy 16..271 B | `200`, `crypto:null` | `200`, свой `crypto` | нет |
| После V19 | `200`, `crypto:null` (строки уже нет) | `200`, свой `crypto` | нет |
| Replay (`Idempotency-Key` / `client_message_id`) при legacy-строке | — | `201` (тот же message id) | нет |

### Тесты P1-03

* **Real HTTP + real PostgreSQL**: `backend/src/test/java/ru/krug/backend/integration/E2eeLegacyEnvelopeIT.java`
  — `@SpringBootTest(webEnvironment=RANDOM_PORT)`, реальный Tomcat, реальные dev-JWT,
  PG16 Testcontainers.
  Сценарий: E2EE DIRECT, send только на B1 → снять V18 constraint → INSERT 16 B строки для A2
  → вернуть constraint как `NOT VALID` → **GET как A2 → 200 `crypto:null`**, GET как B1 → 200
  со своим конвертом, оба replay-пути → 201. Затем выполняется **реальный файл V19**:
  quarantine = 1 (`legacy_short`), live legacy = 0, valid = 1 и байты сохранены,
  `convalidated=t` у parent и всех партиций, FORCE восстановлен. После V19 GET A2 снова
  `200 crypto:null`, GET B1 — свой конверт.
* **Миграционный IT**: `E2eeMigrationIT.v19QuarantinesLegacyEnvelopesAndValidatesTheCiphertextFloor`
  — V15 seed → V17 → INSERT 16/271/272 B → V18 (`convalidated=f`) → V19: два legacy ушли в
  quarantine, 272 B остался, все constraint-записи валидированы, у `krug_app` нет SELECT на
  quarantine.
* **Non-superuser**: `E2eeMigrationIT.nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17`
  расширен прогоном V18→V19 владельцем БД с `NOSUPERUSER NOBYPASSRLS` над legacy-строкой:
  V19 видит и переносит её благодаря временному `NO FORCE`, затем возвращает FORCE.
* **WS replay**: отдельного legacy-WS PoC нет; `RealtimeChatHistoryAdapter` использует тот же
  `findForDevice`/`toDomainOrNull`, а существующие `E2eeMessageRealtimeIT` (3/3) и полный
  suite зелёные. Это ограничение проверки, не отдельный code-path.

### Эксплуатационные замечания по V19

* V19 делает `ACCESS EXCLUSIVE` на `message.message_envelopes` и полный `VALIDATE` — на
  большой таблице это окно блокировки чтения/записи. Запускать в maintenance-window; V19 —
  forward-only, откат только restore из backup.
* Quarantine хранит ciphertext/metadata для аудита; доступ только у владельца схемы. Политику
  retention для quarantine нужно определить отдельно (не в этом слайсе).
* Строки `> 33040` в норме уже невозможны из-за V16 CHECK; V19 всё равно переносит их
  defensive-веткой `legacy_out_of_range`.

## P2-06 — request-level UUID канонизируется явно

**Выбран вариант «canonicalize to lower-case», не strict-reject**: upper-case hex — тот же
UUID, и его отклонение сломало бы существующих клиентов без выигрыша в безопасности.
Envelope-UUID остаются strict (`EnvelopeCodec`, §4.7) — это не менялось.

* `backend/src/main/java/ru/krug/backend/shared/api/CanonicalUuidDeserializer.java`:
  принимает только 8-4-4-4-12 (hex в любом регистре), нормализует в lower-case через
  `UUID.fromString(value.toLowerCase(ROOT))`; `1-1-1-1-1`, braced/URN и прочие lenient-формы
  → обычный `400 VALIDATION_FAILED`. Upper-case не reject.
* `MessageCreateRequest` аннотирует `client_message_id`, `sticker_id`, `reply_to_id` и
  `attachment_ids` этим десериализатором, поэтому канонический `UUID` — единственная форма,
  которую видит приложение, response и idempotency-hash.
* Идемпотентность: `SendMessageUseCase.requestHash` хэширует `UUID`-объект; upper-case и
  lower-case одного значения дают один и тот же hash. `client_message_id` replay сравнивает
  `UUID`, поэтому регистр не создаёт второе сообщение.

**Тест** (`MessageApiIT.canonicalizesClientMessageIdCaseAndKeepsIdempotencyConsistent`):

1. send lower-case → `201`, echo `client_message_id` lower-case;
2. тот же `Idempotency-Key`, upper-case UUID → `201`, `Idempotent-Replay: true`, тот же id;
3. новый `Idempotency-Key`, upper-case UUID → `201`, тот же id/count=1 (не конфликт);
4. `1-1-1-1-1` → `400 VALIDATION_FAILED`;
5. сообщений в БД ровно 1.

Контракт не менялся: `format: uuid` по-прежнему допускает upper-case; канонизация — серверная
нормализация, а не новое ограничение wire.

## P2-07 — `ChatKeysService.requireCurrentDevice`: owner + ACTIVE

`backend/src/main/java/ru/krug/backend/auth/application/usecase/ChatKeysService.java:220`

`requireCurrentDevice` больше не возвращает `principal.deviceId()` вслепую:

```java
deviceRepository.findById(deviceId)
    .filter(device -> device.status() == Device.Status.ACTIVE)
    .filter(device -> device.userId().equals(principal.userId()))
    .map(Device::id)
    .orElseThrow(() -> DomainException.forbidden(
        "X-Device-Id is not an active device of the caller"));
```

Гард вызывается и в `getChatKeys`, и в `verifyDevice` до чтения verifications и до записи.
`DeviceBindingFilter` остаётся основной границей; это defense-in-depth на случай будущей
регрессии path-нормализации (класс инцидента P0-01). `findById` работает в tenant-контексте,
активированном `requireE2eeChat`, и RLS `p_devices_self` не даёт увидеть чужое устройство;
дополнительный `userId.equals` закрывает и сценарий, если политика когда-нибудь расширится.

**Тесты** (`backend/src/test/java/ru/krug/backend/unit/ChatKeysServiceDeviceGuardTest.java`, 5/5):

* active own device → проходит, view содержит свой `my_device_id`/`verifier_device_id`;
* ACTIVE device другого пользователя → `403`;
* REVOKED own device → `403`;
* unknown device → `403`;
* `verifyDevice` с чужим device → `403` до любой записи.

HTTP-путь с чужим `X-Device-Id` по-прежнему даёт `401` на фильтре (проверено существующими
`E2eeMessageRealtimeIT`/`E2eeMessageIT`, полный suite зелёный).

## 5. Проверки (TASKS §5)

Все команды — в текущем дереве, `JAVA_HOME=JDK 21`, Maven offline
(`-Dmaven.repo.local=.m2repo`). Git-репозитория нет; проверялось фактическое дерево.

```bash
# 1. Полный backend suite (unit + integration, включая новые тесты)
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 332, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0

# 2. Contract / generated types
cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.

# 3. Регенерация schema.d.ts (контракт не менялся)
npm run --silent api:types
# checksum src/api/schema.d.ts до/после: cc936fdb9b082104f7f3c2b0dde0df885da3bd6d
# (файл не изменился)

# 4. Точечные прогоны P1-03/P2-06/P2-07
cd ../backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='E2eeLegacyEnvelopeIT' test
# Tests run: 1, Failures: 0, Errors: 0

JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='E2eeMigrationIT#v19QuarantinesLegacyEnvelopesAndValidatesTheCiphertextFloor' test
# Tests run: 1, Failures: 0, Errors: 0

JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='MessageApiIT#canonicalizesClientMessageIdCaseAndKeepsIdempotencyConsistent' test
# Tests run: 1, Failures: 0, Errors: 0

JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='ChatKeysServiceDeviceGuardTest' test
# Tests run: 5, Failures: 0, Errors: 0
```

**V19 на реальной БД (PG16):**

* миграция V1→V18 + legacy 16/271 B → V19: `message.message_envelopes_quarantine` = 2 строки
  (`legacy_short`), live-таблица содержит только 272 B, `pg_constraint.convalidated = t` у
  parent и всех партиций, `relforcerowsecurity = t` восстановлен;
* тот же прогон владельцем БД с `NOSUPERUSER NOBYPASSRLS` — успешно (NO FORCE-окно);
* у `krug_app` нет `SELECT` на quarantine (`has_table_privilege = false`).

**P1-03 real HTTP:** `E2eeLegacyEnvelopeIT` поднимает реальный Tomcat на RANDOM_PORT и реальный
PG16; в состоянии «V18 NOT VALID + 16 B строка для A2» GET A2 — `200` `crypto:null`, GET B1 —
`200` со своим конвертом; replay — `201`; после реального V19 — те же `200`, 500 отсутствуют.
Профиль теста — `test` (dev-JWT binding), а не `keycloak`; дефект P1-03 находится в
repository-маппинге и от профиля аутентификации не зависит. Это ограничение проверки.

**Plaintext/decrypt/flag:**

* `KRUG_E2EE_ENABLED` default — `false` (`application.yml:129`), не менялся;
* новых `decrypt`/plaintext-путей и crypto-библиотек для E2EE нет; сервер по-прежнему только
  проверяет форму/права и хранит opaque bytes;
* в логе legacy-skip нет ciphertext: только `message_id`, `recipient_device_id`, reason;
* quarantine доступна только владельцу схемы, `krug_app` прав не имеет.

## P1/P2 closure

| Finding | Статус | Что сделано | Доказательство |
|---|---|---|---|
| **P1-03** legacy envelope 16..271 B → 500 на GET/WS replay | **closed** | (A) SQL-фильтр `272..33040` + `toDomainOrNull` skip в `MessageEnvelopeRepositoryAdapter`; legacy не конструируется, GET → `200 crypto:null`, replay → `201`. (B) V19 переносит invalid-строки в `message.message_envelopes_quarantine` (`legacy_short`/`legacy_out_of_range`), удаляет их из live, валидирует `ck_envelopes_ciphertext_min` на parent+партициях; валидные не трогает; NO FORCE-окно для non-superuser owner, FORCE восстанавливается. | Real HTTP PG16: A2 → 200 `crypto:null`, B1 → 200 свой конверт, 500=0; после V19 то же; V19 IT: quarantine=2/1, valid сохранён, `convalidated=t`; non-superuser V18→V19 успешно; полный suite 332/0. |
| **P2-06** upper-case `client_message_id` (request-level UUID) | **closed** | `CanonicalUuidDeserializer` явно принимает 8-4-4-4-12 в любом регистре и нормализует в lower-case; lenient-формы → 400; десериализатор применён к UUID-полям `MessageCreateRequest`; idempotency-hash и `client_message_id` replay используют канонический UUID. Контракт/`schema.d.ts` не менялись. | `MessageApiIT`: upper-case + тот же `Idempotency-Key` → replay 201 same id; upper-case + новый ключ → 201 same id, count=1; `1-1-1-1-1` → 400. |
| **P2-07** `ChatKeysService.requireCurrentDevice` доверяет `principal.deviceId` | **closed** | `requireCurrentDevice` делает `findById` + ACTIVE + `userId == principal.userId`, иначе 403; применяется в `getChatKeys` и `verifyDevice`; фильтр остаётся основной границей. | unit 5/5: active own → ok; foreign active / revoked own / unknown → 403; `verifyDevice` foreign → 403 до записи. |
| P0-01, P1-01, P1-02, P2-01…P2-05 | **closed ранее** | Не переоткрывались; regression-тесты существуют, полный suite зелёный. | 332/0, ArchUnit 10/10, contract 33/58. |
| P2-08 (prekey retention) | **PARTIAL (вне G4b)** | Не входил в задачу B3F2; retention остаётся B4-долгом. | — |

## Остаточные риски / что не входит

* **V19 lock/validate:** на большой таблице V19 — тяжёлая транзакционная миграция с
  `ACCESS EXCLUSIVE` и полным scan; нужен maintenance-window и backup. Это не код-дефект, а
  rollout-ограничение.
* **Quarantine retention:** таблица `message_envelopes_quarantine` не чистится автоматически;
  политику хранения/удаления после расследования нужно согласовать отдельно.
* **WS legacy replay:** отдельный WS-клиент к legacy-строке не поднимался; path общий с REST
  (`findForDevice`), существующие 3 WS IT и полный suite зелёные. Если нужен отдельный
  end-to-end WS-кейс, это следующий шаг, а не незакрытый P1.
* **Real HTTP профиль:** regression P1-03 использует `test`-профиль (dev-JWT), не `keycloak`;
  дефект не зависит от профиля, но keycloak-прогон в этом слайсе не повторялся.
* **G2/G4/git/one-PR** остаются внешними условиями GO для E7-F; этот отчёт их не заменяет.
* **`%2563`/proxy, flag-off WS cursor, prekey retention, envelope retention** — остаточные
  риски review-07, не входившие в P1-03/P2-06/P2-07 и не изменявшиеся.

---

**Итог:** P1-03 закрыт на двух уровнях (tolerant read-path + V19 quarantine/VALIDATE),
P2-06 и P2-07 закрыты с regression-тестами. Полный suite 332/332, ArchUnit 10/10,
contract 33/58, `schema.d.ts` без дрейфа, E2EE-флаг по умолчанию false, новых
plaintext/decrypt-путей нет.

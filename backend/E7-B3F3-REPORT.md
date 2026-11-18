# E7-B3F3 — P2-09/P2-10/P2-11/P2-12 после E2EE-REVIEW-08

> **Сессия:** backend security-разработчик «Круга». **Вход:** `docs/E2EE-REVIEW-08.md`
> (G4c: GO WITH CONDITIONS; P1-03/P2-06/P2-07 закрыты; открыты P2-09/10/11/12 и
> постоянные real-HTTP regressions), `backend/E7-B3F2-REPORT.md`, V18/V19,
> `E2eeLegacyEnvelopeIT`, `E2eeMigrationIT`, `docs/E2EE-SPEC.md` §4.1/§5.4/§6.5,
> `backend/README.md`, `contracts/openapi.yaml`, `contracts/ws-protocol.md`.
>
> **Зона:** только `backend/**`, `docs/E2EE-SPEC.md`, `backend/README.md`, `docs/TASKS.md`,
> этот отчёт. `contracts/**`, `frontend/**`, `design/**` не менялись. Git-репозитория в
> workspace нет, поэтому one-PR/diff по-прежнему не подтверждается.
>
> **Флаг:** `krug.e2ee.enabled` / `KRUG_E2EE_ENABLED` остаётся **false** по умолчанию
> (`application.yml:129`). Новых decrypt/plaintext-путей нет; сервер не читает и не логирует
> ciphertext. Деплоя и перезапуска внешних сервисов не было; порты 8080/8081/5432/8180 не
> затрагивались.

## Статус

**DONE по P2-09, P2-10, P2-11, P2-12.** Без новых фич и без изменения wire-контракта.
Тестов не отключал, `500` не маскировал: legacy/quarantine-строки теперь не конструируются в
`CryptoEnvelope`, отдаются как `crypto:null`, а lossless-перенос в quarantine усилен.

| Проверка | Результат |
|---|---|
| Полный backend suite | **340/340**, Failures 0, Errors 0, Skipped 0 (baseline 332 + 8 новых) |
| ArchUnit | **10/10** |
| Contract | **33 operations / 58 schemas**, generated types in sync |
| Точечные новые/изменённые | **19/19** (`MessageEnvelopeRepositoryAdapterTest` 2, `E2eeMigrationIT` 9, `E2eeLegacyEnvelopeIT` 4, `E2eeMessageRealtimeIT` 4) |
| P2-09 | legacy-only replay: `201` true replay (валидное тело), `409` conflict/idempotency, `422` short bytes, `500` = 0 |
| P2-10 | ложное «старые строки остаются читаемыми» удалено; V18/V19/V20, quarantine, `crypto:null`, maintenance/backup, retention описаны в SPEC и README |
| P2-11 | V19 `DELETE ... WHERE EXISTS`; V20 RLS без policy (owner-only), revoke грантов, retention function + scheduler; конфликт копии не удаляет live-строку |
| P2-12 | real-HTTP encoded/nested paths, chunked 524288/524289, floor 271/272/33040/33041, WS legacy replay, 271 B HTTP, `toDomainOrNull` + log-capture, byte-level quarantine |

## P2-09 — legacy-only replay: выбран явный 422/409

**Решение:** не синтезировать `201` для сообщения, у которого не осталось ни одного
валидного конверта. Причины:

* `201` означал бы, что сервер «принял»/«повторил» конверт, который нарушает собственный
  V18-контракт (`ciphertext < 272 B`), физически не хранится и не может быть отдан клиенту;
* fingerprint хранимых конвертов пуст (SQL-фильтр `272..33040` в `findByMessage`), поэтому
  сравнение с любым валидным телом корректно даёт конфликт, а не ложный replay;
* явные `422/409` детерминированы, не теряют сообщение (`GET` отдаёт `crypto:null`) и не
  требуют расшифровки; review-08 прямо допускал такой вариант.

Задокументировано в `docs/E2EE-SPEC.md` §4.1 (bullet «Legacy-only replay») и в
`backend/README.md` (Read/WS). **Настоящий replay не сломан:** тот же `Idempotency-Key` +
те же **валидные** bytes по-прежнему `201 Idempotent-Replay: true`; повтор исходных
коротких bytes — `422` даже с тем же ключом.

Тест `E2eeLegacyEnvelopeIT.legacyOnlyReplayIsDocumented422Or409AndNever500` делает сообщение
legacy-only (единственный конверт 300 B заменяется на 16 B), затем проверяет:

1. тот же ключ + то же **валидное** тело → `201`, тот же `id`, `Idempotent-Replay: true`;
2. новый ключ, тот же `client_message_id`, валидное другое тело → `409 CLIENT_MESSAGE_ID_CONFLICT`;
3. тот же ключ, валидное другое тело → `409 IDEMPOTENCY_KEY_REUSED`;
4. повтор исходных 16 B → `422 INVALID_ENVELOPE_FORMAT` (`details.reason="ciphertext_too_short"`);
5. `GET` этим устройством → `200`, `crypto:null`; `500` нет; второго сообщения нет.

## P2-10 — документы синхронизированы с V19/V20

* `docs/E2EE-SPEC.md:2597` (§6.5.1): ложное «V18 поднял floor… старые строки остаются
  читаемыми» заменено на фактическое: V18 `NOT VALID` — временное состояние, V19 переносит
  строки в quarantine, read-path отдаёт `crypto:null`.
* §4.1: строка `ciphertext` дополнена V18/V19/tolerant read; добавлен bullet
  «Legacy-only replay (P2-09)».
* §5.4 (revoke): добавлено, что legacy/quarantined конверты остаются `crypto:null` — это
  «недоступно на этом устройстве», а не удаление сообщения/`500`.
* Новый §6.5.3: V18, V19 (6 шагов, lossless `DELETE ... WHERE EXISTS`), tolerant read,
  rollout maintenance-window/backup/forward-only, обязательные SQL-проверки
  (`convalidated`, live 0 вне диапазона, `FORCE`, quarantine count), V20 RLS/retention,
  `DB_USER != FLYWAY_USER`.
* `backend/README.md`: новый раздел «V18/V19/V20 migrations — ciphertext floor,
  legacy-envelope quarantine, retention» с таблицей поведения, rollout-проверками и
  retention; обновлены Read/WS-раздел и список тестов.

## P2-11 — quarantine: RLS, retention, lossless DELETE

### V19 — удаляем только реально скопированное

`V19__e2ee_legacy_envelope_quarantine.sql`:

```sql
DELETE FROM message.message_envelopes e
 WHERE (octet_length(e.ciphertext) < 272 OR octet_length(e.ciphertext) > 33040)
   AND EXISTS (SELECT 1 FROM message.message_envelopes_quarantine q
                WHERE q.message_id = e.message_id
                  AND q.recipient_device_id = e.recipient_device_id
                  AND q.created_at = e.created_at
                  AND q.workspace_id = e.workspace_id
                  AND q.chat_id = e.chat_id
                  AND q.session_id = e.session_id
                  AND q.header = e.header
                  AND q.ciphertext = e.ciphertext);
```

Если `INSERT ... ON CONFLICT DO NOTHING` наткнулся на конфликтующую quarantine-строку с тем
же PK, live-строка **не** удаляется; `VALIDATE` падает, транзакция Flyway откатывается.
Проверено `E2eeMigrationIT.v19DeleteOnlyRemovesRowsActuallyCopiedToQuarantine`: вручную
созданная конфликтующая копия (`reason='audit-conflict'`, другие bytes) → V19 падает с
`ck_envelopes_ciphertext_min`, live-строка и конфликтующая копия на месте, `FORCE`
восстановлен откатом.

### V20 — RLS без policy + bounded retention

`V20__e2ee_envelope_quarantine_hardening.sql`:

* `ENABLE ROW LEVEL SECURITY` **без policy**: owner (migrator) обходит RLS, любой non-owner
  denied даже после будущего широкого `GRANT`; `FORCE` намеренно не ставится, иначе
  перестанет работать retention;
* `REVOKE ALL` у `PUBLIC` и `krug_app`; таблица остаётся owner-only;
* индекс `ix_envelope_quarantine_quarantined_at`;
* `message.purge_envelope_quarantine(p_retention_days integer)` — `SECURITY DEFINER`,
  `search_path = pg_catalog, message`, окно **1..3650** дней, иначе
  `QUARANTINE_RETENTION_INVALID`; `EXECUTE` только у `krug_app`, табличных прав у неё нет;
* `EnvelopeQuarantineRetentionScheduler` вызывает функцию раз в сутки
  (`krug.e2ee.quarantine-retention-enabled/-days/-poll-interval`, default 90 дней,
  first run через 1 час); в `test` выключен, чтобы не удалять фикстуры;
* оператор без приложения: `SELECT message.purge_envelope_quarantine(90);`.

Проверено `E2eeMigrationIT.v20EnablesOwnerOnlyRlsAndBoundedQuarantineRetention`:
`relrowsecurity=t`, `relforcerowsecurity=f`, `krug_app` не имеет SELECT/INSERT/UPDATE/DELETE,
`prosecdef=t`, `krug_app` получает `permission denied` при прямом SELECT, вызов функции
удаляет только строку старше 90 дней, свежая и V19-строка остаются, `0` дней → ошибка.

**Требование к деплою:** `DB_USER` (runtime) ≠ `FLYWAY_USER` (owner). Функция должна
принадлежать owner'у схемы; это зафиксировано в SPEC §6.5.3 и README.

## P2-12 — закрытые тестовые пробелы

* **Real-HTTP regressions** (`E2eeMessageRealtimeIT.wireFloorChunkedAndEncodedPathRegressionsArePermanent`):
  * canonический и single-encoded (`%63`, `%6D`, `%6d`) GET — `200`;
  * nested `%2563` — `400/404`, не `200` (добавлен явный запрет `%` после одного decode в
    `ApiRequestPath`, закрыт double-decode-класс P0-01);
  * `;`, `..`, trailing slash, `//` — `400/404`; query — `200`;
  * encoded POST валидного конверта — `201`;
  * floor `271 → 422 ciphertext_too_short`, `272 → 201` (363 b64u), `33040 → 201`
    (44054 b64u), `33041 → 413 ENVELOPE_TOO_LARGE reason=canonical`; в БД ровно 2 строки;
  * chunked без `Content-Length`: ровно `524288` → `201`, `524289` → `413 PAYLOAD_TOO_LARGE`
    (реальный Tomcat, `HttpURLConnection.setChunkedStreamingMode`).
* **WS legacy replay** (`E2eeLegacyEnvelopeIT.legacyEnvelopeIsNullOnWsReplay`): A2 получает
  кадр `message.created` с `crypto:null`/`text:null`; B1 — свой конверт байт-в-байт.
* **271 B HTTP** (`E2eeLegacyEnvelopeIT.legacy271ByteEnvelopeIsNullOnRealHttpAndQuarantinedByV19`):
  `200 crypto:null` до и после реального V19; quarantine `legacy_short`; валидный 272+ не
  тронут.
* **`toDomainOrNull` + log-capture** (`MessageEnvelopeRepositoryAdapterTest`, 2 теста):
  битый header и «неожиданная форма» (NPE в маппере) пропускаются, валидная строка остаётся;
  лог содержит `message_id`/`recipient_device_id`/reason, **не** содержит ciphertext ни в
  b64u, ни в hex. Catch расширен с `IllegalArgumentException | IllegalStateException` до
  `RuntimeException`, чтобы NPE/ClassCast на экзотической строке тоже не давал `500`.
* **Byte-level quarantine** (`E2eeMigrationIT.v19...`): до V19 снимается полный snapshot
  live-строки (включая `workspace_id`, `chat_id`, `session_id`, `header`, `ciphertext`,
  `created_at`); после V19 каждая колонка quarantine сравнивается с snapshot для 16 B и
  271 B строк.

## 5. Проверки

Все команды — в текущем дереве, `JAVA_HOME=JDK 21`, Maven offline
(`-Dmaven.repo.local=.m2repo`). Git-репозитория нет; проверялось фактическое дерево.

```bash
# 1. Полный backend suite
cd backend
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 340, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# surefire: files=79, tests=340, failures=0, errors=0, skipped=0, time≈109 s
# ArchUnit: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
# В логе 3× "Skipping unreadable envelope" — ветка toDomainOrNull реально исполняется,
# ciphertext в этих сообщениях отсутствует (проверено log-capture-тестом).

# 2. Точечные новые/изменённые
JAVA_HOME=$(/usr/libexec/java_home -v 21) mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='MessageEnvelopeRepositoryAdapterTest,E2eeMigrationIT,E2eeLegacyEnvelopeIT,E2eeMessageRealtimeIT' test
# Tests run: 19, Failures: 0, Errors: 0, Skipped: 0

# 3. Contract / generated types
cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.

# 4. Артефакты: contracts/openapi.yaml (mtime 10:13), contracts/ws-protocol.md (10:18),
#    frontend/src/api/schema.d.ts (10:51) не изменялись этой сессией.
#    backend/target/krug-backend-0.1.0-SNAPSHOT.jar — mtime 10:28, СТАРШЕ B3F2/B3F3:
#    перед деплоем собрать jar заново на финальном дереве. Не деплоился.
```

**Что именно проверяет full suite по этой задаче:** `E2eeLegacyEnvelopeIT` 4/4 (16 B, 271 B,
legacy-only replay, WS replay), `E2eeMigrationIT` 9/9 (включая byte-level V19, DELETE-conflict,
V20 RLS/retention, non-superuser owner), `MessageEnvelopeRepositoryAdapterTest` 2/2,
`E2eeMessageRealtimeIT` 4/4 (включая wire-regressions).

## Контракт

| Что | Изменение | Зачем |
|---|---|---|
| `contracts/openapi.yaml` | **нет** | `Message.crypto` уже `oneOf [CryptoEnvelope, null]`; лимиты/коды не менялись |
| `contracts/ws-protocol.md` | **нет** | `message.created` уже допускает `crypto:null` |
| `frontend/src/api/schema.d.ts` | **нет** | контракт не менялся; `contract:check` in sync |
| Поведение API | **без изменения wire** | legacy-only replay явно документирован как `422/409`; tolerant read уже был в B3F2 |

## DDD

Изменения не нарушают слои:

```
shared.infrastructure.web     ApiRequestPath (nested %), без новых зависимостей
shared.infrastructure.config  KrugProperties.E2ee (+retention) — config binding
message.infrastructure        MessageEnvelopeRepositoryAdapter (tolerant mapping),
                              EnvelopeQuarantineRetentionScheduler (JdbcTemplate, infra)
db/migration                  V19 (hardening), V20 (RLS/retention function)
```

Домен/application/API не менялись; ArchUnit 10/10 (в полном suite).

## P2 closure

| Finding | Статус | Что сделано | Доказательство |
|---|---|---|---|
| **P2-09** legacy-only replay даёт 422/409, не 201 | **closed (documented 422/409)** | Решение: не синтезировать 201 для несуществующего конверта; истинный idempotency-replay остаётся 201. Спека/README обновлены. | `E2eeLegacyEnvelopeIT.legacyOnlyReplayIsDocumented422Or409AndNever500`: 201 true replay с валидным телом; 409 conflict/idempotency; 422 short; 500=0. |
| **P2-10** ложное «legacy rows remain readable», нет V19 в docs | **closed** | §6.5.1 исправлен; §4.1/§5.4 дополнены; новый §6.5.3; README V18/V19/V20 + history/WS; TASKS §10. | Текст SPEC/README; `grep` больше не находит «старые строки остаются читаемыми». |
| **P2-11** quarantine без RLS/retention, DELETE без проверки копии | **closed** | V19 `DELETE ... WHERE EXISTS` (PK + bytes); V20 RLS без policy/revoke/индекс + `purge_envelope_quarantine` + scheduler (90 d). | `v19DeleteOnlyRemovesRowsActuallyCopiedToQuarantine`; `v20EnablesOwnerOnlyRlsAndBoundedQuarantineRetention`; byte-level V19 assertion. |
| **P2-12** тестовые пробелы | **closed** | real-HTTP encoded/nested/chunked/floor; WS legacy replay; 271 B HTTP; `toDomainOrNull`+log-capture; byte-level quarantine; DELETE-conflict. | 19/19 focused; 340/340 full; log содержит ids/reason и не содержит ciphertext. |
| **P1-03 / P2-06 / P2-07** | **closed ранее** | Не переоткрывались; regression-тесты зелёные. | 340/0; `E2eeLegacyEnvelopeIT` 4/4. |

## Остаточные риски / что не входит

* **V19 checksum:** V19 усилен в этой задаче (добавлен `WHERE EXISTS`), поэтому его
  контрольная сумма отличается от B3F2-версии. V19 не был задеплоен (флаг off; локальная
  dev-БД на V15, test-БД создаются заново), но если на каком-то стенде B3F2-V19 уже
  применялся, перед обновлением нужен `flyway repair`; строки там уже перенесены старым
  (в штатном потоке тоже lossless) `DELETE`, V20 применится отдельно.
* **V19 rollout:** `ACCESS EXCLUSIVE` + полный scan/`VALIDATE`; на большой таблице нужен
  maintenance window и backup. V19/V20 forward-only; откат — restore. Старые (strict)
  инстансы могут отдавать `500` на legacy-строках, пока V19 не завершён — деплоить новый код
  вместе с V19.
* **Quarantine retention:** 90 дней — default, не согласованная PM политика; окно
  настраивается `krug.e2ee.quarantine-retention-*`. Owner-only RLS без policy защищает от
  будущего широкого `GRANT`, но не от `DB_USER == FLYWAY_USER`; это должно гарантироваться
  деплоем/ops (документировано).
* **Nested `%`:** `ApiRequestPath` теперь отвергает `%` после одного decode; это закрывает
  double-decode-класс для API, но proxy-специфичные нормализации (`%2563` на прокси) всё ещё
  должны проверяться в инфраструктуре E7-F.
* **P1-03 real HTTP** по-прежнему в `test`-профиле (dev-JWT), не `keycloak`; дефект
  repository-маппинга профиль-независим. Отдельного keycloak-прогона этого сценария нет.
* **P2-08 (prekey retention)** и envelope retention остаются B4-долгом; не входили в B3F3.
* **G2/G4/git/one-PR** — внешние условия GO; этот отчёт их не заменяет.
* **Jar:** `krug-backend-0.1.0-SNAPSHOT.jar` (10:28) старше B3F2/B3F3; перед деплоем собрать
  заново. Не деплоился.

---

**Итог:** P2-09/P2-10/P2-11/P2-12 закрыты. Полный suite **340/340** (baseline 332 + 8),
ArchUnit **10/10**, contract **33/58**, E2EE-флаг по умолчанию **false**, wire/contract не
менялись, новых plaintext/decrypt-путей нет. Статус задачи: **DONE**.

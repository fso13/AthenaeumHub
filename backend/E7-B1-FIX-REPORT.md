# E7-B1F — B1 fixes after `docs/E2EE-REVIEW-04.md`

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, необходимые правки `contracts/**`,
> `frontend/src/api/schema.d.ts` и `frontend/scripts/check-contract.mjs` (guard). Явно
> запрошенные отчётные правки: этот файл, `docs/TASKS.md` §8 (`P1/P2 closure`, `Contract`) и
> `docs/E2EE-SPEC.md` §6.5.2 (runbook/роль миграции). Git-репозитория в workspace по-прежнему
> нет, поэтому изменение одним changeset (I-01 F-3) невыполнимо; `contracts/openapi.yaml` и
> `frontend/src/api/schema.d.ts` согласованы и проверены `contract:check`.

## Статус

**DONE** по всем пунктам задания:

* **P1 закрыты 6/6.** P1-01…P1-03 и P1-05…P1-06 реализованы и покрыты тестами;
  **P1-04** — по заданию не реализуется (E2EE send/coverage + 4 строки E-таблицы уходят в
  B3/B4). Завышенная формулировка «I-01 применён» исправлена: I-01 = **contract-side DONE
  (A–D), behavior-side PARTIAL (E: 9/13), F-3 unverifiable (no git)**.
* **P2 закрыты 12/13** из списка задания. **P2-08** (гонка лимита prekey + retention) в
  список не входил и не менялся — остаётся долгом B3.
* Тесты: **300/300** (baseline 282 + 18 новых), ArchUnit **10/10**, `contract:check`
  зелёный, `tsc --noEmit` — 0. V1→V17 исполняется **non-superuser owner'ом без
  `BYPASSRLS`**.

## Сделано

### P1-01 — rate limit на `POST /keys/claim`

* `ops/application/port/RateLimitPort`: новый `checkKeyClaim(principal, chatId, targetDeviceId)`.
* `InMemoryRateLimiter`: независимые fixed-window'ы `claim:user:*`, `claim:chat:*`,
  `claim:device:*`; сообщения (`send:user/chat`) не затронуты. Конфиг:
  `krug.rate-limit.claim-per-user` (60/60s), `claim-per-chat` (10/60s) +
  `claim-user-window`/`claim-chat-window`.
* `KeyClaimService.claim` вызывает лимит **до** цикла claim (после проверки членства), поэтому
  `429 RATE_LIMITED` + `Retry-After` не расходует ни один OPK и не раскрывает устройства.
* Тест `E2eeClaimRateLimitIT`: 3 claim'а в окне, четвёртый → `429`, `Retry-After ≥ 1`,
  `consumed_at` не вырос, другой caller не затронут, обычный send — `201`.
* Контракт: `429` (+`Retry-After`) добавлен к `/keys/claim`.

### P1-02 — identity scoping в `POST /devices`

* `DeviceRepository`/`DeviceRepositoryAdapter`: `findByPositioningIdentityKeys`,
  `findRevokedByIdentityKeys`, `findByIdentityDhKey`, `findByIdentitySigningKey` теперь
  принимают `userId` и фильтруют `user_id = :userId`. Глобальная уникальность остаётся
  задачей БД (V17), app-проверки видят только свои устройства.
* `DeviceRegistrationService.register`/`findExistingIdentityPair` активируют
  `principal.withWorkspace(null)`: эндпоинт device-scoped, workspace-claim dev-токена больше
  не расширяет RLS-видимость.
* `P2-07`-механика (flush внутри try, маппинг constraint'ов) обеспечивает `409
  IDENTITY_KEY_CONFLICT` для чужого bundle вместо `404`/`500`.
* Тест `E2eeLimitsIT.crossUserIdentityBundleIsConflictNotNotFound`: A и B в общем чате
  (peer-устройство видимо по `p_devices_chat_peer`) — B отправляет валидный bundle A → `409`;
  A не изменён; B не видит A в `GET /devices`; cross-workspace bundle → `409`.

### P1-03 — WS `chat.keys.changed` / `device.list.changed` / `session.revoked`

* `auth/application/service/DeviceKeyEvents` — единственная точка эмиссии. В транзакции
  пишется outbox-строка (метаданные) и публикуется Spring-событие; `realtime/infrastructure/
  event/RealtimeDeviceKeyListener` доставляет его **AFTER_COMMIT**.
* `RealtimePublisherPort` + `InMemoryRealtimeHub`: `publishKeyChanged` (подписчики чата, без
  `seq`/`event_id`, не replay), `publishDeviceListChanged` (все live-сессии владельца),
  `publishSessionRevoked` (`session.revoked` + close **4403**, проактивно).
* Триггеры: revoke (`DEVICE_REVOKED`, generation уже ++), verification
  (`VERIFICATION_CHANGED`), prekey-ротация (`KEY_GENERATION_CHANGED` + `device.list.changed`),
  новое capable-устройство (`DEVICE_ADDED`). Для fan-out по всем E2EE-чатам пользователя —
  `chat.e2ee_chat_scopes(uuid)` (SECURITY DEFINER, только `current_user_id()`), т.к. токен
  Keycloak не несёт workspace и RLS иначе вернула бы 0 строк.
* Outbox `ops.outbox` — FORCE RLS по workspace (B-02), поэтому `DeviceKeyEvents` перед каждой
  вставкой активирует tenant-контекст нужного workspace. Для `device.list.changed` при
  отсутствии workspace-claim строка outbox не пишется (колонка NOT NULL), WS-доставка от
  этого не зависит.
* `IDENTITY_KEY_CHANGED` в B1 не эмитится, потому что in-place ротации identity нет
  (revoke терминален, новое устройство — это `DEVICE_ADDED`/`DEVICE_REVOKED`). Константа и
  транспорт готовы; событие появится вместе с rotation в B3/v2 — это не «забытый» путь, а
  отсутствующая операция.
* Тесты `E2eeRealtimeIT` (2): revoke → `device.list.changed` (status REVOKED, gen 2) и
  `chat.keys.changed` у владельца и peer, `session.revoked` + close 4403, target исчез из
  `GET /chats/{id}/keys`, повторный revoke — `204` без дублей, reconnect не реплеит;
  verification/prekey/device-add события. WS-кадры валидируются `WsFrameContract`
  (`keyChanged`, `deviceListChanged` добавлены в `ws-frames.schema.json`).

### P1-05 — V16 реально исполнима под non-superuser owner'ом

* `auth.devices` (backfill `identity_key_alg`), `chat.chats`/`chat.chat_members`
  (preflight/backfill `direct_key`): временный `ALTER TABLE … NO FORCE ROW LEVEL SECURITY`,
  затем `FORCE` обратно **до** `VALIDATE`. `ENABLE` не снимается; `krug_app` всё время под
  tenant-политикой. Flyway выполняет файл одной транзакцией, поэтому падение откатывает и
  `NO FORCE`.
* Добавлен fail-fast `DO`-блок `DEVICE_KEY_BACKFILL_INCOMPLETE`: backfill, не увидевший
  строки, больше не «тихий no-op».
* Тест `E2eeMigrationIT.nonSuperuserOwnerWithoutBypassRlsCanApplyV16AndV17`: `CREATE ROLE
  … NOSUPERUSER NOBYPASSRLS CREATEROLE`, БД принадлежит роли, Flyway V1→V16→V17 от этой роли;
  проверены backfill `LEGACY`, `direct_key`, `relforcerowsecurity=true`, глобальный индекс.
* Runbook `docs/E2EE-SPEC.md` §6.5.2 (разделы 5–7: роль, требования, диагностика, V17,
  откат) + `backend/README.md` (раздел V17/migration role).

### P1-06 — «воскрешение» revoked identity-пары

* `V17__e2ee_identity_hardening.sql`: `ux_devices_identity_sig`/`ux_devices_identity_dh`
  пересозданы **без** `WHERE status <> 'REVOKED'` (уникальность по всем строкам).
* Preflight/cleanup: дубли и NULL-комбинации (которые V16 CHECK пропускал) переносятся в
  `auth.identity_key_quarantine` (owner-only), ключи остаются у одного устройства (ACTIVE,
  затем самый старый), остальные нормализуются в `LEGACY`. Переживший repair дубль → fail-fast
  `IDENTITY_KEY_DUPLICATE_UNRESOLVED`.
* Приложение: своя revoked-пара → `410 DEVICE_REVOKED`; чужая/дубль → `409
  IDENTITY_KEY_CONFLICT` (unique-индекс). Комментарий V16 исправлен (partial-индексы V16 —
  исторический шаг, инвариант обеспечивает V17).
* Тесты: `v17MakesIdentityUniquenessHardAndAllOrNoneNullSafe` (revoked-дубль → 409, строки
  user2 нет, quarantine, индекс без `REVOKED`), cross-user `409` в `E2eeLimitsIT`.

### P2-01 — all-or-none CHECK

V17: `ck_devices_keys_all_or_none` заменён на трёхзначно-безопасный предикат (явные
`IS NOT NULL` до `octet_length`, ветки LEGACY/Ed25519+X25519), `NOT VALID` → `VALIDATE`.
Негативные вставки `(alg='Ed25519+X25519', sig != NULL, dh NULL)` → `23514`. Ремонт старых
строк — в quarantine (P1-06).

### P2-02 — единый capability-предикат

* `auth.device_is_e2ee_capable(status, alg, sig, dh, binding, fingerprint)` (V17): ACTIVE +
  Ed25519+X25519 + все четыре поля с точными длинами.
* Используется в `countActiveE2eeCapable`, `peerHasE2eeCapableDevices`, `listActiveSummaries`
  (`peer_capable`), проверке target'а verification-триггера, `user_has_e2ee_capable_device`.
  `DeviceRepository.findActiveByUserIds` требует все четыре поля (JPQL) — совпадает с
  доменом; `Device` уже гарантирует fingerprint инвариантом `requireKeyInvariant`.
* Тест сверяет SQL-функцию для legacy/revoked/active (true только для полного ACTIVE).

### P2-03 — scope-триггер verification

`auth.check_key_verification_scope()` (V17): target ACTIVE + capable (`device_is_e2ee_capable`),
verifier device ACTIVE и принадлежит `verifier_user_id`, плюс прежние проверки чата/членства.
Тесты: revoked target → `VERIFICATION_SCOPE_MISMATCH`, revoked verifier device → mismatch,
ACTIVE-capable пара → insert ok; ACTIVE legacy verifier разрешён (по спеке требуется ACTIVE,
не capable).

### P2-04 — `verified` и `target_key_generation`

`ChatKeysService.toInfo` выставляет `verified=true` только при
`verification.target_key_generation == device.keyGeneration()`; `verified_count` считается по
тем же флагам; `countByOtherVerifierDevices` дополнительно сверяет generation в SQL.
Тест: verification при gen=1 → verified; SQL gen→2 → `verified=null`, `verified_count=0`;
gen→1 → снова verified.

### P2-05 — `409 KEY_CHANGED` + `Idempotency-Key` verification

* `VerificationRequest.expected_key_generation` (optional, ≥1): несовпадение → `409
  KEY_CHANGED` (details `expected/actual`), запись не создаётся.
* `ChatKeysService.verifyDevice` использует `IdempotencyPort` (scope `PUT
  /api/v1/chats/{chatId}/keys/verification`, хэш запроса); replay отдаёт **исходную** строку
  (`verified_at`, `id`) через `KeyVerificationRepository.findById`. Тенант-контекст для
  idempotency передаётся с workspace чата, иначе последующий insert упёрся бы в RLS.
* Тест: stale generation → 409; повтор того же ключа → тот же `verified_at`, одна строка.

### P2-06 — DIRECT race / GROUP idempotency

* `ChatRepository.saveDirectChat` → `INSERT … ON CONFLICT DO NOTHING` (без target, покрывает и
  partial `ux_chats_direct_pair`) и возвращает `boolean`. `ChatCreateService` при `false`
  перечитывает победителя и отдаёт `200`; PostgreSQL не ловит unique-violation в середине
  транзакции, поэтому «поймать исключение и перечитать» было бы неверно.
* GROUP: `IdempotencyPort` (scope по workspace, хэш `GROUP\n<name>`), replay → тот же чат.
* Тесты: два параллельных DIRECT-запроса → `{200, 201}`, один чат; повтор DIRECT → `200`;
  GROUP с тем же ключом → тот же id, с другим → новый.

### P2-07 — flush внутри try

`DeviceRepository.flush()` + `DeviceRegistrationService`: `save`+`flush` в `try`;
`ck_devices_*` → `422 INVALID_KEY_FORMAT`, unique (`ux_devices_identity_*`) → `409
IDENTITY_KEY_CONFLICT`. Тест — cross-user bundle → 409 (не 500).

### P2-09 — guard не тавтология

`frontend/scripts/check-contract.mjs`: `length = 33` → `length === 33`. Mutation-проверка:
`=== 32` → `Contract check failed: … exactly 33 operations`; `=== 33` → passed.

### P2-10 — flag-on onboarding и E2EE-only-DIRECT

* Доменное правило `Chat.requireSupportedType(mode, type)` (E2EE + GROUP → `409
  E2EE_GROUP_NOT_SUPPORTED`) используется и `ChatCreateService`, и `Chat.provisioning`
  (`Chat.createGroup`).
* `WorkspaceOnboardingService`: для E2EE-воркспейса default «Общий чат» **не создаётся**;
  MANAGED — без изменений.
* E2EE DIRECT: оба участника должны иметь ACTIVE capable-устройство
  (`auth.user_has_e2ee_capable_device`, SECURITY DEFINER, т.к. чата ещё нет и
  `p_devices_chat_peer` не работает) → иначе `409 E2EE_NO_ACTIVE_DEVICES`.
* Тест `E2eeFlagOnIT` (flag on): E2EE-воркспейс создан, чатов 0, GROUP → 409
  E2EE_GROUP_NOT_SUPPORTED, DIRECT без устройств → E2EE_NO_ACTIVE_DEVICES, после регистрации
  capable-устройств → `201 E2EE`, повтор → `200` тот же чат, список чатов валиден.

### P2-11 — `one_time_prekeys:[null]`

`DeviceRequestMapper.toOneTime`: null-элемент → `422 INVALID_KEY_FORMAT` (без NPE/500);
`400` добавлен в контракт `POST /devices` (bean validation `name`/`platform`). Тест: raw JSON
`[null]` → 4xx с `INVALID_KEY_FORMAT`, устройство не создано.

### P2-12 — EXPLAIN

`E2eeQueryPlanIT` на реалистичных объёмах (3000 устройств, 3000 OPK, 2000 конвертов):
`EXPLAIN (FORMAT JSON)` для claim (`auth.device_prekeys`, partial index или pkey — без Seq
Scan), списка устройств (`ix_devices_user_status`), identity (`ux_devices_identity_sig`),
конвертов получателя (`…recipient_device_id…` в плане партиции). Seq Scan отсутствует.

### P2-13 — тестовые пробелы

`E2eeLimitsIT` (10 тестов): `409 IDENTITY_KEY_CONFLICT` (cross-user/cross-workspace),
`DEVICE_LIMIT_REACHED`, `NO_SPK` (просроченный SPK + здоровое устройство), repeat DIRECT →
`200` тем же id, конкурентный DIRECT, GROUP idempotency, `[null]`, `KEY_CHANGED`+replay,
`verified` vs generation, cross-workspace claim → 403 без расхода OPK, GROUP-ответ без
peer/capability.

## Файлы

### Миграции

* `backend/src/main/resources/db/migration/V16__e2ee_device_keys.sql` — NO FORCE окна,
  fail-fast `DEVICE_KEY_BACKFILL_INCOMPLETE`, исправленный комментарий про uniqueness.
* `backend/src/main/resources/db/migration/V17__e2ee_identity_hardening.sql` — quarantine,
  cleanup, глобальные unique-индексы, NULL-safe CHECK, capability-функция, scope-триггер,
  `auth.user_has_e2ee_capable_device`, `chat.e2ee_chat_scopes`, индекс
  `ix_key_verifications_verifier_chat`.

### Backend

* `auth`: `DeviceRepository`/`DeviceRepositoryAdapter`, `DeviceRegistrationService`,
  `DeviceRevocationService`, `PrekeyUploadService`, `KeyClaimService`, `ChatKeysService`,
  `DeviceQueryService` (без изменений), `KeyVerificationRepository(+Adapter)`,
  `DeviceKeyEvents`, события `DeviceKeyChangedEvent`/`DeviceListChangedEvent`/
  `DeviceSessionRevokedEvent`, `DeviceRequestMapper`, `VerificationRequest`,
  `DeviceKeyController`.
* `chat`: `Chat` (доменное правило), `ChatRepository(+Adapter)` (capability-функция,
  `userHasE2eeCapableDevice`, conflict-safe DIRECT), `ChatCreateService`, `ChatProvisioning`
  (через `Chat.createGroup`), `ChatKeyScopePort`/`ChatKeyScopeAdapter`.
* `workspace`: `WorkspaceOnboardingService` (no default E2EE GROUP).
* `ops`: `RateLimitPort`, `InMemoryRateLimiter`.
* `realtime`: `RealtimePublisherPort`, `InMemoryRealtimeHub`, `WsFrameCodec`,
  `RealtimeDeviceKeyListener`.
* `shared`: `KrugProperties` (+claim-лимиты), `application.yml`.

### Контракт / типы / guard

* `contracts/openapi.yaml`: `400` на `POST /devices`; `429` на `POST /keys/claim`; optional
  `expected_key_generation` в `VerificationRequest`.
* `contracts/ws-protocol.md`: уточнение про prekey-ротацию → `KEY_GENERATION_CHANGED`
  (в фиксированном enum §6.3.1 C нет отдельного prekey-reason), generation не меняется.
* `frontend/src/api/schema.d.ts` — перегенерирован `npm run api:types`.
* `frontend/scripts/check-contract.mjs` — `===` в guard.

### Тесты

* Новые: `E2eeLimitsIT` (10), `E2eeClaimRateLimitIT` (1), `E2eeRealtimeIT` (2),
  `E2eeFlagOnIT` (1), `E2eeQueryPlanIT` (1), `support/WsTestClient`.
* Расширены: `E2eeMigrationIT` (3 → 6), `ws-frames.schema.json` (+2 `$defs`),
  `WorkspaceOnboardingServiceTest` (E2EE без default-чата), `SubscriptionServiceTest`
  (новый port), `DeviceRegistrationServiceTest` (совместимый конструктор).

## Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd backend
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 300, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit 10/10; baseline 282 + 18 новых

mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMigrationIT' test
# 6/6: V16 normal/degraded/deleted, corrupt/duplicate preflight,
#      V17 uniqueness/NULL-safe/trigger, non-superuser owner V16+V17

mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeDeviceKeyIT,E2eeLimitsIT,E2eeClaimRateLimitIT,E2eeRealtimeIT,E2eeFlagOnIT,E2eeQueryPlanIT' test
# 7 + 10 + 1 + 2 + 1 + 1 = 22/22

cd ../frontend
npm run api:types
npm run contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync.
npx tsc -p tsconfig.json --noEmit      # exit 0
# mutation (P2-09): length === 32 -> "Contract check failed: ... exactly 33 operations";
#                   length === 33 -> passed
```

Стабильность набора: `FileContractIT.quarantinedDownloadErrorMatchesErrorSchema` один раз
упал по таймингу фонового scan-воркера в полном прогоне (изолированно и на повторе —
зелёный); фикстуры `E2eeQueryPlanIT` теперь удаляются в `@AfterEach`, чтобы 5k «шумовых»
строк не влияли на последующие тесты. `OutboxIT` закреплён
`krug.outbox.relay.enabled=false` в его контексте: планировщик мог опубликовать строку
между insert и явным `publishPending()` (timing-flake, не связанный с B1F-логикой).

Покрыто новыми/расширенными тестами: OPK-истощение под лимитом, cross-user/cross-tenant
identity conflict, DEVICE_LIMIT, NO_SPK, DIRECT repeat/race, GROUP idempotency, `[null]`,
KEY_CHANGED/idempotent replay, verified-vs-generation, cross-workspace claim, WS key events
(no `seq`, no replay, 4403), flag-on onboarding/capability gate, EXPLAIN-планы, V17
quarantine/unique/CHECK/trigger, миграция под non-superuser owner'ом.

## Контракт

| Изменение | Причина |
|---|---|
| `POST /devices` → `400` | bean-validation и `[null]`-элементы документированы (P2-11) |
| `POST /keys/claim` → `429` + `Retry-After` | новый rate limit (P1-01) |
| `VerificationRequest.expected_key_generation` (optional) | `409 KEY_CHANGED` достижим и проверяем (P2-05) |

Схем/путей не добавляли: **28 paths / 33 operations / 58 schemas** — без изменений.
`schema.d.ts` соответствует YAML (генерируется, вручную не правился); guard исправлен и
прошёл mutation-проверку. Git отсутствует: I-01 F-3 («закоммитить одним PR») невыполним;
файлы контракта и типов согласованы в рабочем дереве.

## DDD

```
auth.application.service.DeviceKeyEvents        — единая точка key-events (application)
auth.application.event.*                        — платформенно-нейтральные события
chat.application.port.ChatKeyScopePort          — published read port (без кросс-модульного SQL в application)
chat.infrastructure.persistence.ChatKeyScopeAdapter
realtime.infrastructure.event.RealtimeDeviceKeyListener — AFTER_COMMIT → RealtimePublisherPort
realtime.infrastructure.ws.*                    — кадры/хаб/close 4403
```

ArchUnit: **10/10** — domain без Spring/JPA, application ↛ infrastructure/api, api ↛
domain/infrastructure, WS-транспорт только в `realtime.infrastructure.ws`.

## Риски и вопросы

1. **P2-08 не закрыт** (не входил в список): гонка лимита 200 OPK и отсутствие retention для
   `consumed_at/retired_at/expires_at` остаются. До B3 нужен SECURITY DEFINER/`FOR UPDATE`
   либо `INSERT … WHERE count < 200` + retention-джоб.
2. **Prekey-reason.** В enum §6.3.1 C нет отдельного значения для ротации prekey; используется
   `KEY_GENERATION_CHANGED` (generation не меняется) + `device.list.changed`. Это
   интерпретация, зафиксированная в `contracts/ws-protocol.md`; если PM хочет отдельный
   `PREKEY_ROTATED` — это новое решение по спеке, не правка B1.
3. **`device.list.changed` без outbox-строки** при Keycloak-принципале без workspace-claim
   (колонка `ops.outbox.workspace_id NOT NULL`). WS-доставка после commit от этого не
   зависит; durable Kafka-путь для device-событий остаётся stub (B-01/SL-02).
4. **Hub по-прежнему in-process** (E3): multi-node fan-out key-events требует Redis/Kafka
   pub/sub — следующий срез.
5. **P1-04 / B3-B4:** E2EE send/envelopes/`envelope_coverage` и 4 строки E-таблицы не
   реализованы; контрактные коды (`E2EE_LEGACY_DEVICE`, `E2EE_NO_PEER_ENVELOPE`,
   `E2EE_PLAINTEXT_FORBIDDEN`, coverage) остаются недоказуемыми до B3/B4. I-01 =
   PARTIAL (behavior-side).
6. **Git:** нет репозитория → patch-bundle не создавался; согласованность contract ↔
   `schema.d.ts` подтверждена `contract:check`, но «один changeset» проверить нельзя.

## Что дальше

1. E7-B3/B4: E2EE send, envelopes/fan-out, coverage, 4 отложенные E-строки + contract-тесты.
2. P2-08: атомарный лимит prekey + retention; Redis rate limiter (B-03).
3. Multi-node realtime (Redis pub/sub) до горизонтального масштабирования.
4. G2 (браузерные KAT) и G4 (внешний crypto-review) — предусловия включения
   `KRUG_E2EE_ENABLED`.

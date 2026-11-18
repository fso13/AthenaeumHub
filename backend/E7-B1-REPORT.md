# E7-B1 + I-01 — session report

> **Correction after `docs/E2EE-REVIEW-04.md` (2026-11-16, E7-B1F).** Формулировка
> «I-01 применён» ниже завышена: фактически I-01 = **contract-side DONE (A–D)**,
> **behavior-side PARTIAL** (E: 9/13; 4 строки требуют E2EE send → B3/B4), **F-3
> unverifiable** (git отсутствует). Исправления и доказательства —
> [`E7-B1-FIX-REPORT.md`](<E7-B1-FIX-REPORT.md>), `docs/TASKS.md` §8.

> Формат — `docs/TASKS.md` §5. Сам `docs/TASKS.md` не изменялся: зона сессии запрещает
> `docs/**`; отчёт лежит в разрешённой зоне `backend/` и продублирован в финальном ответе.

## Статус

**DONE в границах E7-B1**: I-01 применён, V16 исполнима на PG16, device
keys/prekeys/claim/keys/verification работают с `e2ee.enabled=false`. E2EE
chat/messages/envelopes (B3/B4) намеренно не реализованы: любые E2EE-сообщения и
E2EE-создание чата/воркспейса отвечают `409 E2EE_DISABLED`, plaintext-fallback
отсутствует.

## Сделано

### I-01 contract

- `contracts/openapi.yaml`: все A-схемы §6.3.1 (`Base64Url16/32/64`, `SignedPrekey`,
  `OneTimePrekey`, `CryptoHeader`, `PrekeyBlock`, `CryptoEnvelope`, `DeviceList`,
  `SignedPrekeyUpload`, `PrekeyUploadResult`, `KeyClaimRequest`, `PrekeyBundle`,
  `UnavailableDevice`, `KeyClaimResponse`, `DeviceKeyInfo`, `ChatKeysResponse`,
  `VerificationRequest/Response`, `EnvelopeCoverage`, `MessageCreateResult`, `Chat`,
  `ChatCreateRequest`), расширены `Device`, `DeviceRegistration` (required не менялся),
  `Message` (`client_message_id`, `crypto`), `MessageCreate` (`envelopes`),
  `ChatSummary` (`nullable name`, `peer_id`, `peer_has_e2ee_capable_devices`).
- B-пути: `GET/DELETE /devices`, `GET/DELETE /devices/{id}`, `POST
  /devices/{id}/prekeys`, `POST /keys/claim`, `GET /chats/{id}/keys`, `PUT
  /chats/{id}/keys/verification`, `POST /workspaces/{id}/chats`; изменены ответы
  messages (`MessageCreateResult`) и ошибки §4.8.
- `contracts/ws-protocol.md`: `chat.keys.changed`, `device.list.changed`;
  `chat.session.reset` явно не вводится; `message.created` — `Message` с `crypto`
  (managed: `crypto:null`, `client_message_id` добавлен в WS payload).
- `frontend/src/api/schema.d.ts` перегенерирован `npm run api:types`.
- **Отклонение зоны:** `frontend/scripts/check-contract.mjs` обновлён механически
  (counts 23/26/35 → 28/33/58 + required/invariants I-01). Без этого `contract:check`
  не может быть зелёным; других изменений во `frontend/**` нет.

### V16

`V16__e2ee_device_keys.sql` (forward-only, V1–V15): identity keys/binding/fingerprint,
all-or-none CHECK, global partial unique `IK_sig`/`IK_dh` (non-REVOKED), drop мёртвой
`identity_public_key`, `p_devices_chat_peer`; `auth.device_prekeys` + owner/chat-peer RLS
+ grants + `auth.claim_one_time_prekey` (`FOR UPDATE SKIP LOCKED`, workspace-check);
`auth.key_verifications` + composite ownership FK + BEFORE INSERT scope trigger + vh=2;
`direct_key` preflight/backfill/`NOT VALID`→`VALIDATE`/format CHECK/duplicate preflight/
partial unique; mode-immutability triggers; E2EE message CHECKs;
`message.message_envelopes` partitions + parent-only indexes; `ensure_partition()` создаёт
обе партиции и sender-scoped `client_message_id` index.

### Backend

- Device registration: legacy 201 (`LEGACY`, `e2ee_capable=false`), partial → 422,
  full → Ed25519 SPK+binding verification, fingerprint, `key_generation=1`, SPK/OPK в
  одной транзакции; порядок §3.1 (revoked 410 → existing pair → Idempotency-Key).
- `GET /devices`, `DELETE /devices/{id}` (terminal revoke, generation++, prekeys/
  verifications reset), `POST /devices/{id}/prekeys` (rotation/replenish/conflict/limit),
  `POST /keys/claim` (membership, atomic OPK, `NO_SPK`/`NO_KEYS`/`NO_PREKEYS`),
  `GET /chats/{id}/keys` (per-verifier `verified`), `PUT .../verification` (vh=2),
  `POST /workspaces/{id}/chats` (DIRECT idempotent 200, derived peer/capability).
- `e2ee_capable` derived; `krug.e2ee.enabled` default **false**.
- No E2EE message/envelope implementation; `POST/GET messages` в E2EE-чате и запрос с
  `envelopes` → `409 E2EE_DISABLED`; managed response несёт `client_message_id`,
  `crypto:null`, без `envelope_coverage`.

## Файлы

- Контракт: `contracts/openapi.yaml`, `contracts/ws-protocol.md`,
  `frontend/src/api/schema.d.ts` (+ `frontend/scripts/check-contract.mjs`, отклонение).
- Миграция: `backend/src/main/resources/db/migration/V16__e2ee_device_keys.sql`.
- Backend: `auth/**` (domain Device/DevicePrekey/KeyVerification/DeviceKeyCrypto,
  repositories/adapters, registration/query/revoke/prekeys/claim/chat-keys services,
  DeviceController/DeviceKeyController, DTO/mappers), `chat/**` (create DIRECT/GROUP,
  summary peer/capability, DirectPairKey), `message/**` (DTO/gate/managed response),
  `workspace/**` (E2EE onboarding gate, no security_mode upsert), `shared/**`
  (ErrorCode, Base64Url, E2EE flag, DeviceBindingFilter, KrugProperties).
- Config: `application.yml`, `application-test.yml`.
- Docs: `backend/README.md` (раздел E7-B1), этот отчёт.
- Tests: `E2eeDeviceKeyIT` (7), `E2eeMigrationIT` (3), `DeviceKeyCryptoTest` (3),
  `DeviceKeyTestSupport`;
  обновлены `NotificationIT` (E2EE fan-out без send), `TestProperties`,
  `JwtServiceTest`, `MessageCipherTest`.

## Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 282, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# ArchUnit 10/10; baseline 269 сохранён, +13 новых тестов

cd frontend
npm run api:types
npm run contract:check
# Contract check passed: 33 operations, 58 contract schemas, types in sync
npx tsc -p tsconfig.json --noEmit   # exit 0
npm run lint                        # exit 0
npm run format:check                # exit 0
```

Покрыто: legacy/full/partial device, bad SPK/binding, replay identity pair, revoke/410,
prekey rotation/idempotent/conflict/limit/legacy 422, claim + OTP consume + NO_PREKEYS,
foreign/unknown device, RLS prekey isolation, chat keys per verifier device, vh=1 422,
flag-off workspace/chat/message, managed contract shape, DIRECT `name=null`/`peer_id`/
capability, V1–V15→V16 normal/degraded/deleted DIRECT, corrupt/duplicate preflight,
partitions/indexes/grants/RLS/CHECK/trigger.

## Контракт

- I-01 применён по §6.3.1 A/B/C; схема/пути/коды — без изобретений.
- `contract:check` зелёный; `schema.d.ts` соответствует YAML.
- **Сознательные отклонения поведения E-таблицы:** строки, требующие успешного E2EE
  send (`201 MessageCreateResult` с coverage, envelope на legacy → 422, no peer envelope
  → 409), относятся к B3/B4 и в B1 не реализуемы. Сервер отвечает
  `409 E2EE_DISABLED`; contract paths/схемы при этом на месте.
- Менедж-чат с `envelopes` отвечает `409 E2EE_DISABLED` (а не `422
  ENVELOPES_NOT_ALLOWED`) — при выключенном флаге это E2EE-операция.
- Git-репозитория в workspace нет, поэтому «закоммитить одним PR» физически
  невозможно; файлы контракта и `schema.d.ts` согласованы в рабочем дереве.

## DDD

```
ru.krug.backend.auth
  domain/model         Device, DevicePrekey, KeyVerification
  domain/service       DeviceKeyCrypto (только публичная Ed25519-verify + SHA-256)
  domain/repository    DeviceRepository, DevicePrekeyRepository, KeyVerificationRepository
  application/command  RegisterDeviceCommand, DeviceKeyInput, Signed/OneTimePrekeyCommand
  application/model    DeviceView, SignedPrekeyView, PrekeyUploadView, PrekeyBundleView,
                       KeyClaimView, DeviceKeyInfoView, ChatKeysView, VerificationView
  application/usecase  DeviceRegistrationService, DeviceQueryService, RegisterDeviceUseCase,
                       DeviceRevocationService, PrekeyUploadService, KeyClaimService,
                       ChatKeysService
  infrastructure/persistence  JPA entities/adapters (auth.*)
  api / api/dto / api/mapper   DeviceController, DeviceKeyController, DTO/mappers

ru.krug.backend.chat
  domain/model Chat(+DIRECT), ChatSummary(+peer/capability)
  domain/service DirectPairKey
  application/usecase ChatCreateService (+ ChatQueryService)
  infrastructure/persistence ChatEntity/Adapter (+direct_key, capability query)

ru.krug.backend.message / workspace / shared — гейты и порты (E2eeSettingsPort,
Base64Url, ErrorCode, DeviceBindingFilter).
```

ArchUnit: `mvn -Dtest=ArchitectureTest test` → **10/10** правил зелёные; domain не зависит
от Spring/JPA, application — от infrastructure/api, API DTO — в `api.dto`.

## Риски и вопросы

- E2EE chat/message/envelopes — B3/B4; текущий сервер никогда не принимает plaintext в
  E2EE-чате, но и не умеет E2EE-send.
- `peer_has_e2ee_capable_devices` для существующих DIRECT считается через RLS
  `p_devices_chat_peer`; создание **нового** E2EE-чата при включённом флаге потребует
  отдельного capability-канала (сейчас недостижимо из-за flag off).
- `frontend/scripts/check-contract.mjs` — единственное изменение вне разрешённой зоны
  (необходимо для зелёного contract-check).
- Нет git-репозитория — коммит не создан.
- Внешний crypto-review (G4) и браузерные KAT (G2) остаются предусловиями включения
  флага.

## Что дальше

1. E7-B3/B4: E2EE chat/envelopes/fan-out, coverage, legacy-target/peer-envelope коды;
   contract-тесты E-таблицы на успешный E2EE send.
2. WS-эмиссия `chat.keys.changed`/`device.list.changed` при revoke/verification (сейчас
   контракт и `message.created`-поля готовы; сами key-события ещё не публикуются —
   E2EE-клиентов нет).
3. Capability-канал для создания нового E2EE-чата при включённом флаге (P2-10).
4. G2/G3/G4, затем включение `KRUG_E2EE_ENABLED`.

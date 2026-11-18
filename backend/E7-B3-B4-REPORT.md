# E7-B3/B4 — E2EE chat, envelopes, send/history/WS

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, минимальные правки
> `contracts/**` (только документация WS-лимитов) и этот отчёт. `frontend/**`,
> `docs/**` (кроме согласованного `docs/TASKS.md` §9), `design/**` не менялись;
> `frontend/src/api/schema.d.ts` не потребовал регенерации — `contracts/openapi.yaml`
> не изменился (проверено `npm run contract:check`).
> Схема/миграции не расширялись: B3/B4 используют `message.message_envelopes` и
> E2EE-CHECK'и из V16, а также V17 capability-предикат.

## Статус

**DONE в границах E7-B3/B4.** E2EE DIRECT-чат создаётся, неизменяем и не порождает
plaintext-системных сообщений; `POST /chats/{id}/messages` принимает только opaque
`envelopes[]`, валидирует форму/права/покрытие и никогда не расшифровывает; `GET`
отдаёт `crypto` только адресату `X-Device-Id`; `message.created` собирается per-device;
все коды §4.8 достижимы. **I-01 behavior-side E закрыт (13/13)**: четыре отложенные
строки E-таблицы теперь реализованы и покрыты тестами. F-3 («одним PR») по-прежнему
непроверяем: git-репозитория в рабочем дереве нет.

Вне scope и не реализовано: клиентский X3DH/Double Ratchet (E7-F), key backup, E2EE
groups/files/stickers, G4, включение флага по умолчанию.

## Сделано

### 1. E2EE chat creation (§6.2.8)

* `POST /workspaces/{id}/chats` в E2EE-воркспейсе создаёт `DIRECT` c
  `security_mode=E2EE` (режим наследуется от воркспейса и не задаётся запросом).
* `E2EE + GROUP` → `409 E2EE_GROUP_NOT_SUPPORTED` (единое доменное правило
  `Chat.requireSupportedType`, включая onboarding).
* `security_mode` неизменяем: API не имеет поля, DB-триггеры V16 дают
  `MODE_CHANGE_FORBIDDEN` на `chat.chats` и `workspace.workspaces` (тест).
* Сервер не создаёт системных сообщений в E2EE-чате: членство/ключи приходят
  WS-событиями, в `message.messages` нет ни одной `SYSTEM`-строки (тест).
* Оба участника обязаны иметь ACTIVE `e2ee_capable`-устройство; иначе
  `409 E2EE_NO_ACTIVE_DEVICES` (существующий гейт B1F, регрессия покрыта).
* Флаг off: создание E2EE-чата → `409 E2EE_DISABLED` **до** любых записей (тест).

### 2. E2EE send: envelopes, coverage, идемпотентность (§4.1/§4.2/§4.5/§4.7)

* `MessageCreateInput` больше не считает `envelopes` «непрозрачным мусором»:
  `EnvelopeCodec` (application) строго парсит `envelopes[1..10]`:
  canonical unpadded base64url (decode→encode совпадает), точные длины
  (`session_id` 16, identity/SPK/OPK/dh 32, signature 64), `v=1`,
  `scheme=PAIRWISE_X3DH_DR`, диапазоны `pn/n/key_generation` 0..2^31-1,
  `additionalProperties:false` для envelope/`header`/`prekey`,
  ciphertext: form guard 65536 до decode, decoded 16..33040, encoded ≤44054.
  Ошибки: `INVALID_ENVELOPE_FORMAT`, `UNSUPPORTED_ENVELOPE_VERSION`,
  `ENVELOPE_TOO_LARGE` (`details.reason=form|canonical`, HTTP 413).
* Тело запроса ≤524288 B проверяется **до** JSON-парсинга отдельным
  `PayloadLimitFilter` (Content-Length не обязателен: тело читается bounded, затем
  отдаётся кэшированный wrapper). Ошибка — `413 PAYLOAD_TOO_LARGE` с контрактным
  `Error`-конвертом.
* `E2eeEnvelopeValidator` проверяет только публичные факты:
  * `chat_id` = путь; `sender_device_id` = `X-Device-Id` (ACTIVE capable устройство
    вызывающего, принадлежит ему);
  * `sender_key_generation`/`recipient_key_generation` = текущие generation →
    иначе `409 KEY_CHANGED` (`details.expected/actual`);
  * `prekey.sender_identity_signing_key`/`..._dh_key` = зарегистрированные ключи
    устройства (P0-2b) → иначе `422 INVALID_ENVELOPE_FORMAT` с точным
    `details.field`;
  * получатель — ACTIVE capable устройство участника чата; legacy-получатель →
    `422 E2EE_LEGACY_DEVICE` (`details.field="envelopes[i].recipient_device_id"`),
    без частичного fan-out;
  * self-envelope и дубли recipient'ов запрещены
    (`INVALID_ENVELOPE_FORMAT`/`DUPLICATE_ENVELOPE`);
  * membership/неизвестное/revoked устройство → `422 UNKNOWN_DEVICE`.
* Coverage (§4.2, P1-B/P1-B-1/P1-7): считаются только ACTIVE `e2ee_capable`
  устройства. `peer_devices==0` → `409 E2EE_NO_ACTIVE_DEVICES`;
  `peer_covered==0` → `409 E2EE_NO_PEER_ENVELOPE`; частичное покрытие → `201` +
  `warning` (`PEER_DEVICE_UNCOVERED` приоритетнее `SELF_DEVICE_UNCOVERED`);
  `uncovered_device_ids` — только capable-устройства. Ответ содержит
  `envelope_coverage` (devices/covered/peer/self/uncovered/warning) и валидируется
  контрактом `MessageCreateResult`.
* Plaintext запрещён: `text`, `sticker_id`, `attachment_ids`, `reply_to_id`,
  `type != TEXT` → `422 E2EE_PLAINTEXT_FORBIDDEN` с `details.field`; `envelopes` в
  managed-чате (флаг on) → `422 ENVELOPES_NOT_ALLOWED`; пустой/отсутствующий
  `envelopes` в E2EE → `422 ENVELOPES_REQUIRED`.
* `seq` выделяется только после полной валидации (нет «дыр» и частичных записей);
  `message.messages` пишется с `crypto_scheme=E2EE_PAIRWISE`, без body/sticker/
  `reply_to_id`/`content_meta`, `sender_device_id` обязателен. Каждый конверт
  пишется в `message.message_envelopes` как opaque bytes (session_id/header/
  ciphertext/prekey) с одним `created_at` на сообщение (PK
  `(message_id, recipient_device_id, created_at)` не мешает двум конвертам).
* Идемпотентность: `Idempotency-Key` с теми же bytes → `201` +
  `Idempotent-Replay: true`, тот же `id`/`seq`/coverage. `client_message_id`
  scoped `(chat, sender)`: тот же отправитель + exact same bytes → replay
  (det-chекин до `seq`), другой body или другой отправитель →
  `409 CLIENT_MESSAGE_ID_CONFLICT` (никогда не replay и не возврат чужого
  сообщения). Для сравнения bytes используется детерминированный
  `EnvelopeFingerprint` (SHA-256 канонических полей, не хранится и не логируется).
* Сервер не расшифровывает и не выводит ключи: сохранённый ciphertext побайтово
  равен присланному; `body_ciphertext IS NULL`; в логах нет ни plaintext, ни
  ciphertext, ни ключей.

### 3. E2EE history (§4.3)

* `GET /chats/{id}/messages` в E2EE: `text:null`, без sticker/attachments/
  `reply_to_id`; `crypto` — **только** конверт для `X-Device-Id` (SQL-фильтр
  `workspace_id + recipient_device_id + message_id IN (...)` под RLS).
* Для своих отправленных, других устройств того же пользователя и legacy-устройств
  `crypto:null`. Конверты других устройств и их число не отдаются.
* Флаг off → `409 E2EE_DISABLED`. Серверного поиска/DLP по E2EE-контенту нет.
* `Message.client_message_id` присутствует всегда (nullable) для сопоставления
  локальной копии.

### 4. Realtime (§4.4)

* `RealtimeEvent` получил in-process `cryptoByDevice`; `WsFrameCodec.event(event,
  deviceId)` подставляет в `payload.crypto` только конверт устройства соединения
  (или `null`), сама map на провод не попадает и не персистится.
* `message.created` для E2EE: `text:null`, `client_message_id`, `crypto` =
  конверт устройства соединения (у отправителя на своём устройстве — `null`;
  у устройства без конверта — `null`). Это ровно wire-контракт
  `contracts/ws-protocol.md`/§4.4; «конверты других устройств» доступны только
  через `GET` и только своему `X-Device-Id`.
* Replay (`RealtimeChatHistoryAdapter`) резолвит конверт по `deviceId` сессии;
  live и replay дают одинаковый `Message`.
* `chat.keys.changed`/`device.list.changed`/`session.revoked` не менялись
  (B1F), контента не несут.

### 5. Коды ошибок (§4.8) — достижимы

`E2EE_DISABLED`, `E2EE_LEGACY_DEVICE`, `E2EE_NO_ACTIVE_DEVICES`,
`E2EE_NO_PEER_ENVELOPE`, `E2EE_PLAINTEXT_FORBIDDEN`, `ENVELOPES_REQUIRED`,
`ENVELOPES_NOT_ALLOWED`, `TOO_MANY_ENVELOPES`, `DUPLICATE_ENVELOPE`,
`INVALID_ENVELOPE_FORMAT`, `UNSUPPORTED_ENVELOPE_VERSION`, `ENVELOPE_TOO_LARGE`
(413), `PAYLOAD_TOO_LARGE` (413), `KEY_CHANGED` (409),
`CLIENT_MESSAGE_ID_CONFLICT` (409), `UNKNOWN_DEVICE`.

## Файлы

### Domain

* `message/domain/model`: `CryptoScheme`, `CryptoEnvelope`, `EnvelopeHeader`,
  `EnvelopePrekey`, `MessageEnvelope`; `Message` (+`cryptoScheme`, `createE2ee`,
  E2EE-инварианты, `isE2ee`).
* `message/domain/repository/MessageEnvelopeRepository` (saveAll/для устройства/
  для сообщения), `MessageRepository` (sender-scoped replay + owner lookup).

### Application

* `message/application/model`: `EnvelopeBatch`, `EnvelopeCoverageView`,
  `E2eeSendPlan`, `MessageDeviceView`; расширены `MessageCreateInput`
  (`envelopesPresent`), `MessageView` (`cryptoScheme`, `withCrypto`),
  `SendMessageResult` (coverage), `MessageCreatedNotification` (`cryptoByDevice`).
* `message/application/port`: `MessageDeviceDirectoryPort`,
  `MessageChatContextPort`.
* `message/application/service`: `EnvelopeCodec`, `EnvelopeLimits`,
  `EnvelopeWireMapper`, `EnvelopeFingerprint`, `E2eeEnvelopeValidator`.
* `message/application/usecase`: `SendMessageUseCase` (parse/hash/replay),
  `MessageSubmissionHandler` (E2EE-ветка, coverage, seq, envelopes, outbox, WS),
  `MessageQueryHandler` (E2EE read, crypto per device, replay coverage,
  sender-scoped lookup).

### Infrastructure / API

* `message/infrastructure/adapter`: `MessageDeviceDirectoryAdapter` (auth devices
  под RLS), `MessageChatContextAdapter` (chat type + DERIVED peer).
* `message/infrastructure/persistence`: `MessageEnvelopeRepositoryAdapter`
  (native SQL, JSONB `::text`, bytea, partitioned insert),
  `MessageEntity`/`MessagePersistenceMapper` (`crypto_scheme`),
  `MessageJpaRepository`/`MessageRepositoryAdapter` (sender-scoped queries).
* `message/api`: `EnvelopeCoverageResponse`; `MessageResponse`
  (+nullable `envelope_coverage`), `MessageApiMapper`, `MessageController`.
* `shared`: `PayloadLimits`, `PayloadLimitFilter`,
  `CachedBodyHttpServletRequest`, `DomainException.payloadTooLarge`.
* `realtime`: `RealtimeEvent` (+`cryptoByDevice`), `RealtimeEventFactory`,
  `RealtimeChatHistoryPort`/`Adapter` (+deviceId, envelopes), `SubscriptionService`,
  `WsFrameCodec`, `InMemoryRealtimeHub`, `RealtimeMessageCreatedListener`.

### Contract/docs

* `contracts/ws-protocol.md` — уточнение §8: E2EE send/fan-out реализован,
  `crypto` per-connection device, конверты других устройств только через GET,
  REST-лимиты.
* `contracts/openapi.yaml` — **не менялся** (все схемы/пути/коды были в I-01).
* `frontend/src/api/schema.d.ts` — **не менялся** (контракт тот же;
  `contract:check` подтверждает синхронность).
* `backend/README.md` — раздел «E2EE chat and messages (E7-B3/B4)»: flow, flag,
  лимиты, no server crypto, ошибки, тесты.
* `backend/E7-B3-B4-REPORT.md` (этот файл), `docs/TASKS.md` §9.

### Тесты

* Новые: `E2eeMessageIT` (12), `E2eeMessageFlagOffIT` (1),
  `E2eeMessageRealtimeIT` (1).
* Адаптированы под новые сигнатуры (не отключены): `MessageDomainTest`
  (`reconstitute` + `CryptoScheme.MANAGED`), `SubscriptionServiceTest.FakeHistory`
  (`deviceId` в `after`).

## Проверки

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
cd backend
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 314, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS
# baseline 300 сохранён, +14 новых; ArchUnit 10/10
# (один промежуточный прогон дал известный timing-flake OutboxIT: publishPending()=0;
#  изолированно и на повторном полном прогоне — зелёный, см. E7-B1-FIX-REPORT)

mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMessageIT' test
# Tests run: 12, Failures: 0, Errors: 0, Skipped: 0

mvn -o -Dmaven.repo.local=.m2repo -Dtest='E2eeMessageFlagOffIT,E2eeMessageRealtimeIT' test
# Tests run: 2, Failures: 0, Errors: 0, Skipped: 0

cd ../frontend
npm run --silent contract:check
# Contract check passed: 33 operations, 58 contract schemas (51 checked for required fields),
# generated types in sync. (openapi.yaml и schema.d.ts не менялись)
```

Покрыто новыми тестами:

* **create**: E2EE DIRECT 201 (контракт `Chat`), режим E2EE, `peer_id`/capability,
  повтор 200 тем же id, GROUP → `E2EE_GROUP_NOT_SUPPORTED`, 0 `SYSTEM`-сообщений,
  immutability чата и воркспейса (DB), флаг off → `E2EE_DISABLED` для create/send/
  read, plaintext fallback отсутствует.
* **send/storage**: 2 конверта (peer prekey + своё второе устройство без prekey),
  `text:null`/`crypto:null`, coverage 1/1+1/1 без warning, `crypto_scheme`,
  `body_ciphertext IS NULL`, `content_meta='{}'`, байтовое равенство ciphertext,
  prekey сохранён/`NULL`, seq 1→2.
* **reject**: text/sticker_id/attachment_ids/reply_to_id/type=STICKER → 422
  `E2EE_PLAINTEXT_FORBIDDEN`; `envelopes` отсутствует/пуст → `ENVELOPES_REQUIRED`;
  >10 → `TOO_MANY_ENVELOPES`; дубль → `DUPLICATE_ENVELOPE`; v=2 →
  `UNSUPPORTED_ENVELOPE_VERSION`; unknown envelope/header field, padded session_id,
  ciphertext 15 B, `header.extra` → `INVALID_ENVELOPE_FORMAT`; ciphertext 33041 B →
  413 `ENVELOPE_TOO_LARGE/canonical`; 70000 символов → 413
  `ENVELOPE_TOO_LARGE/form`; >512 KiB тело → 413 `PAYLOAD_TOO_LARGE`; ни одно
  отклонение не создаёт message/seq.
* **recipients/coverage**: legacy-target → 422 `E2EE_LEGACY_DEVICE` с точным
  `details.field`, сообщение не создано; нет peer-конверта → 409
  `E2EE_NO_PEER_ENVELOPE`; revoked единственный peer-девайс → 409
  `E2EE_NO_ACTIVE_DEVICES`; partial peer+self → `PEER_DEVICE_UNCOVERED` (приоритет),
  self-only → `SELF_DEVICE_UNCOVERED`, uncovered ids корректны; self-envelope → 422.
* **generation/binding**: stale sender/recipient generation → 409 `KEY_CHANGED`;
  чужой `sender_identity_signing_key` → 422 с `prekey.sender_identity_signing_key`;
  чужой `sender_device_id` → 422; legacy sender device → 422 `E2EE_LEGACY_DEVICE`.
* **read**: `crypto` только своему устройству (peer/второе своё), у третьего
  устройства/своего отправителя/legacy — `null`; `text:null`,
  `client_message_id` есть; в ответе нет id чужого устройства и нет `envelopes`;
  контракты `MessagePage`/`Message`/`CryptoEnvelope` валидны.
* **idempotency**: тот же `Idempotency-Key`+bytes → тот же id/seq/coverage;
  тот же `client_message_id`+bytes с новым ключом → replay; другие bytes → 409
  `CLIENT_MESSAGE_ID_CONFLICT`; другой пользователь с тем же id → 409 (не replay);
  ровно одно сообщение/один набор конвертов.
* **RLS/tenant**: non-member → 404; под чужим `app.workspace_id` конверты не видны
  (0 строк); INSERT конверта с чужим `workspace_id` → RLS violation.
* **WS**: реальный сокет — `message.created` без plaintext, `crypto` =
  конверт устройства соединения (recipient_device_id/ciphertext), у отправителя
  `crypto:null`, конверты других устройств не утекают, replay после reconnect
  отдаёт конверт этого устройства, у третьего устройства `crypto:null`.
* **managed не затронут**: managed-сообщения по-прежнему `201 Message` без
  `envelope_coverage` и без `crypto`; managed+envelopes при флаге on → 422
  `ENVELOPES_NOT_ALLOWED`.

## Contract

* Отклонений от `contracts/openapi.yaml` нет: пути/схемы/статусы/коды I-01
  используются как есть; `envelope_coverage` присутствует только в E2EE-ответе
  (`MessageCreateResult`), managed-ответ — прежний `Message` без поля.
* `contracts/openapi.yaml` и `frontend/src/api/schema.d.ts` **не изменялись**;
  `contract:check` зелёный (33 operations / 58 schemas / types in sync).
* `contracts/ws-protocol.md` обновлён только в §8 (устаревшее «E2EE fan-out —
  E7-B3/B4»): wire-формат `message.created` не менялся — `crypto` для устройства
  соединения, `text:null`, `client_message_id`; событие не несёт map конвертов.
* Разъяснение по формулировке задания «WS `crypto:null`»: wire-контракт (§4.4 и
  `contracts/ws-protocol.md`) требует конверт **устройства соединения**, поэтому
  `crypto:null` — это кадр отправителя на своём устройстве (и любого устройства без
  конверта), а не всех получателей. Конверты других устройств остаются доступны
  только через `GET`; сервер их не рассылает.

## DDD

```
ru.krug.backend.message
  domain/model             CryptoScheme, CryptoEnvelope, EnvelopeHeader, EnvelopePrekey,
                           MessageEnvelope, Message (+E2EE invariants)
  domain/repository        MessageRepository, MessageEnvelopeRepository
  application/model        EnvelopeBatch, EnvelopeCoverageView, E2eeSendPlan,
                           MessageDeviceView, MessageView, SendMessageResult
  application/port         MessageDeviceDirectoryPort, MessageChatContextPort
                           (published read-порты; реализуются в infrastructure)
  application/service      EnvelopeCodec, EnvelopeLimits, EnvelopeWireMapper,
                           EnvelopeFingerprint, E2eeEnvelopeValidator
  application/usecase      SendMessageUseCase, MessageSubmissionHandler, MessageQueryHandler
  infrastructure/adapter   MessageDeviceDirectoryAdapter (auth DeviceRepository),
                           MessageChatContextAdapter (chat ChatRepository)
  infrastructure/persistence MessageEnvelopeRepositoryAdapter, MessageEntity/Mapper,
                           MessageJpaRepository/RepositoryAdapter
  api / api/dto / api/mapper MessageController, MessageResponse,
                           EnvelopeCoverageResponse, MessageApiMapper

ru.krug.backend.realtime
  application/model        RealtimeEvent (+ cryptoByDevice, in-process only)
  application/port         RealtimeChatHistoryPort (+ deviceId)
  infrastructure/ws        WsFrameCodec (per-device crypto), InMemoryRealtimeHub
  infrastructure/adapter   RealtimeChatHistoryAdapter (envelopes для устройства сессии)

ru.krug.backend.shared
  application/model        PayloadLimits (512 KiB)
  infrastructure/web       PayloadLimitFilter, CachedBodyHttpServletRequest
```

ArchUnit: `mvn -o -Dmaven.repo.local=.m2repo -Dtest=ArchitectureTest test` →
**10/10**. Domain не зависит от Spring/JPA/Jackson; application — от
infrastructure/api; API не видит domain; cross-context domain-изоляция соблюдена
(message-application общается с auth/chat только через порты/ids; адаптеры — в
infrastructure). Транспортные WS-типы не выходят за `realtime.infrastructure.ws`.

## Риски и вопросы

1. **Контракт vs спека по нижней границе ciphertext.** `CryptoEnvelope.ciphertext`
   в `openapi.yaml` имеет `minLength: 363` (канонический padded v1), а сервер
   принимает decoded 16..33040 по §4.5/§4.7. Клиент, отправивший <363 символов,
   получит `201` и эхо-конверт, который не пройдёт клиентскую валидацию схемы.
   Реальные клиенты всегда паддят до 272 B (363 символа). Если PM хочет строгую
   контрактную границу — это одно правило `encoded >= 363 → 422` в
   `EnvelopeCodec`; отдельного решения требует согласование §4.5 и контракта.
2. **Replay coverage при исчезнувшем peer-устройстве.** `replayCoverage`
   пересчитывает покрытие best-effort; если у peer не осталось capable-устройств,
   `peer_devices=0` нарушит `minimum: 1` контракта (крайний случай; сообщение уже
   доставлено ранее). Альтернатива — хранить coverage — потребовала бы новой
   колонки/таблицы, чего спека §6.5 не предусматривает.
3. **WS и «fan-out envelopes via GET».** Реализован контракт §4.4: кадр несёт
   конверт устройства соединения. Если PM имел в виду буквально «всегда
   `crypto:null` в WS, конверты только через GET», это изменение wire-контракта
   (`contracts/ws-protocol.md`), а не кода — сейчас кадр эквивалентен GET для того
   же устройства.
4. **Durable outbox не несёт конверты.** Outbox-строка `message.created` —
   метаданные (id/seq/type/created_at), как и раньше; Kafka-консьюмер (stub) не
   получит ciphertext, что соответствует «конверты только адресату». Multi-node
   realtime по-прежнему in-process hub (E3), для горизонтального масштабирования
   нужен Redis/Kafka pub/sub с per-device адресацией.
5. **P2-08 (B1F, не входил в задачу)**: гонка лимита 200 OPK и retention
   `device_prekeys` остаются долгом.
6. **G2 (браузерные KAT) и G4 (внешний crypto-review)** — по-прежнему предусловия
   включения `KRUG_E2EE_ENABLED` по умолчанию; B3/B4 их не заменяют.
7. **Git отсутствует**: изменения не «одним PR»; контракт ↔ `schema.d.ts`
   согласованы в рабочем дереве и проверены `contract:check`.

## Что дальше

1. E7-F: клиентский X3DH/Double Ratchet, локальная копия/outbox, безопасный рендер
   (`crypto:null` → «недоступно на этом устройстве»), safety number.
2. Redis/Kafka pub/sub для multi-node per-device fan-out; durable-доставка
   `chat.keys.changed`.
3. P2-08: атомарный лимит prekey + retention.
4. Решение PM по п.1/п.3 рисков (граница ciphertext; WS vs GET) и по G2/G4.

# D1-BE2 — attachment media metadata, artwork, MIME/limits

> Формат — `docs/TASKS.md` §5. Зона сессии: `backend/**`, additive-правки
> `contracts/**`, регенерация `frontend/src/api/schema.d.ts`. Остальной `frontend/**`,
> `docs/**`, `design/**`, `deploy/**` не менялись; порт `8080` не трогался. Git-репозитория
> в рабочем дереве нет, поэтому «одним PR» проверить нельзя — изменения согласованы в
> рабочем дереве.

## Статус

**DONE в границах D1-BE2.** Реализованы media metadata / artwork / MIME / limits для
managed-вложений (`docs/TASKS-DASHBOARD-V1.md` §3.3, §5.2):

* `AttachmentRef.media` (nullable) в контракте и в ответах REST/WS;
* `file.uploads.media` + `file.attachments.media` jsonb (V29) с DB-backstop;
* клиентский sanitized `media` принимается только для MANAGED upload и только в
  managed-чате; E2EE не парсит и не хранит plaintext-метаданные;
* строгие bounds: duration/width/height, длины строк, `year`, безопасный `artwork_url`;
* MIME-allowlist и duration для голосовых `audio/webm|audio/ogg`;
* существующий scan/quota pipeline (`complete -> SCANNING -> CLEAN -> bind`) не изменён;
* server-side ffprobe/ID3-парсинга нет — это D1.1.

Полный backend suite — **486/486**, `ArchitectureTest` — **10/10** (JDK 21).
`frontend/src/api/schema.d.ts` регенерирован; `npm run contract:check` зелёный.

## 1. Contract (additive)

`contracts/openapi.yaml`:

* `AttachmentRef.media: object|null` — managed-only метаданные:
  * `kind: AUDIO|VIDEO|IMAGE|FILE` (required при наличии объекта);
  * `duration_ms: integer|null`, `minimum: 0`, `maximum: 604800000` (7 суток);
  * `width/height: integer|null`, `1..16384`;
  * `title/artist/album: string|null`, `maxLength: 255`; `genre: 64`;
  * `year: string|null`, `maxLength: 8`, `pattern: ^[0-9]{4}$`;
  * `artwork_url: string|null`, `format: uri`, `maxLength: 2048`;
  * `metadata_source: ID3|SERVER|CLIENT|NONE` (required).
  * Описание фиксирует: sanitized client values (MVP), server extraction — D1.1;
    строки обрезаны/без HTML/control; `artwork_url` никогда не запрашивается сервером
    (no server-side SSRF); `null` для plain/legacy и E2EE.
* `UploadInitRequest.media` — тот же объект; клиент присылает метаданные вместе с init.
  `complete` копирует значения в `AttachmentRef.media`.
* `POST /uploads` — добавлен документированный `415 UnsupportedMediaType` (голосовой
  MIME вне allowlist; этот ответ и раньше возвращался существующей file-policy).
* `Error` — в описание добавлен `MEDIA_METADATA_INVALID` (422).

`contracts/ws-protocol.md`:

* `payload.attachments[]` — `AttachmentRef`; managed-вложение несёт `media` (или `null`)
  с теми же полями, что REST. E2EE `attachments` всегда пуст, поэтому plaintext media
  в WS не попадает.

**Фактические счётчики контракта:** было **47 paths / 55 operations / 87 schemas**,
стало **47 / 55 / 87** — новых path/operation/schema нет, изменения только additive
в существующих схемах. `openapi-typescript` синхронен; `frontend/src/api/schema.d.ts`
обновлён через `npm run api:types`.

## 2. V29 — схема и DB-backstop

`backend/src/main/resources/db/migration/V29__attachment_media_metadata.sql`:

* `file.uploads.media jsonb` — метаданные путешествуют с resumable-сессией;
* `file.attachments.media jsonb` — immutable-копия для сообщения/истории;
* `file.media_metadata_valid(jsonb)` — `IMMUTABLE` SQL-функция (без I/O):
  * `jsonb_typeof(media) = 'object'`;
  * `kind`/`metadata_source` в enum;
  * `duration_ms` — целое `0..604800000`; `width/height` — целые `1..16384`;
  * строки ограничены по длине, без `<`/`>` и `[[:cntrl:]]`; `year` — 4 цифры;
  * `artwork_url` — `http(s)://`, ≤2048, без whitespace/HTML;
* `ck_uploads_media_valid` и `ck_attachments_media_valid` — CHECK поверх функции;
* `ix_attachments_media_kind (workspace_id, (media->>'kind')) WHERE media IS NOT NULL` —
  partial-индекс под фильтр «Файлов» (D1-FE4), без rewrite.

Forward-only. Rollback-план: `DROP INDEX ix_attachments_media_kind`,
`ALTER TABLE ... DROP CONSTRAINT ck_*_media_valid`, `DROP FUNCTION file.media_metadata_valid`,
`ALTER TABLE ... DROP COLUMN media`; данные media при откате теряются, остальные
attachment-поля не затрагиваются.

## 3. Backend pipeline

### 3.1 Приём и хранение

* `UploadInitRequest.media` → `MediaMetadataRequest` (API DTO) → `MediaMetadataInput`
  (application) → `MediaMetadata.sanitize(...)` (domain value object).
* `InitUploadHandler` валидирует metadata **до** idempotency-резерва и quota:
  отклонённый запрос не создаёт upload/attachment и не резервирует квоту.
* Sanitized `MediaMetadata` сохраняется в `file.uploads.media`; `CompleteUploadHandler`
  копирует её в `Attachment.uploaded(...)` → `file.attachments.media`.
* Persistence: `Map<String,Object>` + `@JdbcTypeCode(SqlTypes.JSON)` (тот же паттерн,
  что `message.content_meta`/`ops.outbox.payload`), поэтому jsonb пишется/читается
  штатно, без `stringtype=unspecified`.
* `MediaMetadata.fromMap` fail-closed: повреждённая/legacy-строка отдаётся как `null`
  и не ломает листинг сообщений (новые плохие строки не пропускает CHECK).

### 3.2 Валидация и bounds

`ru.krug.backend.file.domain.model.MediaMetadata`:

| Поле | Правило |
|---|---|
| `kind` | required, `AUDIO/VIDEO/IMAGE/FILE` (case-insensitive на входе) |
| `metadata_source` | required, `ID3/SERVER/CLIENT/NONE` |
| `duration_ms` | `0..604800000` (7 суток) |
| `width/height` | `1..16384` |
| `title/artist/album` | trim, ≤255, без `<`/`>`, C0/C1-control и bidi-control |
| `genre` | trim, ≤64, те же запреты |
| `year` | ровно 4 цифры |
| `artwork_url` | trim, ≤2048, absolute `http(s)`, hostname без userinfo/IP-literal/`localhost`/`.local`/`.internal`; сервер URL не резолвит и не запрашивает |

Пустые строки после trim превращаются в `null`. Строки нигде не используются в путях
и не интерполируются в HTML; клиент рендерит их как текст (React escaping), сервер
дополнительно запрещает HTML-разметку. `artwork_url` — только данные для клиента,
никакого server-side fetch, поэтому server-side SSRF отсутствует; запрет IP/localhost
дополнительно не даёт направить карточку на intranet-адрес.

### 3.3 MIME / голосовые

* Для `kind=AUDIO` MIME обязан быть `audio/*` и входить в allowlist:
  `audio/webm, audio/ogg, audio/mpeg, audio/mp4, audio/aac, audio/wav, audio/x-wav,
  audio/flac, audio/x-flac, audio/opus`; иначе `415 UNSUPPORTED_TYPE`.
* Для `VIDEO`/`IMAGE` MIME обязан быть соответствующего семейства; `FILE` — без
  ограничения семейства (общий allowlist уже применён `FileTypePolicy`).
* Голосовые: MIME `audio/webm`/`audio/ogg` (с параметрами `codecs` и в любом регистре)
  требует `kind=AUDIO` и `duration_ms` в `1..600000` (10 минут). Без `media` такой
  upload отклоняется `422 MEDIA_METADATA_INVALID` (`reason=required_for_voice`).
* Обычный `FileTypePolicy` (dangerous/unsupported MIME), quota и AV-scan не менялись.

### 3.4 E2EE

* `InitUploadHandler` по-прежнему принимает только `encryption_mode=MANAGED` и делает
  это **до** любого разбора `media`; `E2EE` → `422 MODE_NOT_SUPPORTED` (тест с заведомо
  malformed media доказывает, что парсинга нет).
* Дополнительно: MANAGED-upload в **E2EE-чат** с `media` отклоняется до `sanitizeMedia`
  (`422 MEDIA_METADATA_INVALID`, `reason=e2ee_plaintext_forbidden`). Media-less upload
  в E2EE-чат остаётся доступен — существующий E4 pipeline не меняется.
* В E2EE-чате `attachment_ids` запрещены (`E2EE_PLAINTEXT_FORBIDDEN`), поэтому E2EE
  сообщение не может получить attachment и, следовательно, `media`; тест проверяет,
  что после отклонённого E2EE-send в `file.attachments` нет строк для этого чата.
* Defense-in-depth на чтении: `MessageQueryHandler.enrich` отдаёт E2EE-сообщению пустой
  список attachments, даже если строка появилась в обход API (баг/прямой SQL).
* `media` отсутствует/`null` для E2EE; сервер не хранит plaintext-метаданные.

### 3.5 Выдача

* REST: `Message.attachments[].media` в `POST /chats/{id}/messages`,
  `GET /chats/{id}/messages` (и в replay того же ответа).
* WS: `message.created.payload.attachments[].media` (live и replay; outbox payload
  также содержит `media` для консистентности).
* `media = null` для plain/legacy; контракт допускает и отсутствие, и `null`.

## 4. Тесты

Добавлено **19 тестов** (467 → 486):

* `backend/src/test/java/ru/krug/backend/unit/MediaMetadataTest.java` — **10**:
  sanitize/trim/roundtrip, обязательные enum, bounds duration/width/height, длины строк,
  HTML/control/bidi, `year`, artwork policy (javascript/data/file/ftp/userinfo/localhost/
  IP/private/link-local/relative/oversize), voice MIME+duration, kind/MIME mismatch,
  fail-closed `fromMap`.
* `backend/src/test/java/ru/krug/backend/integration/MediaMetadataIT.java` — **9**:
  media roundtrip upload→complete→message→page + contract validation + jsonb assertion;
  plain attachment → `media:null`; 13 reject-кейсов без создания upload-строки;
  `audio/x-ms-wma` → 415; voice webm/ogg (missing/wrong kind/no duration/too long/valid);
  idempotency replay с другим media → 409, с тем же → тот же upload_id;
  E2EE encryption mode до парсинга; MANAGED upload с media в E2EE-чат → 422 без парсинга;
  V29 columns/function/constraints/index + DB-backstop на 8 плохих jsonb.
* `RealtimeFrameContractTest` расширен проверкой `media` в WS payload.
* `E2eeMessageIT` дополнен проверкой отсутствия attachment/media строк в E2EE-чате.
* `FileUploadTestSupport` получил helper для init с `media`.

`ArchitectureTest` — **10/10**: новые классы разложены по слоям (domain value object,
application input, API DTO, persistence mapping) без нарушений правил.

### Прогон

```bash
cd backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test
# Tests run: 486, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS

cd ../frontend
npm run api:types
npm run contract:check
# Contract check passed: 55 operations, 87 contract schemas, generated types in sync.
```

Примечания по тестовой изоляции (только тесты, поведение продукта не затронуто):

* в полном прогоне `OutboxIT` иногда видел `published_at != null` из-за relay-шедулера
  соседнего кэшированного Spring-контекста (этот race уже описан комментарием в самом
  тесте). Устаревшая строгая проверка «строка ещё не опубликована» убрана; инварианты
  (metadata-only payload без plaintext, публикация после `publishPending`, отсутствие
  дубля при replay) сохранены;
* `keycloak`/`prod` тест-контексты не загружают `application-test.yml`, поэтому их noop
  сканер с пустым fail-marker мог пометить чужой SCANNING-файл как CLEAN (общая
  Testcontainers-БД). В этих тест-классах file-jobs отключены
  (`krug.files.scan-enabled=false`, `gc-enabled=false`, `reconcile-enabled=false`), чтобы
  полный suite был детерминированным; `FileContractIT` по-прежнему проверяет реальный
  quarantine-путь своим test-контекстом.

## 5. Изменённые файлы

Контракт/типы:

* `contracts/openapi.yaml`
* `contracts/ws-protocol.md`
* `frontend/src/api/schema.d.ts` (только регенерация)

Backend main:

* `backend/src/main/resources/db/migration/V29__attachment_media_metadata.sql`
* `backend/src/main/java/ru/krug/backend/file/domain/model/{MediaKind,MediaMetadataSource,MediaMetadata}.java`
* `backend/src/main/java/ru/krug/backend/file/domain/exception/MediaMetadataInvalidException.java`
* `backend/src/main/java/ru/krug/backend/file/domain/model/{Upload,Attachment}.java`
* `backend/src/main/java/ru/krug/backend/file/infrastructure/persistence/{UploadEntity,AttachmentEntity}.java`
* `backend/src/main/java/ru/krug/backend/file/application/model/MediaMetadataInput.java`
* `backend/src/main/java/ru/krug/backend/file/application/command/InitUploadCommand.java`
* `backend/src/main/java/ru/krug/backend/file/application/usecase/{InitUploadHandler,CompleteUploadHandler,FileAccessGuard,MessageAttachmentService}.java`
* `backend/src/main/java/ru/krug/backend/file/api/dto/{UploadInitRequest,MediaMetadataRequest}.java`
* `backend/src/main/java/ru/krug/backend/file/api/{FileUploadController}.java`
* `backend/src/main/java/ru/krug/backend/file/api/mapper/FileApiMapper.java`
* `backend/src/main/java/ru/krug/backend/message/application/model/{MessageAttachmentView,AttachmentMediaView}.java`
* `backend/src/main/java/ru/krug/backend/message/application/usecase/{MessageSubmissionHandler,MessageQueryHandler}.java`
* `backend/src/main/java/ru/krug/backend/message/api/dto/{AttachmentRefResponse,AttachmentMediaResponse}.java`
* `backend/src/main/java/ru/krug/backend/message/api/mapper/MessageApiMapper.java`
* `backend/src/main/java/ru/krug/backend/realtime/application/model/{AttachmentSnapshot,AttachmentMediaSnapshot}.java`
* `backend/src/main/java/ru/krug/backend/realtime/application/service/RealtimeEventFactory.java`
* `backend/src/main/java/ru/krug/backend/realtime/infrastructure/event/RealtimeMessageCreatedListener.java`
* `backend/src/main/java/ru/krug/backend/realtime/infrastructure/adapter/RealtimeChatHistoryAdapter.java`
* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java`

Тесты:

* `backend/src/test/java/ru/krug/backend/unit/MediaMetadataTest.java`
* `backend/src/test/java/ru/krug/backend/integration/MediaMetadataIT.java`
* `backend/src/test/java/ru/krug/backend/support/FileUploadTestSupport.java`
* `backend/src/test/java/ru/krug/backend/unit/RealtimeFrameContractTest.java`
* `backend/src/test/java/ru/krug/backend/integration/E2eeMessageIT.java`
* `backend/src/test/java/ru/krug/backend/integration/OutboxIT.java` (только race-устойчивость)
* `backend/src/test/java/ru/krug/backend/integration/{KeycloakAuthIT,KeycloakJwtIT,AuthBffIT,AuthBffRateLimitIT,ProdProfileIT}.java`
  (только test isolation: file-jobs выключены в контекстах без `application-test.yml`)

## 6. Границы и D1.1

* Нет server-side ffprobe/ID3/artwork extraction — принимаются sanitized client values;
  серверная экстракция и derived-обложка (attachment CLEAN / защищённый URL) — D1.1.
* Нет E2EE-вложений: `encryption_mode` в upload API остаётся `MANAGED`-only; E2EE media —
  local-only клиента, D1.1.
* `artwork_url` не проксируется и не кэшируется сервером; это URL для браузера.
* `media` не добавлялась в `UploadSession` response: контракт D1 определяет её только на
  `AttachmentRef`; клиент получает метаданные после bind/в ленте.
* Голосовой `audio/webm|audio/ogg` без `media.duration_ms` намеренно отклоняется: без
  длительности voice-карточка не соответствует acceptance §6.C.
* Существующие scan/quota/GC/RLS-политики не менялись; миграция forward-only.

## 7. Status

**DONE.**

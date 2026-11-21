# #97 — Серверные аудиометаданные и обложки

**Статус: DONE**

## 1. Итог

Добавлен серверный, полностью локальный разбор аудио при загрузке в managed-контур:

- MP3 ID3v2.2/2.3/2.4: `TIT2/TT2`, `TPE1/TP1`, `TALB/TAL`, `TYER/TDRC/TYE`,
  `TCON/TCO`, `APIC/PIC`;
- M4A/MP4: `©nam`, `©ART`, `©alb`, `©day`, `©gen` (плюс численный `gnre`), `covr`;
- длительность: `TLEN`, Xing/Info frame count или CBR-оценка по MPEG-кадру для MP3;
  `mvhd` для M4A/MP4;
- извлечённая обложка пишется отдельным объектом в приватный bucket и отдаётся только
  через аутентифицированный `GET /api/v1/attachments/{attachmentId}/artwork`;
- серверный результат сохраняется как `media.kind=AUDIO`, `metadata_source=SERVER`;
- fallback работает и на `POST /workspaces/{id}/files`, и на существующем resumable
  `/uploads` (после `complete`, когда байты уже доступны);
- новые ответы проходят существующий OpenAPI-контракт; file-center, message attachment
  и music-room read-path получают те же поля без отдельного маппинга.

Схема БД **не менялась**: новые колонки не нужны, `media` остаётся прежним jsonb,
object key обложки выводится из серверных UUID. Миграций нет.

## 2. Что и где добавлено

### Domain (чистый Java, без Spring)

| Файл | Назначение |
|---|---|
| `backend/src/main/java/ru/krug/backend/file/domain/model/AudioMetadata.java` | Результат разбора: теги, длительность, безопасная raster-обложка. |
| `backend/src/main/java/ru/krug/backend/file/domain/service/AudioMetadataParser.java` | Bounded-парсер ID3v2.2/2.3/2.4 и M4A/MP4, оценка длительности. |
| `backend/src/main/java/ru/krug/backend/file/domain/service/ArtworkImages.java` | Sniffing обложки по magic bytes; только статические raster-типы. |
| `backend/src/main/java/ru/krug/backend/file/domain/service/AudioFileTypes.java` | Определение AUDIO по MIME/расширению, отделение voice (`audio/webm`, `audio/ogg`). |
| `backend/src/main/java/ru/krug/backend/file/domain/service/AudioArtworkKey.java` | Детерминированный приватный object key обложки из workspace/attachment UUID. |

### Application

| Файл | Назначение |
|---|---|
| `.../file/application/usecase/AudioMetadataExtractor.java` | Решение о fallback, чтение объекта, разбор, запись обложки, сборка `MediaMetadata.serverAudio`. |
| `.../file/application/usecase/AttachmentArtworkHandler.java` | Авторизация/видимость и выдача байтов обложки. |
| `.../file/application/model/ServerAudioMedia.java` | Внутренний результат (media + artwork key). |
| `.../file/application/model/AttachmentArtworkView.java` | Байты + sniffed MIME для API. |

### API / wiring

| Файл | Изменение |
|---|---|
| `.../file/api/AttachmentArtworkController.java` | `GET /api/v1/attachments/{attachmentId}/artwork`. |
| `.../file/application/usecase/WorkspaceFileUploadHandler.java` | Разбор AUDIO на `POST /workspaces/{id}/files`, `media` в ответе `FileItem`. |
| `.../file/application/usecase/CompleteUploadHandler.java` | Fallback на `/uploads/complete` при отсутствующем/пустом client media. |
| `.../file/application/usecase/FileAccessGuard.java` | Fail-closed `isE2eeChat` для запрета разбора в E2EE-чате. |
| `.../file/domain/model/Upload.java` | `withMedia` — сохранить серверный результат в upload-сессии. |
| `.../file/domain/model/MediaMetadata.java` | `serverAudio(...)`, permissive read для persisted server URL. |
| `.../file/application/model/FileMediaView.java` | Единый маппинг domain → file-center/API view. |
| `.../file/application/usecase/FileMutationService.java` | Best-effort удаление объекта обложки при удалении файла. |
| `.../file/infrastructure/config/FilesProperties.java`, `FilesSettingsAdapter.java`, `FileSettingsPort.java` | Новый `krug.files.artwork-base-url`. |

### Контракт и клиентские типы

- `contracts/openapi.yaml`: новый path `/attachments/{attachmentId}/artwork` (бинарный
  ответ, `401/403/404/409/410/423`), обновлены описания `AttachmentRef.media`,
  `UploadInitRequest.media` и `MusicRoomTrack.artwork_url`.
- `frontend/src/api/schema.d.ts`: добавлены path/operation `attachmentArtwork`
  (файл генерируется из OpenAPI; добавление точечное).

## 3. Поток данных

### 3.1 `POST /workspaces/{workspaceId}/files` (глобальная загрузка)

1. Файл проходит существующие проверки: workspace membership, тариф/гость, `FileTypePolicy`,
   квота, приватный bucket, AV `PENDING`.
2. Для AUDIO (MIME `audio/*` или расширение `mp3/m4a/aac/ogg/opus/flac/wav/weba/wma`, кроме
   voice) объект читается через `ObjectStoragePort.open` и разбирается bounded-парсером.
3. Обложка (если есть) пишется в `workspaces/{workspaceId}/artwork/{attachmentId}` с
   sniffed raster MIME.
4. В `file.attachments.media` сохраняется `{"kind":"AUDIO","metadata_source":"SERVER", ...}`;
   тот же объект сразу возвращается в `201 FileItem.media` и попадает в `GET /files`.

### 3.2 `POST /uploads` → `PUT parts` → `POST /complete` (resumable)

На `init` байтов ещё нет, поэтому «решение о fallback» принимается по `init`-payload:
`media == null`, `metadata_source=NONE`, `kind != AUDIO` или AUDIO без единого поля/длительности.
Сам разбор выполняется в `complete`, после `completeMultipart` и проверки SHA-256:

- полный клиентский payload (например, voice `CLIENT` с длительностью) **не перетирается**;
- отсутствующий/пустой — заменяется серверным `AUDIO/SERVER`;
- `file.uploads.media` и `file.attachments.media` получают одну и ту же копию;
- повторный `complete` идемпотентен, повторного разбора нет.

E2EE-чаты не инспектируются вообще: `CompleteUploadHandler` до чтения объекта проверяет
security mode чата через `FileAccessGuard.isE2eeChat` (missing/foreign chat → fail closed).
Для E2EE остаётся прежнее поведение media-less upload.

## 4. Поддерживаемые теги и длительность

### MP3

| Версия | Title | Artist | Album | Year | Genre | Artwork |
|---|---|---|---|---|---|---|
| ID3v2.2 | `TT2` | `TP1` | `TAL` | `TYE` | `TCO` | `PIC` |
| ID3v2.3 | `TIT2` | `TPE1` | `TALB` | `TYER` | `TCON` | `APIC` |
| ID3v2.4 | `TIT2` | `TPE1` | `TALB` | `TDRC` | `TCON` | `APIC` |

Поддержаны text encodings 0/1/2/3 (ISO-8859-1, UTF-16 с BOM и LE-fallback, UTF-16BE,
UTF-8), unsynchronisation, extended header, syncsafe-размеры v2.4. Сжатые/зашифрованные
фреймы пропускаются и **никогда не распаковываются**.

Длительность:
1. `TLEN` (мс), если валиден и в `[1, 604800000]`;
2. Xing/Info frame count для MPEG-1/2 Layer III;
3. CBR-оценка по первому MPEG-кадру: `audioBytes * 8000 / bitrate`.

### M4A/MP4

`moov/udta/meta/ilst`: `©nam`, `©ART`, `©alb`, `©day`, `©gen`, `gnre` (ID3 genre index),
`covr` (первый безопасный raster). Длительность — `moov/mvhd` (version 0 и 1).
`moov` может находиться после `mdat`: парсер проходит box-структуру потоком, не загружая
`mdat` в память.

## 5. Безопасность

- **Bounded memory / no zip bomb.** Тег ≤ 8 MiB, `moov` ≤ 8 MiB, текст-фрейм ≤ 64 KiB,
  обложка ≤ 2 MiB, ≤ 4096 фреймов/box-ов, глубина атомов ≤ 8. Все размеры проверяются
  против уже прочитанного буфера; длины `long`, без overflow. Никакой декомпрессии нет.
- **No network / no SSRF.** Парсер и extractor не делают сетевых запросов. `artwork_url`
  никогда не фетчится сервером; серверный URL строится из конфигурации, а не из тега.
  Object key собирается только из UUID.
- **No arbitrary MIME.** Content-Type обложки определяется по magic bytes; разрешены
  только `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/bmp`, `image/avif`.
  SVG/HTML/произвольный MIME не пройдут. Ответ отдаётся с `X-Content-Type-Options: nosniff`.
- **AV fail-closed.** `GET .../artwork` использует тот же gate, что скачивание: SCANNING →
  `409`, INFECTED/FAILED → `423`, DELETED → `410`. Обложка из неотсканированного объекта
  не отдаётся. Видимость: ACTIVE-участник чата для привязанного вложения, участник
  воркспейса для workspace-ассета, владелец — для ещё не привязанного глобального файла.
- **E2EE.** Серверный разбор не запускается для E2EE-чата; E2EE-контент не становится
  plaintext-метаданными.
- **Artwork URL policy.** Клиентский `artwork_url` по-прежнему проходит строгую проверку
  (absolute http(s), без credentials/IP-литералов/localhost). Серверный URL строится только
  из конфигурации; при чтении persisted-значения применяется та же scheme/format-проверка
  без host-ограничения, чтобы не потерять валидный локальный dev-origin.
- **Sanitize.** Текст очищается от `<`, `>`, C0/C1, bidi и BOM, пробелы схлопываются,
  длины ограничены; это повторяет клиентский `id3.ts` и гарантирует, что hostile-тег не
  превратится в 422 при загрузке и не станет разметкой в UI.
- **Логи.** Никаких тегов/названий/байтов в логах: только `attachment_id` и техническая
  причина (`parse_failed`, `artwork_store_failed`, `metadata_rejected`).
- **RLS/квоты/аудит** не изменены: новые пути идут через существующие репозитории и
  `TenantContext`.

## 6. Конфигурация

| Переменная | Default | Смысл |
|---|---|---|
| `KRUG_FILES_ARTWORK_BASE_URL` | `http://localhost:8081` | Абсолютный публичный origin API для `media.artwork_url`. Production обязан выставить публичный origin (например, `https://chat.example.com`). Пустое значение отключает URL, endpoint по id продолжает работать. |

`media.artwork_url` — не presigned URL и не ссылка на MinIO: это абсолютный URL
аутентифицированного API-endpoint. Клиент должен запрашивать его с токеном (как
`attachmentDownloadUrl`). Байты обложки в JSON не попадают.

## 7. Тесты

Добавлено **30** тестов:

| Набор | Кол-во | Что покрывает |
|---|---|---|
| `AudioMetadataParserTest` | 15 | ID3v2.2/2.3/2.4, APIC/PIC, UTF-8/UTF-16, M4A ilst/mvhd/covr/gnre, отсутствие тегов, CBR-длительность, malformed/oversized tag, oversized artwork, hostile text, compressed APIC не распаковывается, magic-bytes MIME. |
| `AudioMetadataExtractorTest` | 5 | сохранение полного client media, fallback, приватная запись обложки, пустой base URL, voice не парсится, storage failure не ломает загрузку. |
| `AudioMetadataIT` | 10 | глобальная загрузка MP3/M4A (теги/длительность/обложка), file-center, `GET artwork` 200/404/401, fallback на `/uploads`, сохранение client media, пустой `NONE`, no-tags, malformed, oversized artwork, E2EE не инспектируется. |

Существующие `MediaMetadataTest`, `MediaMetadataIT`, `File*IT`, `WorkspaceFilesIT`,
`MusicRoomIT`, `ContractValidationIT`, `ArchitectureTest` переиспользуются без ослабления
контракта.

### Результаты

- `AudioMetadataParserTest` — 15/15.
- `AudioMetadataExtractorTest` — 5/5.
- `AudioMetadataIT` — 10/10.
- ArchUnit — 10/10.
- `npm run contract:check` — passed: 155 operations, 204 schemas, generated
  `frontend/src/api/schema.d.ts` in sync (включает `attachmentArtwork`).
- Полный backend-прогон: см. раздел «Полный прогон» ниже.

## 8. Ограничения и осознанные решения

1. **Fallback на `/uploads` выполняется в `complete`, а не в `init`.** На `init` нет байтов;
   решение о необходимости серверного разбора принимается по payload, а сам разбор — после
   появления объекта. Это не меняет контракт `init` и идемпотентность.
2. **Нет тегов — всё равно `AUDIO/SERVER`.** Для AUDIO без тегов создаётся объект с
   `kind=AUDIO`, `metadata_source=SERVER` и `null`-полями; UI показывает fallback-карточку.
3. **Voice (`audio/webm`, `audio/ogg`) не парсится.** Это не MP3/M4A; клиентский
   `CLIENT`-payload с длительностью сохраняется как раньше.
4. **VBR без Xing** оценивается как CBR по первому кадру; для точных VBR-файлов нужен
   Xing/Info (поддержан) или `TLEN`.
5. **Очень большие `moov` (> 8 MiB) пропускаются** — файл загрузится без тегов, но не
   создаст неограниченную аллокацию.
6. **Осиротевшая обложка при откате транзакции `complete`.** Объект пишется до коммита
   attachment; при редком rollback он может остаться в bucket. Это не влияет на
   безопасность/видимость (endpoint требует attachment с `media.kind=AUDIO`), а штатное
   удаление файла чистит обложку best-effort. Отдельный GC обложек — вне #97.
7. **`artwork_url` может быть `null`**, если `KRUG_FILES_ARTWORK_BASE_URL` пуст; endpoint
   при этом работает по `attachmentId`.
8. **`artwork_url` требует Authorization.** Это URL аутентифицированного API-endpoint, а не
   presigned MinIO URL: `<img src>` без заголовка получит `401`, поэтому клиент должен
   запрашивать обложку через свой API-клиент (и кэшировать байты). Такой вариант явно
   разрешён постановкой; серверные байты никогда не становятся публичными.

## 9. Откат

Изменения аддитивные, миграций и новых колонок нет:

1. откатить код (file-domain/application/api, два handler-а и `FileSettingsPort`);
2. убрать `artwork-base-url` из конфигурации;
3. удалить объекты `workspaces/*/artwork/*` из bucket (одноразово);
4. убрать path `/attachments/{attachmentId}/artwork` из OpenAPI и regenerated types.

Существующие attachment-строки с `media.metadata_source=SERVER` останутся читаемыми:
`MediaMetadata` уже знает этот enum, а `fromMap` fail-closed.

## 10. Полный прогон

Базовый набор до #97 — 912 тестов. Добавлено 30 тестов #97; в изолированном дереве это
942, в общем рабочем дереве на момент отчёта — 963 (параллельно добавлялись несвязанные
bot/rate-limit тесты).

Проверенные прогоны на **JDK 21** (как в CI):

| Прогон | Результат |
|---|---|
| `-Dtest='ru.krug.backend.unit.*Test'` | **440/440**, BUILD SUCCESS |
| `AudioMetadataParserTest`, `AudioMetadataExtractorTest`, `MediaMetadataTest`, `ArchitectureTest`, `AudioMetadataIT`, `MediaMetadataIT`, `FileContractIT`, `FileUploadIT`, `FileMessageIT`, `WorkspaceFilesIT`, `FileCenterIT`, `FileCenterContractIT`, `MusicRoomIT`, `ContractValidationIT` | **107/107**, BUILD SUCCESS |
| Полный `mvn test` (JDK 21) | **963/963**, FAILURES 0, ERRORS 0, BUILD SUCCESS; ArchUnit 10/10. В общем дереве сюда входят и параллельно добавленные bot/rate-limit тесты; тестов #97 — 30. |

Команда целевого прогона:

```bash
cd backend
JAVA_HOME=<jdk-21> mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest='AudioMetadataParserTest,AudioMetadataExtractorTest,MediaMetadataTest,ArchitectureTest,AudioMetadataIT,MediaMetadataIT,FileContractIT,FileUploadIT,FileMessageIT,WorkspaceFilesIT,FileCenterIT,FileCenterContractIT,MusicRoomIT,ContractValidationIT' test
```

> Замечание по окружению: Maven по умолчанию запускался на JDK 26, где Byte Buddy 1.15.11
> не поддерживает Java 26 и Mockito-тесты падают до выполнения логики. Прогон на JDK 21
> (как в CI) обязателен. Один из промежуточных полных прогонов упал каскадом
> `FlywaySqlException / SQLState 08001`, потому что Testcontainers PostgreSQL пересекался с
> параллельным прогоном в общем workspace; повторный чистый прогон — 963/963.

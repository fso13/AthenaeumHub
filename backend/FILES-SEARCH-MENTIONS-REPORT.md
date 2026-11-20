# #83 — глобальные файлы, серверный поиск, серверные mentions

**Статус: DONE.**

Срез закрывает три связанные поверхности managed-режима:

1. **Глобальные файлы воркспейса** — `POST /workspaces/{id}/files` (multipart, любой
   разрешённый тип) через тот же managed-пайплайн, что и обычная загрузка в чат:
   `FileTypePolicy` (dangerous block + runtime allowlist), квота, AV-скан. Плюс
   `PATCH /files/{id}` (rename владельцем), `DELETE /files/{id}` (soft delete
   владельцем/админом) и привязка загруженного файла к сообщению через существующий
   `attachment_ids` при отправке.
2. **Серверный поиск сообщений** — `GET /workspaces/{id}/search/messages` с
   `q/chat_id/from/to/cursor/limit`, только MANAGED plaintext, без E2EE, без чужих
   чатов, с plain-text snippet и диапазонами подсветки.
3. **Mentions** — `MessageCreate.mentions[]` + `mention_all`, валидация активных
   участников чата, `@all` только OWNER/ADMIN, хранение `message.mentions` (V50),
   `Message.mentions`/`mention_all` в ответе, уведомления `MENTION`,
   `GET /me/mentions` + `POST /me/mentions/read`.

Полный backend-suite и ArchUnit — см. §8 (числа после финального прогона).

---

## 1. Контракт и сгенерированные типы

`contracts/openapi.yaml` — additive:

| Operation | Назначение |
|---|---|
| `POST /workspaces/{workspaceId}/files` (`uploadWorkspaceFile`) | multipart `file`, 201 `FileItem`; 400/401/403/413/415/422 |
| `PATCH /files/{fileId}` (`renameFile`) | body `FileRename{name}`, 200 `FileItem`; 400/401/403/404/410/422 |
| `DELETE /files/{fileId}` (`deleteFile`) | 204; 401/403/404/409/422 |
| `GET /workspaces/{workspaceId}/search/messages` (`searchMessages`) | 200 `MessageSearchPage`; 400/401/403/404 |
| `GET /me/mentions` (`listMentions`) | 200 `MentionPage`; 400/401/403 |
| `POST /me/mentions/read` (`markMentionsRead`) | 204; 400/401/403/422 |

Новые схемы: `FileRename`, `SearchHighlight`, `MessageSearchHit`, `MessageSearchPage`,
`Mention`, `MentionPage`, `ReadMentionsRequest`. Additive-поля:

* `Message` → `mentions: uuid[]`, `mention_all: boolean` (для E2EE/tombstone всегда
  пусто/false; это проверяет и домен, и `MessageView`);
* `MessageCreate` → `mentions` (max 50, unique) и `mention_all` (default false);
* `FileItem.chat_id`/`message_id` стали nullable — глобальный файл ещё не привязан к
  чату/сообщению; описание file-center обновлено.

`GET /files` по-прежнему отдаёт метаданные без object key/sha256/URL. Новые
operation'ы намеренно не добавлены в список «обязательных для фронтенда» в
`check-contract.mjs` (как и в #92), но счётчики guard'а обновлены:
**117 paths / 144 operations / 191 schema**.

`frontend/src/api/schema.d.ts` регенерирован штатным `npm run api:types`.
`npm run contract:check` — passed, `npx tsc -p tsconfig.json --noEmit` — passed.

---

## 2. Глобальные файлы: пайплайн и права

`WorkspaceFileUploadHandler` (`@Transactional`):

1. `SafeFileName.require` — display-имя 1..255, без `/`, `\`, NUL/control и bidi
   символов; object key всегда строится из серверных UUID (`workspaces/<ws>/files/<upload>`).
2. `FileAccessGuard.requireWorkspaceAccess` — активирует RLS и требует ACTIVE-участие;
   чужой/неизвестный воркспейс → 403 без раскрытия существования.
3. Лимит размера: `WorkspaceLimits.effectiveMaxFileBytes(guest)`; превышение →
   `413 FILE_TOO_LARGE` (тариф/факт в `details`).
4. `FileTypePolicy.check(filename, mime, settings.allowedFileExtensions())`:
   dangerous (`exe`, `svg`, `html`, …) → `422 DANGEROUS_TYPE_BLOCKED`; неизвестное
   расширение/MIME → `415 UNSUPPORTED_TYPE`.
5. `Upload.createWorkspaceFile` + `quota.reserve` (атомарный `used+reserved+new<=limit`).
6. Байты **стримятся** в приватный бакет частями по `FileSize.DEFAULT_PART_SIZE`
   (8 MiB) через `ObjectStoragePort.createMultipart/uploadPart/completeMultipart`;
   в heap не буферизуется весь файл. SHA-256 считается на лету; фактическое число
   байт сверяется с заявленным (`422 INCOMPLETE_UPLOAD`).
7. Создаётся `Attachment.workspaceFile(...)`: `source=WORKSPACE`, `status=READY`,
   `scan_status=PENDING`, `chat_id=NULL`; upload → `SCANNING`; `quota.commit`
   переводит reserved → used ровно один раз.
8. AV: существующий `UploadScanHandler` (ClamAV в prod, fail-closed) переводит
   `PENDING → CLEAN` и разрешает скачивание; `INFECTED/FAILED` → `QUARANTINED`,
   объект удаляется, квота освобождается. **Обхода AV нет**: `SKIPPED` для
   `source=WORKSPACE` невозможен (V50 shape-check запрещает), а привязка к сообщению
   требует `READY + CLEAN` (`Attachment.assertBindable`).

Права/видимость:

| Действие | Кто | Поведение |
|---|---|---|
| upload | ACTIVE-участник воркспейса | 201 `FileItem`; файл без чата |
| list (`GET /files`) | владелец (unbound) | unbound `WORKSPACE` виден только загрузившему; после привязки — обычная chat-membership видимость |
| rename (`PATCH`) | только владелец | 404 для не-владельца (существование не раскрывается); меняется только display-имя |
| delete (`DELETE`) | владелец или workspace OWNER/ADMIN | soft delete + удаление объекта + `releaseCommitted`; повтор — 204 |
| delete привязанного к сообщению файла | — | `409 CONFLICT` (`attached_to_message`): жизненным циклом владеет сообщение |
| delete direct-image | — | `422 IMAGE_INVALID`: у аватаров/обложек/лого свой endpoint |

`FileAccessGuard.activateAttachmentScope` расширен для `WORKSPACE`-файлов (член
воркспейса может резолвить workspace для delete-модерации админом), а
`MessageAttachmentService.bind` привязывает unbound `WORKSPACE`-файл к чату
(`bindTo(messageId, chatId)`), после чего он участвует в обычной chat-visibility.
`UploadScanHandler` больше не «воскрешает» файл, удалённый во время скана: при
`DELETED` upload помечается `FAILED`, вердикт AV не пишется.

Квота/обслуживание:

* `committedAttachmentBytes` учитывает `source IN ('UPLOAD','WORKSPACE')` (direct
  images по-прежнему исключены — у них нет reservation);
* unbound-GC (`findUnboundReadyBefore`) по-прежнему фильтрует `source='UPLOAD'`,
  поэтому глобальные файлы не удаляются 24-часовым TTL;
* `ix_attachments_workspace_owner (workspace_id, user_id, created_at DESC) WHERE
  source='WORKSPACE'` для листинга владельца.

Транспорт: `spring.servlet.multipart.max-file-size` поднят до 512 MiB (backstop для
этого endpoint'а; большие файлы — через resumable `/uploads`). `MaxUploadSizeExceeded`
для маршрута `POST /api/v1/workspaces/{id}/files` маппится в `413 FILE_TOO_LARGE`, а не
в plugin-код.

**`POST /messages/{id}/attachments` не добавлен.** Это опциональный пункт задачи;
привязка уже покрыта штатным путём `MessageCreate.attachment_ids` (включая
глобальные файлы), а отдельная мутация уже отправленного сообщения потребовала бы
нового realtime-события/revision-контракта. Ограничение зафиксировано в §10.

---

## 3. Серверный поиск

`SearchMessagesService` + `MessageSearchQueryAdapter`:

* вызывающий — ACTIVE-участник воркспейса (403 иначе), при `chat_id` — ACTIVE-участник
  чата (404, существование скрыто);
* SQL (один запрос, без N+1) требует для **каждого** результата
  `chat_members.status='ACTIVE'`, `chats.security_mode='MANAGED'`,
  `messages.crypto_scheme='MANAGED'`, `deleted_at IS NULL` у чата и сообщения и
  отсутствие `message.message_deletions` для вызывающего; выбираются только `TEXT`
  с непустым body. Поэтому cross-chat/cross-workspace утечка невозможна даже без
  `chat_id`, а E2EE-шифртекст никогда не доходит до приложения;
* body хранится AES-GCM, поэтому SQL не может сделать `LIKE`: адаптер декодирует
  ограниченное keyset-окно кандидатов (`LIMIT`, 100..500) и сервис фильтрует
  literal-подстроку без учёта регистра. Не расшифровавшийся body пропускается
  fail-closed;
* `q` — 1..200 символов, без regex/wildcard; `from < to` (ISO-8601 instant);
  `limit` 1..50 (default 20); невалидные значения → 400 `VALIDATION_FAILED` с `field`;
* snippet — **plain text** (не HTML/markdown), ≤ 240 символов, центрирован на первом
  совпадении, с `…` по краям; `highlights[]` — диапазоны `[start,end)` в символах
  этой строки; клиент обязан рендерить как текст (контракт это фиксирует);
* курсор непрозрачен (base64url `msp1`), привязан к воркспейсу, `chat_id` и
  нормализованному `q`; двигается по последнему **просканированному кандидату**,
  поэтому страница без совпадений не зацикливает пагинацию. `has_more=true`, если
  окно было заполнено или лимит попаданий достигнут до конца окна.

---

## 4. Mentions

### Вход и валидация

`MessageCreate.mentions[]` (до 50 уникальных id) + `mention_all`. В
`MessageSubmissionHandler` (managed-ветка, **до** аллокации `seq`):

* STICKER + mentions → `422 VALIDATION_FAILED`;
* каждый id обязан быть ACTIVE-участником **этого** чата, иначе
  `422 MENTION_INVALID` (без раскрытия, существует ли пользователь/чат);
* `@all` разрешён только chat OWNER/ADMIN, иначе `403 MENTION_ALL_FORBIDDEN`;
* дубликаты схлопываются; автор исключается из получателей;
* mentions входят в idempotency-fingerprint (`SendMessageUseCase.requestHash`) и в
  проверку replay (`sameContent`), поэтому тот же `client_message_id` с другим
  mention-составом — конфликт, а не replay.

E2EE: `requireE2eePayload` отвергает mentions (`422 E2EE_PLAINTEXT_FORBIDDEN`,
`field=mentions`) до любой работы с ключами; `Message`/`MessageView` дополнительно
не отдают mention-метаданные для E2EE и tombstone.

### Хранение (V50)

* `message.mentions` — per-recipient inbox: `workspace_id/chat_id/message_id/user_id`,
  `mention_all`, `read_at`, `created_at`; уникальность `(message_id, user_id)`;
  индексы `(user_id, created_at DESC, id DESC)`, partial unread, `(message_id)`;
  `ENABLE/FORCE RLS` + tenant policy + grant только `krug_app`. `@all`
  материализуется в строки для активных участников на момент отправки, поэтому
  новый участник не получает старый `@all`;
* `message.messages.mentions jsonb` + `mention_all` — явные id для payload/рендера
  (`Message.mentions`), без дополнительного запроса на чтении; check-констрейнт
  «jsonb-массив»;
* запись inbox-строк и сообщения — одна транзакция.

### Уведомления

`MessageMentionNotification` публикуется в транзакции отправки; AFTER_COMMIT
`NotificationMentionListener` вызывает `NotifyUseCase.notifyMentioned` (REQUIRES_NEW):
на каждого получателя — `notification.notifications` с `type=MENTION`, title
«Вас упомянули», `body=NULL` (никакого контента), dedupe по
`(user, chat, message, MENTION)`, preference-режим IN_APP/EMAIL применяется как у
MESSAGE (`MUTE` гасит уведомление, `MENTIONS/ALL` — нет).

### Инбокс

`GET /me/mentions?unread&cursor&limit[&workspace_id]` — workspace-скоуп (claim, иначе
первый ACTIVE воркспейс; `workspace_id` переопределяет), только метаданные
(чат/сообщение/автор/`read_at`), без текста сообщения; `unread_count` — по всему
воркспейсу; keyset-курсор привязан к воркспейсу и `unread`.
`POST /me/mentions/read {ids[]|all}` — `read_at` выставляется один раз
(идемпотентно), `Idempotency-Key` обязателен. SQL всегда фильтрует
`user_id = caller`, RLS — workspace.

---

## 5. Миграция V50

`backend/src/main/resources/db/migration/V50__global_files_and_mentions.sql`
(номер согласован задачей; V49 в этом дереве отсутствует — Flyway допускает разрыв,
на чистой БД цепочка V1..V48,V50 применяется без ошибок):

* `file.uploads.chat_id` → nullable (только для глобальных файлов);
* `file.attachments`: `source` расширен `WORKSPACE`; `ck_attachments_source_shape`
  требует `upload_id NOT NULL` и допустимые scan-статусы для `WORKSPACE`
  (`SKIPPED` запрещён), `UPLOAD`/`DIRECT_IMAGE` не ослаблены; partial index
  `ix_attachments_workspace_owner`;
* `message.messages.mentions jsonb NOT NULL DEFAULT '[]'` + `mention_all boolean`,
  check на массив;
* `message.mentions` + индексы + RLS/grants.

Forward-only rollback plan зафиксирован в шапке миграции. RLS существующих таблиц
не менялся; новых «публичных» таблиц нет.

---

## 6. Файлы

Новые (backend):

```
src/main/resources/db/migration/V50__global_files_and_mentions.sql
src/main/java/ru/krug/backend/file/api/WorkspaceFileController.java
src/main/java/ru/krug/backend/file/api/dto/FileRenameRequest.java
src/main/java/ru/krug/backend/file/application/command/UploadWorkspaceFileCommand.java
src/main/java/ru/krug/backend/file/application/usecase/WorkspaceFileUploadHandler.java
src/main/java/ru/krug/backend/file/application/usecase/FileMutationService.java
src/main/java/ru/krug/backend/file/domain/service/SafeFileName.java
src/main/java/ru/krug/backend/message/api/MessageSearchController.java
src/main/java/ru/krug/backend/message/api/MeMentionsController.java
src/main/java/ru/krug/backend/message/api/dto/{SearchHighlightResponse,MessageSearchHitResponse,
  MessageSearchPageResponse,MentionResponse,MentionPageResponse,MarkMentionsReadRequest}.java
src/main/java/ru/krug/backend/message/api/mapper/{MessageSearchApiMapper,MentionApiMapper}.java
src/main/java/ru/krug/backend/message/application/command/SearchMessagesQuery.java
src/main/java/ru/krug/backend/message/application/model/{MessageSearchRow,SearchHighlightView,
  MessageSearchHitView,MessageSearchPageView,MessageSearchCriteria,MessageSearchCursor,
  MentionPlan,MessageMentionView,MentionInboxRow,MentionPageView,MentionPageCursor}.java
src/main/java/ru/krug/backend/message/application/port/{MessageSearchPort,MessageMentionPort,
  MentionInboxPort}.java
src/main/java/ru/krug/backend/message/application/usecase/{SearchMessagesService,
  MessageMentionService,MentionInboxService}.java
src/main/java/ru/krug/backend/message/application/event/MessageMentionNotification.java
src/main/java/ru/krug/backend/message/domain/model/{SearchHighlight,MessageMention}.java
src/main/java/ru/krug/backend/message/domain/repository/MessageMentionRepository.java
src/main/java/ru/krug/backend/message/domain/service/SearchSnippet.java
src/main/java/ru/krug/backend/message/infrastructure/persistence/{MessageSearchQueryAdapter,
  MessageMentionEntity,MessageMentionJpaRepository,MessageMentionRepositoryAdapter}.java
src/main/java/ru/krug/backend/notification/infrastructure/event/NotificationMentionListener.java
```

Изменены (backend):

```
file/api/mapper/FileApiMapper.java
file/application/usecase/{FileAccessGuard,MessageAttachmentService,UploadScanHandler}.java
file/domain/model/{Attachment,AttachmentSource,Upload}.java
file/domain/repository/AttachmentRepository.java
file/infrastructure/persistence/{AttachmentRepositoryAdapter,FileCenterQueryAdapter,
  UploadEntity,WorkspaceQuotaRepositoryAdapter}.java
message/api/MessageController.java
message/api/dto/{MessageCreateRequest,MessageResponse}.java
message/api/mapper/MessageApiMapper.java
message/application/model/{MessageCreateInput,MessageView}.java
message/application/usecase/{MessageSubmissionHandler,SendMessageUseCase}.java
message/domain/model/Message.java
message/infrastructure/persistence/{MessageEntity,MessagePersistenceMapper,
  MessageRepositoryAdapter}.java
notification/application/usecase/NotifyUseCase.java
notification/domain/model/{Notification,NotificationType}.java
shared/api/GlobalExceptionHandler.java
shared/error/ErrorCode.java
workspace/application/port/WorkspaceAccessPort.java
workspace/application/usecase/WorkspaceAccessService.java
src/main/resources/application.yml
```

Прочее: `contracts/openapi.yaml`, `frontend/src/api/schema.d.ts` (регенерация),
`frontend/scripts/check-contract.mjs` (счётчики guard'а; единственная правка вне
заявленной зоны, без неё `contract:check` красный).

Попутно исправлено в общем коде:

* `WorkspaceQuotaRepositoryAdapter.lockUsage` теперь делает native
  `SELECT … FOR UPDATE` вместо JPA `findForUpdate`. Без этого `reserve`+`commit` в
  одной транзакции (глобальная загрузка) читал устаревший first-level-cache и падал
  с `IllegalStateException: reserved quota is smaller than the reservation`.
* `UploadScanHandler` пишет вердикт AV точечным `UPDATE file.attachments SET
  status/scan_status/updated_at` вместо whole-row save. Это убирает lost update:
  rename/delete, закоммиченный во время скана, больше не перезаписывается, а
  DELETED-строка не воскрешается (`WHERE status <> 'DELETED'`).
* `MessageRepositoryAdapter.softDeleteForAll` очищает `mentions`/`mention_all`
  вместе с ciphertext (tombstone не хранит mention-метаданные; inbox-строки остаются
  content-free указателями).

---

## 7. Тесты

Новые классы (31 тест):

| Класс | Тестов | Покрытие |
|---|---:|---|
| `integration/WorkspaceFilesIT` | 5 | upload+scan+CLEAN+квота; dangerous/unsupported/traversal/413/403; rename owner-only, delete owner/admin, quota release, идемпотентный delete; привязка к сообщению, chat-visibility, 409 для привязанного; rename во время AV-скана не перезаписывается вердиктом |
| `integration/MessageSearchIT` | 5 | snippet+highlights, case-insensitive literal, chat-фильтр, утечка из private channel исключена, 404/403, from/to, delete-for-all/delete-for-me/E2EE исключены, keyset-пагинация, cursor-binding, валидация параметров |
| `integration/MentionsIT` | 3 | explicit mention: БД + MENTION notification (body null) + `/me/mentions` + read; @all OWNER ok / MEMBER 403, материализация активных участников; non-member 422, limit, dedupe; sticker 422; jsonb round-trip `Message.mentions` |
| `integration/MentionsE2eeIT` | 1 | E2EE-чат: `422 E2EE_PLAINTEXT_FORBIDDEN`, field=mentions, ни message, ни mention-строк не создаётся |
| `unit/SearchSnippetTest` | 5 | все совпадения, окно/ellipsis/offset, нет совпадения, literal regex-символы, отсутствие HTML-обработки |
| `unit/SafeFileNameTest` | 3 | обычные/юникод имена, traversal/control/bidi, пустое/длинное |
| `unit/MessageMentionServiceTest` | 6 | active-member валидация, @all роли, dedupe, лимит 50, запись строк, пустой план |
| `unit/UploadScanHandlerTest` | 3 | вердикт — targeted UPDATE (не whole-row save); DELETED во время скана не воскрешается; INFECTED освобождает квоту/удаляет объект |

Команды (JDK 21, offline Maven repo):

```bash
mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest=WorkspaceFilesIT,MessageSearchIT,MentionsIT,MentionsE2eeIT test
mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest=SearchSnippetTest,SafeFileNameTest,MessageMentionServiceTest,UploadScanHandlerTest test
mvn -o -Dmaven.repo.local=.m2repo test        # full suite + ArchUnit
```

Регрессия затронутых поверхностей (отдельный прогон): `FileCenterIT` 9/9,
`DirectImageUploadIT` 15/15, `FileMaintenanceIT` 3/3, `FileUploadIT` 11/11,
`MessageActionsIT` 6/6, `MigrationsIT` 11/11 (цепочка V1..V48,V50).

Контракт/фронтенд:

```bash
npm run api:types        # schema.d.ts синхронизирован
npm run contract:check   # passed: 144 operations, 191 schemas, types in sync
npx tsc -p tsconfig.json --noEmit
```

---

## 8. Полный прогон

```bash
JAVA_HOME=<jdk21> mvn -o -Dmaven.repo.local=.m2repo test
```

Результат на финальном коде:

* **905 tests, 0 failures, 0 errors, 0 skipped**;
* `ArchitectureTest` (ArchUnit) — **10/10**;
* `BUILD SUCCESS`.

До среза в дереве было 874 теста (816 базовых из #92 + 58 тестов параллельных
задач); этот срез добавляет **31** тест (27 новых + 3 unit на scan-verdict + 1
регрессионный на rename во время скана): 874 + 31 = 905.

Первый полный прогон выявил плавающую ошибку (rename, перезаписанный AV-вердиктом);
она исправлена переходом на targeted UPDATE вердикта (см. §2/§6) и закрыта
`UploadScanHandlerTest` + `WorkspaceFilesIT#aRenameCommittedDuringTheScanIsNotOverwrittenByTheVerdict`.
Повторный полный прогон — зелёный.

---

## 9. Приватность и анти-утечки (сводка)

* Поиск: SQL требует ACTIVE-участие в **каждом** чате, `MANAGED` и у чата, и у
  сообщения; E2EE ciphertext не декодируется; удалённые/скрытые сообщения исключены;
  snippet — plain text, без HTML; курсор не является границей безопасности.
* Глобальные файлы: unbound видит только владелец; привязанный — участники чата;
  object key/sha256/URL не возвращаются; object key не выводится из имени файла.
* Mentions: id не-участника → 422 без раскрытия; `@all` — только OWNER/ADMIN;
  уведомление без тела; `/me/mentions` — только метаданные и только свои строки
  (SQL `user_id = caller` + RLS); E2EE — 422 до любой работы с ключами.

---

## 10. Ограничения / follow-up

* **`POST /messages/{id}/attachments` не реализован** (опциональный пункт).
  Привязка глобального файла выполняется через `attachment_ids` при отправке;
  отдельная мутация уже отправленного сообщения требует нового realtime-события и
  revision-политики — отдельная задача.
* **Транспортный лимит 512 MiB** для multipart: файлы больше — только через
  resumable `/uploads` (там лимит тарифа до 2 GB). Это осознанный backstop против
  буферизации гигантских multipart-запросов.
* **Поиск сканирует окно кандидатов** (100..500 на запрос) из-за AES-GCM at rest.
  Для очень больших воркспейсов это может требовать нескольких страниц; отдельный
  plaintext-индекс сознательно не вводился (он бы противоречил шифрованию тела).
* **Wiki/UI**: `FilesPage.tsx`, поиск в ChatScreen и рендер mentions не менялись
  (зона — только `schema.d.ts`). UI-подключение — отдельная frontend-задача.
* **V50 без V49**: если параллельная задача добавит V49 после применения V50 на
  существующей БД, потребуется `flyway repair`/out-of-order; на чистых БД и в CI
  цепочка применяется корректно.
* **Rename/delete** ограничены активными файлами; direct images и привязанные к
  сообщению файлы управляются своими flow (422/409), чтобы не оставлять висячих
  ссылок.
* **STICKER + mentions** запрещены; mentions без текста (только вложение) разрешены.

---

## 11. Итог

**DONE** — все обязательные пункты #83 реализованы, полный backend-suite 905/905,
ArchUnit 10/10, контракт/типы синхронизированы. Единственный необязательный пункт
(`POST /messages/{id}/attachments`) не добавлен осознанно: привязка покрыта штатным
`attachment_ids`, см. §10.

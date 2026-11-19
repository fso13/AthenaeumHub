# FILE-CENTER (#73) — список/поиск/фильтры/квоты файлов воркспейса

> Зона сессии: `backend/**`, additive-правки `contracts/openapi.yaml`, регенерация
> `frontend/src/api/schema.d.ts`. Остальной `frontend/**`, `docs/**`, `design/**`,
> `deploy/**` не менялись. Git-репозитория в рабочем дереве нет; изменения проверены
> полным backend-suite и backend contract-тестами.

## Статус

**DONE.** Добавлен `GET /files` (file-center), независимый от загруженной истории:
список/поиск/фильтры/пагинация/сводка квоты. Возвращаются только метаданные
(`AttachmentRef` + `chat_id`/`chat_name`/`message_id`/`created_at`); содержимого,
object key, sha256 и presigned URL в ответе нет. Скачивание остаётся на существующем
`GET /attachments/{attachmentId}/download-url`.

Полный backend-suite: **570/570, failures/errors 0. ArchUnit: 10/10.**
(базовая линия 544 + 19 новых тестов file-center + 7 тестов параллельных задач,
попавших в тот же прогон).

## 1. Контракт

`contracts/openapi.yaml`, additive:

* path `GET /files` (`operationId: listFiles`, tag `files`);
* parameters: `workspace_id?`, `chat_id?`, `kind?`, `scan_status?`, `query?`, `mime?`,
  `extension?`, `cursor?`, `limit?` (1..100, default 50), `DeviceId`;
* schemas:
  * `FileItem` — `allOf: [AttachmentRef, {chat_id, chat_name, message_id, created_at}]`;
  * `FileQuotaSummary` — `used_bytes`, `reserved_bytes`, `storage_bytes`, `percent`;
  * `FilePage` — `items[]`, `page {next_cursor, has_more}`, `quota` (nullable);
* ответы: `200 FilePage`, `400 BadRequest`, `401`, `403`, `404`.

`frontend/src/api/schema.d.ts` регенерирован штатным
`npm run api:types` (openapi-typescript 7.13.0). `npm run contract:check` проходит:
67 operations, 103 schemas, generated types in sync.

## 2. Доступ и видимость

`ListFilesService`:

1. Воркспейс: `workspace_id` из запроса; иначе из `chat_id` (через
   `ChatWorkspacePort` для Keycloak-токена без claim); иначе из claim dev-токена.
   Если ни одного источника нет — `400 VALIDATION_FAILED`.
2. `tenantContext.activate(...)` → `WorkspaceAccessPort.requireActiveMember`.
   Чужой/неизвестный воркспейс — `403 FORBIDDEN` (существование не раскрывается).
3. `chat_id` задан → `ChatAccessPort.requireActiveChat`; чужой/неизвестный чат — `404`.
4. SQL дополнительно требует ACTIVE-участие вызывающего в чате каждого файла
   (`JOIN chat.chat_members ... status='ACTIVE'`). Это сознательно строже
   «workspace membership»: участник воркспейса не перечисляет файлы приватного чата,
   в который его не добавляли. Права на скачивание у существующего endpoint’а такие же.
5. E2EE исключён дважды: `chat.chats.security_mode = 'MANAGED'` и
   `message.messages.crypto_scheme = 'MANAGED'`. E2EE-вложения не возвращаются даже
   при прямом SQL-фикстуре.
6. Не возвращаются: вложения без `message_id` (ещё не отправлены), `status` =
   `DELETED`/`FAILED`, сообщения с `deleted_at` (delete-for-all) и сообщения,
   скрытые вызывающим (delete-for-me через `message.message_deletions`), удалённые
   чаты.

## 3. Запрос и фильтры

`FileCenterQueryAdapter` — один native SQL-запрос (без N+1), RLS активен для всех
таблиц; выбираются только метаданные:

```
file.attachments a
  JOIN chat.chats c            ON c.id = a.chat_id AND c.workspace_id = a.workspace_id
  JOIN chat.chat_members cm    ON cm.chat_id = a.chat_id AND cm.user_id = :userId
                                  AND cm.status = 'ACTIVE'
WHERE a.workspace_id = :workspaceId
  AND a.message_id IS NOT NULL
  AND a.status IN ('READY','BOUND','QUARANTINED')
  AND c.security_mode = 'MANAGED' AND c.deleted_at IS NULL
  AND EXISTS (live MANAGED message with m.chat_id = a.chat_id)
  AND NOT EXISTS (delete-for-me marker)
```

Фильтры (все опциональны, значения биндятся как JDBC-параметры):

| Параметр | Семантика |
|---|---|
| `chat_id` | точный чат (с предварительной проверкой доступа) |
| `kind` | `IMAGE/VIDEO/AUDIO/FILE`; `media->>'kind'`, иначе вывод из MIME |
| `mime` | точное совпадение MIME без учёта регистра |
| `extension` | расширение без точки, `^[a-z0-9]{1,10}$`, без учёта регистра |
| `query` | literal-подстрока без учёта регистра по имени файла и MIME; `%`/`_` — обычные символы (`position`, не LIKE) |
| `scan_status` | `PENDING/CLEAN/INFECTED/FAILED/SKIPPED` |

`limit` — 1..100 (default 50); `query` — до 200 символов; `mime` — до 128;
невалидные enum/значения → `400 VALIDATION_FAILED` с `details.field`.

## 4. Пагинация и квота

* Стабильный keyset-порядок `created_at DESC, id DESC`; id — tie-breaker для строк,
  созданных в одну микросекунду.
* Курсор — opaque base64url `fcp1\0workspace\0micros\0id`; проверяется версия и
  привязка к воркспейсу. Чужой/битый курсор → `400 VALIDATION_FAILED` (`field=cursor`).
* Запрос берёт `limit + 1` строку, `has_more` и `next_cursor` вычисляются без count.
* `quota` — read-only снимок `file.workspace_limits`/`workspace_usage`; в отличие от
  upload/complete он **не** берёт `FOR UPDATE`, поэтому список не блокирует загрузки.
  `percent = min(100, (used+reserved) * 100 / storage_bytes)`.
* `quota.used_bytes` — квота воркспейса, включая ещё не привязанные и невидимые
  вызывающему файлы; это осознанно workspace-level счётчик, а не сумма страницы.

## 5. Файлы

Новые:

* `backend/src/main/java/ru/krug/backend/file/api/FileCenterController.java`
* `backend/src/main/java/ru/krug/backend/file/api/dto/{FilePageResponse,FileItemResponse,FileMediaResponse,FileQuotaSummaryResponse}.java`
* `backend/src/main/java/ru/krug/backend/file/application/command/ListFilesQuery.java`
* `backend/src/main/java/ru/krug/backend/file/application/model/{FilePageCursor,FileCenterRow,FileItemView,FileMediaView,FilePageView,FileQuotaSummaryView}.java`
* `backend/src/main/java/ru/krug/backend/file/application/port/FileCenterQueryPort.java`
* `backend/src/main/java/ru/krug/backend/file/application/service/FileCenterRequests.java`
* `backend/src/main/java/ru/krug/backend/file/application/usecase/ListFilesService.java`
* `backend/src/main/java/ru/krug/backend/file/domain/exception/InvalidFileCursorException.java`
* `backend/src/main/java/ru/krug/backend/file/infrastructure/persistence/FileCenterQueryAdapter.java`

Изменены:

* `backend/src/main/java/ru/krug/backend/file/api/mapper/FileApiMapper.java`
  (маппинг `FilePageView` → DTO);
* `contracts/openapi.yaml`;
* `frontend/src/api/schema.d.ts` (только регенерация).

Миграций нет: используются существующие индексы `ix_attachments_chat_created`,
`ix_attachments_workspace_status`, `ix_attachments_message`. Отдельный частичный
индекс `(workspace_id, created_at DESC, id DESC)` — возможный follow-up для больших
воркспейсов; в этой сессии не добавлялся, чтобы не занимать номер миграции,
параллельно используемый другой задачей (`V35__profile_fields.sql`).

## 6. Тесты (19 новых)

`backend/src/test/java/ru/krug/backend/integration/FileCenterIT.java` (9):

* `listsBoundFilesWithProvenanceAndQuota` — chat/message/created_at, отсутствие
  `object_key`/`sha256`/`url`/`content`, квота;
* `filtersByKindMimeExtensionLiteralSearchAndScanStatus` — все фильтры, literal `%`,
  невалидные значения → 400;
* `filtersByChatAndHidesForeignOrRemovedChats` — чужой воркспейс 403, чужой чат 404,
  удалённый из чата участник;
* `paginatesStablyThroughAllFiles` — 5 файлов, limit=2, три страницы без дублей,
  чужой cursor → 400;
* `neverReturnsE2eeChatOrE2eeMessageAttachments` — E2EE-чат + E2EE-сообщение,
  managed-файл рядом виден;
* `excludesDeletedForAllAndDeletedForMeMessages` — delete-for-all (DELETED) и
  delete-for-me;
* `excludesUploadsThatWereNeverBoundToAMessage` — READY без message_id не в списке,
  но квота учтена;
* `workspaceIdIsOptionalWithADevClaimOrAChatId`;
* `emptyWorkspaceHasZeroQuotaAndNoItems`.

`FileCenterContractIT` (2): `FilePage`/`FileItem`/`FileQuotaSummary` и `Error`
против `contracts/openapi.yaml`.

`FilePageCursorTest` (3): микросекунды, tie-breaker id, битые/чужие курсоры.
`FileCenterRequestsTest` (5): limit, query, enum, mime/extension, cursor.

## 7. Проверка и оговорки

* `mvn -Dtest='FileCenterIT,FileCenterContractIT,FilePageCursorTest,FileCenterRequestsTest' test`
  — 19/19;
* полный `mvn test` — 570/570, ArchUnit 10/10 (запуск на JDK 21: дефолтный
  `mvn` в окружении подхватывает JDK 26, где падают pre-existing Mockito inline
  тесты, не связанные с file-center);
* `python3 scripts/validate-yaml.py` — `contracts/openapi.yaml` OK;
* `npm run api:types` — `schema.d.ts` синхронизирован;
* `npm run contract:check` — passed (67 operations, 103 schemas, drift чист).

Оговорки:

* `chat_name` для DIRECT-чатов равен `null`: сервер не раскрывает имя собеседника
  (в `auth.users` RLS только self); клиент выводит имя из chat summary, как и раньше
  (D-S4-02). Для GROUP возвращается `chat.name`.
* `QUARANTINED`-вложения с привязанным сообщением попадают в список с
  `scan_status=INFECTED/FAILED`, но остаются недоступны для скачивания (423);
  это metadata-only поверхность, не обход fail-closed download.
* `frontend/src/components/pages/FilesPage.tsx` не менялся: задача backend-only,
  текущая страница по-прежнему собирает файлы из загруженной истории. Подключение
  к `GET /files` — отдельная frontend-задача.
* `frontend/scripts/check-contract.mjs` в этой сессии не менялся; его guard’ы
  обновлялись параллельными задачами, итоговый `contract:check` зелёный.

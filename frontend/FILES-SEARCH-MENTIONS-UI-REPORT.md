# Frontend #83 — глобальные файлы, серверный поиск, серверные mentions

**Статус: DONE.** Зона изменений — только `frontend/**` (плюс сгенерированный
`schema.d.ts`, который уже был синхронизирован backend-срезом). Сервер остаётся
единственным источником истины: клиент не создаёт файлы, результаты поиска,
упоминания, счётчики или состояние прочтения локально.

## 1. Контракт, который подключён

| Surface             | Operation                                          | Где используется                                          |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Глобальная загрузка | `POST /workspaces/{workspaceId}/files` (multipart) | `FilesStore.uploadFile` → `FilesPage`                     |
| Rename              | `PATCH /files/{fileId}` (`FileRename`)             | `FilesStore.renameFile` → inline-редактор строки          |
| Delete              | `DELETE /files/{fileId}` (Idempotency-Key)         | `FilesStore.deleteFile` → confirm-dialog                  |
| Поиск               | `GET /workspaces/{workspaceId}/search/messages`    | `ChatStore.searchMessages` → `MessageSearchPanel`         |
| Mention inbox       | `GET /me/mentions`                                 | `ChatStore.refreshMentions` → вкладка «Упоминания» в bell |
| Read                | `POST /me/mentions/read` (`ids[]` / `all`)         | `ChatStore.markMentionRead` / `markAllMentionsRead`       |

`MessageCreate.mentions[]`/`mention_all` отправляются вместе с сообщением;
`Message.mentions`/`mention_all` используются для рендера chips и для inbox.

## 2. Файлы (`FilesPage`)

- Кнопка «Загрузить» открывает file input и вызывает реальный multipart
  `POST /workspaces/{id}/files` через `ApiClient.postFormData` (XHR, реальный
  upload-progress). Состояние `fileCenterUpload` хранит filename/progress/error;
  баннер показывает progressbar, «Отменить загрузку», «Повторить» и «Скрыть».
  По успеху список перезапрашивается тем же фильтром (`reloadFileCenter`) и
  обновляется квота (`refreshLimits`).
- Ошибки маппятся по контрактным кодам: `403/413/415/422 DANGEROUS_TYPE_BLOCKED/
503`, плюс честный `423/409` для удаления. Никаких «успешных» локальных строк.
- Rename — owner-only inline-форма: валидация 1..255, `204/` server row
  заменяет строку; `404` показывается как «переименовать может только владелец»
  (сервер намеренно скрывает существование).
- Delete — подтверждение через модальный `AdminConfirmDialog` (focus trap,
  Escape, disabled на время запроса). `409 CONFLICT attached_to_message`
  показывается в диалоге, строка остаётся; `404` закрывает диалог как
  согласованное состояние. Кнопки видны всем, права проверяет сервер; заголовок
  подсказывает правило owner/OWNER/ADMIN.
- Фильтры, таблица, пагинация и скачивание сохранены.

## 3. Серверный поиск

- `ChatStore.messageSearch` — отдельная цепочка: `query`, `chatId`, `items`,
  `status`, `nextCursor`, `hasMore`, `loadMoreStatus`, `seq`.
- `ChatScreen` дебаунсит ввод 300 мс и вызывает
  `GET /workspaces/{id}/search/messages` (workspace-wide, `limit=20`).
  Пустой запрос — явная подсказка «Поиск по всем чатам», не локальная фильтрация
  загруженной истории. `MessageList` больше не фильтрует историю по строке.
- `MessageSearchPanel` рендерит `snippet` **как текст**, подсвечивает
  `highlights` через `<mark>` (диапазоны clamp/sort/merge, UTF-16), показывает
  `chat_name`, автора и дату. Есть loading / error+retry / empty / no-results и
  cursor «Показать ещё».
- Переход к попаданию: переключает чат, затем bounded-подгрузка истории
  (до 10 страниц `loadMore`) до найденного `message_id`; при успехе — focus +
  highlight строки, иначе честное уведомление «сообщение не загружено».
- Поиск одинаково доступен из иконки в `ChatHeader` и из `ChatDetails`.

## 4. Mentions

- Composer отслеживает финальный текст: `buildMentionPayload` сканирует
  `@Name` по директории участников **чата** (fallback — workspace до загрузки),
  возвращает `{mentions[], mention_all}`. Удалённый из текста `@Name` убирает id;
  неизвестное имя остаётся обычным текстом (без гарантированного 422).
- `@all` предлагается только при роли чата OWNER/ADMIN (`allowMentionAll`);
  не-менеджеру кандидат не показывается. Если сервер всё равно ответит
  `403 MENTION_ALL_FORBIDDEN`, outbox показывает честный текст
  «доступно только владельцу и администратору чата».
- Payload уходит в `store.send(...)` и `store.sendThreadReply(...)`; E2EE-ветка
  не передаёт mentions вовсе (`E2EE_PLAINTEXT_FORBIDDEN` на сервере не
  провоцируется), STICKER их не несёт.
- Рендер chips стал серверно-авторитетным: при наличии `Message.mentions`
  chips строятся только по этим id (через `memberNames`), `@all` — по
  `mention_all`; legacy-сообщения без поля сохраняют текстовый fallback.
- `@all` материализуется mock-сервером в inbox-строки; выражается отдельным
  chip `mention--all`.

## 5. Mention inbox / badge

- В `NotificationBell` появились две вкладки: «Уведомления» и «Упоминания»;
  вкладка упоминаний показывает `unread_count`, список
  chat/author/time/read-state (без текста сообщения — контракт content-free),
  фильтр «Только непрочитанные», «Отметить прочитанным» на строке и
  «Прочитать все».
- Бейдж bell остаётся счётчиком уведомлений (не суммируется с mentions, чтобы
  не двоить MENTION-notification + inbox-row); непрочитанные упоминания дают
  отдельную точку на bell и tooltip, а точное число — на вкладке.
- Открытие строки помечает её прочитанной и переключает чат; отметка
  оптимистична с rollback при ошибке, `read_at` выставляется один раз
  (сервер идемпотентен).
- `refreshMentions()` вызывается на bootstrap (бейдж в первом кадре), при
  открытии панели и после workspace switch; epoch-guard отбрасывает stale
  ответы.

## 6. MSW

Добавлены handlers и состояние:

- `POST /workspaces/:workspaceId/files` — multipart через существующий
  `readMultipartForm`, проверки имени/размера/квоты/dangerous-extension,
  создание `FileItem` + attachment/upload (скачивание работает), 201.
- `PATCH /files/:fileId` — Idempotency-Key, safe display name, 404/ошибки.
- `DELETE /files/:fileId` — 204 идемпотентно, `409 attached_to_message`,
  освобождение квоты.
- `GET /workspaces/:workspaceId/search/messages` — literal-поиск по managed
  чатам, snippet ≤240 + highlights, opaque UTF-8 base64url cursor, привязанный
  к `q`/`chat_id`, пагинация, 400-валидация.
- `GET /me/mentions` — seeded inbox, `unread_count`, фильтр, cursor.
- `POST /me/mentions/read` — `ids`/`all`, idempotent `read_at`.
- `POST /chats/:chatId/messages` — валидирует mentions (участники чата,
  `MENTION_ALL_FORBIDDEN` для не-менеджера, `E2EE_PLAINTEXT_FORBIDDEN`),
  сохраняет `Message.mentions`/`mention_all` и материализует inbox-строки.

## 7. Тесты и проверки

Новые suite (17 тестов, включая axe):

| Файл                                      | Тестов | Покрытие                                                                                                  |
| ----------------------------------------- | -----: | --------------------------------------------------------------------------------------------------------- |
| `src/components/FilesUpload83.test.tsx`   |      4 | multipart upload + progress/done/refresh, rename + server error, delete confirm + 409, dangerous 422, axe |
| `src/components/MessageSearch83.test.tsx` |      4 | hint/empty query, snippets+`<mark>`, cursor paging, jump+focus, error/retry, axe                          |
| `src/components/Mentions83.test.tsx`      |      4 | `mentions[]` в payload, скрытие `@all` для MEMBER, `@all` для OWNER + честный 403, axe                    |
| `src/components/MentionInbox83.test.tsx`  |      5 | список/unread, mark-one, mark-all, unread-фильтр, переход в чат, error/retry, axe                         |

Полный прогон (`npm run check`, 2026-11-20):

- lint — 0 errors; format — passed; contract:check — 144 operations / 191
  schemas, типы синхронны; stickers/security/session-writers — passed;
- vitest — **122 files / 1266 tests passed** (требование 1204+);
- `tsc --noEmit` + `vite build` — passed.

## 8. Ограничения / осознанные решения

- Rename/delete UI не скрывает кнопки по владельцу: `FileItem` не содержит
  владельца, поэтому права проверяет сервер (`404`/`403` показываются честно).
- Jump к старому сообщению ограничен 10 страницами истории; если его нет в
  окне, показывается уведомление, а не фиктивный скролл.
- Счётчик bell не складывает notifications и mentions (одно упоминание даёт обе
  записи); точные числа — на вкладках.
- `@all` скрыт, пока роль чата не загружена (unknown role); сервер всё равно
  авторитетен.
- Legacy-сообщения без `Message.mentions` рендерят chips по тексту; новые —
  строго по id.

**DONE**

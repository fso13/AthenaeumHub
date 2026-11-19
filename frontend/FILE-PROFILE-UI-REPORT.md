# FILE-CENTER + PROFILE UI (#73/#72) — отчёт frontend

> Зона сессии: только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `schema` не менялись; `contracts/openapi.yaml` уже содержал
> `GET /files`, `PATCH /me`, `GET/DELETE /me/sessions` (67 operations / 103
> schemas), `src/api/schema.d.ts` регенерировать не потребовалось.
> Git-репозитория в рабочем дереве нет; изменения проверены типами, линтом,
> unit/axe-тестами и D1 Playwright-сюитой.

## Статус

**DONE.** File-center переведён с «собери вложения из загруженной истории» на
серверный `GET /files` (фильтры/поиск/скан-статус/курсор/квота); профиль получил
частичное редактирование `PATCH /me` и реальный список сессий Keycloak с
подтверждаемым отзывом. 2FA остаётся честно недоступной, устройства — как были.

## 1. API-слой

`src/api/types.ts`

- добавлены алиасы из контракта: `AuthUser`, `ProfileUpdate`, `ProfileSession`,
  `ProfileSessions`, `FileItem`, `FilePage`, `FilePageMeta`,
  `FileQuotaSummary`, `FileKindFilter`, `FileScanStatusFilter`.

`src/api/endpoints.ts`

- `ListFilesQuery` — типизированные `workspace`, `chat`, `kind`, `scan_status`,
  `query`, `mime`, `extension`, `cursor`, `limit`; пустые фильтры не отправляются,
  `cursor` — только серверный `next_cursor`;
- `ChatApi.listFiles`, `updateMe`, `listMySessions`, `revokeMySession`;
- `PATCH /me` принимает только контрактные поля, `DELETE` сессии кодирует id один
  раз; `X-Device-Id` по-прежнему добавляет общий HTTP-клиент.

`src/store/filesStore.ts`

- `fileCenter: { items, status, error, hasMore, nextCursor, quota, query }`;
- `loadFiles(query)` — замена страницы, сброс items, защита от гонок через
  sequence-токен; ошибка не оставляет «старые строки под новым фильтром»;
- `loadMoreFiles()` — ровно одна серверная страница, дедупликация по `id`, курсор
  не конструируется локально;
- смена workspace инвалидирует in-flight запросы и чистит file-center;
- `listFiles` добавлен в `FilesStoreDeps`.

`src/store/chatStore.ts`

- `loadProfile()` — один `GET /me` для профильного модала (dev-сессия не несёт
  bio/phone/email);
- `updateProfile(patch)` — PATCH, затем `me.user`/`user` заменяются ответом
  сервера; при ошибке локального оптимистичного апдейта нет;
- `listMySessions()` / `revokeMySession()` — возвращают результат/ошибку, не
  подменяя серверное состояние.

## 2. FilesPage / FileCenter

`src/components/pages/FilesPage.tsx` переписан на `GET /files`:

- тулбар: таблетки `Все/Изображения/Документы/Аудио/Видео` (контрактные
  `IMAGE/FILE/AUDIO/VIDEO`), поиск с debounce 250 мс (literal `query` по имени и
  MIME), селектор `scan_status`, счётчик загруженных строк;
- таблица 7 колонок: иконка/превью, имя, чат, размер, тип, scan-статус, действия;
  на мобильном — существующая card-раскладка;
- `Показать ещё` — только при `page.has_more`, курсор берётся из `next_cursor`;
- состояния: первичная загрузка, пустой список, «ничего не найдено» + сброс
  фильтров, ошибка списка + retry, ошибка следующей страницы + retry,
  ошибка/retry лимитов (сохранён прежний блок);
- download — существующий `GET /attachments/{id}/download-url` через
  `FilesStore.getDownloadUrl`, затем noopener-переход; для `INFECTED/FAILED`
  кнопка выключена;
- превью: `media.artwork_url` (только http/https) либо presigned URL для CLEAN
  raster-изображения (`isSafePreviewImage`), иначе расширение; список не рендерит
  object key/sha256/presigned URL как данные; `<img>` не получает SVG/HTML;
- квота: `FilePage.quota` (used/reserved/storage/percent) для заголовка и meter,
  `/limits` — для тарифа и правил; при отсутствии quota используется `usage`
  из `/limits`;
- `chat_name` для DIRECT равен `null` по контракту — имя выводится из загруженного
  chat summary/справочника (то же правило, что D-S4-02), иначе «Чат недоступен»;
- `chatDisplayName` экспортирован из `pageData.ts` (переиспользование, не копия).

`SettingsPage`: строки «Активные сеансы» больше не утверждают «API не подключён»
и не показывают число устройств как число сессий. Вкладка «Устройства» и
security-card ведут в реальный профиль («Открыть профиль»), где сессии можно
завершить. Дизейбл «Завершить все сеансы» убран как вводящий в заблуждение.

## 3. ProfileDialog (#72)

`src/components/ProfileDialog.tsx`:

- **Редактирование**: display_name / bio / phone; форма появляется по
  «Редактировать», фокус уходит в первое поле, Esc отменяет форму (а не закрывает
  модал), сохранение/отмена, live-region «Профиль сохранён.»;
- **Инкрементальный PATCH**: отправляются только изменённые поля; пустые bio/phone
  уходят как `null` (контрактное «очистить»); неизменённая форма закрывается без
  запроса; email/пароль/2FA не редактируются и не отправляются;
- **Валидация 80/280/32** повторяет серверный trim + bounds; ошибки у полей
  (`aria-invalid`, `aria-describedby`), фокус на первом невалидном поле; ответ
  сервера с `details.field` подсвечивает соответствующее поле;
- **Ошибки сохранения**: форма не закрывается, `role=alert`, профиль не меняется
  локально; 503 имеет отдельную честную формулировку;
- **Сессии**: `GET /me/sessions` при открытии, `name`/`created_at`/
  `last_access_at`/`current`; текущая помечена «Текущая»; id/IP/username/токены не
  рендерятся; loading/empty/error(503)/retry;
- **Отзыв**: кнопка «Завершить» → `AdminConfirmDialog` с явным подтверждением;
  для текущей сессии отдельно сказано, что access token живёт до истечения, а
  refresh-сессия отзывается; после `204` список **перечитывается**, строка не
  удаляется оптимистично; `404` трактуется как «уже завершена» с перечитыванием;
  503/сеть показывают retry в диалоге;
- **2FA**: остаётся `Недоступно` с прежним честным пояснением — API аутентификатора
  в контракте нет;
- **Устройства**: существующий `GET /devices`, без изменений;
- **/me после сохранения**: `updateProfile` заменяет `me.user`/`user`, поэтому
  шапка, sidebar и профиль сразу читают серверный ответ;
- **focus/aria/mobile**: focus trap и возврат фокуса сохранены, возврат на
  «Редактировать» после save/cancel, backdrop не закрывает модал во время
  редактирования, поля с label/описанием, на 390 px форма складывается в одну
  колонку; axe-тесты для обычного режима и режима редактирования.

`src/styles/app.css`: добавлены только стили в существующей палитре/радиусах —
`.page-select`, `.files-more`, `.file-error`, `.profile-form*`, `.profile-saved`,
`.profile-sessions`, `.mini-session`; ширина колонки действий 68→90 px под две
иконки. `src/i18n/ru.ts` — новые ключи и правки устаревших формулировок.

## 4. MSW и тесты

`src/mocks/db.ts`, `src/mocks/handlers.ts`:

- `GET /files`: workspace/chat/kind/scan_status/query/mime/extension/limit,
  opaque-cursor mock, сортировка `created_at DESC, id DESC`, quota из
  `db.limits`, whitelist полей `FileItem` (object key/hash/url не отдаются);
- `PATCH /me`: partial-семантика, `422 empty_patch`, bounds 80/280/32, control
  chars, очистка null/пустой строкой, unknown-поля игнорируются;
- `GET /me/sessions` (сортировка, текущая сессия), `DELETE` (UUID, 404, 204);
- управляемые ошибки/задержки для тестов и счётчики запросов; reset/seed сессий.

Тесты:

- новый `src/components/FilesPage.test.tsx` (6): таблица/фильтры/поиск/scan,
  cursor-пагинация без дублей, download-url + превью + отсутствие ключей/URL в
  списке + disabled для INFECTED, error/retry, empty, axe;
- `src/components/Profile.test.tsx` (12): прежние 6 обновлены под реальные сессии
  (2FA по-прежнему disabled); новые 6 — incremental save, bounds 80/280/32 без
  запроса, ошибка сервера без оптимистичного апдейта, revoke confirm + перечитывание,
  503/retry сессий и ошибка отзыва без потери строки, axe в edit-mode;
- `src/components/Dashboard.test.tsx` — Files-фикстура переведена на
  `db.fileCenterItems`, асинхронные ожидания фильтров/мобильных строк;
- `src/store/filesStore.test.ts` — тест типизированных `mime/extension/cursor`
  и append-пагинации;
- `scripts/check-contract.mjs` — guard’ы: `FileItem` = `AttachmentRef` +
  provenance и без `object_key/sha256/url/content`, nullable quota, отсутствие
  IP/username/токенов в `ProfileSession`, отсутствие email/password в
  `ProfileUpdate`, bounds 80/280/32;
- `e2e/d1-settings-profile.spec.ts` — обновлён профильный сценарий (реальные
  сессии) и добавлен e2e: incremental PATCH (тело запроса), второй PATCH только с
  `display_name`, отзыв сессии после подтверждения.

## 5. Проверка

| Проверка                                                            | Результат                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc -p tsconfig.json --noEmit`                                 | passed                                                                                                                                                                  |
| `npm run lint`                                                      | 0 errors; 4 pre-existing warning (ChatDetails/CreateChatDialog/chatBridgeSupport), в изменённых файлах 0                                                                |
| `npm run format:check`                                              | passed                                                                                                                                                                  |
| `npm run contract:check`                                            | passed: **67 operations / 103 schemas**, generated types in sync                                                                                                        |
| `npm run security:check`                                            | passed: 307 files, no XSS/localStorage/token-log violations                                                                                                             |
| `npm run check`                                                     | passed полностью: lint → format → contract → stickers → security → session-writers → tests → build                                                                      |
| `vitest run`                                                        | **92 files / 990 tests passed** (базовая линия 977+; +13)                                                                                                               |
| `PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npm run test:e2e:d1` | **37/37 passed** (включая 1600/390 visual/a11y и новый profile edit/revoke)                                                                                             |
| Screenshots                                                         | `visual-review/fidelity-2/pages-files-light.png`, `pages-files-dark.png`, `mobile-files.png`, `modal-profile-light.png`, `modal-profile-dark.png`, `mobile-profile.png` |

Примечание: финальная правка `SettingsPage` (текст/кнопка «Открыть профиль»)
после полного прогона проверена `tsc`/eslint; по просьбе родительской сессии
повторный полный suite не запускался — финальный `npm run check` остаётся за ней.

## 6. Осознанные ограничения

- **Dev-профиль**: backend #72 честно отвечает `503 AUTH_UNAVAILABLE` на
  `/me/sessions` без Keycloak identity-link. UI показывает это как retryable
  ошибку, а не пустой список. `PATCH /me` в dev работает; профиль дополнительно
  читает `GET /me`, чтобы показать bio/phone/email.
- **Текущая сессия**: контракт разрешает её отзыв; UI предупреждает, что access
  token доживёт до истечения, а refresh-сессия будет отозвана. Мгновенная
  инвалидация stateless access token — вне среза (как и в backend-отчёте).
- **Счётчик файлов** — число загруженных строк, а не total: в контракте нет
  count-поля. Заголовок квоты — workspace-level снимок, не сумма страницы.
- **Поиск** — literal по filename/MIME (контракт); по имени чата не ищет, поэтому
  placeholder изменён на «Имя файла или MIME».
- **DIRECT-чаты**: `chat_name` null, имя выводится клиентом из chat summary
  (D-S4-02), как и в backend-отчёте #73.
- **E2E file-center**: D1-сюита проверяет страницу/пустое состояние/контракт;
  наполнение `GET /files` в MSW задаётся тестовыми фикстурами
  (`db.fileCenterItems`), а upload-сценарии e2e (`files.spec.ts`) в file-center
  не переходят. Реальный backend отдаёт привязанные к сообщениям вложения.
- **Отзыв сессии** не удаляет строку оптимистично: после `204` выполняется
  повторный `GET /me/sessions`; при ошибке перечитывания старая строка остаётся.
- 2FA, смена email/пароля, загрузка аватара и «выйти на всех устройствах» не
  добавлялись — их нет в контракте #72.

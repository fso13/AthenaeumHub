# E9-F — full admin (users/chats/storage) + design system / UI-UX pass

> Формат — `docs/TASKS.md` §5. Зона сессии: только `frontend/**`; `backend/**`,
> `contracts/**`, `docs/**`, `design/**` и `src/api/schema.d.ts` не менялись.
> E2EE-флаг (`VITE_E2EE_ENABLED=false`), managed-файлы, медиа, стикеры и уведомления
> не затронуты. Git-репозитория в рабочем дереве нет, поэтому «одним PR» проверить
> нельзя — изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E9-F.** Реализованы R-05 (полноценная админка: Overview / Users /
Chats / Storage / Settings) и R-06 (токены, светлая/тёмная тема, адаптивность
390/768/1440, touch-targets ≥44, WCAG AA, состояния). Контракт не менялся —
**41 path / 47 operations / 81 schema**, `schema.d.ts` синхронен.

- `npm run check` — зелёный: lint, format, contract (`47 operations, 81 schemas,
69 checked for required fields`), stickers, security (226 files), session-writers,
  vitest **661/661 (65 files)**, `tsc` + `vite build`.
- `e2e/admin.spec.ts` (mock, password-auth) — **10/10**, включая axe WCAG 2.0/2.1 AA
  в light/dark и viewport 390/768.
- Было до среза: 645 unit-тестов / 63 файла. Добавлено 16 unit-тестов (5 store +
  11 RTL) и 7 e2e-сценариев (было 3 в `admin.spec.ts`).

## Сделано

### 1. Информационная архитектура `/admin`

`src/components/admin/tabs.ts`, `AdminScreen.tsx`:

- разделы **Overview / Users / Chats / Storage / Settings**; маршрут
  `/admin?tab=<id>`, `overview` — дефолт и чистый `/admin`;
- `role="tablist"` + `role="tab"` с `aria-selected`, `aria-controls`, roving
  tabindex; стрелки Left/Right, Home/End, Enter/Space (native button); смена вкладки
  пишет history-entry, Back/Forward и deep link работают;
- единственный `role="tabpanel"` (`aria-labelledby` активной вкладки); секции
  монтируются лениво — переход на Storage не грузит users/chats;
- hero/setup-чип/«Продолжить настройку»/«К чатам»/«Выйти» сохранены из E8.
- Settings — прежняя форма SMTP/лимитов/registration + тестовое письмо и
  аудит-подсказка, вынесена в `AdminSettingsSection.tsx` без изменения логики
  (SMTP-пароль по-прежнему только в state формы, после PATCH очищается).

### 2. Типизированный API-клиент

`src/api/types.ts`, `src/api/endpoints.ts`:

```ts
listAdminUsers(query?: { query?; cursor?; limit? }): Promise<AdminUserPage>
listAdminChats(query?: { workspaceId?; query?; type?: 'DIRECT'|'GROUP'; cursor?; limit? }): Promise<AdminChatPage>
getAdminStorage(query?: { workspaceId? }): Promise<AdminStorage>
```

Типы — только из `schema.d.ts`: `AdminUser`, `AdminUserPage`, `AdminUserStatus`,
`AdminChat`, `AdminChatPage`, `AdminChatType`, `AdminStorage`,
`AdminStorageWorkspace`, `AdminStorageTotals`. Параметры маппятся в
`query/cursor/limit/workspace_id/type`; пустой поиск не отправляется (серверный
default). Курсор — непрозрачный `next_cursor`, клиент его не конструирует и не
интерпретирует. Ни одного «изобретённого» поля/эндпоинта.

### 3. `AdminDirectoryStore` (`src/ops/adminDirectory.ts`)

- отдельный срез состояния с собственной подпиской (`OpsStore.directory`,
  `useAdminDirectoryState()`), `reset()`/`dispose()` на logout/account switch;
- `users`/`chats`: `items`, `nextCursor`, `hasMore`, `status`
  (`idle|loading|ready|error`), `error`, `loadingMore`, `moreError`, фильтры;
  `storage`: `data`, `status`, `error`;
- курсорная пагинация: append + дедупликация по `id` (граничная строка может
  повториться), `hasMore = has_more && next_cursor` — без «вечного» Load more;
- гонки: у каждого среза монотонный token + generation; ответ, пришедший после
  смены фильтра/поиска/reset, отбрасывается и не смешивается с новой цепочкой;
- `setUsersQuery`/`setChatsFilters` дедуплицируют одинаковое значение;
- `ADMIN_PAGE_SIZE = 25` (контракт допускает 1..100).

### 4. Users (FR-ADM-10)

`AdminUsersSection.tsx`:

- поиск по email/имени — controlled input + debounce 300 мс, `maxLength=254`,
  явная кнопка «Сбросить»; подсказка «поиск буквальный, без шаблонов»;
- cursor-пагинация «Показать ещё» (во время загрузки — `disabled` + «Загружаем ещё…»),
  ошибка следующей страницы не стирает уже показанные строки, есть retry;
- колонки: **email, name, status, admin, workspaces, chats, storage, created**;
  статус — чип, admin — бейдж, storage — `formatBytes`, created — `<time>`;
- skeleton фиксированной высоты (без layout shift), empty (отдельно «ничего не
  найдено» и «пользователей нет»), error + retry + `ErrorDetails`;
- счётчик показанных строк (`role="status"`), 25 строк на страницу.

### 5. Chats (FR-ADM-11)

`AdminChatsSection.tsx`:

- фильтры `workspace_id`, `type` (`DIRECT|GROUP`, плюс «Все типы») и поиск по имени
  (debounce 300 мс, `maxLength=120`), кнопка сброса всех фильтров;
- колонки: **workspace, name, type, mode, members, messages, last activity**;
  `name=null` → «Без названия», нет активности → «Активности не было», `messages`
  — `chat_counters` (подсказка в `title`);
- cursor-пагинация/append/ошибки — как в Users;
- **источник списка пространств:** отдельного admin-справочника пространств в
  контракте нет, поэтому options фильтра строятся из строк `/admin/storage`
  (одна строка на неудалённый workspace) + уже загруженных чатов как fallback.
  Это видно пользователю подсказкой и описано в README/рисках. Storage-чтение
  кешируется в срезе, поэтому повторные переключения вкладок его не дублируют.

### 6. Storage (FR-ADM-12)

`AdminStorageSection.tsx`:

- итоги `used_bytes`, `reserved_bytes`, `objects`, `attachments` (`role="group"`,
  `aria-label="Итоги хранилища"`) и строка на пространство (workspace + mode, used,
  reserved, objects, attachments, limit bar);
- лимит: `role="progressbar"` c `aria-valuemin/max/now` и `aria-label`
  «<workspace>: занято N% от лимита», заполнение через inline `width` (единственный
  inline-style, значение вычисляется); `storage_limit_bytes=0` → «Без лимита».
- **пагинации нет осознанно**: эндпоинт отдаёт одну строку на неудалённый
  workspace, totals считаются по строкам выдачи (E9-B, риск №2). Это написано на
  экране и в README; кнопки «Показать ещё» на вкладке нет (есть e2e-проверка);
- имена файлов, object keys, sha256, байты и E2EE не запрашиваются и не рендерятся.

### 7. Guard и 403

- клиентский `me.user.is_platform_admin` — только UX; источник истины —
  серверный `PlatformAdminGuard`;
- non-admin deep link (`/admin`, `/admin?tab=users`) → `AdminForbiddenScreen`,
  admin-секции не монтируются, directory-запросов нет (RTL-тест);
- `AdminScreen` дополнительно проверяет `403` от users/chats/storage и показывает
  тот же forbidden-экран (на случай устаревшего `/me`); App уже обрабатывает 403 от
  settings/overview/save/test-email;
- `directory.reset()` вызывается из `ChatStore.reset()` → logout/смена пользователя
  не оставляют данные предыдущего админа.

### 8. Дизайн-система и UI/UX (FR-UX-1/2/5)

`src/styles/app.css`:

- **токены**: `--space-1..8`, `--radius-xs|sm|base|lg|xl|pill`, `--shadow-sm|md|lg`,
  `--text-xs..2xl`, `--leading*`, `--tap-size: 44px`; цветовые токены и dark-тема
  (`prefers-color-scheme: dark`) сохранены/дополнены;
- **визуальный язык Pickle**: огуречный зелёный + графит/cream, крупные радиусы
  (`--radius-lg/xl`), спокойные тени, sticky admin-header с blur, «пилюльные»
  вкладки, активный чат с тонкой accent-полосой, primary-кнопки с мягкой тенью;
- **shell/sidebar/composer/auth**: composer c `--radius-lg`, focus-ring и blur;
  auth-карточка `--radius-xl` и мягкий градиент; кнопки/иконочные кнопки/
  chat-item/inputs получили `min-height`/размер `--tap-size` (44 px); `button--small`
  и `icon-button--small` увеличиваются до 44 px на coarse-pointer;
- admin-строки — без «случайных» hex: только токены; legacy-часть CSS (не
  затронутые экраны) не переписывалась целиком — см. риски;
- responsive: ≥1120 px — выровненные колонки с заголовком; <1120 px — карточки с
  видимыми метками; toolbar складывается в колонку ≤720 px; вкладки переносятся
  (flex-wrap), а не скроллятся; `overflow-x: clip` у admin-shell.

### 9. Доступность (FR-UX-3/4)

- `:focus-visible` — глобально; у вкладок видимый focus-ring;
- семантика: `main`, `h1` один, `tablist/tab/tabpanel`, `dl/dt/dd` в каждой строке
  (метка всегда в a11y-tree — на desktop визуально скрыта, на mobile видима),
  `role=status` для скелетона/счётчика, `role=alert` для ошибок, `aria-busy`,
  `aria-valuenow` у progressbar, `aria-label` у групп/полосы;
- скелетоны фиксированной высоты, empty/error/retry на каждом списке, понятные
  тексты ошибок (403 → «только платформенному администратору»);
- dialog focus trap/return: `SafetyNumberDialog` получил Tab-trap (остальные
  диалоги уже имели), Escape/backdrop/возврат фокуса сохранены;
- `prefers-reduced-motion` — глобально отключает анимации;
- axe (`@axe-core/playwright`, теги wcag2a/2aa/21aa) — 0 violations на
  overview/users/chats/storage/settings, 403-экране, в light/dark и на 390/768.

### 10. Моки и E2E-обвязка

- `src/mocks/handlers.ts`: `GET /admin/users|chats|storage` с фильтрами,
  keyset-подобной пагинацией (`au:<offset>`/`ac:<offset>`), валидацией
  cursor/limit/query/type (400 `VALIDATION_FAILED`), totals по строкам для
  `?workspace_id=`;
- `src/mocks/db.ts`: `adminDirectory` — overrides (`usersOverride`, `chatsOverride`,
  `storageOverride`), задержки, принудительные ошибки, журналы запросов; дефолты
  выводятся из существующих users/chats/workspaces, поэтому `/admin/overview` и
  directory не расходятся;
- `src/mocks/browser.ts`: E2E-only `window.__krugAdminUsersSeed` (40 строк) для
  проверки пагинации; сбрасывается вместе с mock-db.

## Contract

| Операция                                                     | Использование                                          |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `GET /admin/users?query=&cursor=&limit=`                     | Users: поиск + cursor + limit 25                       |
| `GET /admin/chats?workspace_id=&query=&type=&cursor=&limit=` | Chats: фильтры + cursor                                |
| `GET /admin/storage?workspace_id=`                           | Storage (без фильтра в UI) + options workspace-фильтра |

Контракт не менялся: 41 path / 47 operations / 81 schema. Обязательные поля
`AdminUser`/`AdminUserPage`/`AdminChat`/`AdminChatPage`/`AdminStorage*` уже
зафиксированы в `scripts/check-contract.mjs`; `npm run contract:check` зелёный.
`src/api/schema.d.ts` не редактировался.

## Security / privacy

- UI не запрашивает и не рендерит текст сообщений, E2EE-конверты, имена файлов,
  object keys, `sha256` или байты; все поля — из `Admin*`-схем (by construction
  без контента).
- Никаких секретов в admin-состоянии: SMTP-пароль остаётся только в state формы,
  в `AdminDirectoryStore`/URL/localStorage не попадает; `security:check` зелёный.
- Поисковая строка уходит только в `/admin/users|chats` как query-параметр;
  отображается как текст (экранирование React), в audit на сервере не пишется.
- Клиентский guard не является авторизацией: все запросы защищены серверным
  `PlatformAdminGuard`; 403 обрабатывается экраном «Доступ запрещён».

## Приёмка (TASKS-ADMIN-V2)

| Пункт                                                                                                    | Статус                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Admin sections Overview / Users / Chats / Storage / Settings                                             | ✅ `?tab=` + tablist                 |
| Users: поиск email/name, cursor, колонки, mobile cards, empty/error/skeleton                             | ✅                                   |
| Chats: workspace/type/search, cursor, колонки, mobile cards                                              | ✅                                   |
| Storage: totals + per-workspace used/reserved/objects/attachments, limit bar, no pagination (documented) | ✅                                   |
| Guard platform admin, 403 screen                                                                         | ✅ + directory 403                   |
| Типизированный API-клиент, без изобретённых полей, без контента                                          | ✅                                   |
| Токены color/space/radius/shadow/type, light/dark, без random hex в затронутых компонентах               | ✅ (admin-слой полностью на токенах) |
| Pickle-язык: green/graphite/cream, крупные радиусы, спокойные тени; shell/sidebar/composer/auth/admin    | ✅                                   |
| 390/768/1440, sidebar/panel, touch ≥44, без horizontal scroll                                            | ✅ e2e 390/768 + desktop             |
| WCAG AA: contrast, focus-visible, keyboard, aria, dialogs, reduced motion, states                        | ✅ axe light/dark                    |
| Тесты: admin filters/pagination/loading/error, non-admin, axe, mobile/RTL                                | ✅ 14 unit + 10 e2e                  |
| `npm run check` 645+, contract 47/81, Playwright mock/admin/axe                                          | ✅ 661 + 10/10                       |
| README admin/UI notes                                                                                    | ✅ раздел «E9-F»                     |

## Tests

- **Unit/RTL: 661/661, 65 files.**
  - `src/ops/adminDirectory.test.ts` (5): первая страница + append с дедупликацией
    граничной строки; отбрасывание устаревшего ответа при смене поиска; параметры
    чат-фильтров и сброс курсора; storage snapshot + 403 с сохранением данных;
    `reset()` + поздний ответ.
  - `src/components/admin/AdminDirectory.test.tsx` (11): users список/пагинация
    (25 → 30), debounce-поиск и сброс, skeleton, error+retry, required-колонки как
    `<dt>/<dd>` + отсутствие `<table>`, chats workspace/type/search, storage
    totals/лимит/«Без лимита»/нет пагинации, keyboard-вкладки + deep link,
    non-admin deep link без directory-запросов, directory 403 → forbidden-экран,
    ошибка refresh сохраняет загруженные строки.
  - `src/components/admin/Admin.test.tsx` (5, обновлён под вкладки): setup →
    `/admin` → Settings, non-admin setup/403, `SETUP_ALREADY_COMPLETED`.
- **E2E `e2e/admin.spec.ts` — 10/10** (`npm run test:e2e:admin`, mock):
  setup → `/admin` → settings; non-admin setup/403; users (40 сид-строк: 25 → 40,
  поиск, axe); chats (workspace/type/search, axe); storage (totals, progressbar,
  нет пагинации, axe); settings (axe + ArrowLeft); dark-theme axe; mobile 390
  (карточки, touch-targets ≥44, нет clipping/h-scroll, axe); tablet 768 (карточки,
  нет clipping, axe). `expectNoA11yViolations` — `AxeBuilder` с wcag2a/2aa/21aa.
- Проверки: `npm run check` (lint, format, contract 47/81, stickers, security,
  session-writers, vitest, build) — зелёный.

## Риски и вопросы

1. **Workspace-фильтр чатов без admin-справочника пространств.** В контракте нет
   `GET /admin/workspaces`, поэтому options берутся из `/admin/storage` (строка на
   неудалённый workspace) + fallback из загруженных чатов. Следствие: Chats-вкладка
   делает дополнительное audit-чтение storage (`admin.storage.viewed`, только
   счётчики), кешируемое в срезе. Если появится admin-справочник — заменить одним
   запросом.
2. **Storage без пагинации.** Одна строка на неудалённый workspace, totals — сумма
   строк (E9-B). На пилоте (~20 workspace) приемлемо; при тысячах нужен cursor и
   SQL-totals. Осознанно, написано в UI.
3. **`messages_count` — выделенные последовательности `chat_counters`, включая
   удалённые сообщения.** UI показывает подсказку в `title`, но точный live-count
   потребовал бы отдельного запроса по `message.messages`.
4. **Top users по storage не показан.** Per-user `storage_used_bytes` есть в Users;
   отдельный top-N требует второго cross-tenant агрегата (optional в задаче).
5. **axe в RTL не запускается.** jsdom не считает layout/contrast, поэтому
   `color-contrast` и реальные media-queries проверяются только Playwright
   (Chromium) — там же 390/768/1440 и dark theme. RTL покрывает семантику,
   роли, labels, keyboard и состояния.
6. **Тёмная тема — только `prefers-color-scheme`.** Отдельного переключателя нет
   (FR-UX-1 требует светлую/тёмную тему, а не ручной выбор); ручной toggle
   потребовал бы persisted-настройки профиля и нового контракта.
7. **Токены внедрены в затронутые компоненты, не во весь CSS.** В оставшихся
   legacy-секциях (E2EE-баннеры, старые диалоги) ещё есть литеральные px/размеры;
   полная миграция 4k+ строк CSS — отдельный follow-up, чтобы не ломать
   существующие экраны.
8. **Админка read-only.** Suspend/delete/rename пользователей и чатов, сброс
   паролей, просмотр содержимого — вне scope и контракта (E9-B даёт только чтения).
9. **Каждое чтение — audit-событие.** Refresh-кнопки и смена фильтров создают
   записи; при частом поиске включён debounce 300 мс, но аудит-объём растёт
   линейно от действий админа.
10. **Playwright-браузеры.** В песочнице нельзя писать в `~/Library/Caches`
    (`EPERM`); для локального прогона браузеры скачивались в
    `frontend/.pw-browsers` и удалены после проверки. Для CI нужен
    `PLAYWRIGHT_BROWSERS_PATH` (как в README) и доступ к CDN.
11. **`AdminUser.email` nullable.** UI рендерит `—`; поиск по email на сервере
    исключает null, поэтому такие строки находятся только по имени.

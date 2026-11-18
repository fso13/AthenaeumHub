# D1-FE1 — Message Dashboard shell, rail/99+, pages, themes

> Зона сессии: `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**` и `frontend/src/api/schema.d.ts` не менялись. E2EE-флаг в этом
> срезе `false`; менеджмент — managed-only. Контракт D1-C1/BE1 используется
> как есть, новых API/полей не добавлено.

## Статус

**DONE в границах D1-FE1.** Каркас Message Dashboard перенесён в продукт:
space rail с непрочитанными и `99+`, сайдбар с секциями и навигацией, страницы
`Overview` / `Files` / `Plugins` / `Security` / `Settings`, роутинг
`?view=…` + back-to-chat, светлая/тёмная темы, мобильный drawer. Треды,
чат и существующие сценарии не сломаны.

Полный `npm run check` — **783/783** теста (74 файла), contract:check —
**47 paths / 55 operations / 87 schemas**, `vite build` — успешно. Новых
Playwright-сценариев в этом срезе нет: responsive/темы проверены CSS-брейкпоинтами
и RTL (mobile drawer), axe — на Overview. Дополнительно выполнен ручной
Playwright-прогон Chromium на 390/768/1440: горизонтального скролла нет
(`scrollWidth === innerWidth`), drawer открывается/закрывается, тёмная тема
применяется без console errors.

## 1. Space rail

`frontend/src/components/SpaceRail.tsx`, `frontend/src/domain/unread.ts`,
`frontend/src/store/chatStore.ts`.

- Пространства слева из `state.workspaces` (в dev-режиме — единственное
  workspace сессии), активное состояние — `aria-current="page"`, индикатор
  и подсветка.
- Бейдж = сумма `ChatSummary.unread_count` по чатам пространства. Граница:
  `99 → 99`, `100 → 99+`; `0` — бейдж не рендерится. Сам бейдж декоративный
  (`aria-hidden`), точное число всегда есть в `aria-label` кнопки —
  `Пространство: {name}, непрочитанных: {count}`.
- Переключение пространства — существующий `store.selectWorkspace`. В
  dev-режиме доступно одно пространство; в password-режиме rail показывает все
  членства.
- Для неактивных пространств нет агрегатного unread-эндпоинта, поэтому
  `loadWorkspaceUnread()` один раз читает `GET /workspaces/{id}/chats` и
  складывает `unread_count`. Ошибка не ломает rail: бейдж просто отсутствует;
  активное пространство всегда пересчитывается из живого `chats`.
- Пересчёт после `markRead`, WS `message.created` и `/sync` сделан в
  `updateChatSummary` / `applySync` / `withActiveWorkspaceUnread`: активная
  сумма всегда производна от `ChatSummary.unread_count`.
- Мобильный доступ — общий drawer с сайдбаром (кнопка меню, `Esc`, фон,
  закрытие при выборе чата/пространства).

## 2. Shell и навигация

Новые: `frontend/src/components/AppShell.tsx`,
`frontend/src/components/pages/*`, `frontend/src/router/views.ts`,
`frontend/src/hooks/useTheme.ts`, `frontend/src/theme/themePreference.ts`.

- `.app` стал трёхзонным: rail (72 px) + sidebar (304/258 px) + контент;
  на ≤900 px rail/sidebar уезжают в drawer, контент занимает всю ширину.
- Сайдбар: навигация `Обзор`, `Файлы`, `Плагины`, `Защита`, `Настройки`
  (кнопки, active `aria-current`), затем секции «Каналы» и «Личные сообщения»
  с прежними unread-бейджами чатов.
- Роутинг: `?view=overview|files|settings|plugins|security` через существующий
  history-router. Неизвестное значение → чат; `view=chat` нормализуется в
  отсутствие параметра. «К чатам» и клик по чату возвращают в переписку,
  `activeChatId`, slices и открытый тред не сбрасываются. Browser back
  работает через `popstate`.
- Темы: `data-theme="light|dark"` на `<html>`; токены макета
  (`surface`, `surface-2`, `rail`, `line`, `text`, `text-2`, `text-3`,
  `accent`, `accent-fill`, `accent-soft`, `online`, `danger`) вынесены в
  CSS-переменные. Явная тема перекрывает `prefers-color-scheme`; без выбора
  используется системная. Выбор хранится как несекретная per-device настройка
  `krug.theme`; `scripts/check-security.mjs` явно расширен этим модулем
  (workspace id + theme, без auth-данных).
- Focus-visible, `prefers-reduced-motion`, semantic landmarks (`main`, `nav`,
  `aside`), skip-link `#chat-main`, фокус на `<main>` при открытии страницы.

## 3. Страницы

### Overview

`pages/OverviewPage.tsx`. Только существующие данные:

- метрики: число чатов, участники (`GET /workspaces/{id}/members`), сумма
  непрочитанных, роль пользователя в пространстве;
- хранилище: `GET /workspaces/{id}/limits` — used/limit, прогресс, лимит файла
  и число вложений в сообщении;
- быстрые чаты из `chats`, недавние вложения из уже загруженных сообщений;
- ссылки в «Файлы», «Защиту» и диалог участников; honest empty/loading/error
  для участников.

### Files

`pages/FilesPage.tsx`. В контракте нет `GET /files`, поэтому страница не
изобретает список: она показывает вложения из уже загруженных сообщений
(`Message.attachments`) и лимиты из `/workspaces/{id}/limits`.

- фильтры `Все / Изображения / Документы / Аудио / Видео` (MIME + безопасный
  extension-fallback), поиск по имени и чату, счётчик результатов `aria-live`;
- квоты: тариф, used/limit, максимальный файл, лимит вложений, гостевой лимит;
- empty (файлов нет), no-matches (сброс фильтров), error лимитов с retry;
- строки — список, а не таблица: на 390 px схлопываются в карточки без
  горизонтального скролла.

### Plugins / Security

`pages/PluginsPage.tsx`, `pages/SecurityPage.tsx`. Каталога плагинов, DLP и
рабочего аудита в контракте нет, поэтому разделы честно disabled: объяснение,
`aria-disabled`-строки и метка «Недоступно», без фиктивных переключателей.
В «Защите» показывается реальный режим пространства (managed) из `/me`;
E2EE-тексты оставлены на случай включения флага.

### Settings

`pages/SettingsPage.tsx`. Только существующие настройки:

- профиль из `/me` (имя, email), пространство и роль — read-only;
- тема light/dark (единственная новая настройка, реально применяется);
- настройки уведомлений — существующий `NotificationPreferencesDialog`;
- пространство: режим защиты, тариф, used/limit чатов и хранилища, лимит файла;
- устройство из `state.device`; участники; вход в существующую админку для
  platform admin; выход.

Никаких выдуманных полей (2FA, «опасная зона», DLP-тумблеры) не добавлено.

## 4. Unread-инварианты

- `sumUnread` суммирует только положительные конечные значения; отображение
  capped, `aria-label` — точное.
- Активное пространство: `workspaceUnread[active] = sum(chats)` при каждом
  `updateChatSummary`/`applySync`.
- `markRead` уже вызывает `updateChatSummary(chatId, {unread_count: 0})`, поэтому
  бейдж исчезает без отдельной логики.
- WS `message.created` инкрементирует `ChatSummary.unread_count` (кроме
  собственных/видимых сообщений); rail пересчитывается тем же путём.
- Inactive-пространства не получают live-обновлений в этом срезе (WS подписан
  на активное); их число обновляется при следующем чтении списка чатов.

## 5. Тесты

`src/components/Dashboard.test.tsx` — **14** тестов:

|   # | Покрытие                                                                        |
| --: | ------------------------------------------------------------------------------- |
|   1 | rail `99+`, точное число в aria, отсутствие бейджа при 0, active, click         |
|   2 | границы 99/100 и `sumUnread`                                                    |
|   3 | неактивное пространство: cached unread 123 → `99+`, переключение                |
|   4 | WS-сообщение при скрытой вкладке увеличивает rail-бейдж; `markRead` убирает его |
|   5 | `workspaceUnreadTotals`: активное из chats, неактивное из кэша                  |
|   6 | Overview, `?view=overview`, активный чат сохранён, back-to-chat                 |
|   7 | быстрый чат из Overview → диалог                                                |
|   8 | Files: вложения, лимиты, поиск, no-matches, фильтр аудио                        |
|   9 | Files: error лимитов + retry                                                    |
|  10 | Plugins/Security: honest disabled, без switch/checkbox                          |
|  11 | Settings: light/dark `data-theme`, существующие настройки уведомлений           |
|  12 | mobile drawer trigger/close, card-rows вместо table                             |
|  13 | axe на Overview (color-contrast off, как в существующих сьютах)                 |
|  14 | чистые `parseView`/`withView`                                                   |

Регрессий в 769 существующих тестах нет. Итог: **783** теста, 74 файла.

## 6. Безопасность и данные

- Только контрактные поля; `schema.d.ts` не регенерировался.
- Тема — несекретная строка `light`/`dark`; localStorage больше нигде не
  расширен; auth-токены остаются в прежних модулях.
- Вложения рендерятся текстом/размерами, без `dangerouslySetInnerHTML`; SVG и
  произвольные MIME не исполняются.
- Rail aria-label содержит точное число; бейдж не дублируется скринридером.
- `scripts/check-security.mjs` по-прежнему падает на XSS-синках, cookie, eval,
  E2EE-логах и сетевых вызовах.

## 7. Изменённые файлы

```
frontend/src/components/AppShell.tsx              (new)
frontend/src/components/SpaceRail.tsx             (new)
frontend/src/components/pages/PageShell.tsx       (new)
frontend/src/components/pages/OverviewPage.tsx    (new)
frontend/src/components/pages/FilesPage.tsx       (new)
frontend/src/components/pages/SettingsPage.tsx    (new)
frontend/src/components/pages/PluginsPage.tsx     (new)
frontend/src/components/pages/SecurityPage.tsx    (new)
frontend/src/components/pages/pageData.ts         (new)
frontend/src/components/Dashboard.test.tsx        (new)
frontend/src/domain/unread.ts                     (new)
frontend/src/hooks/useTheme.ts                    (new)
frontend/src/router/views.ts                      (new)
frontend/src/theme/themePreference.ts             (new)
frontend/src/workspace/deviceWorkspace.ts         (comment only)
frontend/src/App.tsx
frontend/src/components/Sidebar.tsx
frontend/src/components/Icons.tsx
frontend/src/store/chatStore.ts
frontend/src/i18n/ru.ts
frontend/src/styles/app.css
frontend/src/test/setup.ts
frontend/scripts/check-security.mjs
frontend/README.md
frontend/D1-FE1-REPORT.md                         (new)
```

Не менялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`.

## 8. Проверка

```bash
cd frontend
npm run check
# lint + format:check + contract:check + stickers:check + security:check +
# session-writers:check + vitest run + tsc/vite build
# Test Files 74 passed (74) / Tests 782 passed (782)
# Contract check passed: 55 operations, 87 contract schemas
# vite build — success
```

Ручной сценарий (dev/mock, Chromium 390/768/1440): открыть чат → rail показывает активное
пространство и бейдж непрочитанных (`99+` при > 99, точное число в aria) →
«Обзор» (`?view=overview`) → быстрый чат/«К чатам» возвращает в ту же
переписку → «Файлы» (empty/поиск/фильтры/error лимитов) → «Плагины»/«Защита»
показывают honest disabled → «Настройки» переключают тему и открывают
уведомления; на 390 px rail/sidebar открываются кнопкой меню и закрываются
`Esc`/фоном/выбором чата.

## 9. Риски / follow-up

1. **Нет `GET /files`** — «Файлы» и «Недавние вложения» показывают только
   вложения из уже загруженных сообщений. Для полного списка нужен контракт
   D1.1 (или переиспользование admin storage, но оно platform-admin-only).
2. **Unread неактивных пространств** читается отдельным `GET chats` и не
   обновляется live, пока пространство не активно. Агрегат
   `WorkspaceSummary.unread_count` — D1.1.
3. **Plugins/Security** — UI-only disabled; каталог, DLP и аудит появятся с
   API. Сейчас нет ни фиктивных данных, ни «тумблеров в никуда».
4. **Settings** намеренно read-only там, где нет PATCH (профиль, workspace).
   Редактирование — отдельные задачи с контрактом.
5. **Мобильный drawer** — навигационный, без focus-trap (в отличие от модалок):
   закрывается `Esc`, фоном и выбором; фокус на страницу ставится при открытии
   `PageShell`.
6. **Тема** хранится в localStorage (`krug.theme`) и перекрывает системную;
   если нужен режим «системная» в UI — это небольшое расширение настроек.
7. **Playwright** для 390/768/1440 и тем в этом срезе не добавлялся; CSS
   брейкпоинты и RTL mobile drawer покрыты, визуальная сверка с v1.0 —
   на приёмке QA.

# D1 UX Fidelity 2 — pages, modals and details to `design/dashboard` v1.0.0

**Статус: DONE**

Дата: 19.11.2026 · Источник истины: `design/dashboard/DESIGN.md` §4.7–4.14, §5–§7,
`tokens.json`, `styles.css`, `index.html` и скриншоты
`overview-light`, `files-light`, `plugins-light`, `security-light`, `settings-light`,
`profile-light`, `chat-settings-light`, `mobile-overview`, `mobile-files`,
`mobile-profile`.

Второй visual-fidelity срез закрывает страницы пространства, модальные окна профиля
и настроек чата, правую панель и компактный заголовок сайдбара. Ни backend,
ни `contracts/`, ни `design/`, ни `schema/` не менялись; E2EE flag остаётся `false`,
все E2EE-ветки сохранены.

---

## 1. Что сделано

### 1.1 PageHeader и страницы

| Страница     | Реализация                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader` | 64 px, back 32, uppercase eyebrow `workspace · режим`, title 18/650, subtitle, right-aligned actions; `<main>` сохраняет focus и `aria-labelledby`.                                                                                                                                                        |
| Overview     | greeting, дата, 4 stat-карточки, активность из реально загруженных сообщений, быстрый доступ, 3-колоночный блок «Хранилище / Контроль / Команда», недавние вложения. Все числа — из `/chats`, `/messages`, `/workspaces/{id}/limits`, `/workspaces/{id}/members`, presence. Пустые состояния честные.      |
| Files        | toolbar с 5 фильтрами и поиском, квота/тариф, таблица 7 колонок (`icon / name / chat / size / type / status / action`), мобильные карточки, лимиты по тарифу, правила загрузки, empty/error/retry.                                                                                                         |
| Plugins      | 2-колоночная сетка карточек каталога; каждая карточка помечена «Недоступно», `role="switch"` и чекбоксы отсутствуют; сверху честный empty-banner «Каталог плагинов пока недоступен».                                                                                                                       |
| Security     | mode-card, карточки «Ключи и устройства» (реальные `GET /devices`), «Политики DLP», «Журнал аудита» и «Сеансы»; DLP/audit/session API отсутствуют — disabled/empty, без фиктивных данных.                                                                                                                  |
| Settings     | левый nav 190 px + панели: профиль (read-only поля `/me`, безопасность), внешний вид (рабочая тема, disabled density/previews/avatars/accent), уведомления (реальные preferences + существующий dialog), пространство (режим, тариф, лимиты, участники, admin link), устройства (реальные `GET /devices`). |

### 1.2 Модальные окна

- **ProfileDialog** — 540 px, r18, header 58, 2×2 mini-cards (о себе, контакты,
  устройства, безопасность) + компактная секция «Внешний вид / Уведомления»,
  footer «Выйти / Готово». Сохранены focus trap, Esc, focus return, вложенные
  confirm/notification dialogs, мобильный right-sheet.
- **ChatSettingsDialog** — 820 px, r18, header 58, tabs 42 px:
  «Основное / Участники / Права / Опасная зона»; для DIRECT —
  «Основное / Приватность / Опасная зона». Сохранены серверный `PATCH`
  (name/description), валидация, счётчики, E2EE-запрет описания, notice/error,
  отсутствие оптимистичного обновления, focus trap и Esc.
- Участники делегируются существующему E12-диалогу; роли, права, invite-link,
  обложка, приватность и опасные действия — disabled с честными объяснениями.
- `--modal` widths: 540 (sm) / 720 (default) / 820 (lg); на ≤760 px — right-sheet
  на всю высоту с сохранением скролла body.

### 1.3 Правая панель

- Обложки из макета: `frontend/public/covers/cover-atlas.svg`,
  `cover-family.svg`, `cover-dm.svg` (managed / E2EE / DIRECT).
- 112 px cover + squircle avatar 76 + name + subtitle + chips.
- Участники и online берутся из существующего workspace-справочника:
  «N участников · M в сети»; при незагруженном справочнике — честный fallback.
- Строки в порядке макета:
  - группа: настройки → приватность/ключи → уведомления → аудит/DLP →
    участники → плагины → вложения → «Покинуть чат» (disabled);
  - DIRECT: настройки → приватность → уведомления → секретный чат →
    общие файлы → «Позвонить» / «Заблокировать» (disabled).
- **Исправлен баг «нет вложений»**: в сетку попадает любое реально загруженное
  вложение (не только `media.kind` с `artwork_url`); artwork используется как
  улучшение, иначе — плитка с расширением/иконкой. Счётчик показывает реальное
  число, при >4 на четвёртой плитке `+N`.
- Мобильный right-sheet ≤340 px со scrim, Esc и focus-safe close.

### 1.4 Сайдбар и композер

- Убрана строка «Чатов: N из 100» из шапки сайдбара: остались название
  пространства, chevron и «+». Лимит чатов теперь виден в «Настройки →
  Пространство».
- Placeholder композера: «Написать в «{chat}»…», имя чата без вложенных
  кавычек. Попутно исправлен layout поля композера: строка `textarea + emoji`
  вместо вертикальной колонки (поле вернулось к 38 px).

---

## 2. Честные ограничения (API отсутствует)

Это не «заглушки ради картинки»: элементы либо disabled, либо показывают
объяснение.

1. **Плагины** — нет API каталога/состояний/разрешений. Карточки каталога
   показывают состав из макета и всегда помечены «Недоступно»; переключателей нет.
2. **DLP, журнал аудита, завершение сеансов, смена режима защиты, экспорт** —
   API нет; кнопки disabled, карточки объясняют отсутствие данных.
3. **Загрузка из раздела «Файлы»** — отдельного хранилища вне чата нет; кнопка
   «Загрузить» disabled с подсказкой «Файлы загружаются из чата». Скачивание
   вложений требует presigned URL и в этом срезе не подключено.
4. **Права чата, invite-link, замена обложки, privacy-переключатели** — API нет;
   disabled с пояснением. Редактирование name/description работает через
   существующий `PATCH /chats/{chatId}`.
5. **Профиль** — PATCH `/me`, 2FA, телефон, bio и управление сессиями отсутствуют;
   поля read-only / disabled, данные только из `/me` и `GET /devices`.
6. **Участники чата** — членского endpoint чата нет; используется workspace-
   справочник, и это явно подписано в панели.
7. **Превью вложений** — для плиток используется `media.artwork_url`
   (server-sanitized); для обычных файлов показывается расширение, а не
   выдуманная картинка.

---

## 3. Осознанные отличия от макета

| Отличие                                                                        | Причина                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Заливка accent-кнопок — `--accent` (`#2F7A38`), не `--accent-fill` (`#65BD45`) | белый текст на `#65BD45` не проходит WCAG AA; зелёный бренд сохранён, axe зелёный |
| `text-3` чуть темнее макета                                                    | контраст ≥4.5:1 (унаследовано из первого среза)                                   |
| В «Файлах» есть «Обновить» рядом с «Загрузить»                                 | существующая функция refreshLimits; на ≤760 px скрыта                             |
| В «Настройках» дополнительный пункт «Администрирование»                        | только для platform-admin, ведёт в существующую админку                           |
| DIRECT-панель не показывает «Участники/Плагины»                                | в макете у личного чата их нет; порядок строк совпадает                           |
| Карточки каталога плагинов                                                     | визуальный состав из макета, но честно disabled: API каталога нет                 |
| Мини-секция «Внешний вид / Уведомления» в профиле                              | сохранение существующей функциональности темы и notification preferences          |

---

## 4. Проверка

```bash
cd frontend
npm run check
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" \
  npx playwright test --config playwright.dashboard.config.ts   # 29 passed
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" \
  npx playwright test --config playwright.auth.config.ts        # 19 passed
PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers" \
  npx playwright test --config playwright.config.ts             # 15 passed
```

Фактические результаты:

- `npm run check` — **876/876** тестов, 81 файл; lint, format, contract,
  stickers, security, session-writers и production build — OK.
- `test:e2e:d1` — **29 passed** (shell, media, settings/profile, threads,
  a11y 390/768/1440, 6 + 5 visual).
- `test:e2e:auth` — **19 passed**.
- `test:e2e` (chat/files/media/notifications/stickers/ws) — **15 passed**.

### Визуальные артефакты

Скриншоты лежат в `frontend/visual-review/fidelity-2/` (каталог в `.gitignore`,
это human-review, не pixel snapshots):

- страницы 1600 light: `pages-overview-light`, `pages-files-light`,
  `pages-plugins-light`, `pages-security-light`, `pages-settings-light`;
- страницы 1600 dark: `pages-overview-dark`, `pages-files-dark`,
  `pages-plugins-dark`, `pages-security-dark`, `pages-settings-dark`;
- модалки 1600: `modal-profile-light`, `modal-chat-settings-light`,
  `modal-chat-settings-members-light`, `modal-profile-dark`,
  `modal-chat-settings-dark`;
- 390: `mobile-overview`, `mobile-files`, `mobile-settings`, `mobile-profile`,
  `mobile-chat-settings`;
- details: `details-attachments-light` (реальная плитка вложения),
  `details-direct-light`.

Новый сценарий — `e2e/d1-visual-2.spec.ts`: проверяет page header 64 px,
4 stat-карточки, 190 px settings-nav, modal 540/820, header 58, radius 18,
hidden desktop table на 390, мобильный sheet 390×844 и реальную сетку вложений.
Пиксельных snapshot’ов нет.

### Обновлённые тесты

- `src/components/Dashboard.test.tsx` — новое приветствие, «Файлы»-лейбл,
  переход по вкладкам настроек перед темой/уведомлениями.
- `src/components/ChatSettings.test.tsx` — вкладка «Опасная зона»,
  member-directory request count с учётом загрузки панели.
- `src/components/CreateChat.test.tsx` — лимит чатов проверяется в
  «Настройки → Пространство» вместо удалённой строки сайдбара.
- `e2e/d1-settings-profile.spec.ts` — danger-вкладка и возврат на «Основное».
- `e2e/d1-visual.spec.ts` — chip «Личный чат» без strict-mode коллизии.
- `e2e/e2ee.real.spec.ts` — readiness-wait переведён с удалённой строки
  «Чатов: N из M» на `.ws-btn__name` и список чатов.

---

## 5. Файлы

Новые:

- `src/components/pages/PageHeader.tsx`
- `e2e/d1-visual-2.spec.ts`
- `public/covers/cover-atlas.svg`, `cover-family.svg`, `cover-dm.svg`
- `D1-UX-FIDELITY-2-REPORT.md`
- `visual-review/fidelity-2/*.png` (генерируются, в `.gitignore`)

Изменены:

- `src/components/pages/PageShell.tsx`, `OverviewPage.tsx`, `FilesPage.tsx`,
  `PluginsPage.tsx`, `SecurityPage.tsx`, `SettingsPage.tsx`, `pageData.ts`
- `src/components/ChatDetails.tsx`, `ProfileDialog.tsx`,
  `ChatSettingsDialog.tsx`, `Sidebar.tsx`, `Composer.tsx`, `ChatScreen.tsx`,
  `ChatHeader.tsx`, `AppShell.tsx`, `Icons.tsx`
- `src/i18n/ru.ts`, `src/styles/app.css`
- `src/components/Dashboard.test.tsx`, `ChatSettings.test.tsx`,
  `CreateChat.test.tsx`
- `e2e/d1-settings-profile.spec.ts`, `e2e/d1-visual.spec.ts`,
  `e2e/e2ee.real.spec.ts`

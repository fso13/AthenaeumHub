# D1 UX Fidelity — перенос `design/dashboard` v1.0.0

**Статус: PARTIAL** — каркас, рейл, сайдбар, шапка, плоская лента, композер,
правая панель, тёмная тема и адаптив перенесены и проверены. Осознанно
отложены реакции (нет поля в контракте) и часть data-bound содержимого панели
(медиа-сетка показывает только реальные вложения, числа участников — только
после ленивой загрузки справочника). Старый bubble-UI в DOM desktop-чата
отсутствует.

Дата: 19.11.2026 · Источник истины: `design/dashboard/{DESIGN.md,tokens.json,styles.css,index.html}` +
`screenshots/{desktop-light,desktop-dark,dm-light,thread-light,mobile-light}.png`.

---

## 1. Что перенесено

### 1.1 Каркас

| Параметр     | Макет                                   | Реализация                                                    |
| ------------ | --------------------------------------- | ------------------------------------------------------------- |
| Фон страницы | тёплый layered backdrop                 | `body:has(.app)` + `--backdrop` из `styles.css`               |
| Окно         | 1548 × 1000, radius 18, hairline/shadow | `min(1548px,100%)`, `min(1000px,100dvh-52px)`, `--shadow-win` |
| Сетка        | 72 / 272 / `minmax(0,1fr)` / 304        | `.app` grid; `:has(.details--open)` переключает 3/4 колонки   |
| < 1340       | sidebar 258, details 292                | media 1340                                                    |
| < 1200       | «почти full-screen»                     | padding 12, окно `100% × 100dvh-24`                           |
| Страницы     | занимают чат + details                  | `.page { grid-column: 3 / -1 }`                               |
| Мобильный    | full-bleed, drawer, sheet               | media 760/420, `details` fixed-sheet, scrim                   |

Проверено в Playwright: `app = 1548×1000`, rail 72, sidebar 272, details 304,
header 64 при 1600×1150.

### 1.2 Рейл (`SpaceRail.tsx`)

- 72 px, фон `--rail`, hairline справа.
- Логотип-плитка 40×40, radius 12, тёмная, с пузырём чата.
- Пространства 40×40, radius 12, squircle-аватар 40, hover/active, индикатор
  3×24 справа, бейдж 17 px / `99+`, `aria-label` с точным числом (сохранён),
  бейдж декоративный (`aria-hidden`).
- «+» (создать пространство) — честно disabled: API создания пространства в
  shell отсутствует.

### 1.3 Сайдбар (`Sidebar.tsx`, `Avatar.tsx`)

- Шапка 64: название пространства 16.5 px + chevron; свитчер оформлен как
  заголовок (нативный `<select>` прозрачным слоем, aria сохранён).
- 5 пунктов навигации 38 px: icon 19 + label + badge; активный — зелёная
  иконка; badge непрочитанных вынесен на «Обзор» (реальный unread).
- Секции «Каналы» / «Личные сообщения»: collapsible header 34 px + add.
- Строки 40 px, аватар 28, unread pill 17 px, active `--active`.
- Футер: аватар 28 + имя/«В сети» + справочник участников, тема, выход.
- Убран визуальный шум: preview/время в строках чата, селект-коробка,
  members-кнопка из шапки, admin-иконка (админка осталась в «Настройках»).
- Лимит чатов (`Чатов: N из M`) сохранён честной строкой.

### 1.4 Шапка чата (`ChatHeader.tsx`)

- 64 px, аватар 38, название 14.6/650, подпись «N участников · M в сети» /
  «В сети» с online-точкой.
- Иконки: поиск (включает inline-фильтр), refresh (сохранён для e2e),
  «О чате» (настройки), E2EE safety (при E2EE), звонок/видео — disabled с
  честным title, info — toggle правой панели.
- Chip режима «Управляемый» / «Сквозное шифрование».
- Клик по identity также открывает/закрывает панель.
- Realtime-статус оставлен компактной точкой (нужен e2e WS и live-состоянию).

### 1.5 Плоская лента (`MessageList.tsx`, `MessageRow.tsx`)

- Никаких пузырей: grid `38px minmax(0,1fr)`, gap 12, `padding 4px 0 12px`,
  аватар 38 (radius 12), author 13.7/650, time 11.2, badge «вы».
- Свои и чужие в одной колонке, без `justify-end`.
- Текст 14.1/22 (`line-height 1.55`), max-width 660.
- Дата-разделитель с линиями (`day-separator`), лента прижата к низу при
  короткой истории (`messages::before { margin-top:auto }`).
- Hover-actions (reply/thread) в floating `.msg-tools`, quote 2 px accent,
  thread-link pill, editable/read-маркеры, deleted-стиль.
- Вложения/voice/song/видео/файлы/стикеры рендерятся компонентами E4–E7 и
  переведены на нейтральные поверхности (свои сообщения больше не красят
  медиа-карточки в зелёный bubble).
- Skeleton переделан в плоские строки (аватар + две линии).
- Поиск — client-side фильтр по загруженной/расшифрованной истории с
  счётчиком и пустым состоянием; серверного поиска в срезе нет.

### 1.6 Композер (`Composer.tsx`)

- 56 px: `+` (вложение) 38, стикер 38, поле-pill 38 + emoji, mic 38,
  круглая send 40 (`--accent-fill`, тень).
- Reply bar, запись (`RecordingBar`) сохранены, поле растёт до 116 px.
- Подпись managed/DLP или E2EE (`#composer-note`), hint/counter.
- Emoji-поповер: локальная вставка 12 эмодзи, Esc/click-outside; API эмодзи
  не выдумывался.
- На mobile стикер и подсказка скрыты, limits-bar не-ошибочный скрыт, чтобы
  сохранить высоту ленты; ошибки лимитов остаются видимыми.

### 1.7 Правая панель (`ChatDetails.tsx`, новый)

- 304 / 292 px, обложка 112 (gradient managed/E2EE), аватар 76 (border 4),
  title 18, subtitle, chips (групповой/личный, режим, роль, «Секретный» для
  E2EE DIRECT).
- Поиск по переписке, строки 38 px:
  - «Настроить чат» → существующий `ChatSettingsDialog`;
  - «Приватность и ключи» → раскрытие + «Проверить ключи» (SafetyNumberDialog)
    для E2EE; для managed честно объясняет, что ключи на сервере;
  - «Настройки уведомлений» → существующий `NotificationPreferencesDialog`
    (не фиктивный switch);
  - «Аудит и DLP» → страница «Защита» (managed) / disabled (E2EE);
  - «Участники чата» → раскрытие списка workspace-справочника (ленивая
    загрузка только по клику) + «Открыть справочник»;
  - «Плагины пространства» → страница «Плагины» / disabled (E2EE);
  - «Вложения» → медиа-сетка 2×2.
- Медиа-сетка: только реальные `attachments` с `media.kind`; artwork берётся
  из `media.artwork_url` (server-sanitized). Если вложений нет — честный
  текст, а не фиктивные плитки.
- Низ: «Покинуть чат» (disabled), для DIRECT «Позвонить»/«Заблокировать»
  (disabled); footnote managed/E2EE.
- Toggle из шапки; на ≤1180 — overlay 320 с close; на ≤760 — правый sheet
  340 + scrim; Esc и backdrop закрывают, фокус не ломается.
- При открытом треде панель уступает место `ThreadPanel` (360/344).

### 1.8 Тёмная тема и адаптив

- Полный набор токенов `surface / surface-2 / surface-3 / rail / line /
text / text-2 / text-3 / accent / accent-fill / accent-soft / online /
danger / warning / active / hover / backdrop / shadow-win` для light/dark;
  старые компоненты продолжают работать через legacy-alias’ы.
- Тёмные палитры `#17191E / #202329 / #101216 / #252830 / #EEF0F4`.
- Брейкпоинты: 1600 (окно), 1340 (258/292), 1180 (details overlay,
  rail+sidebar 256), 920 (rail скрыт, sidebar 252), 760 (drawer + sheet),
  420 (аватар 32, компактный композер).
- Focus-visible 2 px `--accent-fill`, `prefers-reduced-motion` отключает
  анимации и smooth-scroll, `aria-current`, `aria-expanded`, `aria-pressed`,
  `role="switch"` в существующих диалогах сохранены.
- Контраст: axe (WCAG 2.1 AA) зелёный на 390/768/1440 в обеих темах.

---

## 2. Осознанные отличия от макета

| Отличие                                                                                              | Причина                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `text-tertiary` светлый `#979DA7` заменён на `#676D79`, тёмный `#787E89` → `#8F95A0`                 | исходный токен даёт 2.7:1 на белом и валит axe; это единственное заметное отклонение от tokens.json |
| light `danger #D94A3D` → `#C23A2F`, `warning #C08A2A` → `#8A611A`                                    | AA на soft-фонах (3.6–3.0:1); dark-значения не менялись                                             |
| В шапке есть дополнительная иконка настроек «О чате»                                                 | e2e D1 открывает `ChatSettingsDialog` именно из шапки; info-иконка отвечает за details              |
| Realtime-статус — точка, а не текст                                                                  | нужен e2e WS (`title="Онлайн"`), в макете его нет                                                   |
| Sidebar-строки без preview/времени                                                                   | требование «убрать визуальный шум»; unread и presence сохранены                                     |
| Уведомления — строка-диалог, не switch                                                               | нет per-chat mute API; переключатель был бы фиктивным                                               |
| «Плагины пространства», «Участники чата», «Настройки уведомлений»                                    | чтобы не конфликтовать с навигацией/существующими e2e-селекторами и честно отражать scope           |
| Счётчик участников в шапке — fallback до загрузки справочника                                        | в контракте нет `GET /chats/{id}/members`; справочник workspace грузится лениво                     |
| Медиа-сетка пустая при отсутствии вложений                                                           | данные не выдумываются                                                                              |
| Страницы Overview/Files/Plugins/Security/Settings перекрашены токенами, но не переверстаны в page-v1 | вне первого среза; функциональность и тесты сохранены                                               |
| Auth/admin переведены на токены, admin возвращён к документному скроллу                              | иначе admin-таблицы обрезались новым окном                                                          |

---

## 3. Отложено (честный остаток)

1. **Реакции-чипы** — в `contracts/openapi.yaml` у `Message` нет поля реакций;
   фиктивные чипы не рисовались. Нужен контракт (reactions + toggle) → затем
   `ReactionChip` по `.reaction/.is-mine` из `styles.css`.
2. **Per-chat участники и роли** — используется workspace-справочник; для
   «N участников» и списка именно чата нужен членский endpoint чата.
3. **Медиа-сетка 2×2 на демо-данных** — компонент готов, но показывает только
   реальные вложения; демо-моки чата вложений не содержат.
4. **Полные page-v1** (Overview/Files/Plugins/Security/Settings) — текущие
   страницы остались функциональными, но не повторяют композицию макета.
5. **Тред-заголовок** — панель приведена к 360/344 и v1-поверхностям, но текст
   шапки «Тред / Ответы на сообщение» отличается от макета «ТРЕД / имя чата».
6. **Reactions/emoji API, звонки, блокировка, выход из чата, создание
   пространства** — disabled с title, без фиктивных запросов.
7. **Старые `.bubble*`-правила** остались в конце legacy-части `app.css` как
   мёртвый CSS; ни один компонент их больше не рендерит. Удаление — отдельная
   чистая уборка, чтобы не задеть исторические состояния.

---

## 4. Проверка

```bash
cd frontend
npm run check          # lint + format + contract + stickers + security + session-writers + 876 tests + build
npm run test:e2e:d1    # 24 passed (shell, media, settings/profile, threads, 6 visual)
npm run test:e2e:auth  # 19 passed (auth + admin)
npm run test:e2e       # 15 passed (chat, chat-create, files, media, notifications, stickers, ws)
```

Фактические результаты:

- `npm run check` — **876/876** тестов, 81 файл, build OK.
- `npm run test:e2e:d1` — **24 passed**.
- `npm run test:e2e:auth` — **19 passed**.
- `npm run test:e2e` — **15 passed**.
- `tsc --noEmit` — без ошибок.
- Playwright visual (без pixel snapshots): метрики окна/колонок + скриншоты
  `e2e/d1-visual.spec.ts` → `frontend/visual-review/*.png`:
  `d1-visual-desktop-light.png`, `desktop-dark.png`, `desktop-dm.png`,
  `desktop-media.png`, `desktop-thread.png`, `mobile-chat.png`,
  `mobile-details.png`, `mobile-drawer.png`.

### Обновлённые тесты

- `src/components/ChatScreen.test.tsx`, `Threads.test.tsx` — селекторы
  `.bubble-text` → `.msg-text`.
- `e2e/d1-threads.spec.ts`, `e2e/e2ee.real.spec.ts` — те же селекторы.
- Новый `e2e/d1-visual.spec.ts` (1600 light/dark, DM, media, thread, 390 mobile;
  сравнение — eyeball, без хрупких pixel snapshots).

---

## 5. Файлы

Новые:

- `src/components/ChatDetails.tsx`
- `e2e/d1-visual.spec.ts`
- `D1-UX-FIDELITY-REPORT.md`
- `visual-review/*.png` (сгенерированы, в `.gitignore`)

Изменены:

- `src/components/AppShell.tsx`, `SpaceRail.tsx`, `Sidebar.tsx`,
  `ChatHeader.tsx`, `ChatScreen.tsx`, `MessageList.tsx`, `MessageRow.tsx`,
  `Composer.tsx`, `Avatar.tsx`, `ThreadPanel.tsx`, `Icons.tsx`
- `src/styles/app.css` — токены v1 + секция `D1 UX FIDELITY` (каркас, рейл,
  сайдбар, лента, композер, details, адаптив, скелетон, медиа)
- `src/i18n/ru.ts`, `src/domain/messages.ts` (FNV-1a для распределения
  аватар-градиентов)
- `frontend/.gitignore` (`visual-review`)

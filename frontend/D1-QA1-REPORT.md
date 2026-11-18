# D1-QA1 — e2e, a11y и responsive для Dashboard, threads, settings, media

> Зона сессии: `frontend/**`. `backend/**`, `contracts/**`, `docs/**`, `design/**`
> и `frontend/src/api/schema.d.ts` не менялись. E2EE-флаг в срезе `false`;
> проверялся managed-контур. Тестовый backend не поднимался: e2e идёт на MSW
> mock-контуре в режиме Auth BFF password (`VITE_AUTH_MODE=password`).

## Статус

**DONE.** Добавлен отдельный Playwright-набор D1 (18 сценариев), axe-матрица
light/dark на 390/768/1440, проверки отсутствия горизонтального скролла,
focus/aria. Найдены и исправлены два реальных contrast-бага в CSS и два
устаревших e2e-селектора, сломанных после D1-FE1 (drawer и mobile bar).
Полный `npm run check` — **852/852** тестов, contract/stickers/security/
session-writers — зелёные, `vite build` — успешно. Новых unit-тестов не
требовалось: поведение покрыто e2e на реальном DOM, а существующие RTL-тесты
D1-FE1..FE5 остались без изменений.

Блокеров backend/API нет. Опасная зона чата (archive/leave/delete) остаётся
честно `disabled` — это зафиксированный MVP-контракт D1 (`D1-BE3` не отдаёт
эти операции), а не дефект e2e.

## Что добавлено

### Playwright

Новый конфиг `playwright.dashboard.config.ts` и скрипт `test:e2e:d1`:

- `testDir: e2e`, `testMatch: /d1-.*\.spec\.ts/`, workers=1, retries=0;
- dev-server на `127.0.0.1:4175` с `VITE_USE_MOCKS=true`,
  `VITE_AUTH_MODE=password`, `VITE_DEV_SESSION=false`;
- реального backend, Keycloak и секретов нет; логин — demo-пользователь из
  `src/mocks/fixtures.ts` (`demo@krug.test`).

Наборы:

| Файл                              | Сценарии                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/d1-dashboard.spec.ts`        | 6: login → rail/`99+` exact aria, Overview/Files/Settings + `?view=`, back-to-chat/browser back, mobile drawer, a11y/responsive 390/768/1440 |
| `e2e/d1-threads.spec.ts`          | 3: root → panel → reply → счётчик, close/Esc/focus-trap/focus-return, 390 full-screen sheet                                                  |
| `e2e/d1-settings-profile.spec.ts` | 5: owner save name/description + disabled danger, read-only MEMBER, 390, profile `/me`/devices, devices empty                                |
| `e2e/d1-media.spec.ts`            | 4: ID3 song card + локальная обложка, fallback без тегов, voice disabled без микрофона, mock MediaRecorder recording/cancel/send             |
| `e2e/d1-helpers.ts`               | login/dashboard, drawer-навигация, axe, no-horizontal-scroll, init-хуки mock-контура                                                         |

### Mock-only test seams

Только в `src/mocks/browser.ts`, доступны исключительно когда приложение
запущено с MSW (`window.__krugMocks`/init globals); production API не менялся:

- `__krugUnreadCounts` (init) — per-chat unread до первого bootstrap-чтения.
  Нужен, чтобы граница 99/100 не зависела от гонки `markRead` активного чата.
- `__krugWorkspaceRole` (init) — boot с ролью `MEMBER` для read-only формы.
- `__krugMocks.devices.clear()` — честное пустое состояние `GET /devices`.

## Покрытие требований

### Dashboard shell

- Login (password mock) → dashboard; rail `nav[aria-label="Пространства"]`.
- `99 → "99"`, `100 → "99+"`; badge декоративный (`aria-hidden`), точное
  число в `aria-label` кнопки: `"…, непрочитанных: 99+ (100)"`.
- `aria-current="page"` на активном пространстве и активном разделе.
- Разделы `Обзор` / `Файлы` / `Настройки` открывают `?view=…`, заголовок
  страницы единственный `h1`, `<main>` получает фокус; «К чатам» и browser
  back возвращают в переписку без потери чата.
- Мобильный drawer на 390: `aria-expanded`, закрытие Esc и фоном.

### Threads

- Пустой тред из действия сообщения → панель `role="dialog"` с `role="log"`.
- Ответ отправляется, появляется в панели, счётчик корня становится
  `"1 ответ"` (`aria-label` «Открыть тред, ответов: 1»), в основной ленте
  ответа нет.
- Закрытие кнопкой и `Esc`, focus trap по Tab, возврат фокуса на триггер.
- 390: панель — full-screen sheet (`position: fixed; inset: 0`), кнопка
  «Назад», композер доступен, горизонтального скролла нет.

### Chat settings

- OWNER: name/description сохраняются после `200`; заголовок и список чатов
  обновляются, notice «Настройки сохранены…»; значение нормализуется
  (trim/схлопывание пробелов).
- Danger zone: archive/leave/delete `disabled` + объяснение.
- MEMBER: поля `disabled`, объяснение read-only, кнопки «Сохранить» нет,
  PATCH не уходит.
- 390: диалог помещается в viewport, axe/overflow зелёные.

### Profile

- `/me`: имя, email, пространство, роль, платформенный админ.
- `GET /devices`: текущее устройство, `WEB`, статус; ключи/отпечатки не
  рендерятся.
- `devices.clear()` → «Устройства ещё не зарегистрированы.».
- 2FA/сессии — `aria-disabled`-строки без выдуманных переключателей.

### Media

- MP3 с ID3v2.4 (`TIT2/TPE1/TALB/TYER/TCON/TLEN` + `APIC` PNG): song card,
  title/artist/album/year/genre, `3:00`, локальная обложка (blob URL).
- MP3 без тегов: `track.mp3`, «Неизвестный исполнитель», дефолтная обложка.
- Voice button без `navigator.mediaDevices` — `disabled` + честный `title`.
- Mock `MediaRecorder`: «Идёт запись», timer, Esc-отмена без загрузки, затем
  stop-and-send → вложение `voice-*.webm` в ленте.

## A11y / responsive

- `@axe-core/playwright`, теги `wcag2a`, `wcag2aa`, `wcag21aa`.
- 390/768/1440 × light/dark: чат (оба темы), Overview (light), Files (light),
  Settings (dark) — 0 violations.
- Модалки: thread panel, chat settings, profile — 0 violations.
- Анимации/переходы отключаются инжектированным CSS перед axe; фиксированных
  `waitForTimeout` в новом наборе нет (только auto-wait условия: загрузка,
  timer, network). Это убирает flaky-сон и не маскирует незавершённые
  transition.
- `scrollWidth <= clientWidth + 1` проверяется на каждом viewport и на
  мобильных sheet/диалогах.

## Исправленные дефекты

1. **Contrast: duration песни на своём сообщении.** `.song-card__duration`
   наследовал `--faint`/`--muted`, а карточка на исходящем сообщении лежит на
   `--bubble-out` (#1f6b57): axe дал 1.04:1. Добавлено
   `.msg-row--mine .song-card__duration { color: var(--bubble-out-ink) }`.
2. **Contrast: время корня треда.** `.thread-panel__root-time` использовал
   `--faint` на `--accent-softer` (< 4.5:1). Заменено на `--muted`.
3. **e2e auth:** после D1-FE1 текст «Тестовое пространство» встречается и в
   mobile bar; селектор сужен до `complementary[aria-label="Пространство и чаты"]`.
4. **e2e chat-create 390:** сайдбар теперь в drawer; тест сначала открывает
   навигацию, затем «Создать чат».

Пункты 1–2 — реальные баги доступности, исправлены точечно в CSS; 3–4 —
устаревшие селекторы существующих e2e после D1-FE1, поведение приложения не
менялось.

## Команды и результаты

```bash
cd frontend
npm run check                                  # 852/852, contract/build зелёные
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:d1     # 18 passed
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e        # 15 passed
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:auth   # 19 passed (auth + admin)
```

- D1 suite: **18 passed** (~24 s, 1 worker, 0 retries).
- Существующие наборы после правок: **15 passed** (default dev) и
  **19 passed** (password auth + admin).
- Скриншоты/видео с секретами не создавались: Playwright пишет screenshot
  только при падении, `trace` — on-first-retry; артефакты не коммитятся.

## Ограничения и честные допущения

- E2EE-ветки (threads disabled, voice disabled, description disabled) в этом
  срезе не проверялись: флаг `false`, контур managed-only. Их покрывают
  RTL-тесты D1-FE2/FE3/FE5.
- Голосовой e2e использует mock `MediaRecorder`; байты не являются playable
  WebM, поэтому проверяется запись/таймер/отмена/отправка и появление
  вложения, а не воспроизведение. Карточка `VoiceMessage` и плеер покрыты
  `VoiceRecording.test.tsx`.
- MP3-фикстура синтетическая (ID3 + один MPEG-заголовок): проверяются
  метаданные/обложка/fallback, а не декодирование аудио.
- «Файлы» проверяются на уже загруженных вложениях (в контракте нет
  `GET /files`); это зафиксировано в D1-FE1.
- Опасная зона чата намеренно `disabled` до появления API (D1.1), e2e
  фиксирует именно это состояние.

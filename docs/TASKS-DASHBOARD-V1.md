# D1 — Message Dashboard v1.0: внедрение макета в продукт

| Поле | Значение |
|---|---|
| **ID** | D1 |
| **Тип** | Epic (FE + BE + contract) |
| **Статус** | **READY / запланирован** (см. `docs/TASKS.md` §12) |
| **Приоритет** | P1 (XL, после текущего G4; managed-only) |
| **Дизайн** | [`design/dashboard/`](../design/dashboard/), версия **1.0.0**, заморожен 18.11.2026 |
| **Release-снапшот** | [`design/dashboard/releases/pickle-message-dashboard-v1.0.0.zip`](../design/dashboard/releases/pickle-message-dashboard-v1.0.0.zip) |
| **Контракт** | [`contracts/openapi.yaml`](../contracts/openapi.yaml) |
| **Зависимости** | I-01 (contract sync), E4 (upload/attachments), E6 (notifications), E7 (E2EE flag/keys), Keycloak |
| **Компоненты** | `frontend/`, `backend/`, `contracts/`, QA |
| **Оценка** | XL: ~35–45 dev-days; разбивка ниже |
| **Владелец** | FE lead + BE lead, PM — приёмка |

## 1. Контекст и цель

Макет [`design/dashboard`](../design/dashboard/) прошёл дизайн-ревью и **зафиксирован как v1.0.0**.
Нужно перенести его в продукт: заменить текущий экранный слой чата на концепцию Message Dashboard и
довести до продакшена три продуктовые фичи, которых сейчас нет:

1. **Треды** — обсуждение любого сообщения в отдельной панели, с ответами и счётчиком.
2. **Голосовые, аудио и видео** — запись с микрофона, карточки аудио/видео, проигрывание.
3. **Метаданные песен** — при загрузке песни показывать обложку, исполнителя, альбом, год, жанр и
   длительность (ID3/`APIC`), с честным fallback, если тегов нет.

Плюс:

4. **Непрочитанные на иконках пространств** — число, при `> 99` — `99+`.
5. **Разделы пространства** — Обзор, Файлы, Плагины, Защита, Настройки; окна Профиля и Настроек чата.
6. **Визуальная система** — светлая/тёмная темы, плоская лента, правая панель, мобильный drawer/sheet.

Источник истины по UI — замороженный макет и скриншоты, а не текущий фронтенд.

## 2. Scope

### D1 MVP (обязательно к релизу)

| # | Фича | FE | BE |
|---|---|---|---|
| 1 | Рейл пространств + бейдж непрочитанных и `99+` | да | без изменений (сумма `ChatSummary.unread_count`) |
| 2 | Шелл: сайдбар, навигация, страницы Обзор/Файлы/Настройки, правая панель | да | данные из существующих API |
| 3 | Плоская лента сообщений: даты, реакции, ответы, вложения | да | без изменений |
| 4 | Треды: создание, панель, ответы, счётчик, превью последнего ответа | да | новые поля/эндпоинты |
| 5 | Голосовые: запись, таймер, отмена, отправка, проигрывание | да | MIME/лимиты, attachment |
| 6 | Аудио/видео-вложения: карточка, длительность, play/download | да | `media` в `AttachmentRef` |
| 7 | Песня: ID3-метаданные и обложка; fallback | да | хранение sanitized media (managed) |
| 8 | Настройки чата: основное, участники/роли, опасная зона | да | `PATCH /chats/{id}` + участники |
| 9 | Профиль: окно, устройства, 2FA, сеансы | да | существующие `/me`, `/devices` |
| 10 | Адаптив 390/768/1440, темы, a11y | да | — |

### D1.1 (следом, не блокирует MVP)

- Полные страницы **Плагины** и **Защита** (каталог, DLP-политики, аудит) — нужны API/данные, которых
  сейчас нет; в MVP страницы работают на существующих/мок-данных с честными состояниями.
- Серверная экстракция метаданных для managed (ffprobe/ID3) и кросс-девайсное хранение обложек.
- Треды в **E2EE** (метаданные треда без plaintext-превью; отдельное решение по крипто-слою).
- Плеер с прогрессом/скоростью, плейлисты, «сейчас играет».
- Уведомления по тредам (отдельный счётчик).

### Вне scope

- Звонки (аудио/видео) — только иконки/тосты, как в макете.
- Реальный marketplace плагинов и выполнение плагинов на сервере.
- DLP-движок и полноценный аудит (только UI + контракт в D1.1).
- Изменение криптопротокола E2EE.
- Нативные приложения.

## 3. Контракт и модель данных

### 3.1 Непрочитанные

- **MVP:** FE суммирует `ChatSummary.unread_count` по чатам пространства; `> 99 → "99+"` — только отображение.
  Сервер по-прежнему хранит точное число, `markRead` уже есть.
- **Если** чатов в пространстве станет много, добавить `WorkspaceSummary.unread_count` или
  `GET /workspaces/{id}/unread` (агрегат, без content). Это D1.1.
- Уточнить у продукта: это непрочитанные **сообщения** или **уведомления**? В макете — сообщения.

### 3.2 Треды

Выбрать модель «плоское дерево»: ответ — обычное сообщение с `thread_root_id`, без вложенных тредов
(максимальная глубина 1). Это переиспользует seq, идемпотентность, вложения, реакции и WS.

```yaml
Message:
  properties:
    thread_root_id:
      type: [string, "null"]
      format: uuid
      description: Корень треда; null — обычное сообщение канала
    thread_summary:
      type: [object, "null"]
      description: Только для корня; считается сервером
      properties:
        reply_count: { type: integer, minimum: 0 }
        last_reply_at: { type: [string, "null"], format: date-time }
        last_reply_author_id: { type: [string, "null"], format: uuid }
        last_reply_excerpt: { type: [string, "null"], maxLength: 160 }

MessageCreate:
  properties:
    thread_root_id: { type: [string, "null"], format: uuid }
```

- `GET /chats/{chatId}/messages?thread_root_id=<root>` — ответы треда с `before_seq`/`limit`;
  без параметра — обычная лента (только `thread_root_id = null`).
- `POST /chats/{chatId}/messages` с `thread_root_id` — ответ в тред; тот же `Idempotency-Key`.
- Валидация: корень существует, тот же чат, корень сам не ответ (`thread_root_id = null`), глубина 1,
  право писать в чат.
- WS `message.created` добавляет `thread_root_id`; FE обновляет счётчик/превью корня.
- **E2EE:** в D1 не поддерживаем; сервер не может строить excerpt. Ответы в E2EE — отдельное решение.
- Превью `last_reply_excerpt` — только managed; для E2EE `null`.

### 3.3 Вложения: аудио, видео, песня

```yaml
AttachmentRef:
  properties:
    media:
      type: [object, "null"]
      properties:
        kind: { type: string, enum: [AUDIO, VIDEO, IMAGE, FILE] }
        duration_ms: { type: [integer, "null"], minimum: 0 }
        width: { type: [integer, "null"] }
        height: { type: [integer, "null"] }
        title: { type: [string, "null"], maxLength: 255 }
        artist: { type: [string, "null"], maxLength: 255 }
        album: { type: [string, "null"], maxLength: 255 }
        year: { type: [string, "null"], maxLength: 8 }
        genre: { type: [string, "null"], maxLength: 64 }
        artwork_url: { type: [string, "null"], format: uri }
        metadata_source: { type: string, enum: [ID3, SERVER, CLIENT, NONE] }
```

- **Managed:** сервер после scan извлекает ID3/ffprobe-метаданные и обложку, хранит `media` в БД;
  обложка — производный attachment (CLEAN) или защищённый URL. Клиентские значения — только fallback.
- **E2EE:** сервер **не** читает медиа; метаданные парсит клиент, хранит локально (IndexedDB) и
  показывает в ленте/«Файлах»; `media` в API отсутствует или полностью непрозрачен.
- **MVP-компромисс:** FE парсит ID3 для карточки (уже реализовано в макете), managed BE сохраняет
  sanitized `media` из клиента, E2EE — local-only. Серверная экстракция — D1.1.
- Голосовые: MediaRecorder → attachment `audio/webm` (или `audio/ogg`), `duration_ms`; лимиты из
  `WorkspaceLimits`; MIME-allowlist; антивирус — существующий pipeline.
- Безопасность: любые строки тегов экранировать, обрезать, не использовать в путях/HTML; malformed ID3
  не должен ронять парсер (try/catch, лимит на размер кадра/обложки).

### 3.4 Настройки чата

```yaml
PATCH /chats/{chatId}:
  body: { name?: string, description?: string }
  # права: owner/admin; audit; идемпотентность не нужна
```

- Участники/роли — использовать `workspace members`/новые chat-members эндпоинты; если их нет,
  ограничить D1 read-only составом + приглашением по ссылке (как в макете).
- Опасная зона: archive/leave/delete — отдельные операции с подтверждением и audit; в MVP можно
  оставить UI + `TODO`, если backend-операций нет. Явно отметить в PR.

## 4. FE-задачи

1. **Каркас**: `SpaceRail`, `Sidebar` (навигация + секции), `ChatDetailsPanel`, страницы
   `OverviewPage`, `FilesPage`, `SettingsPage`, `PluginsPage`, `SecurityPage`; роутинг `view`
   (state/URL), back-to-chat, темы.
2. **Лента**: перейти от пузырей к плоской ленте; дата-разделители, реакции, hover-actions,
   вложения, пустые/загрузка/ошибки; сохранить reply.
3. **Треды**: `ThreadLink`, `ThreadPanel`, `ThreadComposer`; создание из hover/мобильной иконки;
   пагинация ответов; обновление счётчика; закрытие по `Esc`; состояния «нет ответов».
4. **Голос/песня/видео**: `VoiceMessage`, `AudioAttachment`, `VideoAttachment`, `SongCard`,
   `RecordingBar`; MediaRecorder; ID3-парсер; fallback; превью обложки; локальный кэш для E2EE.
5. **Непрочитанные**: сумма по пространству, `99+`, `aria-label` с точным числом, обновление после
   `markRead`; не показывать бейдж при 0.
6. **Настройки/профиль**: модалки, формы, роли, инвайт, dangerous actions, подтверждения.
7. **Страницы**: Обзор (метрики/активность/быстрые чаты/хранилище), Файлы (фильтры/поиск/квоты),
   Плагины/Защита — на существующих данных или явных `empty/disabled` состояниях.
8. **Качество**: 390/768/1440, light/dark, focus-visible, `aria`, reduced motion; RTL + Playwright.

## 5. BE-задачи

1. **Threads**: миграция `messages.thread_root_id`, индекс `(chat_id, thread_root_id, seq)`,
   constraint root/one-level; API list/send; summary-запрос; RLS; идемпотентность; WS fan-out;
   тесты прав/лимитов/повторов.
2. **Media metadata**: миграция `attachments.media jsonb` + artwork; managed-экстракция (D1.1) или
   приём sanitized client media (MVP); duration/width/height; MIME-allowlist; лимиты; тесты
   malformed/oversize/scan.
3. **Unread**: существующий `ChatSummary.unread_count`; при необходимости aggregate endpoint (D1.1);
   markRead не ломать.
4. **Chat settings**: `PATCH /chats/{id}` + audit; участники/роли — по готовности; тесты 403/404/422.
5. **Contract**: `openapi.yaml` + `frontend/src/api/schema.d.ts` + `contract:check`; additive,
   versioning note.
6. **Realtime**: `message.created` с `thread_root_id`; не терять порядок/backpressure; тест resume.

## 6. Acceptance criteria

### A. Непрочитанные

- [ ] На иконке пространства видно число непрочитанных; при 100+ — `99+`.
- [ ] При 99 — `99`, при 100 — `99+` (граница).
- [ ] Открытие чата и `markRead` уменьшают число; при 0 бейдж исчезает.
- [ ] `aria-label` кнопки содержит точное число; бейдж не дублируется скринридером.
- [ ] Состояние переживает reload (числа из API, не localStorage).

### B. Треды

- [ ] У любого сообщения можно создать тред; ссылка «N ответов» открывает панель.
- [ ] Ответ отправляется, появляется у всех участников, счётчик и превью обновляются.
- [ ] После reload тред и ответы на месте; `seq`/порядок соблюдены.
- [ ] Ответ на ответ запрещён (UI не предлагает; API 422).
- [ ] Нет прав/удалённый корень/E2EE → понятная ошибка, без 500.
- [ ] Мобильный: панель overlay, `Esc`/фон закрывают, композер доступен.
- [ ] В E2EE MVP: треды недоступны с явным объяснением (или feature flag off).

### C. Голос/аудио/видео/песня

- [ ] Микрофон: разрешение, таймер, отмена, отправка; нет доступа — понятная ошибка.
- [ ] Голосовое проигрывается, длительность совпадает; лимит/тип проверяются.
- [ ] Аудио/видео-вложение: карточка, play (или download), размер, длительность.
- [ ] MP3 с ID3: обложка, title, artist, album, year, genre, duration.
- [ ] MP3 без ID3/M4A/битый файл: fallback (имя, «Неизвестный исполнитель», дефолтная обложка),
      без падения и без XSS.
- [ ] Песня появляется в ленте и в «Файлах», обложка видна; после reload — согласно выбранной
      стратегии (managed — сервер, E2EE — local).
- [ ] Квота/лимит файла соблюдаются; при превышении — понятная ошибка.

### D. Страницы, окна, адаптив

- [ ] Обзор/Файлы/Плагины/Защита/Настройки открываются, «назад» возвращает в чат.
- [ ] Профиль и Настройки чата: открытие/закрытие, `Esc`, фон, фокус.
- [ ] 390/768/1440 без горизонтального скролла; drawer/sheet работают.
- [ ] Light/dark; контраст; focus-visible; axe без critical/serious.
- [ ] Нет console errors, битых изображений, дублей `id`.

## 7. Тест-план

```bash
# frontend
cd frontend
npm run lint && npm run format:check
npm run contract:check
npm test
npm run build

# backend
cd ../backend
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
mvn -o -Dmaven.repo.local=.m2repo test

# e2e (после появления API/MSW)
cd ../frontend
npx playwright test
```

- Новые unit/RTL: бейдж, тред-панель, ID3-парсер (UTF-8/UTF-16/CP1251, APIC, битые данные), fallback,
  composer recording, modal a11y.
- BE IT: threads (root/one-level/RLS/idempotency/limit), media metadata, chat settings, WS.
- Playwright: 390/768/1440, light/dark, thread create/reply/reload, song upload, 99+ boundary.
- Ручная сверка с v1.0: [`desktop-light`](../design/dashboard/screenshots/desktop-light.png),
  [`thread-light`](../design/dashboard/screenshots/thread-light.png),
  [`media-light`](../design/dashboard/screenshots/media-light.png),
  [`mobile-thread`](../design/dashboard/screenshots/mobile-thread.png).

## 8. Definition of Done

- [ ] Contract обновлён, `schema.d.ts` сгенерирован, `contract:check` зелёный.
- [ ] Миграции forward-only, RLS, индексы; rollback-план описан.
- [ ] FE/BE тесты и e2e зелёные; a11y axe; нет console errors.
- [ ] Feature flags: треды (managed), запись голоса, media metadata — можно выключить.
- [ ] Документация: README/ADR по threads и metadata; обновлён `frontend/README.md`.
- [ ] Демо на стенде: сценарий из §6, скриншоты/видео приложены к PR.
- [ ] PM/design приёмка по v1.0; отклонения — отдельным change request в v1.1, не правкой v1.0.

## 9. Подзадачи и оценка

| ID | Задача | Роль | Оценка |
|---|---|---|---|
| D1-C1 | Contract delta: threads, media, chat settings | PM/BE | 2 d |
| D1-BE1 | Threads: schema/API/summary/WS/tests | BE | 6 d |
| D1-BE2 | Media metadata + artwork + MIME/limits | BE | 4 d |
| D1-BE3 | Chat settings PATCH + audit + members | BE | 3 d |
| D1-FE1 | Shell, rail, sidebar, pages routing, themes | FE | 5 d |
| D1-FE2 | Flat message list, attachments, voice/song/video | FE | 6 d |
| D1-FE3 | Threads UI + realtime + mobile | FE | 4 d |
| D1-FE4 | Overview/Files + limits + empty/error | FE | 4 d |
| D1-FE5 | Profile/Chat settings modals | FE | 3 d |
| D1-QA1 | E2E, a11y, responsive, contract | QA | 3 d |

## 10. Риски и вопросы

| # | Риск/вопрос | Решение |
|---|---|---|
| 1 | «Непрочитанные» — сообщения или уведомления? | В макете — сумма `unread_count` чатов; подтвердить у продукта |
| 2 | Треды в E2EE | MVP — managed-only; E2EE отдельным ADR |
| 3 | ID3: доверие и кросс-девайс | MVP — client-side + local (E2EE), managed sanitized; серверная экстракция D1.1 |
| 4 | Обложка в E2EE | Локальный кэш; сервер не получает plaintext |
| 5 | Большие обложки/битые теги | Лимит 2 МБ, таймаут, try/catch, sanitize |
| 6 | Нагрузка на summary тредов | Индекс + отдельный запрос/кэш; не тянуть все ответы |
| 7 | UI-регрессии текущего фронтенда | Поэтапно, feature flag; снапшоты |
| 8 | Плагины/Защита без API | MVP — честные disabled/empty; D1.1 |

## 11. Ссылки

- Дизайн: [`design/dashboard/`](../design/dashboard/), [`DESIGN.md`](../design/dashboard/DESIGN.md)
- Версия: [`VERSION.md`](../design/dashboard/VERSION.md), [`releases/`](../design/dashboard/releases/)
- Референс: [Dribbble Shot 17943583](https://dribbble.com/shots/17943583-Message-Dashboard)
- Контракт: [`contracts/openapi.yaml`](../contracts/openapi.yaml)
- Текущий фронтенд: `frontend/src/components/{Sidebar,ChatHeader,MessageList,MessageRow,Composer}.tsx`


## 12. Порядок реализации

1. **D1-C1 contract** — threads, `AttachmentRef.media`, `PATCH /chats/{id}`; additive, `schema.d.ts`, contract-check.
2. **D1-BE1 threads** — миграция/индекс/constraint, list/send, summary, WS, RLS, idempotency.
3. **D1-BE2 media** — `media jsonb`, duration/artwork, MIME/limits, sanitized client media для managed, local-only для E2EE.
4. **D1-BE3 chat settings** — PATCH + audit, members по E12.
5. **D1-FE1 shell** — rail/sidebar/pages/routing/themes.
6. **D1-FE2 feed/media** — плоская лента, voice/audio/video/song, ID3 client-side.
7. **D1-FE3 threads UI** — link/panel/composer/mobile; E2EE threads — явно disabled.
8. **D1-FE4 pages** — Overview/Files/limits/empty/error.
9. **D1-FE5 modals** — profile/chat settings.
10. **D1-QA1** — e2e/a11y/responsive/contract.

Флаги: threads managed-only, voice recording, media metadata — отключаемые. D1 не меняет криптопротокол E2EE; E2EE threads — D1.1.

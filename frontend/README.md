# «Круг» — frontend F-01 + F-04 (Auth BFF) + E3-F + E4-F + E5-F + E6-F + E9-F + E10-F + E11-F + E12-F

Managed-чат по контракту `contracts/openapi.yaml`: история с пагинацией, optimistic send, retry с идемпотентностью, read receipts, reconnect через `GET /sync`. Срез **F-04** добавляет собственные формы входа/регистрации/подтверждения email (Auth BFF: `/auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/resend-email-code`, `/auth/refresh`, `/auth/logout`), `/me`, регистрацию устройства, onboarding первого workspace и auth guard. Браузер не ходит в Keycloak и не использует OIDC-редирект. Срез **E3-F** добавляет WebSocket-клиент: `POST /realtime/ticket`, `hello`/`subscribe`/`ack`/`ping`/`typing`, live `message.created`/`message.receipt`, replay по `last_seq`, `resume.gap` → REST, typing/presence TTL, backoff 1–30 с + jitter и индикатор online/reconnecting/offline. Срез **E4-F** добавляет managed-файлы: preflight и лимиты, picker/drag&drop, chunked upload 8 МиБ с прогрессом и resume, `attachment_ids` в сообщении, карточки вложений с presigned URL TTL 5 минут и scan status. Срез **E5-F** добавляет встроенные стикеры managed-чата: picker с наборами, поиском по alt, избранным и локальными недавними, отправку `type=STICKER` с optimistic UI, рендер `<img>` без пузыря и PNG-ассеты 2×8. Срез **E6-F** добавляет in-app уведомления: колокольчик с unread badge, панель со списком и cursor-пагинацией, optimistic read one/all с rollback, настройки per-chat/type/channel/mode и E2EE-безопасный рендер (`body=null` → generic title + «контент скрыт»). Срез **E12-F** добавляет управление участниками пространства (R-09): список с поиском/refresh, добавление существующего пользователя по email с ролью, смена роли и удаление с подтверждением; OWNER/ADMIN-контролы, read-only для остальных, серверные 403/404/409 без потери строки. Dev-режим F-01 (`POST /dev/session`) сохранён как fallback.

Контракт — единственный источник API-форм. `backend/**`, `infra/**`, `docs/**`, `design/**` и `contracts/**` не изменяются.

## Стек

- Vite 7 + React 19 + TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`).
- Собственный нормализованный store на `useSyncExternalStore` (без тяжёлого data-layer: нужен явный контроль `seq`, optimistic outbox и идемпотентных повторов).
- Собственный Auth BFF-клиент (`src/api/authApi.ts`): email+пароль, 6-значный email-код, refresh/logout; токены только в memory + namespaced sessionStorage, без OIDC-библиотек.
- MSW 2 для контрактных моков (браузер и Node-тесты), включая `/me`, `/devices`, `/workspaces`, `/realtime/ticket`, весь files pipeline (`/limits`, `/uploads/*`, `/attachments/*`), стикеры (`/sticker-packs`, `/stickers/{id}/favorite`, `STICKER`-сообщения) и уведомления (`/notifications`, `/notifications/read`, `/notification-preferences`); WebSocket в mock-режиме заменён in-process mock-сервером (тот же протокол кадров).
- Vitest + Testing Library + jsdom; Playwright — smoke, auth flow, mock-WS live/reconnect, mock-files upload/send, mock-stickers picker/send/favorite, mock-notifications bell/read/prefs и axe.
- ESLint 9 (flat config) + Prettier.

## Быстрый старт

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, dev-режим + MSW
```

Сборка и проверки:

```bash
npm run build        # tsc --noEmit + vite build
npm test             # Vitest + RTL (MSW)
npm run lint
npm run format:check
npm run contract:check
npm run security:check
npm run check        # всё перечисленное + build
```

`package-lock.json` коммитится. Пакетный менеджер — `npm` (pnpm в окружении нет).

## Режимы авторизации

| Режим      | Env                                           | Что происходит                                                                 |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `dev`      | `VITE_AUTH_MODE=dev`, `VITE_DEV_SESSION=true` | `POST /dev/session` при старте и на 401; чат открывается сразу, без login      |
| `password` | `VITE_AUTH_MODE=password`                     | Свои формы `/login`, `/register`, `/verify`; `/me`; `/devices`; refresh/logout |

`dev` — fallback и значение по умолчанию для существующих E2E F-01. `password` — целевой режим F-04 и production (`VITE_AUTH_MODE=password`). Третьего режима и mock-провайдера в production нет: моки живут только в MSW (`VITE_USE_MOCKS=true`, dev/E2E/тесты).

### Auth BFF (F-04)

- Браузер вызывает только `POST /api/v1/auth/*`; Keycloak (пароли, пользователи, SMTP-письма) остаётся за backend-BFF. Никаких запросов на `:8180`/`/realms`, редиректов и callback-маршрута.
- `POST /auth/register` → `202 {verification_id, expires_in, resend_after}` → экран `/verify` с 6-значным кодом, таймером истечения и повторной отправкой не чаще 60 с.
- `POST /auth/verify-email` → `AuthSession`; `POST /auth/login` → `AuthSession`. Ошибки `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED` (+`verification_id` → сразу `/verify`), `422 CODE_INVALID` (+`attempts_left`), `410 CODE_EXPIRED`, `409 EMAIL_TAKEN`, `429 RATE_LIMITED` (+`Retry-After`), `503 AUTH_UNAVAILABLE` показываются понятным RU-текстом.
- `POST /auth/refresh` вызывается на первый 401 (один replay, общий для параллельных запросов, cooldown 5 с). Недействительный refresh очищает токены и возвращает на `/login`.
- `POST /auth/logout` отзывает refresh в Keycloak (best-effort), затем очищает sessionStorage/memory token, device id и E2EE-состояние текущего аккаунта (E7-F5F) и возвращает на `/login?logged_out=1`.
- При старте с сохранённой сессией выполняется `GET /me`; при `workspaces: []` открывается onboarding.
- Dev-проверка без backend: `VITE_USE_MOCKS=true VITE_AUTH_MODE=password npm run dev` — MSW реализует `/auth/*`; демо-пользователь `demo@krug.test` / `Krug-demo-2026`, код подтверждения `123456` (только mock).

## Переменные окружения

Скопируйте `.env.example` в `.env.local` (файл в `.gitignore`).

| Переменная              | По умолчанию                                                | Назначение                                                                       |
| ----------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | `/api/v1` при mock, `http://localhost:8081/api/v1` при real | База API (контракт: `http://localhost:8081/api/v1`)                              |
| `VITE_USE_MOCKS`        | `true` в dev, `false` в production build                    | MSW-моки вместо backend                                                          |
| `VITE_AUTH_MODE`        | `dev`                                                       | `dev` (F-01) или `password` (Auth BFF, F-04); production — `password`            |
| `VITE_DEV_SESSION`      | `true`                                                      | В dev-режиме вызывать `POST /dev/session` при старте и на 401                    |
| `VITE_API_PROXY_TARGET` | —                                                           | Dev-прокси Vite: `/api` → target (обход выключенного CORS у backend)             |
| `VITE_WS_URL`           | —                                                           | Переопределяет `ws_url` из ticket; `/ws` — тот же origin, `wss://...` — напрямую |
| `VITE_WS_PROXY_TARGET`  | `VITE_API_PROXY_TARGET` или `http://localhost:8081`         | Dev-прокси Vite: `/ws` → target, `ws: true`                                      |
| `VITE_REALTIME_ENABLED` | `true`                                                      | Выключить WebSocket-клиент (REST/sync остаются рабочими)                         |
| `VITE_MEDIA_ORIGINS`    | `http://localhost:9002`                                     | Origin(ы) presigned URL/MinIO через запятую: `img-src`/`media-src`/`connect-src` |
| `VITE_DEVICE_NAME`      | `Круг — браузер`                                            | Имя устройства для `POST /devices`                                               |
| `VITE_APP_VERSION`      | `0.1.0`                                                     | `app_version` для `POST /devices`                                                |

Порт 8080 в этом окружении занят другим проектом (`competency-service`); «Круг» использует frontend `5173`, backend `8081`. Keycloak в браузере не используется.

В production build Vite добавляет meta-CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`); `connect-src` включает origin API, `img-src`/`media-src`/`connect-src` — origin(ы) `VITE_MEDIA_ORIGINS` (по умолчанию MinIO `http://localhost:9002`) и `blob:`. В dev CSP не вставляется, чтобы не ломать HMR Vite. SVG из пользовательских файлов не рендерится (только скачивание).

## Архитектура

```text
src/
  api/
    schema.d.ts      # генерируется из ../contracts/openapi.yaml
    types.ts         # алиасы контрактных схем (включая MeResponse/WorkspaceSummary/Device)
    http.ts          # fetch-клиент: Authorization, X-Device-Id, Idempotency-Key, timeout, no-store
    problem.ts       # ApiError {status, code, details, request_id, Retry-After}
    endpoints.ts     # dev/session, /me, /devices, /workspaces, chats, messages, read, sync, realtime/ticket, files, sticker-packs/favorites, notifications/preferences, workspace members
    authApi.ts       # /auth/register|verify-email|resend-email-code|login|refresh|logout
  auth/
    session.ts       # dev session + единые getAccessToken/getDeviceId для API
    runtime.ts       # password-mode token/device runtime (memory + sessionStorage fallback)
    storage.ts       # единственный модуль с sessionStorage; auth session + pending verification
    PasswordAuthProvider.tsx  # Auth BFF flow: login/register/verify/resend/logout/refresh
    AuthContext.ts   # безопасная view-model: user/status/actions, без токенов
    errors.ts        # контрактные auth-коды → AuthErrorInfo + RU-текст
    reauth.ts        # 401 → /auth/refresh hook для API-слоя
  config/env.ts      # AppConfig из VITE_*
  router/router.ts   # /login, /register, /verify, /onboarding, / (history API)
  domain/
    messages.ts      # sort/merge по seq, dedupe, группировка по дням
    errors.ts        # code/status → понятный RU-текст и retry-политика (включая files)
  files/
    hash.ts          # SHA-256 parts/файла, streaming для больших файлов
    format.ts        # байты, MIME/тип, безопасные image previews
    limits.ts        # usage/80-95-100 %, guest cap
    errors.ts        # коды files → ApiError/retryable
  store/chatStore.ts # server state + outbox + sync + read + onboarding/workspace
  store/filesStore.ts# preflight, upload queue, parts, resume, scan poll, limits, download cache
  stickers/
    model.ts         # STICKER-message detection, alt-search, favorites/recent resolution
    recent.ts        # recent stickers: IndexedDB per user + memory fallback (no tokens)
    store.ts         # packs/favorites/recent/disabled, optimistic favorite + rollback
  realtime/          # protocol v1, close codes/backoff, RealtimeClient, socket adapter
  hooks/             # bootstrap, online/offline, reconnect, debounce read
  components/        # ChatScreen, Sidebar, MessageList, Composer, StickerPicker, AttachmentCard, LimitsBar, UploadTray, NotificationBell/Panel/Preferences, WorkspaceMembersDialog, auth/*
  mocks/             # MSW handlers (files, stickers, notifications/preferences, workspace members) + in-process mock WS server
  i18n/ru.ts         # простой типизированный словарь RU
  styles/app.css     # токены по мотивам design/, без импорта прототипа
```

### Auth-flow (password / Auth BFF)

1. **Guard.** Без сохранённой сессии любой путь, кроме `/login`, `/register` и `/verify`, заменяется на `/login` (history `replaceState`, без полной перезагрузки). `/verify` без активного подтверждения ведёт на `/login?verification=missing`.
2. **Login.** `/login` — email + пароль с show/hide, loading, generic-ошибкой и ссылкой на регистрацию. Пароль уходит только в `POST /auth/login`; при `403 EMAIL_NOT_VERIFIED` приложение открывает `/verify` с `verification_id`.
3. **Register.** `/register` — имя (1..80), email (≤254), пароль (10..128) и подтверждение; клиентская валидация до сети. Успех (`202`) не создаёт сессию: показывается `/verify` с email, сроком кода и обратным отсчётом повторной отправки (60 с).
4. **Verify.** `/verify` — 6 цифр (`inputMode=numeric`, `autocomplete=one-time-code`), ошибки `CODE_INVALID` с остатком попыток, `CODE_EXPIRED`, `429` после 5 попыток; повторная отправка через `POST /auth/resend-email-code`. Успех (`AuthSession`) сохраняет токены и открывает приложение.
5. **Bootstrap.** Сохранённая сессия сразу даёт `authenticated`; store вызывает `GET /me`, регистрирует устройство (`POST /devices`, `Idempotency-Key`), выбирает `default_workspace_id` и загружает `GET /workspaces/{id}/chats` → `GET /chats/{id}/messages`.
6. **Onboarding.** Если `/me` вернул `workspaces: []`, показывается форма создания workspace (`POST /workspaces`, `security_mode=MANAGED`) с `Idempotency-Key` и `X-Device-Id`. После `201` — повторный `/me`, выбор созданного workspace и чат «Общий чат».
7. **Device.** `device_id` не секрет и сохраняется в namespaced sessionStorage (`krug.device.id`), затем передаётся как `X-Device-Id` во все защищённые запросы; при повторной загрузке устройство переиспользуется.
8. **Refresh.** На первый 401 API-слой вызывает `POST /auth/refresh` с refresh token из storage, сохраняет ротированную пару и повторяет запрос **один раз**. Параллельные 401 делят одну попытку, повторный refresh в течение 5 секунд подавляется — цикла 401 нет. Если refresh не удался, токены очищаются и показывается `/login` (сессия истекла); E2EE-состояние при этом не стирается.
9. **Logout.** `POST /auth/logout {refresh_token}` (best-effort), затем очистка auth storage, memory token, device id, E2EE-состояния текущего аккаунта и возврат на `/login?logged_out=1`. Кнопка «Выйти» — в sidebar.
10. **401/403.** 401 после неудачного refresh → `/login`; 403 на `/workspaces/{id}/chats` → «Нет доступа к пространству» с retry/выходом. Ошибки 403/404 не раскрывают существование ресурса.

### Поток данных managed-чата (F-01)

1. **Bootstrap dev.** `POST /dev/session` (если нет сессии в памяти) → `GET /workspaces/{id}/chats` → `GET /chats/{id}/messages?limit=30`. Активным выбирается чат из сессии, иначе первый.
2. **История.** Ответ сортируется по `seq` (не по времени клиента), дубликаты отбрасываются по `id` и `seq`. «Загрузить ещё» — `before_seq=<min seq>&limit=30`; перед вставкой запоминается `scrollHeight`, после рендера `scrollTop` корректируется на дельту (scroll anchoring, `useLayoutEffect`).
3. **Optimistic send.** Сразу создаётся outbox-запись с `client_message_id` + `Idempotency-Key`; UI синхронно показывает её со статусом «Отправляется…». На `201` запись удаляется, серверное сообщение вставляется тем же патчем (без промежуточного дубля).
4. **Retry.** Тот же `client_message_id` и тот же `Idempotency-Key`; текст остаётся в failed-пузыре, кнопка «Вернуть текст» переносит его обратно в composer и удаляет outbox-запись. Для `409 IDEMPOTENCY_IN_PROGRESS` — автоматический повтор до 3 раз с задержкой `Retry-After`.
5. **Read receipts.** `useReadReceipt` ждёт 700 мс (в тестах 30 мс) после изменения максимального видимого `seq`, проверяет `visibilityState === 'visible'` и вызывает `POST /chats/{id}/read`; повторный вызов для того же `seq` не отправляется.
6. **Reconnect.** `online`-событие / `visibilitychange` / интервал 30 с → `GET /sync?workspace_id=` → сравнение `last_seq` → `GET /messages?after_seq=<local max>&limit=100` страницами (до 10 страниц). При включённом realtime `online` сначала поднимает WS: `GET /sync` → новый ticket → `subscribe(last_seq)` (см. E3-F).
7. **Ошибки.** 401 → refresh/re-login и один replay; 403/404 → «Нет доступа» (без раскрытия существования); 409 → конфликт/повтор; 422 → валидация/лимит; 429 → `Retry-After` + блокировка отправки с обратным отсчётом; 5xx/network/timeout → retry. Технические `code`/`request_id` — только в раскрываемых «Деталях».

### WebSocket E3-F

1. **Ticket.** `POST /api/v1/realtime/ticket` с `Authorization: Bearer` и `X-Device-Id` → `{ticket, expires_at, ws_url}`. Тикет одноразовый, живёт 30 с; каждый reconnect получает **новый** тикет. Access token в query не попадает.
2. **Connect.** Браузер идёт на same-origin `/ws?ticket=...`: dev-сервер проксирует `/ws` на `VITE_WS_PROXY_TARGET` (`http://localhost:8081`, `ws: true`). `VITE_WS_URL` переопределяет endpoint (относительный `/ws` или абсолютный `wss://...`). Без override `ticket.ws_url` используется как есть, но loopback-адрес бэкенда в dev заменяется на same-origin `/ws`, чтобы работал proxy и CSP.
3. **Handshake.** После upgrade сервер шлёт `hello` (`heartbeat_ms`, `protocol`). Клиент отвечает `subscribe {chats:[{chat_id,last_seq}], presence:true}`; сервер — `subscribed` и replay `message.created` по возрастанию `seq` (≤500).
4. **Frames.** Сервер: `hello`, `subscribed`, `event` (`message.created`, `message.receipt`, ...), `resume.gap`, `pong`, `error`, `session.revoked`, а также `typing`/`presence`. Клиент: `subscribe`, `ack`, `ping`, `typing`. `typing`/`presence` принимаются и как top-level `type`, и как `event` — оба варианта описаны в контракте.
5. **Dedupe/merge.** Store помнит `event_id` (ring 1000), игнорирует `seq <= last_seq`, мержит по `id`/`seq`. `message.created` принимается и как `payload.message` (контракт), и как flat `payload` (текущий E3-B); от собственного optimistic-сообщения снимает outbox-строку по автору+тексту+reply; поздний REST `201` дедуплицируется по `id`. `message.receipt` монотонно обновляет `receipts[user_id]`; для другого участника в UI появляется «Прочитано».
6. **Gap.** `resume.gap` → `GET /messages?after_seq=<last_seq>&limit=100` страницами (до 10) → live продолжается; гонка live/REST безопасна за счёт `seq`/`event_id`.
7. **Reconnect.** `onBeforeReconnect` делает `GET /sync`, затем новый ticket и `subscribe` с актуальным `last_seq`. Backoff 1/2/4/8/16/30 с + jitter ±20 %, не более 60 попыток/час; при исчерпании бюджет ждёт окно и показывает баннер. Close codes: `4401` → новый ticket, `1008` → fatal, `1013`/`1000`/network → reconnect, `4403`/`session.revoked` → экран «Сессия истекла/отозвана» и stop.
8. **Heartbeat.** `ping` каждые `hello.heartbeat_ms` (≤25 с); если за 60 с не пришло ни одного кадра/pong — close и reconnect.
9. **Typing/presence.** Эфемерные, TTL 5 с/60 с, не replay-ятся. «Печатает…» — один `role="status"` c `aria-live="polite"`; presence показывает число online в шапке.
10. **REST при WS down.** Отправка/история не блокируются; в шапке online/reconnecting/offline, при auth/forbidden/protocol — понятный баннер. 401/403 на ticket не ретраятся бесконечно.

### Managed-файлы (E4-F)

1. **Picker.** Скрепка в composer и drag&drop на весь чат; до `max_attachments` (по умолчанию 10) файлов за раз. Выбор сразу уходит в `POST /uploads/preflight` с `files:[{name,size,mime}]`; решение сервера — источник истины. Клиент дополнительно не даёт выбрать файл больше web-лимита 2 ГиБ и больше `max_file_bytes`/`guest_file_bytes`, но это только UX. Для каждого файла показывается решение: `ALLOW`, `413 FILE_TOO_LARGE`, `409 QUOTA_EXCEEDED`, `415 UNSUPPORTED_TYPE`, `422 TOO_MANY_FILES`/`DANGEROUS_TYPE_BLOCKED`. Preflight не резервирует квоту.
2. **Init.** Для разрешённых файлов — `POST /uploads` с `chat_id/filename/size/mime/encryption_mode=MANAGED` и `Idempotency-Key`; сервер возвращает `upload_id`, `part_size=8 МиБ`, `total_parts`, `expires_at`. Клиент сохраняет `upload_id` и переиспользует его при resume/retry; новый ключ — только при «Начать заново».
3. **Parts.** Файл режется на части по `part_size`; каждая уходит `PUT /uploads/{id}/parts/{n}` с `Content-SHA256` (SHA-256 части, streaming/SHA-256 fallback). В полёте не больше 3 частей (`uploadPartConcurrency`), прогресс считается по подтверждённым частям. `409 CHUNK_CONFLICT` и `422 CHUNK_HASH_MISMATCH` повторяются с тем же `upload_id/part_no` (до 3 попыток, затем кнопка «Повторить»); `429` ждёт `Retry-After`; `410 UPLOAD_EXPIRED` — «Начать заново».
4. **Pause/resume/cancel.** Pause перестаёт планировать новые части (in-flight части дожидаются), resume делает `GET /uploads/{id}` → `received_parts`, вычисляет missing parts по `total_parts` (поля `missing_parts` в контракте нет) и докачивает только их; cancel прерывает запросы и вызывает `POST /uploads/{id}/abort`, освобождая reservation. Retry после обрыва идёт через тот же `GET` и не создаёт второй объект.
5. **Complete/scan.** После всех частей считается финальный SHA-256 и отправляется `POST /complete {sha256,parts_count}`. `202 SCANNING` → polling `GET /uploads/{id}` каждые `uploadScanPollMs` (2 с) до `READY`/терминального статуса; `READY` даёт `attachment_id`, `QUARANTINED` блокирует отправку. Лимиты перезапрашиваются после complete/abort.
6. **Сообщение.** Ready-вложения уходят в `POST /messages` как `attachment_ids` (≤10); `text` может быть `null`/пустым. Optimistic outbox хранит текст + локальные attachment refs; после `201` заменяется серверным `Message` с `attachments`, а `filesStore.markBound` убирает карточки из tray. `409 ATTACHMENT_NOT_READY`, `423 ATTACHMENT_QUARANTINED`, `422 TOO_MANY_FILES` показываются в failed-пузыре; текст не теряется и возвращается кнопкой «Вернуть текст».
7. **Отображение/скачивание.** Карточка: имя, размер, MIME-тип, scan status (`PENDING/CLEAN/INFECTED/FAILED/SKIPPED`). `GET /attachments/{id}/download-url` даёт presigned URL TTL 5 минут; URL запрашивается только для `CLEAN`, кэшируется до истечения (с запасом 30 с) и обновляется после TTL/ошибки (`filesStore.invalidateDownloadUrl`). Изображения (raster allowlist, без SVG) — превью + lightbox (`role=dialog`, `aria-modal`, alt, Esc, backdrop, focus return, download); MP4/WebM — inline `<video controls preload="metadata" playsInline>` без autoplay и poster; MP3/OGG/WAV — inline `<audio controls preload="metadata">` рядом с именем/размером. PENDING/INFECTED не получают URL и плеер, кнопка скачивания заблокирована; FAILED/SKIPPED — без превью, скачивание остаётся серверным. 409 `SCAN_PENDING`/423 `ATTACHMENT_QUARANTINED`/410 `ATTACHMENT_DELETED` дают понятное состояние с retry (кроме terminal) и download fallback. Все внешние ссылки — `rel="noopener noreferrer"`.
8. **Лимиты.** `GET /workspaces/{id}/limits` при активации workspace; usage bar `used+reserved / limit`, предупреждения 80/95/100 %, `max_file_bytes`, `max_attachments`, `guest_file_bytes` для роли `GUEST`. 100 % блокирует picker, но не мешает отправить уже готовые вложения. Ошибка загрузки лимитов не блокирует чат — есть retry.
9. **`QUARANTINED` в статусе upload.** PM добавил `QUARANTINED` в `UploadSession.status` (`contracts/openapi.yaml`); frontend типизирован по контракту, считает статус терминальным и блокирует отправку/скачивание (423). Второй контур — `AttachmentRef.scan_status=INFECTED` и `423 ATTACHMENT_QUARANTINED` при download/send. Backend E4-B должен отдавать `QUARANTINED` при `INFECTED`.
10. **Backend E4-B.** Files pipeline реализован и проверен: real UI smoke `upload → READY → send → attachment card → download` — 1/1 (`E4_FILE_REAL=1`). E2EE-файлы, AV UI, DLP, публичные ссылки, CDN и 10 ГиБ/desktop — вне scope.

### Встроенные стикеры (E5-F)

1. **Picker.** Кнопка-стикер в composer (рядом со скрепкой) открывает панель `role="dialog"` с табами «Избранное», «Недавние» и наборами из `GET /sticker-packs?chat_id`. Панель закрывается по `Esc`, клику вне и кнопке «Закрыть»; фокус возвращается на кнопку-стикер. Табы листаются стрелками/Home/End, сетка стикеров — стрелками, Enter отправляет. Поиск фильтрует по `alt` (case-insensitive, RU).
2. **Данные каталога.** `GET /sticker-packs?chat_id=` — единственный источник наборов и стикеров: `StickerPack {id,name,cover_url,stickers[]}`, `StickerRef {id,pack_id,alt,url,favorite}`. Показываются только active-наборы; `favorite` — персональный флаг текущего пользователя. Ответ сервера не кэшируется между чатами: при смене чата каталог перезапрашивается.
3. **Recent (локально).** Недавние хранятся только на устройстве: IndexedDB `krug-stickers`, namespace по `user.id`, максимум 24 записи, только `{id,pack_id,alt,url}` — без токенов. При недоступном IndexedDB (jsdom, private mode) используется память; ошибка storage никогда не блокирует picker. Recent разрешается против свежего каталога, поэтому стикер из отключённого/удалённого набора не остаётся доступным.
4. **Отправка.** Клик по стикеру: optimistic outbox-строка с `kind=STICKER`, затем `POST /chats/{chatId}/messages` `{client_message_id, type:"STICKER", sticker_id, reply_to_id?}` с `Idempotency-Key`. Текст и `attachment_ids` не отправляются. На `201` outbox заменяется серверным `Message` по `id`/`seq`; повтор идёт с теми же `client_message_id`/`Idempotency-Key`.
5. **Рендер.** Сообщение с `Message.type=STICKER`/`Message.sticker` рисуется как `<img>` 512×512 (intrinsic), `alt` обязателен, `loading="lazy"`, без `.bubble`. Вокруг сохраняются автор, время, read receipt, reply-кнопка и quote на исходное сообщение (для стикера quote показывает `Стикер: {alt}`); в истории после reload стикер рендерится тем же компонентом. `prefers-reduced-motion` не влияет на статичный PNG.
6. **Избранное.** `PUT /stickers/{id}/favorite` / `DELETE` — optimistic переключение звезды в пикере; при ошибке — rollback к предыдущему состоянию и `role="alert"` с понятным текстом, стикер остаётся доступным. Пока запрос в полёте, повторный клик по тому же стикеру блокируется. Избранное — server-side (кросс-девайс), в отличие от recent.
7. **Ошибки.** `404`/`410 STICKER_NOT_FOUND` → «Стикер недоступен», `409 STICKER_PACK_DISABLED` → «Набор стикеров отключён» + набор скрывается из пикера на эту сессию, `422 INVALID_STICKER_MESSAGE` → «Стикер не отправлен». Все три не предлагают blind retry; failed-строка показывает детали (`code`, `request_id`). История со старыми стикерами отключённого набора продолжает рендериться.
8. **Ассеты.** `frontend/public/stickers/{krug,cats}/01.png…08.png` + `cover.png`, ровно 18 PNG 512×512, ≤512 КиБ; SVG для стикеров не используется. `npm run stickers:check` проверяет наличие, PNG-magic, размеры, лимит и отсутствие не-PNG файлов в `public/stickers/**`.
9. **Контракт.** PM добавил `STICKER` в `Message.type` (`TEXT|STICKER|SYSTEM`); `MessageCreate.type=STICKER` и `Message.sticker` уже были в контракте. `schema.d.ts` перегенерирован; после расширения E6 контракт содержит 23 paths / 26 operations / 35 schemas, и `contract:check` фиксирует это покрытие. Frontend контракт не менял.
10. **Backend/моки.** MSW реализует seeded-наборы, favorites (идемпотентные 204), `STICKER`-отправку с валидацией (`404/409/410/422`), историю со стикером и `favorite`-проекцию. Real E5-B проверен на 8081: picker → favorite → send → reload → assets — passed; см. `e2e/stickers.real.spec.ts` и «Известный долг E5-F».

### Уведомления (E6-F)

1. **Bootstrap и refresh.** `GET /notifications?limit=30` вызывается при старте сессии (dev и password), после успешного `GET /sync` и после каждого live `message.created`; все триггеры схлопываются общим promise, поэтому панель не создаёт лишних запросов. Отдельного notification-WS-события в E6 нет (E6-D-04): периодичность обеспечивает существующий `syncIntervalMs` (30 с) и `visibilitychange`. Badge берётся из серверного `unread_count`, обновляется `aria-live`-регионом.
2. **Панель.** Колокольчик в sidebar (`aria-expanded`/`aria-controls`) открывает non-modal `role="region"`: title, `chat_name`, время, read/unread, тип уведомления. Состояния: loading (первая страница), empty, error + retry, список, «Показать ещё» по opaque `next_cursor`. Escape и клик вне закрывают панель, фокус возвращается на колокольчик; панель получает фокус при открытии.
3. **Read one/all.** Клик по уведомлению делает optimistic `read=true` и `unread_count-1`, затем `POST /notifications/read {ids:[id], all:false}` и переход в чат через `store.setActiveChat` (если `chat_id` есть среди доступных чатов). «Прочитать все» — `{all:true}`, optimistic обнуление badge. Обе операции шлют `Idempotency-Key`; при ошибке состояние и счётчик откатываются, в панели появляется `role="alert"` с retry. Поздний ответ single-read не воскрешает badge после успешного read-all.
4. **Preferences.** `GET /notification-preferences` загружается при bootstrap и force-refresh при открытии диалога. `PATCH /notification-preferences` upsert-ит строку по `(chat_id, type, channel)`; форма даёт scope «Все чаты» или конкретный чат, тип `MESSAGE/MENTION/SYSTEM`, канал `IN_APP/EMAIL` и режим `ALL/MENTIONS/MUTE`. 422 показывает «Проверьте значения», 403/404 — «Недостаточно прав», 5xx/network — понятный текст с retry; во время сохранения кнопка disabled. `EMAIL` — только настройка режима, отправка писем в E6 не реализуется (log-заглушка backend).
5. **E2EE и приватность.** Уведомление не содержит plaintext E2EE-сообщения: при `body=null` UI никогда не подставляет текст из чата, показывает generic `title`, `chat_name` и явное пояснение «Текст скрыт: уведомление не содержит контента сообщения». `body` необязателен по контракту; frontend не запрашивает сообщение по `chat_id`, не логирует тело и не отправляет его в аналитику.
6. **Пагинация.** Cursor — непрозрачная base64url-строка сервера; frontend передаёт её обратно без декодирования и не строит собственных курсоров. `has_more`/`next_cursor` — единственный сигнал «Показать ещё»; дубликаты при догрузке отбрасываются по `id`.
7. **Backend E6-B.** В рабочей копии модуль `notification` ещё отсутствует, поэтому срез проверен на MSW-адаптере по контракту: seeded-уведомления (включая `body=null`), unread/read, cursor-пагинация, RLS-фильтр по `user_id`, prefs upsert и 422/403. Real smoke — после подтверждения E6-B на 8081; frontend-контракт и MSW уже готовы.

**Env E6-F.** Новых переменных нет: размер страницы — контрактный default 30, периодичность обновления наследуется от `syncIntervalMs`; `VITE_USE_MOCKS`/`VITE_API_BASE_URL`/`VITE_AUTH_MODE` управляют адаптером так же, как в предыдущих срезах.

## Покрытые состояния

| Состояние           | Где видно                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| auth loading        | сплэш «Проверяем сессию…»                                                                                                  |
| anonymous           | `/login` — email/пароль, show/hide, ссылка «Регистрация»; `/register`; `/verify`                                           |
| verify pending      | `/verify` — 6 цифр, остаток попыток, TTL и resend 60 с; истёкший код — ошибка и возврат ко входу                           |
| no workspace        | onboarding-форма «Создайте пространство»                                                                                   |
| 401 after refresh   | `/login` с очищенными токенами; при ошибке bootstrap — «Сессия истекла» + «Войти»                                          |
| 403 workspace       | «Нет доступа к пространству» + retry/выход                                                                                 |
| device limit        | `409 DEVICE_LIMIT_REACHED` → «Достигнут лимит устройств»                                                                   |
| loading             | скелетон сообщений, скелетон списка чатов                                                                                  |
| empty               | «Пока нет сообщений — напишите первым»                                                                                     |
| error               | панель с «Повторить» + `request_id` в деталях                                                                              |
| offline             | баннер + composer не отправляет, но текст сохраняется                                                                      |
| forbidden (403/404) | «Нет доступа к чату», composer скрыт                                                                                       |
| rate-limit (429)    | баннер с обратным отсчётом, send заблокирован                                                                              |
| realtime online     | зелёный индикатор «Онлайн» в шапке                                                                                         |
| realtime reconnect  | «Переподключение…» + warning-баннер; REST-отправка остаётся доступной                                                      |
| realtime offline    | «Нет live-обновлений»; история/отправка через REST                                                                         |
| WS 401/403          | banner «Сессия live-обновлений истекла» / «Нет доступа к live-обновлениям»; чат не скрывается                              |
| WS revoked          | `session.revoked`/4403 → экран «Сессия истекла»                                                                            |
| typing/presence     | «печатает…» с TTL, число online; ephemeral, без истории                                                                    |
| conflict (409)      | отдельные тексты для `IDEMPOTENCY_KEY_REUSED`, `CLIENT_MESSAGE_ID_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`                     |
| validation (422)    | «Слишком длинное сообщение» / общая валидация + возврат текста                                                             |
| files picker        | скрепка + drag&drop; лимит по числу/размеру, guest cap; 100 % квоты блокирует выбор                                        |
| preflight deny      | per-file `413/409/415/422` с причиной и лимитом; загрузка не начинается                                                    |
| upload progress     | `role=progressbar`, «Часть n из m», pause/resume/cancel; retry с тем же upload_id/part_no                                  |
| upload error        | `CHUNK_CONFLICT`/`CHUNK_HASH_MISMATCH`/`429`/`410` — понятный текст и retry/restart                                        |
| scan                | «Проверяем безопасность…» → «Готов к отправке» или «Заблокирован проверкой»                                                |
| attachments         | карточки имя/размер/тип/scan status; image lightbox, inline video/audio, SVG/HTML не media, scan/quarantine                |
| limits              | usage bar, 80/95/100 % предупреждения, `guest_file_bytes`, retry загрузки лимитов                                          |
| stickers picker     | кнопка-стикер, табы наборов/«Избранное»/«Недавние», поиск по alt, keyboard, Esc/click-outside, aria                        |
| stickers loading    | «Загружаем стикеры…»; ошибка каталога → alert + «Повторить»                                                                |
| stickers empty      | пустые «Избранное», «Недавние», набор; «Ничего не найдено» при поиске                                                      |
| sticker send        | optimistic `<img>` без пузыря → серверный STICKER; reply сохраняется                                                       |
| sticker errors      | 404/410 «Стикер недоступен», 409 «Набор стикеров отключён» + pack скрыт, 422 «Стикер не отправлен»                         |
| favorite            | optimistic PUT/DELETE; ошибка → rollback + alert; pending-стикер блокирует повторный клик                                  |
| notifications bell  | badge из `unread_count`, `aria-live`, keyboard/Escape, возврат фокуса                                                      |
| notifications panel | loading / empty / error+retry / список; title, chat_name, time, read/unread, «Показать ещё»                                |
| notification E2EE   | `body=null` → generic title + «Текст скрыт»; текст сообщения не запрашивается и не рендерится                              |
| read one/all        | optimistic read + unread→0/−1, `Idempotency-Key`, переход в чат; ошибка → rollback + alert                                 |
| prefs               | per-chat/type/channel/mode, GET/PATCH, 422/403/5xx понятным текстом, сохранение с disabled-кнопкой                         |
| members list        | «Участники» из sidebar; display_name/role/joined_at, поиск, refresh, cursor-пагинация; email в списке нет                  |
| members manage      | OWNER/ADMIN: add по email + role, смена роли, удаление с confirm; MEMBER/GUEST — read-only без destructive-контролов       |
| members conflicts   | 403, 404 USER_NOT_FOUND/MEMBER_NOT_FOUND, 409 MEMBER_ALREADY_EXISTS/limit/last owner/self, 422; строка и форма сохраняются |
| retry (5xx/network) | failed-пузырь с «Повторить», повтор идемпотентен                                                                           |

## Безопасность, доступность, i18n

- Нет `dangerouslySetInnerHTML`; текст — текстовые узлы. Контрольный тест рендерит строку с `<b>`/`<script>` и проверяет, что DOM-узлов не появилось.
- Файлы: имена/размеры/MIME рендерятся текстом; SVG/HTML **никогда** не становятся `<img>/<video>/<audio>`; preview — только raster allowlist (`PNG/JPEG/WebP/GIF/AVIF/BMP`), видео/аудио — только codec-allowlist (`MP4/WebM/OGG`, `MP3/OGG/WAV`); внешние presigned-ссылки открываются с `target=_blank` + `rel="noopener noreferrer"`; байты файлов и `Content-SHA256` не логируются.
- **Токены не в `localStorage`.** Access/refresh token Auth BFF и `device_id` хранятся в namespaced `sessionStorage` (только `src/auth/storage.ts`), access token также дублируется в module memory. Пароль и 6-значный код никогда не сохраняются и не логируются. `npm run security:check` запрещает `localStorage` и разрешает `sessionStorage` только в storage-модуле. Токены не попадают в React-context (компоненты видят только `sub/name/email`).
- **Известное ограничение AUTH-D-06:** `sessionStorage` уязвим к XSS и читается любым скриптом того же origin. Auth BFF убрал пароль из браузера и Keycloak-редирект, но не заменил cookie-сессию; HttpOnly refresh cookie — задокументированный follow-up (вне scope).
- `Idempotency-Key` для каждого POST; `X-Request-Id` на каждый запрос; `request_id` из тела/заголовка ошибки показывается в деталях.
- CSRF не применим к Bearer-запросам; `credentials: 'omit'`, `cache: 'no-store'`.
- Семантика: `<main>`, `<h1>` на каждом auth-экране, `role="log"` c `aria-live`, `role="alert"` у ошибок, видимый focus, skip-link, подписи кнопок, `aria-current` у активного чата.
- `prefers-reduced-motion` отключает анимации/скролл; есть dark/light через `prefers-color-scheme`; контрастные токены проверяются axe-core в Playwright (WCAG 2.1 AA) на login, onboarding и основном экране.
- Уведомления не содержат plaintext: `body=null` рендерится как generic title + «Текст скрыт», сообщение по `chat_id` не запрашивается; тело уведомления не логируется. Колокольчик и панель — кнопка с `aria-expanded`/`aria-controls`, `aria-live` для badge, Escape/клик вне, возврат фокуса; диалог настроек — `role="dialog"`, `aria-modal`, focus trap и возврат фокуса.
- Все строки — через `src/i18n/ru.ts` (типизированный словарь, подстановки); хардкода в компонентах нет.
- E9-F admin: `tablist` с roving tabindex и стрелками/Home/End, `aria-selected`/`aria-controls`, единственный `role=tabpanel`; admin-строки — списки `<li>` с `<dl>`-ячейками (метка всегда доступна скринридеру), `role=progressbar` с `aria-valuenow`/`aria-label` для лимита хранилища, `role=status` для счётчика/скелетона и `role=alert` для ошибок. Таблицы-«колонки» на ≥1120 px, карточки с видимыми метками ниже — без горизонтального скролла на 390 px. Диалоги (включая `SafetyNumberDialog`) удерживают Tab внутри и возвращают фокус.

## Тесты

`npm test` — 730 тестов, 71 файл:

- `src/components/auth/authFlow.test.tsx` (18) — guard `/login`, generic-ошибка неверного пароля, register → verify → чат, клиентская валидация без сети, unverified login → `/verify`, `CODE_INVALID` с attempts, `CODE_EXPIRED`, 429 после 5 попыток, resend после countdown, bootstrap из сохранённой сессии через `/me`, 401 → refresh + один replay, refresh failure → `/login` без токенов, logout с отзывом refresh, `X-Device-Id`, onboarding, 403 workspace, переключатель workspace, полный lifecycle register → verify → logout → login → refresh → logout; отсутствие запросов к `:8180`/`/realms`.
- `src/api/authApi.test.ts` (8) — contract-body register без Authorization, `AuthSession`, `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED` (+verification_id), `CODE_INVALID`/`CODE_EXPIRED`/`RATE_LIMITED`, `EMAIL_TAKEN`, refresh rotation + logout revoke, `AUTH_UNAVAILABLE`/`VALIDATION_FAILED`.
- `src/auth/storage.test.ts` (6), `src/auth/runtime.test.ts` (4), `src/config/env.test.ts` (6) — sessionStorage-only auth session/pending verification, malformed state, dev/password runtime, env-режимы без OIDC.
- `src/components/ChatScreen.test.tsx` (14) — история/порядок по `seq`, группировка, экранирование HTML, optimistic send, retry 500, 409/422, пагинация, scroll anchoring, empty/forbidden/429, read receipt, reconnect, 401 replay.
- `src/api/client.test.ts` (4) — заголовки, конверт ошибки, dev 401 replay, `Retry-After`.
- `src/domain/messages.test.ts` (8) — сортировка/дедуп, даты, scroll anchoring, preview/initials.
- `src/domain/errors.test.ts` (9) — 401/403/404/409/422/429/5xx/network, `DEVICE_LIMIT_REACHED`, files 413/409/423/CHUNK_HASH_MISMATCH.
- `src/realtime/protocol.test.ts` (7) — парсер `hello`/`subscribed`/`event`/`gap`/`pong`/`error`/`revoked`, оба варианта `typing`/`presence`, client frames, close-code policy.
- `src/realtime/backoff.test.ts` (5) — 1/2/4/8/16/30 с, jitter ±20 %, бюджет 60/час и скользящее окно.
- `src/realtime/socket.test.ts` (6) — `ws_url` → Vite proxy, `VITE_WS_URL`, wss-upgrade, ticket query без access token.
- `src/realtime/RealtimeClient.test.ts` (12) — handshake/subscribe/heartbeat, gap/typing/presence, reconnect/резюм через `/sync`, 4401/1008/1013/4403, budget, ticket 401/403/network.
- `src/store/realtimeStore.test.ts` (11) — live merge/dedupe event_id+seq, optimistic reconciliation, receipt, typing TTL, presence, `resume.gap` REST, reconnect без дублей, revoked, 403 ticket при рабочем REST.
- `src/components/RealtimeChat.test.tsx` (5) — live-сообщение без reload, live STICKER без пузыря, «Прочитано», typing TTL и aria-live, reconnect-баннер без блокировки composer, 401/403 ticket banners.
- `src/mocks/realtime.test.ts` (3) — mock WS: replay по `seq`, live fan-out, `resume.gap` при окне >500, одноразовый ticket/4401.
- `src/files/hash.test.ts` (6) — SHA-256 векторы, incremental/streaming, Blob/File fallback, progress.
- `src/files/format.test.ts` (6) — байты/проценты, MIME, raster allowlist (SVG/HTML не preview), media-codec allowlist, PDF/video.
- `src/files/limits.test.ts` (4) — used+reserved, 80/95/100 %, guest cap, zero limit.
- `src/store/filesStore.test.ts` (14) — preflight allow/deny/409/422/404, upload parts+progress, complete/scan, quarantine 423, resume с `GET /uploads/{id}` и теми же `upload_id/part_no`, pause/resume, cancel+abort, TTL presigned URL, attachment-only send, `ATTACHMENT_NOT_READY`, cross-chat 403.
- `src/components/FilesChat.test.tsx` (11) — picker+upload+send+card+download, per-file 413, `TOO_MANY_FILES`, pause/resume UI, retry, quarantine, text restore на 409, 423 download, limits 80/95/100, drag&drop, image preview/SVG.
- `src/components/MediaPreview.test.tsx` (6) — image lightbox (dialog/aria-modal/Esc/backdrop/focus trap/focus return/download), video controls без autoplay/poster, audio controls + имя/размер, SVG/HTML без media, PENDING/INFECTED без URL/плеера/скачивания, retry после 409 и ошибки presigned URL.
- `src/stickers/recent.test.ts` (3) — dedupe/newest-first, cap 24, нормализация, memory-fallback roundtrip.
- `src/stickers/store.test.ts` (6) — load/hydrate recent, optimistic favorite + rollback, disabled pack, recent order, rehydrate после reset.
- `src/components/StickersChat.test.tsx` (13) — history-стикер без пузыря 512×512, picker/search/optimistic STICKER + recent, favorite PUT/DELETE + rollback, 409 disabled pack, 404/410/422, keyboard/Esc/click-outside, catalog error+retry, 403/404 чужого чата, reply-совместимость.
- `src/components/Notifications.test.tsx` (14) — badge/panel/E2EE-safe rows, read all + server persistence, read-all и single-read rollback, переход в чат, loading/empty/error+retry, refresh после `/sync` и live `message.created`, Escape/фокус/aria-live, cursor-пагинация, prefs save/422 и per-chat scope.

Моки MSW — «контрактные»: формы ответов совпадают со схемами `contracts/openapi.yaml`; ошибки используют `{code,message,details,request_id}`; `Retry-After` — заголовком. `npm run contract:check` регенерирует типы в памяти и падает при расхождении с `src/api/schema.d.ts`, а также проверяет используемые endpoint'ы (55 operations: dev/session, `/auth/register|verify-email|resend-email-code|login|refresh|logout`, `/me`, `/devices`, `/workspaces`, workspace members (add/role/remove), chats/messages/read/sync, `/realtime/ticket`, `limits`, `uploads/*`, `attachments/*`, `/sticker-packs`, favorites, `/notifications`, `/notifications/read`, `/notification-preferences`, `/admin/users|chats|storage`) и обязательные поля 74 схем, включая files-инварианты (`maxItems=10`, 8 МиБ part_size, Content-SHA256, 202 complete, 423 download), E5-инварианты (`Message.type` со `STICKER`, `MessageCreate.type`, `StickerRef.favorite`, 204 favorites, `chat_id` в `/sticker-packs`) E6-инварианты (`Notification.body` nullable, `unread_count>=0`, `MUTE/MENTIONS/ALL`, `IN_APP/EMAIL`, `NotificationPreferencePatch.mode`, limit default 30 / max 100, Idempotency-Key + X-Device-Id на мутациях) и E12-инварианты (`WorkspaceMember`/`AddWorkspaceMemberRequest`/`ChangeWorkspaceMemberRoleRequest`).

### Playwright

```bash
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install firefox webkit  # E7-F7A matrix
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e        # dev F-01 + files + stickers + notifications + WS
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:auth   # Auth BFF mock (password)
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:ws    # real E3 WS (gated)
E4_FILE_REAL=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:files:real  # real E4 files (backend 8081 + S3 9002)
E6_NOTIFY_REAL=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:notifications:real  # real E6 notifications (seeded)
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:real        # I-01 + E5 real stickers
E5_DISABLED_PACK=1 PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright test --config playwright.real.config.ts e2e/stickers.real.spec.ts  # + disabled pack (docker/psql)
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:e2ee  # E7-F7A: Chromium/Firefox/WebKit WebCrypto + KAT
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:e2ee:real  # E7-F7B: real two-device E2EE (docker overlay)
```

- `e2e/chat.spec.ts` (dev): загрузка → send → 500 retry; axe в light/dark.
- `e2e/auth.spec.ts` (Auth BFF mock): guard → `/login` → register → verify (код `123456`) → чат → logout; invalid credentials; unverified login → `/verify` → wrong code (attempts) → correct code; onboarding без workspace. axe WCAG AA на login/register/verify/onboarding/чате.
- `e2e/files.spec.ts` (mock): picker → upload → send → карточка вложения → download-url TTL 5 мин; preflight 413 до загрузки; axe WCAG AA на composer/tray. **2 passed** на mock-контуре.
- `e2e/media.spec.ts` (mock): picker → upload PNG → send → превью → lightbox (`role=dialog`, Esc, focus return) → backdrop; axe WCAG AA в light/dark. **1 passed** на mock-контуре.
- `e2e/stickers.spec.ts` (mock): history-стикер после reload, picker → поиск → favorite → send STICKER без пузыря → reload; disabled pack 409 скрывает набор и блокирует отправку; axe WCAG AA на picker/чате. **2 passed** на mock-контуре.
- `e2e/stickers.real.spec.ts` (real E5-B): picker → favorite PUT/DELETE → send STICKER (`type=STICKER`, `sticker_id`, пустые text/attachments) → история после reload → PNG 512×512 по `/stickers/**`; **1 passed**. Gated disabled pack — **1 passed** с `E5_DISABLED_PACK=1` (см. долг E5-F).
- `e2e/notifications.spec.ts` (mock): bell badge → панель с E2EE-safe строками → «Прочитать все» → настройки prefs (MUTE) → axe WCAG AA; ошибка read-all → rollback badge → retry; axe в dark theme. **3 passed** на mock-контуре.
- `e2e/ws.spec.ts` (mock): live `message.created` без reload, close 1013 → reconnect без дублей, ephemeral typing TTL, axe WCAG AA. **2 passed** на mock-контуре.
- `e2e/ws.real.spec.ts` — real E3 WS; запускается только при `E3_WS_REAL=1`, требует ticket/`/ws` на 8081. Сейчас **skip**: backend E3 в рабочей копии отсутствует (`ru.krug.backend.realtime` ещё не реализован).

Если браузеры недоступны для скачивания, smoke не считается пройденным (см. отчёт сессии).

### E2EE browser matrix (E7-F7A)

`e2e/e2ee-browser.spec.ts` + `playwright.e2ee.config.ts` проверяют production-примитивы
E2EE в реальных движках: feature detection, нормативные KAT A/B/C/D/F/G из
`docs/E2EE-TEST-VECTORS.json` (векторы не копируются: браузер получает JSON из
`docs/`, SHA-256 сверяется с коммитом) и негативный tamper конверта/AD/подписи.
Нужен только Vite: backend, Keycloak и E2EE-флаг не используются. Gate —
`E2EE_BROWSER_MATRIX=1` (его выставляет `npm run test:e2e:e2ee`).

| Движок (Playwright 1.65.1)     | WebCrypto        | KAT A/B/C/D/F/G            | Tamper | Итог                 |
| ------------------------------ | ---------------- | -------------------------- | ------ | -------------------- |
| Chromium 159.0.8154.6          | все 8 примитивов | 22/22, 128 checks          | 10/10  | PASS                 |
| Firefox 159.0                  | все 8 примитивов | 22/22, 128 checks          | 10/10  | PASS                 |
| WebKit 27.2 (Playwright build) | Ed25519 KAT fail | 20/22, 121 checks (A2, B3) | 10/10  | EXPECTED UNSUPPORTED |

**Browser floor.** Источник истины — runtime feature detection, не User-Agent.
Исторические версии с WebCrypto Ed25519: Firefox 129+, Safari 17+, Chrome 137+;
X25519 проверяется отдельно. Байт-в-байт KAT зелёный на протестированных Chromium
159 и Firefox 159. Playwright WebKit 27.2 поддерживает Ed25519, но подписывает
недетерминированно (hedged nonce), а пустое сообщение подписывает/проверяет
некорректно. Поэтому `detectE2eeSupport()` с E7-F8 выполняет RFC 8032
known-answer probe (A2 seed/empty message/signature) и в WebKit возвращает
`available=false` / `missing:["ed25519"]`; приложение блокирует E2EE с
`E2EE_UNSUPPORTED_BROWSER` (см. `E7-F8-REPORT.md`). Матрица: Chromium/Firefox —
blocking pass, WebKit — явная expected-unsupported строка, не «красный job,
который игнорируют». Shipping Safari этой матрицей не сертифицирован;
JS/WASM-fallback отсутствует.

### Real two-device E2EE (E7-F7B)

`e2e/e2ee.real.spec.ts` + `playwright.e2ee-real.config.ts` — сквозной E2EE в двух
реальных браузерных контекстах (разные IndexedDB, разные `device_id`) против
собранного стека. Нужен **только тестовый overlay**, не production-флаг:

```bash
cd deploy
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build

cd ../frontend
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:e2ee:real
# gate: E2EE_REAL=1; без него оба проекта skipped
```

Overlay включает `KRUG_E2EE_ENABLED=true` и пересобирает SPA с
`VITE_E2EE_ENABLED=true`; base `.env`/`docker-compose.yml` остаются с `false`.
База — **`http://localhost:8088`**, не `127.0.0.1`: backend проверяет Origin
WebSocket по `PUBLIC_URL`, и `127.0.0.1` даёт 403 на `/ws`.

Что проверяется в Chromium и Firefox (WebKit исключён по ADR-26):

1. реальный login через BFF; bridge регистрирует keyed device и prekeys,
   `GET /devices` показывает `e2ee_capable=true`, SPK и OPK > 0;
2. fixture создаёт **новое** E2EE-пространство `E2EE F7B <timestamp>` и добавляет
   второго пользователя через E12 members API;
3. A создаёт/открывает DIRECT E2EE-чат; B открывает его после reload;
4. A → B и B → A: plaintext виден в UI, в `POST /messages` уходит только
   `envelopes` (без `text`), ответ сервера `text:null`;
5. reload обоих контекстов: оба сообщения восстановлены из sealed local copies
   (включая уже принятые входящие — см. F7B-отчёт);
6. P1-01: у B очищаются только ratchet-сессии; после reload история читается из
   sealed incoming copies, без error-bubble и без лишнего `SESSION_RESET`;
   новое сообщение без копии даёт `NO_SESSION` → B отправляет зашифрованный
   `SESSION_RESET` → A перешифровывает окно → B читает замену; затем новый текст
   идёт в новой сессии. Live-пропущенный control добирается sync/catch-up (P1-03);
7. safety number обеих сторон — одинаковый 60-значный код (TOFU-пиннинг), затем
   A фиксирует сверку через `PUT /chats/{id}/keys/verification` и видит
   «Сверено», а B (другое устройство-верификатор) — «Не сверено» (P1-02);
8. `message.messages` — `E2EE_PAIRWISE`, `body_ciphertext NULL`,
   `content_meta={}`; `message.message_envelopes` — opaque ciphertext,
   `PAIRWISE_X3DH_DR`, prekey на первом конверте; plaintext-маркеров нет ни в
   строках БД, ни в backend-логах, ни в WS-кадрах.

Test-only fixtures (документированы в spec): пользователи
`test@krug.local` / `Test1234!` и `pickle-ui-1794919305193@krug.local` /
`CorrectHorseBattery42!`; SQL `UPDATE auth.devices ... status='REVOKED'` перед
login, чтобы повторные прогоны не упирались в лимит 5 устройств; E2EE-пространство
создаётся через API при каждом прогоне (остаются в тестовой БД — это одноразовый
стенд). DB/log-проверки используют `docker exec`/`docker logs`; для удалённого
стека `E2EE_REAL_DB_CHECK=0` отключает их и SQL-фикстуру.

В песочнице DSH Firefox требует writable `TMPDIR` (иначе «Could not find profile
folder»): `TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home
MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1`. Это артефакт среды, не
требование проекта. Результаты и риски — `frontend/E7-F7B-REPORT.md`.

### Real-режим dev (F-01) и I-01

Для проверки против B-01 на `localhost:8081` (профиль `dev`):

```bash
# CORS у текущего B-01 выключен, поэтому dev-сервер проксирует /api на 8081
VITE_USE_MOCKS=false VITE_AUTH_MODE=dev VITE_DEV_SESSION=true VITE_API_BASE_URL=/api/v1 \
VITE_API_PROXY_TARGET=http://localhost:8081 npm run dev
```

Интеграционный Playwright-сценарий (`e2e/real.spec.ts`) проверяет dev/session → chats → history → send → повтор с тем же `Idempotency-Key`/`client_message_id` → read → sync, а также контрактные конверты 401, 403 и 404:

```bash
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npm run test:e2e:real
```

### Mock-сценарии для ручной проверки

В mock-режиме (`VITE_USE_MOCKS=true`) на `window` доступны debug-контролы. Они не входят в production API:

```js
// 500 на следующую отправку (retry-сценарий)
window.__krugMocks.failNextSend(1);

// Контрактные ошибки отправки
window.__krugMocks.forceSendError({
  status: 409,
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'reused',
});
window.__krugMocks.forceSendError({
  status: 422,
  code: 'MESSAGE_TOO_LONG',
  message: 'too long',
  details: { max_length: 8000 },
});
window.__krugMocks.forceSendError({
  status: 429,
  code: 'RATE_LIMITED',
  message: 'slow down',
  retryAfterSeconds: 2,
});
window.__krugMocks.forceSendError(null);

// Онбординг: очистить workspace'ы и чаты, затем перезагрузить страницу
window.__krugMocks.setWorkspaces([]);

// Имитация сообщения другого участника, затем online/offline или «Обновить»
window.__krugMocks.insertMessage('44444444-4444-4444-8444-444444444444', 'Новое сообщение');

// E4-F: лимиты, скан и ошибки files pipeline
window.__krugMocks.files.setLimits({ max_file_bytes: 1024 * 1024, max_attachments: 2 });
window.__krugMocks.files.setLimits({ usage: { used: 900, reserved: 0, limit: 1000 } });
window.__krugMocks.files.setScanPolls(3); // 3 GET /uploads/{id} до READY
window.__krugMocks.files.forceScanStatus('INFECTED'); // QUARANTINED
window.__krugMocks.files.failNextPart(1); // 500 на следующую часть (retry)
window.__krugMocks.files.forcePartError({
  status: 409,
  code: 'CHUNK_CONFLICT',
  message: 'conflict',
  partNo: 2,
});
window.__krugMocks.files.forcePartError(null);
window.__krugMocks.files.forceDownloadError({
  status: 423,
  code: 'ATTACHMENT_QUARANTINED',
  message: 'quarantine',
});
window.__krugMocks.files.forceDownloadError(null);

// E5-F: ошибки стикеров (pack id — из mock-каталога)
window.__krugMocks.forceSendError({
  status: 409,
  code: 'STICKER_PACK_DISABLED',
  message: 'disabled',
  details: { pack_id: 'a1111111-1111-4111-8111-111111111111', status: 'DISABLED' },
});
window.__krugMocks.forceSendError({
  status: 404,
  code: 'STICKER_NOT_FOUND',
  message: 'not found',
});
window.__krugMocks.forceSendError(null);

// E6-F: уведомления и настройки (mock-only)
window.__krugMocks.notifications.failNextRead(1); // 500 на следующий read, badge откатится
window.__krugMocks.notifications.failNextList(1); // 500 на GET /notifications
window.__krugMocks.notifications.failNextPrefs(1); // 500 на GET/PATCH preferences
window.__krugMocks.notifications.forcePrefsError({
  status: 422,
  code: 'VALIDATION_FAILED',
  message: 'bad preference',
});
window.__krugMocks.notifications.forcePrefsError(null);
window.__krugMocks.notifications.insert({
  title: 'Новое сообщение',
  type: 'MESSAGE',
  chat_id: '44444444-4444-4444-8444-444444444444',
  body: null,
});
window.__krugMocks.notifications.reset();
```

Сценарии 403/404/401 удобнее проверять через overrides в тестах (`server.use(...)`).

## Контрактные допущения и ограничения

1. **`Message` не содержит `client_message_id`, и конверт `message.created` в E3-B отличается.** Frontend принимает оба документированных/наблюдаемых варианта (`payload.message` и flat `payload`), чтобы live-доставка не зависела от конверта. Оптимистичная запись сопоставляется по контексту собственного запроса. Оптимистичная запись сопоставляется по контексту собственного запроса; дедупликация — по `id` и `seq`. Контракт не менялся.
2. **Сортировка `GET /messages` не зафиксирована в OpenAPI.** Принято поведение из `SYSTEM-ANALYSIS` §7.3: без параметров — последняя страница (`seq DESC`), клиент сортирует по `seq ASC`; `before_seq` — старше, `after_seq` — новее.
3. **Read receipts по WS.** `message.receipt` несёт `user_id`/`last_read_seq`; UI показывает «Прочитано» на своих сообщениях, когда другой участник дошёл до их `seq`. Receipt не replay-ится; базовое состояние — `/sync`.
4. **`GET /sync` не отдаёт имена чатов.** Неизвестные чаты из sync игнорируются до следующего `GET /chats`.
5. **`/me`, `/devices`, `/workspaces` используются строго по контракту.** `MeResponse.user.email` обязателен; `POST /workspaces` требует `name`+`security_mode` и `X-Device-Id`; `POST /devices` — `name`+`platform=WEB`+`app_version`+`Idempotency-Key`. Никаких дополнительных полей frontend не отправляет.
6. **`/dev/session` сохранён** для `VITE_AUTH_MODE=dev`. В password-профиле backend должен отдавать 404 — frontend его не вызывает.
7. **WS реализован на frontend (E3-F).** Backend E3 (`POST /realtime/ticket`, `/ws`, fan-out) в рабочей копии ещё отсутствует: mock-WS покрывает live/replay/gap/reconnect/typing, реальный smoke `e2e/ws.real.spec.ts` пропускается без `E3_WS_REAL=1` и готов к запуску после E3-B.
8. **`typing`/`presence` описаны в контракте двумя формами** (top-level `type` и `event`); парсер принимает обе, лишних полей не вводит. Presence не привязан к чату контрактом, поэтому показывается только число online.
9. **Keycloak не виден браузеру.** Auth BFF сам проксирует Keycloak Admin/token API; frontend не знает issuer/client/redirect URI и не содержит OIDC-конфигурации.
10. **Токены в sessionStorage, не в HttpOnly cookie.** Auth BFF убрал пароль/код из браузера и Keycloak-редирект, но cookie-сессия — вне scope; известный долг AUTH-D-06.
11. **Auth BFF-контракт аддитивный.** `AuthSession.user.id` — локальный JIT-id (совпадает с `/me`), `token_type=Bearer`, refresh/logout принимают токен в теле. `503 AUTH_UNAVAILABLE` и `422 VALIDATION_FAILED` обрабатываются как документированные расширения.
12. **`UploadSession` не содержит `missing_parts`.** Клиент вычисляет missing parts как `1..total_parts \ received_parts`; новых полей не отправляет/не ожидает.
13. **`UploadSession.status` содержит `QUARANTINED`** (enum обновлён PM; frontend-сессия контракт не меняла). Backend E4-B должен возвращать его при `INFECTED`; `AttachmentRef.scan_status=INFECTED` и 423 остаются обязательным вторым контуром.
14. **Abort после `READY`** контрактом не описан (204/410). Клиент best-effort вызывает abort при удалении готового вложения; если сервер отклонит, локальная карточка всё равно убирается, а квота может освободиться только GC — известный долг.
15. **Presigned URL TTL 5 минут** — клиент кэширует ссылку до `expires_at - 30 с`; после истечения запрашивает новую. CSP production должен включать origin MinIO через `VITE_MEDIA_ORIGINS`, иначе превью не загрузится (скачивание по ссылке всё равно откроется в новой вкладке).
16. **Стикеры — строго по контракту E5.** `MessageCreate.type=STICKER` + один `sticker_id`, пустые `text`/`attachment_ids`; `Message.type` содержит `STICKER`, `Message.sticker`/`sticker_id` — nullable. Ошибки: `404/410 STICKER_NOT_FOUND`, `409 STICKER_PACK_DISABLED` (с `details.pack_id`), `422 INVALID_STICKER_MESSAGE`; `GET /sticker-packs` фильтрует active-наборы и отдаёт персональный `favorite`. Frontend не придумывает поля: disabled pack скрывается локально только после серверного 409, история продолжает рендериться.
17. **Recent ≠ favorites.** Recent — только локально (IndexedDB/память), favorites — `PUT/DELETE /stickers/{id}/favorite` server-side. Recent не синхронизируется между устройствами и не отправляется на сервер; это осознанное решение E5-D-03.
18. **PNG-ассеты — demo.** Финальный арт и APNG-анимация вне E5; SVG для стикеров запрещён, поэтому все ассеты — статичные PNG 512×512.
19. **`Notification.body` — единственный сигнал приватности.** В схеме `Notification` нет `security_mode`, поэтому frontend не пытается угадать E2EE: `body=null` → generic `title` + пояснение «Текст скрыт», текст сообщения не запрашивается. Если backend вернёт `body` для managed-уведомления, он показывается как серверный preview; для E2EE backend обязан держать `null` (E6-D-02).
20. **Нет notification WS event (E6-D-04).** Обновление badge/list идёт через `GET /notifications` на bootstrap, после `GET /sync` и после live `message.created`; отдельного polling-таймера нет — периодичность наследуется от `syncIntervalMs`. Это осознанный scope E6.
21. **`NotificationPreferencePatch` в сгенерированных типах.** Контракт описывает его как `allOf[NotificationPreference, {required:[mode]}]`; `mode` уже обязателен в `NotificationPreference`, поэтому PATCH-тело структурно совпадает с базовой схемой. `openapi-typescript` рендерит allOf как `NotificationPreference & Record<string, never>` (непригодно), поэтому `src/api/types.ts` алиасит базовую схему; поля не добавляются, контракт не меняется.
22. **`chat_name` nullable.** Если сервер не вернул имя чата, панель показывает «Чат недоступен»; переход выполняется только когда `chat_id` есть в загруженных `slices`, иначе уведомление просто отмечается прочитанным. Отдельного route `/chats/{id}` frontend не изобретает — активный чат выбирается через store.
23. **Preferences — upsert без delete.** Контракт даёт только `GET` и `PATCH`; удалить строку нельзя, поэтому UI управляет поведением через `mode=MUTE`, а не выдумывает DELETE. Семантика «какие настройки действуют по умолчанию» определяется backend; UI показывает явные строки и пустое состояние.
24. **`ReadNotificationsRequest` и `all`.** В контракте `all` имеет `default:false`, поэтому сгенерированный тип делает его обязательным. Read-one отправляет `{ids:[id], all:false}` (эквивалентно отсутствию `all`), read-all — `{all:true}`. Backend должен трактовать `all:false` + `ids` как выборочную отметку; контракт не меняется.

## Что вне scope

Кастомные формы пароля/регистрации, 2FA UI, инвайты, управление ролями, BFF, E2EE UI/сессии/сеть (E7-F2+), **E2EE-файлы, AV UI, DLP, публичные ссылки, CDN, presigned upload, 10 ГиБ/desktop**, свои наборы/загрузка/модерация стикеров, E2EE pack keys, APNG, маркетплейс, поиск, плагины, редактирование/удаление, реакции/пины, offline-очередь сообщений, **push/Web Push, email-доставка, digest, mentions parser, quiet hours, notification WS event**, Redis/Kafka fan-out, мобильная нативная версия. Прототип `design/**` не импортируется; используются только визуальный язык и названия состояний.

## Известный долг E4-F

- Backend E4-B files pipeline в рабочей копии отсутствует; проверено только на MSW. Real smoke (MinIO 9002, backend 8081) — после готовности E4-B.
- Нет persistence upload-сессии между перезагрузками страницы: `upload_id` живёт в памяти; после reload можно начать заново, но не докачать старый upload. TTL 24 ч на сервере это допускает; File System Access — отдельная задача.
- Нет presigned upload частей (MVP: части через API), нет CDN, DLP/retention UI, E2EE-файлов.
- AV dev NoopScanner/моки; production ClamAV — отдельная задача.
- Abort готового (committed) вложения — best-effort, семантика квоты не зафиксирована контрактом.

## Известный долг E5-F

- **Real smoke E5-B выполнен** на `localhost:8081` (dev, seed 2×8): `e2e/stickers.real.spec.ts` — picker → favorite PUT → send `STICKER` → история после reload → favorite DELETE → PNG `/stickers/**`; **1 passed**. Gated disabled-pack сценарий (`E5_DISABLED_PACK=1`, временно `UPDATE sticker.sticker_packs`) — 409 `STICKER_PACK_DISABLED`, набор скрыт, старая история рендерится; **1 passed**, статус восстановлен в `finally`. Публичного admin-endpoint для disable в E5 нет — это тестовая предусловие через БД, не production-путь.
- **Recent не кросс-девайс и не переживает очистку IndexedDB.** Это решение E5-D-03: recent локальный; favorites — server-side. Ошибки IndexedDB деградируют в память без уведомления пользователя.
- **Нет кэша стикеров ≤50 МБ** из `SYSTEM-ANALYSIS` §12.8: PNG-ассеты идут с same-origin `/stickers/**`, кэшируются HTTP-кэшем браузера; отдельный quota-managed cache — v1.
- **Только built-in наборы.** Свои наборы, загрузка, модерация, `K_pack`/epoch и E2EE-стикеры — вне E5 (v1).
- **Demo PNG вместо финального арта;** APNG-анимация не проверяется (формат допускается контрактом, demo — PNG). `prefers-reduced-motion` к статичным PNG не применяется.
- **Disabled pack скрывается только на текущую сессию.** `GET /sticker-packs` не отдаёт `enabled/status` (контракт E5), поэтому после reload набор снова появится, если backend не исключил его из active; серверный 409 остаётся источником истины.
- **Нет клиентского лимита/валидации 512 КБ для загрузки стикеров** — загрузка своих стикеров вне scope; для встроенных ассетов размер проверяется `npm run stickers:check`.

## Известный долг E6-F

- **Backend E6-B отсутствует в рабочей копии.** `/notifications`, `/notifications/read`, `/notification-preferences` реализованы в MSW строго по контракту; real smoke (fan-out, RLS, unread, prefs, E2EE fixture) — после подтверждения E6-B на 8081. Adapter `ChatApi` уже готов, менять frontend-контракт не потребуется.
- **Нет notification WS event, push и email-доставки.** После `message.created`/`sync` выполняется REST-refresh; периодического отдельного polling нет. Web Push, digest и quiet hours — v1.
- **Email-канал только настраивается.** `channel=EMAIL` сохраняется через PATCH, но писем frontend не отправляет и статусов доставки не показывает: backend E6-B использует log-заглушку.
- **Нет удаления preference.** Контракт не содержит DELETE; снять правило можно только через `MUTE`. Значения по умолчанию и наследование «глобальный → чат» определяет backend, frontend их не симулирует.
- **Пагинация сбрасывается при refresh.** Любой bootstrap/sync/message-trigger заменяет первую страницу; ранее догруженные страницы исчезают до следующего «Показать ещё». Для 30-элементной панели это приемлемо, отдельный merge-кэш — v1.
- **Multi-tab.** Optimistic read синхронизируется между вкладками только через `syncIntervalMs`; BroadcastChannel/WS-события уведомлений нет.
- **Managed preview.** Если backend пришлёт `body` для managed-уведомления, панель покажет его как текст; для E2EE backend обязан вернуть `null`. Признака `security_mode` в `Notification` нет, поэтому UI не может проверить это independently.

## E7-F1 — крипто-ядро E2EE (без UI, сети и E2E)

Срез **E7-F1** добавляет только клиентское крипто-ядро 1:1 по `docs/E2EE-SPEC.md` §1–§4 и нормативным векторам `docs/E2EE-TEST-VECTORS.json` (v4, 45 векторов). UI, feature flag, сетевые вызовы, X3DH/DR-сессии и E2E — вне среза.

- `src/e2ee/crypto/*` — WebCrypto: feature detection (X25519, Ed25519, HKDF-SHA-256, AES-256-GCM, HMAC-SHA-256, SHA-256/512, CSPRNG), non-extractable `CryptoKey`, X25519 DH, Ed25519 sign/verify. Fallback на JS/WASM отсутствует (E2EE-ADR-02): при нехватке примитива — `E2EE_UNSUPPORTED_BROWSER`. Приватные ключи импортируются через PKCS#8-обёртку (WebCrypto не принимает raw private), временный буфер обнуляется, наружу остаётся только публичная половина.
- `src/e2ee/protocol/*` — header 42 B, AD 163 B, prekey preamble `313+L+M`, канонический envelope-кодек (canonical b64u, точные длины, запрет неизвестных полей, ciphertext 272..33040), inner payload framing (256-байтовый padding, TEXT_JSON 1..8000 code points, bidi/C0/C1-запреты), `kdf.ts` (KDF_RK/KDF_CK/AEAD-параметры) и `x3dh.ts` (stateless DH/HKDF-вывод SK/SID).
- `src/e2ee/verification/*` — fingerprint, safety number на пару устройств (60 цифр, 12 групп), QR `krug://verify/v1`, verification hash v2 (привязка `verifier_device_id`).
- `src/e2ee/storage/*` — абстракция хранилища: IndexedDB и in-memory адаптеры, structured clone, guard `non-extractable` для приватных `CryptoKey`; `localStorage`/`sessionStorage`/логи запрещены (`scripts/check-security.mjs`, правила для `src/e2ee/**`).
- `src/e2ee/api/*` — типы контракта `DeviceRegistration`/`PrekeyBundle`/`CryptoEnvelope` и декодеры b64u → bytes; **никаких** сетевых вызовов.

KAT читает `docs/E2EE-TEST-VECTORS.json` напрямую (не копия): `cd frontend && npm test`. Покрыты все **8 нормативных crypto-секций** — A (4), B (5), C (3), D (3), E (1), E2 (1), F (2), G (5), 24 вектора; F1/F2 сравниваются побайтово по JSON, E1/E2 — test-only reference walk. Плюс негативные тесты (tamper/AD/подписи/лимиты) и storage/support.

**Поддержка браузеров.** Только runtime feature detection, без User-Agent. Ed25519 в WebCrypto: Firefox 129+, Safari 17+, Chrome 137+; X25519 детектируется отдельно. Матрица движков E7-F7A — в разделе «E2EE browser matrix» выше: Chromium 159 и Firefox 159 проходят байт-в-байт KAT; Playwright WebKit 27.2 блокирован из-за недетерминированного Ed25519 (подробности — `E7-F7A-REPORT.md`).

**Ограничения среза:** нет X3DH/DR session state и хранилища сессий (это добавляет E7-F2 ниже), TOFU/пиннинга, отправки/приёма, key-change UI, safety-number UI, Playwright/E2E и включения E2EE. Сервер/контракт не менялись.

## E7-F2 — хранилище сессий, K_storage, outbox и multi-tab (без UI, сети и E2E)

Срез **E7-F2** добавляет локальную персистенцию E2EE по `docs/E2EE-SPEC.md` §2.3, §3.4.5–§3.4.6, §5. UI, feature flag, сетевые вызовы, X3DH/DR send/receive и E2E — вне среза.

- `src/e2ee/storage/types.ts`, `memory.ts`, `indexedDb.ts` — атомарные транзакции по нескольким сторам (`sessions` + `outbox` + `localMessages`): тело транзакции только читает/пишет IndexedDB, при ошибке не коммитится ничего. In-memory адаптер сериализует транзакции и коммитит подменой карт.
- `src/e2ee/storage/kStorage.ts` — `K_storage`: случайные 32 байта → non-extractable AES-256-GCM `CryptoKey` в IndexedDB, nonce 12 байт на запись, AAD `device_id(16) || session_id(16|0×16) || client_message_id(16|0×16) || record_type(u8) || version(u8)`. Гонка первого запуска двух табов сходится на одном ключе. `K_storage` **не** at-rest-шифрование (P1-11): passphrase/unlock в v1 нет, `STORAGE_LOCKED` не используется.
- `src/e2ee/session/*` — версионированные записи сессий (public routing metadata + `K_storage`-sealed `RK/CKs/CKr/MKSKIPPED` + non-extractable `DHs_priv`), индекс `(chat, peer_device)`, optimistic `revision` (stale tab → `SESSION_STATE_STALE`), TTL/лимиты skipped-ключей, удаление прежней `DHs_priv` при каждом сохранении, GC idle-сессий.
- `src/e2ee/session/prekeyStore.ts` — OPK consume-once в одной транзакции (провал AEAD/транзакции ключ не уничтожает), SPK retention `current + 2 previous`, окно 90 дней, TTL 30 дней для неиспользуемых записей, уничтожение всего prekey-материала при revoke/reset.
- `src/e2ee/outbox/*` — P0-4: `state + точные envelopes + Idempotency-Key + client_message_id + локальная копия` одной транзакцией **до** сети; crash/replay-матрица, повтор тех же bytes, идемпотентный `markSent`, «недоступно на этом устройстве» при потере копии, outbox worker без дублей под `krug-outbox`.
- `src/e2ee/locks/*` — `navigator.locks.request("krug-session:"+session_id)` / `"krug-outbox"`, таймаут только на acquisition; fallback — BroadcastChannel lease-мутикс с детерминированной элекцией и истечением lease; последний fallback — внутриреалмовый queue.

Проверки: `cd frontend && npm run check` (lint, format, contract, stickers, security, vitest, tsc, build). Security guard дополнительно запрещает `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon` в `src/e2ee/**`; `console.*`, `Math.random`, `localStorage`/`sessionStorage` по-прежнему запрещены.

## E7-F3 — регистрация устройства, prekeys, binding и TOFU (без UI, флага и E2E)

Срез **E7-F3** добавляет клиентскую часть регистрации устройства и prekey-жизненного цикла по `docs/E2EE-SPEC.md` §2, §3.1–§3.3.1, §5.3, §5.6, §6.2.1–§6.2.6, §7.5. UI, feature flag, X3DH/DR send/receive (F4) и E2E — вне среза; сетевой адаптер добавлен, но к store/UI не подключён.

- `src/e2ee/device/identity.ts` — генерация/загрузка/уничтожение IK_sig (Ed25519) и IK_dh (X25519), `identity_binding_signature`, fingerprint; обе приватные половины — non-extractable `CryptoKey`, при загрузке проверяется их соответствие публичным ключам. `clearDeviceE2eeAccountState` (logout) удаляет identity, `K_storage`, prekeys и pins.
- `src/e2ee/device/registration.ts` — all-or-none `POST /devices` body, SPK+OPK, `Idempotency-Key`, точный retry тех же bytes после сбоя, проверка ответа (`e2ee_capable`, те же ключи, `key_generation`), legacy-регистрация и обработка `409 IDENTITY_KEY_CONFLICT`/`410 DEVICE_REVOKED`/`422`.
- `src/e2ee/device/prekeys.ts` — SPK `current + 2`/90 дней, ротация раз в 30 дней, OPK low-water `<20 → 100`, cap 200, запрет переиспользования `key_id`, pending-upload с точным retry, валидация ответа; `sessionSpk.ts` собирает `activeSessionSpkIds` из `spkId` сессий (F2 retention).
- `src/e2ee/device/binding.ts` — независимая проверка SPK-подписи и `IK_sig→IK_dh`, пересчёт fingerprint, валидация claim/`GET /chats/{id}/keys` и P0-2b-равенство `prekey.sender_identity_*` ↔ bundle ↔ pin.
- `src/e2ee/device/pins.ts`, `pinStore.ts`, `modePin.ts` — TOFU-пины `(user_id, device_id)`, key-change state без авто-принятия, fresh-device mode pin: MANAGED без E2EE-признаков требует явного подтверждения, при признаках E2EE — block/alert и только `E2EE_ONLY`/новый managed-чат. Пины **запечатаны** `K_storage`: `RECORD_TYPES.pin/keyChange/modePin`, AAD привязан к `(owner device, user, target device)`/чату; plaintext в IndexedDB нет. Пропавший/повреждённый `K_storage` — `KEY_STORAGE_UNAVAILABLE`, не «первый контакт».
- `src/api/e2eeDeviceApi.ts` — типизированные `POST /devices`, `POST /devices/{id}/prekeys`, `GET /devices`, `POST /keys/claim` (без `Idempotency-Key`), `GET /chats/{id}/keys`; `409/410/422` → `DeviceApiError.kind`/`retryable`, без тела запроса и ключей в сообщениях.

## E7-F2F — закрытие P1-01/02/06/07 CR1 (без UI, флага и E2E)

Срез **E7-F2F** закрывает оставшиеся условия CR1 в существующем F2-слое. UI, feature flag, сеть и E2E не добавлялись; `docs/**`, `backend/**`, `contracts/**`, `design/**`, `schema.d.ts`/`env.ts` не менялись.

- **P1-01:** `prepareOutgoingMessage`/`commitOutgoingMessage` требуют сдвинутое состояние сессии и сверяют `session_id`/`chat_id`/`local_message_id` с outbox и локальной копией. Без состояния — `SESSION_STATE_MISSING`, расхождение — `SESSION_STATE_STALE`; ни outbox, ни nonce-сдвиг не пишутся.
- **P1-02:** ключ локальной копии — `local:<chat_id>:<direction>:<sender_device_id>:<client_message_id|local_message_id>`. Входящий peer-controlled id не может выдать или перезаписать исходящую копию; `lookupLocalCopy` ищет только в namespace своего устройства/`outgoing`.
- **P1-06:** `tabId` — `crypto.randomUUID()`-совместимый v4 из `crypto.getRandomValues`; при коллизии `tabId` два таба получают `LOCK_TAB_ID_COLLISION` (fail-closed) вместо одновременного входа. Каждое взятие отдаёт `LockFence` (token + epoch + expiry); `drainOutbox` проверяет fence до и после `send`. Fallback явно помечен `isSecurityBoundary=false`, Web Locks — `true`.
- **P1-07:** 50-байтовая AAD-раскладка `K_storage` нормативна и зафиксирована в коде (`K_STORAGE_AAD_OFFSETS` + KAT-тест с фиксированными key/nonce/AAD/ciphertext). Nil UUID и нулевой session id отвергаются, поэтому `0×16` — однозначный sentinel; transplant ciphertext между локальными копиями отвергается.

## E7-F4 — X3DH + Double Ratchet session, TOFU, send/receive (без UI, сети и E2E)

Срез **E7-F4** добавляет production-движок 1:1-сессии по `docs/E2EE-SPEC.md` §3.3–§3.6, §4.1, §5.1–§5.7. UI/picker (F5/F6), сетевые вызовы, groups/files и feature flag — вне среза; `docs/**`, `backend/**`, `contracts/**`, `design/**`, `schema.d.ts`/`env.ts` не менялись.

- `src/e2ee/session/ratchet.ts` — Double Ratchet: `KDF_RK`/`KDF_CK`, DH ratchet (свежая `DHs` на каждый приём), `pn/n`, `skip_message_keys` с `MAX_SKIP`/retention, `MKSKIPPED` для out-of-order, `DUPLICATE_OR_OLD_MESSAGE`, `SESSION_TOO_FAR_BEHIND`, `CHAIN_EXHAUSTED`. Дешифровка идёт на копии состояния: ошибка AEAD/повтор не сдвигают цепочку.
- `src/e2ee/session/handshake.ts` — X3DH initiator: повторная проверка binding/SPK, свежие `EK` и `DHs_A` (P1-9), `IKM/SK/SID`, preamble + подпись, первая sending-цепочка. Responder: preamble signature, P0-2b (`prekey.sender_identity_*` ↔ bundle ↔ TOFU pin), binding, собственные IK/SPK/OPK, `chat_id`/devices/`session_id`, `SK`/`SID`; OPK **не** расходуется до успешного AEAD.
- `src/e2ee/session/send.ts` — fan-out на устройства получателя + другие свои устройства (self-envelope запрещён), ленивое создание сессий через claim bundle, TOFU/`assertDeviceNotBlocked`, `sessionState` обязателен, `prepare`/`commit` (без сети), coverage-precheck `PEER_UNCOVERED`, предупреждения `PEER_DEVICE_UNCOVERED`/`SELF_DEVICE_UNCOVERED`.
- `src/e2ee/session/receive.ts` — prekey vs normal envelope, проверка preamble/AD/header/`key_generation`, выбор/создание сессии, TOFU pin на первом контакте и `KEY_CHANGE_DETECTED` при подмене, атомарный commit state+OPK+local copy, `NO_SESSION`/`SPK_DELETED`/`DECRYPT_FAILED`.
- `src/e2ee/session/reset.ts` — `SESSION_RESET` (content_type=2) body v1 и rate-limit helper; отправка reset остаётся за F5.
- `src/e2ee/session/types.ts` + `sessionStore.ts` — `spkId`, `initiatedBy`, `lastReceivedAt` в состоянии; `record.revision === mode.ifRevision`, неизменяемость chat/peer/IK/`spkId` и монотонные `ns/nr/pn` (CR1b P1-01R).
- `src/e2ee/outbox/outboxStore.ts` — `additionalSessionStates`: все сдвинутые сессии fan-out коммитятся одной транзакцией с outbox и локальной копией; envelope scope (`chat/sender/session`), запрет дублей recipient/session, `header.n = ns - 1`, `header.dh`/`pn` = состоянию (CR1b P1-01R/P2-02).
- `src/e2ee/session/prekeyStore.ts` — SPK retention только `current + 2` / 90 дней; 30-дневный «unused» TTL удалён (claimed-but-undelivered prekey не виден локально), CR1b P1-03.

KAT: `sessionKAT.test.ts` воспроизводит B1/B2, C2/C3, E1 (m1/r1/m2/r2), E2 (0,2,1), F1 (все поля кроме недоступной в векторах подписи) и F2 через production-движок; байтовые F1/F2 остаются в `vectors.test.ts`.

## E9-F — full admin (users/chats/storage) + UI/UX pass

Срез **E9-F** реализует R-05/R-06 из `docs/SYSTEM-ANALYSIS.md` §18 и `docs/TASKS-ADMIN-V2.md` на
фронтенде. Зона — `frontend/**`; `backend/**`, `contracts/**`, `docs/**`, `design/**` и
`src/api/schema.d.ts` не менялись. E2EE-флаг (`VITE_E2EE_ENABLED=false`), managed-файлы,
медиа, стикеры и уведомления работают как раньше.

### `/admin`: разделы, данные, guard

- **Маршруты.** `/admin` — обзор; `/admin?tab=users|chats|storage|settings` — разделы.
  Вкладки — `role=tablist` с roving tabindex, стрелками/Home/End; Back/Forward работают,
  deep link открывает нужный раздел. `useLocation()` парсит `?tab=`, неизвестное значение
  падает в `overview`.
- **Типизированный клиент.** `ChatApi.listAdminUsers/listAdminChats/getAdminStorage` и
  `ListAdminUsersQuery`/`ListAdminChatsQuery`/`GetAdminStorageQuery` в `src/api/endpoints.ts`;
  типы — только из `schema.d.ts` (`AdminUser`, `AdminUserPage`, `AdminChat`, `AdminChatPage`,
  `AdminStorage`, `AdminStorageWorkspace`, `AdminStorageTotals`). Ни одного «изобретённого»
  поля или эндпоинта.
- **Users** (`AdminUsersSection`). Поиск по email/имени (debounce 300 мс, maxLength 254),
  cursor-пагинация через `next_cursor` («Показать ещё», append + дедупликация по `id`),
  колонки email/name/status/admin/workspaces/chats/storage/created, skeleton/empty/error+retry,
  счётчик показанных строк. Смена поиска начинает новую цепочку курсора и отбрасывает
  устаревший in-flight ответ.
- **Chats** (`AdminChatsSection`). Фильтры `workspace_id`, `type` (`DIRECT|GROUP`) и поиск по
  имени (maxLength 120), cursor-пагинация, колонки workspace/name/type/mode/members/messages/
  last activity, `members_count`/`messages_count` — только агрегаты из контракта. Список
  пространств для фильтра берётся из строк `/admin/storage` (в контракте нет отдельного
  admin-справочника пространств); уже загруженные чаты добавляются как fallback, если
  storage недоступен. Это осознанно и записано в интерфейсе (`admin.chats.filterHint`).
- **Storage** (`AdminStorageSection`). Итоги `used_bytes`/`reserved_bytes`/`objects`/
  `attachments` + строка на пространство, полоса лимита (`role=progressbar`,
  `aria-valuenow` = процент, `storage_limit_bytes=0` → «Без лимита»). Пагинации нет
  (эндпоинт отдаёт одну строку на неудалённый workspace — задокументированный trade-off
  E9-B); это явно написано на экране. Имена файлов/object keys/содержимое не запрашиваются
  и не рендерятся.
- **Settings** (`AdminSettingsSection`) — прежняя форма SMTP/лимитов/registration +
  тестовое письмо и аудит-подсказка; SMTP-пароль живёт только в состоянии формы.
- **Guard.** Клиентский `/me.is_platform_admin` — только UX; серверный `PlatformAdminGuard`
  — источник истины. Non-admin deep link → `AdminForbiddenScreen`, admin-разделы не
  монтируются и не делают запросов. 403 от любого `/admin/*` (settings/overview/save/
  test-email) уводит на тот же экран. В `OpsStore` добавлен `directory`
  (`src/ops/adminDirectory.ts`) с отдельной подпиской, сбросом на logout и защитой от гонок.
- **Audit/privacy.** UI показывает только метаданные и агрегаты; контент сообщений,
  E2EE-конверты, имена файлов и байты не запрашиваются. Каждое чтение по-прежнему пишет
  audit на сервере (`admin.users.viewed` и т.д.).

### Дизайн-система и UI/UX (R-06)

- **Токены** в `:root` (`src/styles/app.css`): цвет/поверхности (light + `prefers-color-scheme:
dark`), `--space-1..8`, `--radius-xs|sm|base|lg|xl|pill`, `--shadow-sm|md|lg`,
  `--text-xs..2xl`, `--leading*`, `--tap-size: 44px`. Новые admin-компоненты используют
  только токены (без случайных hex).
- **Визуальный язык Pickle:** огуречный зелёный + графит/cream, крупные радиусы
  (`--radius-lg/xl`), спокойные тени, слитный sticky-header админки с blur, «пилюльные»
  вкладки. Shell/sidebar/composer/auth получили: composer-поле с `--radius-lg` и focus-ring,
  кнопки/иконки/чат-элементы с touch-target ≥44 px, крупные радиусы auth-карточки.
- **Адаптивность 390/768/1440.** Admin: ≥1120 px — выровненные колонки с заголовком;
  <1120 px — карточки с видимыми метками (390 и 768 проверяются Playwright: ни один элемент
  не выходит за viewport, `documentElement.scrollWidth <= clientWidth`). Вкладки переносятся,
  а не скроллятся горизонтально. Toolbar складывается в одну колонку на ≤720 px.
- **A11y.** `:focus-visible` на всех контролах, `aria-current` у чата, `aria-selected`/
  `aria-controls` у вкладок, `role=status/alert`, видимые labels, `aria-valuenow` у лимита,
  `prefers-reduced-motion` (глобально), диалоги с focus trap/return. axe WCAG 2.0/2.1 AA
  (light + dark) прогоняется Playwright на overview/users/chats/storage/settings, 403-экране
  и в mobile-viewport.
- **E2EE/media/files не менялись:** контент по-прежнему рендерится текстовыми узлами,
  SVG/HTML не становятся media, presigned URL не логируются.

### Новые/обновлённые тесты E9-F

- `src/ops/adminDirectory.test.ts` (5) — первая страница + append с дедупликацией граничной
  строки, отбрасывание устаревшего ответа при смене поиска, параметры чат-фильтров и сброс
  курсора, storage snapshot + 403, `reset()`/поздний ответ.
- `src/components/admin/AdminDirectory.test.tsx` (11) — users: список/пагинация, debounce-поиск
  и сброс, skeleton, error+retry, required-колонки как `<dt>/<dd>`, отсутствие `<table>`;
  chats: workspace/type/search; storage: итоги/лимит/«Без лимита»/нет пагинации; keyboard-табы
  и deep link; non-admin deep link без запросов к directory; directory 403 → forbidden-экран;
  ошибка refresh не стирает уже показанные строки.
- `src/components/admin/Admin.test.tsx` (5, обновлён под вкладки) — setup → `/admin`, настройки
  за вкладкой, 403, SETUP_ALREADY_COMPLETED.
- `e2e/admin.spec.ts` (10) — setup → `/admin` → settings, non-admin setup/403, users
  (40 сид-строк: 25 → 40, поиск, axe), chats (фильтры, axe), storage (итоги/полоса/нет
  пагинации, axe), settings (axe + ArrowLeft), dark-theme axe, mobile 390 (карточки,
  touch-targets, нет горизонтального скролла, axe), tablet 768 (карточки, axe).

## E10-F — member directory + DIRECT chats

Срез **E10-F** реализует R-01 (`docs/SYSTEM-ANALYSIS.md` §17.1) и E10
(`docs/TASKS-ADMIN-V2.md`) на фронтенде: создание **DIRECT**-чата через
member picker рядом с существующим **GROUP**-созданием. Зона — `frontend/**`;
`backend/**`, `contracts/**`, `docs/**`, `design/**` и `src/api/schema.d.ts`
не менялись. E9 admin/media/auth и E2EE-флаг (`VITE_E2EE_ENABLED=false`) не
затронуты.

### Типизированный клиент

- `ChatApi.listWorkspaceMembers(workspaceId, {query, cursor, limit})` →
  `WorkspaceMemberPage`; типы `WorkspaceMember`, `WorkspaceMemberRole`,
  `WorkspaceMemberPage` — только из `schema.d.ts`.
- Query-параметры: `query` (literal-поиск по `display_name`, max 80),
  `cursor` (opaque `next_cursor`, не конструируется локально), `limit` = 50.
  `X-Device-Id` добавляет общий authed-helper, как для `/chats` и `/limits`.
- В ответе только `user_id`, `display_name`, `role`, `joined_at`; email,
  устройства и ключи не запрашиваются и не рендерятся.

### CreateChatDialog: GROUP / DIRECT

- **Тип чата** — accessible radio-группа (`fieldset`/`legend`, нативные
  стрелки, `:focus-within`), не кастомный div-переключатель. GROUP доступен
  `OWNER`/`ADMIN`; DIRECT — любому активному участнику, поэтому для `MEMBER`
  диалог открывается сразу на DIRECT, а GROUP-radio `disabled`. Кнопка «+» в
  sidebar больше не блокирует членов пространства — тип проверяет диалог.
- **GROUP** — прежнее поле имени 1..120, счётчик, локальная валидация.
  Payload строго `{type:'GROUP', name}`.
- **DIRECT** — member picker: поиск с debounce 300 мс, список
  `display_name` + роль, single-select, **self исключён** (сервер отдаёт
  вызывающего, UI его фильтрует), skeleton, empty (все/поиск), error + retry,
  «Показать ещё» по `next_cursor` с дедупликацией `user_id`. Payload строго
  `{type:'DIRECT', peer_id}`, без `name`.
- **Идемпотентность** — ключ создаётся при открытии диалога и переиспользуется
  только для того же логического payload (тип + имя/peer). Смена выбора или
  новое открытие — новый `Idempotency-Key`. После успеха список чатов
  обновляется с сервера, чат открывается, диалог закрывается; optimistic-чат
  не вставляется.
- **Ошибки** — `409 CHAT_LIMIT_REACHED` с `details.scope/limit/used` (USER и
  WORKSPACE), `400/422` peer/name-валидация, `403`; диалог остаётся открытым и
  показывает RU-сообщение.
- **A11y/390 px** — focus-trap, Escape и возврат фокуса на кнопку «+» после
  закрытия, `role=status` для счётчика и skeleton, `role=alert` для ошибок,
  `aria-describedby` только на существующие узлы, touch-target, список
  ограничен по высоте и не создаёт горизонтального скролла; CSS использует
  токены и `prefers-reduced-motion` из E9-F.
- **Имя DIRECT-чата** — `ChatSummary.name` nullable; заголовок/sidebar
  резолвят peer по загруженному каталогу (`chatDisplayName`) и не показывают
  название предыдущего group-чата.

### Тесты E10-F

`src/components/CreateChat.test.tsx` — 18 тестов (было 7): GROUP-регрессия и
idempotent replay; загрузка каталога, self-exclusion и отсутствие email;
literal-поиск; DIRECT-создание `peer_id` без `name`, refresh list/open chat;
fresh key на каждое открытие; 400 peer + retry; empty/error; cursor load more;
DIRECT для `MEMBER` с disabled GROUP; лимиты (sidebar и диалог), 409 USER и
WORKSPACE для GROUP и DIRECT, 422, локальная валидация; axe-аудит DIRECT
picker. E2E `e2e/chat-create.spec.ts` — 3 сценария: GROUP, 409 и DIRECT через
member picker на 390 px с axe и проверкой отсутствия горизонтального скролла.
На момент E10-F полный `npm run check` — **672** теста, `contract:check` —
**42 paths / 48 operations / 83 schemas** (member endpoint входит в проверяемые
операции). Актуальные счётчики — в разделе E11-F.

## E11-F — admin actions (suspend/activate, soft-delete chat) + Audit tab

Срез **E11-F** реализует R-08 / FR-ADM-15…18 (`docs/SYSTEM-ANALYSIS.md` §18.5,
`docs/TASKS-ADMIN-V2.md` E11) на фронтенде поверх контракта E11-B. Зона —
`frontend/**`; `backend/**`, `contracts/**`, `docs/**`, `design/**` и
`src/api/schema.d.ts` не менялись. E9 admin design/auth/media и E10 DIRECT-чаты
не затронуты.

### Типизированный клиент

`src/api/endpoints.ts` + `src/api/types.ts`:

- `suspendUser(userId)` → `POST /admin/users/{userId}/suspend` (`204`, без тела);
- `activateUser(userId)` → `POST /admin/users/{userId}/activate` (`204`);
- `deleteChat(chatId)` → `DELETE /admin/chats/{chatId}` (`204`, soft-delete);
- `listAdminAudit({action?, cursor?, limit?})` → `GET /admin/audit` →
  `AdminAuditPage`;
- типы `AdminAuditEvent`/`AdminAuditPage` — только из `schema.d.ts`.

`X-Device-Id` добавляет общий authed-helper (как для `/chats`, `/limits`,
`/notifications`); отдельного заголовка/поля не изобретено. `Idempotency-Key`
не отправляется: контракт его для этих операций не объявляет, а повтор
осознанно даёт `409`. Пустой `action` не передаётся (серверный default —
все действия), `cursor` всегда эхо `next_cursor`.

### Users: suspend / activate

- **Action menu.** В строке появилась колонка «Действия»: `ACTIVE` →
  «Приостановить», `SUSPENDED` → «Активировать», `DELETED` → неактивное
  «Нет действий» (эндпоинта восстановления в контракте нет).
- **UI guard (не замена серверу).** Кнопка `disabled` для собственной строки
  (`Нельзя менять свой статус`), для платформенного админа
  (`Платформенный админ защищён`) и для `DELETED`, с видимой причиной
  (`admin-cell__sub`). `SELF_ACTION_FORBIDDEN` / `LAST_PLATFORM_ADMIN` с
  сервера всё равно обрабатываются.
- **Confirm.** `AdminConfirmDialog`: email/имя цели, последствия
  (Keycloak disable + отзыв сессий; активация без отзыва), запись в audit,
  destructive-стиль для suspend. Focus-trap, initial focus на «Отмена»,
  Esc/backdrop, возврат фокуса на триггер, `aria-modal`/`aria-labelledby`/
  `aria-describedby`, `busy` блокирует двойной submit.
- **Состояние.** Оптимистичного переворота нет: строка меняет чип только после
  `204`, затем страница перечитывается (`GET /admin/users`) — сервер остаётся
  источником истины. Ошибка не удаляет строку и не меняет чип.
- **Ошибки.** `403` — диалог остаётся с текстом про права; `404` — диалог
  закрывается с предупреждением и refresh; `409`
  `USER_ALREADY_SUSPENDED`/`USER_ALREADY_ACTIVE` — состояние уже достигнуто:
  чип патчится, список перечитывается, показывается warning; `503
AUTH_UNAVAILABLE` — «изменения не применены», кнопка становится
  «Повторить»; `5xx`/network — retry; прочие `409` — сообщение о конфликте.

### Chats: soft-delete

- Колонка «Действия» → «Удалить» (danger-ghost). Confirm называет чат
  (имя + пространство), объясняет soft-delete (сообщения/вложения/E2EE не
  удаляются физически) и аудит; показывает полный id чата.
- После `204` строка удаляется из выдачи и цепочка курсора перечитывается.
- `409 CHAT_ALREADY_DELETED` трактуется как согласованное состояние
  (warning «Чат уже удалён — список обновлён», строка убирается, refresh).
  `404` — то же с предупреждением. `403/503/5xx` — диалог остаётся, строка
  не удаляется; на `503` доступен retry.

### Audit tab

- Новая вкладка `?tab=audit` в общем `role=tablist` (roving tabindex,
  стрелки/Home/End, deep link).
- Колонки: **время / действие / актор / цель**; на <1120 px — карточки с
  видимыми `<dt>`-метками. Для известных действий показывается RU-метка и
  исходный код; актор — `actor_email` + короткий `actor_id`, системные
  события — «Система»; цель — `target_type` + короткий `target_id`
  (полный id в `title`).
- **Никакого metadata.** Контракт `AdminAuditEvent` содержит только 7 полей;
  UI рендерит ровно их. `metadata`, hash-chain (`prev_hash`/`hash`),
  `request_id`, тела сообщений/файлы/секреты отсутствуют by construction;
  в подсказке это явно сказано.
- **Фильтр.** `<select>` с известными действиями (значения — реальные
  `action` из backend audit-writer'а: `admin.user.suspended`,
  `admin.chat.deleted`, `admin.audit.viewed`, `settings.updated` и т.д.),
  «Все действия» + «Сбросить». Точное совпадение; смена фильтра начинает
  новую цепочку и отбрасывает устаревший in-flight ответ. События с
  действием вне списка видны в таблице без фильтра (это ограничение UI,
  а не контракта).
- **Пагинация.** Cursor через `next_cursor` («Показать ещё», append +
  дедупликация `id`), отдельные `loadingMore`/`moreError`.
- **Состояния.** Skeleton, empty (пустой журнал vs нет совпадений по фильтру),
  error + retry, сохранение уже загруженных строк при ошибке refresh,
  403 → общий `AdminForbiddenScreen` (как остальные admin-разделы).

### Доступность и адаптивность

- `AdminConfirmDialog` и audit-таблица проходят axe (light + dark) в RTL и
  Playwright; destructive-кнопки используют soft-fill `--danger`, чтобы
  контраст оставался AA в обеих темах.
- 390/768 px: карточки, метки `dt` видимы, кнопки действий ≥44 px на coarse
  pointer, диалог не создаёт горизонтального скролла; 1440 px — выровненные
  колонки.
- `prefers-reduced-motion`, `:focus-visible`, `role=status/alert` — из
  общих токенов E9-F; новых hex-значений нет.

### Тесты E11-F

- `src/api/adminActions.test.ts` (5) — пути/методы/`X-Device-Id`, bodyless
  `204`, query audit (`action`/`cursor`/`limit`, пустой `action` опущен),
  `409 CHAT_ALREADY_DELETED` → типизированный `ApiError`.
- `src/ops/adminDirectory.test.ts` (+10, всего 15) — audit-цепочка/дедуп/
  устаревший ответ/403, suspend патчит чип и перечитывает страницу, `403`
  не меняет строку, `409 USER_ALREADY_SUSPENDED` реконсилится, activate,
  soft-delete + refresh, `CHAT_ALREADY_DELETED` vs `503`, `404` удаляет
  строку и перечитывает.
- `src/components/admin/AdminActions.test.tsx` (12) — suspend/activate через
  confirm с email, disabled self/platform-admin/deleted, Esc + focus
  trap/return, `409`/`403`/`503`/`404`, retry, axe с открытым диалогом,
  chat delete (успех, `409`, `503`).
- `src/components/admin/AdminAudit.test.tsx` (9) — 7 полей и отсутствие
  metadata/hash/request_id, фильтр и сброс, cursor-пагинация 25→30,
  skeleton, два empty-состояния, error+retry, сохранение строк при ошибке
  refresh, 403 → forbidden, axe.
- `e2e/admin.spec.ts` (+5 сценариев и +2 mobile) — suspend → activate с
  диалогом, Esc/фокус, axe, audit-событие после действия; soft-delete чата;
  audit 30 строк: пагинация 25→30, фильтр 15, отсутствие `metadata`/
  `request_id`; dark-theme axe; mobile 390: действия, подписи карточек, диалог,
  отсутствие клиппинга, axe.

## E12-F — workspace members management (R-09)

### Типизированный клиент

- `addWorkspaceMember(workspaceId, {email, role})` → `201 WorkspaceMember`;
- `changeWorkspaceMemberRole(workspaceId, userId, {role})` → `200 WorkspaceMember`;
- `removeWorkspaceMember(workspaceId, userId)` → `204`.
- Формы — только из `AddWorkspaceMemberRequest` / `ChangeWorkspaceMemberRoleRequest`; `WorkspaceMember` переиспользован без новых полей. `X-Device-Id` добавляет общий HTTP-клиент, `schema.d.ts` не менялся и синхронен контракту.

### UI и права

- Вход — кнопка «Участники» рядом с переключателем пространства в sidebar (доступна и при одном workspace). Диалог `role=dialog` с заголовком «Участники пространства».
- **OWNER/ADMIN**: список + форма добавления по email, select роли в каждой управляемой строке, «Удалить» с обязательным confirm.
- **MEMBER/GUEST**: тот же серверный список read-only; форма добавления, select'ы роли и кнопки удаления не рендерятся.
- `OWNER` не предлагается ни при добавлении, ни при смене роли: OWNER-актор видит `ADMIN/MEMBER/GUEST`, ADMIN-актор — только `MEMBER/GUEST`. Строки OWNER и себя — read-only; ADMIN не управляет другим ADMIN. Итоговое решение всё равно за сервером.
- Список показывает `display_name`, роль и `joined_at` (плюс аватар); email выводится только в форме добавления. Поиск — literal-запрос к серверу по имени (debounce 300 мс, ≤80 символов), кнопка refresh и cursor-пагинация через `has_more`/`next_cursor`.

### Ошибки и состояния

- `403` → «Недостаточно прав…»; `403 ROLE_CHANGE_FORBIDDEN` → «Недостаточно прав для этой роли»; `404 USER_NOT_FOUND` → «не найден или неактивен»; `404 MEMBER_NOT_FOUND` → «обновите список»; `409 MEMBER_ALREADY_EXISTS`; `409 WORKSPACE_MEMBER_LIMIT_REACHED` с серверными `details.used/limit`; `409 LAST_OWNER`/`SELF_ACTION_FORBIDDEN`; `400/422` — валидация email.
- **Нет optimistic-мутаций.** Add/remove после успеха перечитывают первую страницу с сервера; смена роли применяет `200`-ответ. Любая ошибка сохраняет строку, введённый email и открытый confirm (кроме явной отмены).
- Состояния: skeleton первой страницы, empty без поиска и «никого не нашли» с запросом, error + retry, ошибка refresh при уже загруженных строках, ошибка «Показать ещё», `role=status` для счётчика/успеха.
- `WorkspaceLimits` не содержит `max_workspace_members`, поэтому UI не изобретает счётчик: лимит показывается из `details.used/limit` ответа `409`, иначе — общий текст серверной ошибки.

### Доступность и адаптивность

- Focus trap по Tab, `Escape` закрывает диалог (при открытом confirm — только confirm), возврат фокуса на кнопку «Участники»/строку, блокировка scroll, labelled/described dialog, `role=alert` у ошибок.
- Confirm переиспользует `AdminConfirmDialog`: фокус на безопасной «Отмене», destructive-кнопка, ошибка остаётся в диалоге для retry.
- 390 px: toolbar и действия строки складываются вертикально, диалог `width: min(760px, 100%)` без горизонтального скролла; axe (RTL, light) — без serious/critical violations.

### Тесты E12-F

- `src/components/WorkspaceMembers.test.tsx` (12): OWNER add по email + отсутствие email в списке, duplicate, limit с `used/limit`, ограничения ADMIN, read-only MEMBER, серверный 403, успешная смена роли, `LAST_OWNER` + `SELF_ACTION_FORBIDDEN` без изменения строки, remove cancel/confirm/error, поиск/empty/refresh, Esc + focus trap/return, axe.
- MSW `POST/PATCH/DELETE /workspaces/{id}/members` повторяют серверные guard'ы и отдают те же коды; GET остаётся ACTIVE-only и без email.

Полный `npm run check` — **730** тестов (71 файл), `contract:check` —
**47 paths / 55 operations / 87 schemas**, `schema.d.ts` синхронен.

## D1-FE3 — threads UI (managed-only)

Плоское дерево глубины 1 по контракту D1-C1 (`docs/TASKS-DASHBOARD-V1.md` §3.2):
ответ — обычное сообщение с `thread_root_id`, без вложенных тредов. E2EE-флаг в этом
срезе `false`; треды доступны только в managed-чатах, в E2EE показывается честно
выключенный контрол без plaintext-превью.

### Типизированный клиент

- `listMessages(chatId, {threadRootId, beforeSeq?, afterSeq?, limit?})` добавляет query
  `thread_root_id`; без него сервер отдаёт только основную ленту.
- `sendMessage` принимает штатный `MessageCreate.thread_root_id`; новых полей и
  схем не изобреталось, `schema.d.ts` не менялся и синхронен контракту
  (`47 paths / 55 operations / 87 schemas`).
- `ThreadSummary` — алиас `NonNullable<ApiMessage['thread_summary']>`; все поля
  (`reply_count`, `last_reply_at`, `last_reply_author_id`, `last_reply_excerpt`)
  читаются из ответа сервера. Для E2EE summary всегда `null`.

### Store

- `AppState.threads` — кэш `ThreadSlice` по ключу `threadKey(chatId, rootId)`;
  `AppState.activeThread` — открытая панель. Переключение чата, workspace и logout
  закрывают/очищают треды.
- `openThread` загружает первую страницу ответов; корень остаётся в основной ленте,
  ответы живут только в thread slice. `loadMoreThread` листает назад по `before_seq`,
  `retryThread` повторяет первую страницу.
- `sendThreadReply` использует тот же optimistic outbox/`Idempotency-Key`/seq, что и
  обычная отправка: строка видна как «Отправляется…», серверный id/seq появляется
  только из `201`; ошибка сохраняет текст и предлагает retry/restore.
- WS `message.created` с `thread_root_id` маршрутизируется в открытый thread slice и
  инкрементирует кэш корня (`reply_count`, последний автор/время/excerpt ≤ 160 code
  points). Ответы никогда не попадают в `.messages`: фильтр есть на загрузке,
  catch-up, WS и в рендере. `last_seq` чата учитывает ответы (subscribe/ack), а
  счётчик summary защищён от replay-двойного инкремента.
- Состояния: loading/empty/ready/error, ошибка «показать ещё» без потери строк,
  retry, `THREAD_ROOT_DELETED`/`THREAD_ROOT_NOT_FOUND` → панель с объяснением и
  выключенным композером; удалённые ответы фильтруются.

### UI

- `ThreadLink` под корнем: счётчик с русским склонением, превью последнего ответа и
  время; кликабельная ссылка открывает панель. Для пустого треда действие «В тред»
  в hover-actions (на touch — всегда видимо).
- `ThreadPanel`: `role="dialog"`, `aria-labelledby`, focus trap по Tab, `Esc`,
  возврат фокуса на кнопку-триггер, `Назад` на мобильном sheet. Контент: корень,
  ответы (с quote-reply навигацией), «Более ранние ответы», пустое состояние,
  ошибка с retry, `OutgoingRow` с retry/restore.
- `ThreadComposer` — только текст (вложения/стикеры вне среза): label, Enter/Shift+
  Enter, счётчик длины, блокировки offline/rate-limit/недоступный тред.
- Desktop: правая колонка (`chat--thread-open`), `≤900px` — full-screen sheet,
  `390/768/1440` без горизонтального скролла; light/dark переменные, `focus-visible`.
- E2EE: `ThreadLink`/действие `disabled` с объяснением, `openThread` возвращает
  `false`, plaintext корня/ответов не рендерится.

### MSW и тесты

- `GET /chats/{id}/messages` валидирует `thread_root_id` (UUID, same-chat, depth 1,
  deleted, E2EE), фильтрует main/thread и считает `thread_summary`; `POST` повторяет
  те же 422-коды и пишет `thread_root_id` в сообщение/WS.
- `src/components/Threads.test.tsx` (11): открытие пустого треда, отправка и счётчик,
  пагинация `before_seq`, live WS и обновление счётчика, отсутствие двойного счёта
  REST+WS, Esc/close/focus trap/return, mobile `Назад`, ошибка загрузки + retry,
  ошибка «показать ещё» + retry, root deleted 422, E2EE disabled, axe.

Полный `npm run check` — **769** тестов (73 файла), `contract:check` —
**47 paths / 55 operations / 87 schemas**, `vite build` зелёный. Отчёт:
[`D1-FE3-REPORT.md`](D1-FE3-REPORT.md).

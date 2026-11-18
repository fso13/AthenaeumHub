# D1-FE5 — настройки чата + модалка профиля

> Формат — `docs/TASKS.md` §5. Зона сессии: `frontend/**`. `backend/**`,
> `contracts/**`, `docs/**`, `design/**` и `frontend/src/api/schema.d.ts` не
> менялись. Git-репозитория в рабочем дереве нет, поэтому изменения согласованы
> в рабочем дереве.

## Статус

**DONE в границах D1-FE5.** Закрыты `docs/TASKS-DASHBOARD-V1.md` §3.4 и §4.6
на контракте D1-BE3 (`PATCH /chats/{chatId}`, `Chat.description`,
`ChatSummary.description`) и существующих `/me`/`GET /devices`.

- `ChatSettingsDialog`: name 1..120, description ≤500, PATCH, роли OWNER/ADMIN,
  read-only для MEMBER/GUEST, E2EE-политика (description disabled, name разрешён),
  trim/валидация, отсутствие оптимистичных обновлений, перевод 403/404/409/422,
  обновление заголовка/списка после `200`, интеграция с E12-участниками,
  честно выключенная опасная зона.
- `ProfileDialog`: имя/email/платформенный админ из `/me`, workspace/роль из
  активного членства, `GET /devices`, тема, настройки уведомлений, logout с
  подтверждением, честно выключенные 2FA/сессии, focus trap/`Esc`/mobile.
- Store/API/MSW: `updateChat`, `listDevices`, `chatSettings`/`devices` state,
  mock-ручки для успеха/задержки/403/404/409/422 и `DeviceList`.
- Тесты: **20** новых RTL-тестов (14 + 6), включая axe и focus/Esc.
  Полный `npm run check` — **852/852** (81 файл), contract **48 paths / 56
  operations / 88 schemas**, build зелёный.

## 1. Contract и границы

Использованы только существующие операции/поля:

- `PATCH /chats/{chatId}` → `ChatUpdateRequest` `{name?, description?}` → `200 Chat`;
- `Chat.description` / `ChatSummary.description` (additive D1-BE3);
- `GET /me` → `MeResponse` (`user.id/display_name/email/is_platform_admin`,
  `workspaces`, `default_workspace_id`);
- `GET /devices` → `DeviceList`; `POST /auth/logout` — существующий logout
  Auth BFF (refresh отзывается провайдером, не FE-модалкой).

Не добавлялись: `GET /chats/{chatId}`, chat-members endpoint, поля `archive`,
`leave`, `delete`, 2FA/session API, optimistic-lock/version, `Idempotency-Key`
для `PATCH`. `schema.d.ts` не редактировался; `contract:check` синхронен.

## 2. Настройки чата (`ChatSettingsDialog`)

### Открытие и поля

- Кнопка «О чате» в `ChatHeader` (icon-button с `aria-label`/`title`) открывает
  `role="dialog"` «Настройки чата».
- Название: 1..120 code points; trim + collapse внутренних пробелов (как сервер).
- Описание: ≤500 code points; CRLF→LF, trim; пустая строка отправляется как `""`
  и очищает описание в `null` на сервере.
- Счётчики длины считают code points (`Array.from`), а не UTF-16, поэтому emoji
  не «съедают» лимит.
- Save отправляет только изменённые поля. Нет изменений → «Нет изменений», запрос
  не уходит.

### Роли и E2EE

- `canManage = activeWorkspace.role ∈ {OWNER, ADMIN}`. MEMBER/GUEST видят те же
  значения в `disabled`-полях, объяснение и не видят кнопку «Сохранить».
  Сервер по-прежнему авторизует по workspace-роли; UI — только подсказка.
- E2EE-чат: `description` disabled, показан честный текст «сервер не хранит
  описание: оно было бы открытым текстом»; `name` разрешён и уходит один, без
  `description`. `security_mode` в теле не отправляется.
- Если UI-состояние устарело и сервер вернул `422 CHAT_SETTINGS_E2EE_UNSUPPORTED`,
  показывается переведённая ошибка, а не успех.

### Валидация и ошибки

- Клиентская: пустое имя, >120, >500, `<`/`>`, control chars (в описании
  разрешены `\n`/`\t`) — поле помечается `aria-invalid`, показывается
  `role="alert"`, запрос не отправляется.
- Серверные: `403` → «недостаточно прав», `404` → «чат исчез», `409` →
  «изменился на сервере», `422 VALIDATION_FAILED` с `details.field` →
  соответствующее сообщение, `CHAT_SETTINGS_E2EE_UNSUPPORTED` → E2EE-текст,
  network/5xx → `describeError`.
- Ошибка не сбрасывает черновик; при редактировании поля ошибка снимается.

### Без оптимистичных обновлений

`ChatStore.saveChatSettings`:

1. ставит `chatSettings.status='saving'` (кнопка `aria-busy`, поля disabled),
2. ждёт `200 Chat`,
3. только затем обновляет `chats` (name/description/security_mode и т.д.) и
   пересчитывает unread-сумму,
4. best-effort перечитывает `GET /workspaces/{id}/chats`, чтобы получить
   серверную истину и не затереть чужое переименование; ошибка refetch не
   отменяет уже подтверждённый `200`,
5. при ошибке оставляет старые `chats`/заголовок и пишет `chatSettings.error`.

`ChatHeader` и `Sidebar` читают один и тот же `chats`, поэтому обновляются
вместе. `toChatSummary` теперь переносит `description`.

### Участники и опасная зона

- Секция «Участники» не дублирует API: кнопка вызывает существующий
  `WorkspaceMembersDialog` (E12, `GET/POST/PATCH/DELETE /workspaces/{id}/members`).
  Отдельного chat-members эндпоинта в контракте нет — это написано в UI.
- «Архивировать чат», «Покинуть чат», «Удалить чат» — нативные `disabled`-кнопки
  с текстом «Недоступно: в этом срезе нет API архивации, выхода или удаления
  чата». Destructive-запросы не отправляются; admin-`DELETE /admin/chats/{id}` не
  переиспользуется (это другая роль/операция).

### Доступность

`role="dialog"`, `aria-modal`, `aria-labelledby`/`aria-describedby`, focus trap по
Tab, `Esc`, возврат фокуса на триггер, блокировка `body` scroll, `field__error`
с `aria-invalid`, `aria-busy` на сохранении, mobile 390/768/1440 без
горизонтального скролла.

## 3. Профиль (`ProfileDialog`)

- Открывается из строки пользователя в `Sidebar` (кнопка «Профиль») и из страницы
  «Настройки» («Открыть профиль»).
- Identity из `/me`: display name, email, `is_platform_admin`; workspace — имя
  активного, роль — `activeWorkspace.role`; в dev-режиме (`/me` не вызывается)
  показываются доступные session-поля и `—`, без выдуманных значений.
- Устройства: новый typed-метод `ChatApi.listDevices()` → `GET /devices`
  (`DeviceList`). Рендерятся `id`, `name`, `platform`, `status`, `created_at`,
  `last_seen_at` и метка «Это устройство». Ключи, `fingerprint`, `identity_*`,
  `signed_prekey`, `one_time_prekey` не рендерятся; ошибка/пусто/загрузка —
  отдельные состояния с retry.
- 2FA и «Активные сессии»: API в этом срезе нет → `aria-disabled`-строки с
  честным текстом, без фиктивных чекбоксов. Logout остаётся доступен.
- Тема — существующий `useTheme` (`data-theme`, `krug.theme`); уведомления —
  существующий `NotificationPreferencesDialog` (E6). Вложенные диалоги владеют
  фокусом/`Esc`, пока открыты.
- Logout: подтверждение через `AdminConfirmDialog` («Выйти из аккаунта?»), затем
  текущий `PasswordAuthProvider.signOut` (отзыв refresh + очистка E2EE-состояния).
  В dev-режиме без `onLogout` кнопка `disabled` — без имитации.
- Focus trap, `Esc`, возврат фокуса, `role="dialog"`, мобильный layout.

## 4. Store / API / MSW

`AppState`:

- `chatSettings: { chatId, status: 'idle'|'saving'|'saved'|'error', error }`;
- `devices: { items: Device[], status: LoadStatus, error }`.

`ChatStore`:

- `saveChatSettings(chatId, {name?, description?})` — guard от повторного save,
  проверка пустого патча, обновление только после `200`, refetch списка;
- `clearChatSettings()`;
- `loadDevices(force?)` — dedupe in-flight, кэш `ready`, `401`/`403`/сеть в
  `devices.error`;
- сброс нового состояния в `reset()` и при `activateWorkspace()`.

`ChatApi`:

- `updateChat(chatId, body)` — `PATCH /chats/{id}` через общий `withReauth`
  (401 → один refresh/replay), без idempotency-заголовка;
- `listDevices()` — `GET /devices`.

MSW:

- `PATCH /chats/:chatId` повторяет D1-BE3: existence hiding (404), workspace
  OWNER/ADMIN (403), E2EE description (422), trim/границы/plain-text,
  `empty_patch` 422; пишет `chatSettingsRequests` с телом и `X-Device-Id`.
- `GET /devices` возвращает `{items}`.
- Новые knobs: `chatSettingsRequests`, `chatSettingsDelayMs`,
  `forceChatSettingsError` (сбрасываются в `resetMockDb`).

## 5. Тесты

Добавлено **20** RTL-тестов (832 → **852**; 79 → **81** файл):

`src/components/ChatSettings.test.tsx` (14):

1. сохранение name/description с trim + обновление заголовка/списка;
2. отсутствие оптимистичного апдейта при задержанном `PATCH`;
3. клиентская валидация: пусто, 121, `<b>`, 501;
4. E2EE: description disabled, сохраняется только name;
5. MEMBER read-only, PATCH не уходит;
6. серверный 403 (UI считал себя OWNER) + чат не изменился;
7. серверный 404;
8. серверный 409 + черновик сохранён;
9. серверный 422 `details.field=description`;
10. серверный `CHAT_SETTINGS_E2EE_UNSUPPORTED` при устаревшем UI;
11. интеграция с E12-диалогом (один `GET /members`, настройки закрыты);
12. disabled archive/leave/delete + honest note, destructive-запросов нет;
13. focus trap/`Esc`/focus return;
14. axe с открытым диалогом.

`src/components/Profile.test.tsx` (6):

1. `/me`-поля, workspace/роль, platform admin, `GET /devices`, отсутствие
   key/fingerprint-текста;
2. honest disabled 2FA/сессии, без чекбоксов;
3. переключение темы + вложенные уведомления (Escape закрывает только их);
4. logout confirm → login, `POST /auth/logout` вызван;
5. focus trap/`Esc`/focus return;
6. axe с открытым профилем.

Команды (JDK не требуется):

```bash
cd frontend
npm run check
# lint + format:check + contract:check + stickers:check + security:check
# + session-writers:check + test + build
# Test Files 81 passed, Tests 852 passed, EXIT 0
# Contract check passed: 56 operations, 88 schemas, types in sync
# vite build: built in 1.10s (chunk-size warning — существующий, не ошибка)
```

## 6. Security / приватность

- **E2EE**: description не отправляется и не принимается сервером; UI показывает
  disabled-поле с честным объяснением. `name` — только label. E2EE-ключи,
  конверты, plaintext и fingerprint не рендерятся и не логируются.
- **Нет утечки plaintext**: описание не попадает в audit (это BE), не
  интерполируется в HTML (React text nodes), `<`/`>` отклоняются и на клиенте,
  и на сервере. `dangerouslySetInnerHTML` не используется.
- **Нет destructive без backend**: archive/leave/delete выключены; admin-delete
  не переиспользуется; logout подтверждается.
- **RBAC**: UI не повышает права; серверные 403/404 проверены тестами.
- **Данные устройств**: `GET /devices` содержит публичные ключи по контракту, но
  UI рендерит только id/name/platform/status/даты; секретов в localStorage нет
  (тема — единственная новая per-device настройка, уже разрешена гардом).
- **Никаких новых сетевых sinks**: только typed `ChatApi`; `security:check`
  зелёный.

## 7. Риски / follow-up

1. **Нет `GET /chats/{chatId}`.** Диалог инициализируется из `ChatSummary` в
   списке, а не отдельным detail-запросом. После `PATCH` и refetch список
   актуален; при устаревшем списке до открытия диалога возможен показ старого
   описания. Detail-endpoint — отдельная additive-операция.
2. **Нет WS `chat.updated`.** Другой участник увидит новое имя/описание после
   sync/refetch/перезагрузки, не мгновенно (ограничение D1-BE3).
3. **Last-write-wins.** Optimistic-lock/version не используются по контракту; два
   OWNER/ADMIN могут перезаписать друг друга. UI переводит `409`, но штатный
   конфликт им не создаётся.
4. **Роль в UI — снимок `/me`.** После смены роли в другой вкладке кнопки могут
   оставаться доступными до refetch; сервер всё равно вернёт `403` (покрыто
   тестом).
5. **Dev-режим.** В `POST /dev/session` нет workspace-роли, поэтому настройки
   чата в dev-режиме read-only. Password-режим (целевой) редактирует. Если нужен
   editable dev-демо — потребуется role в dev-session, это вне D1-FE5.
6. **Опасная зона.** Archive/leave/delete не реализованы и выключены; при
   появлении backend-операций нужны отдельные подтверждения + audit.
7. **2FA/сессии.** API отсутствует; строки честно disabled. Управление
   устройствами (revoke) тоже не включено, хотя `DELETE /devices/{id}` есть в
   контракте: это отдельный UX-срез (риск случайного отзыва текущего устройства).
8. **Axe.** В jsdom `color-contrast` отключён (как во всех существующих
   axe-тестах), поэтому контраст light/dark проверяется вручную/e2e, не в RTL.
9. **Размер бандла.** `vite build` предупреждает о chunk >500 kB — это
   существующее состояние, не регрессия D1-FE5.

## 8. Изменённые файлы

Новые:

- `frontend/src/components/ChatSettingsDialog.tsx`
- `frontend/src/components/ProfileDialog.tsx`
- `frontend/src/components/ChatSettings.test.tsx`
- `frontend/src/components/Profile.test.tsx`
- `frontend/D1-FE5-REPORT.md` (этот файл)

Изменённые:

- `frontend/src/api/types.ts` — `ChatUpdateRequest`, `DeviceList`;
- `frontend/src/api/endpoints.ts` — `updateChat`, `listDevices`;
- `frontend/src/store/chatStore.ts` — `chatSettings`/`devices`, методы,
  `description` в `toChatSummary`, сброс состояния;
- `frontend/src/mocks/db.ts` — mock-состояние настроек чата;
- `frontend/src/mocks/handlers.ts` — `PATCH /chats/:chatId`, `GET /devices`;
- `frontend/src/components/ChatHeader.tsx` — кнопка «О чате»;
- `frontend/src/components/ChatScreen.tsx` — проброс `onOpenChatSettings`;
- `frontend/src/components/AppShell.tsx` — state/рендер двух модалок;
- `frontend/src/components/Sidebar.tsx` — кнопка профиля;
- `frontend/src/components/pages/SettingsPage.tsx` — «Открыть профиль»;
- `frontend/src/i18n/ru.ts` — RU-ключи;
- `frontend/src/styles/app.css` — стили модалок/профиля/адаптив;
- `frontend/README.md` — раздел D1-FE5 и счётчики.

Не менялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/scripts/check-contract.mjs`
(гард уже содержал 48/56/88).

## 9. Приёмка D1-FE5

| Пункт                                                                 | Статус             |
| --------------------------------------------------------------------- | ------------------ |
| Модалка настроек открывается из ChatHeader/«О чате»                   | ✅                 |
| name 1..120, description ≤500, PATCH                                  | ✅                 |
| OWNER/ADMIN controls; MEMBER/GUEST read-only                          | ✅                 |
| E2EE: description disabled + honest, name allowed                     | ✅                 |
| validation/trim, save state                                           | ✅                 |
| 403/404/409/422 переведены, без потери черновика                      | ✅                 |
| no optimistic updates; header/list после `200`                        | ✅                 |
| участники через E12, без дублирования API                             | ✅                 |
| danger zone только disabled/TODO, honest                              | ✅                 |
| профиль: имя/email/роль/workspace из `/me`                            | ✅                 |
| devices: существующие данные `GET /devices`                           | ✅                 |
| 2FA/sessions — honest disabled (API нет)                              | ✅                 |
| тема/уведомления при наличии                                          | ✅                 |
| logout                                                                | ✅ + confirm       |
| focus trap/Esc/aria/mobile                                            | ✅                 |
| tests: save/validation/E2EE/403/read-only/members/profile/confirm/axe | ✅ 20              |
| полный `npm run check` 832+                                           | ✅ 852/852, exit 0 |
| README                                                                | ✅                 |
| без invented fields/endpoints                                         | ✅                 |
| без destructive без backend                                           | ✅                 |
| без plaintext/E2EE-утечек                                             | ✅                 |
| отчёт                                                                 | ✅ этот файл       |

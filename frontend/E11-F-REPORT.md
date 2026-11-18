# E11-F — admin actions (suspend/activate, soft-delete chat) + Audit tab

> Формат — `docs/TASKS.md` §5. Зона сессии: только `frontend/**`.
> `backend/**`, `contracts/**`, `docs/**`, `design/**` и
> `frontend/src/api/schema.d.ts` не менялись. Git-репозитория в рабочем дереве нет,
> поэтому «одним PR» проверить нельзя — изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E11-F.** Реализованы FR-ADM-15…18 / R-08 / AC-R08 на фронтенде:
типизированные admin-мутации `suspendUser`/`activateUser`/`deleteChat`, чтение
`listAdminAudit`, экшены в таблицах users/chats с confirm-диалогами и разбором
`403/404/409/503`, новая вкладка **Audit** с точным фильтром по action и
cursor-пагинацией. E9 admin design/auth/media, E10 DIRECT-чаты и E2EE-флаг не
затронуты.

**Проверки:**

| Проверка                                                                                    | Результат                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run check` (lint, format, contract, stickers, security, session-writers, tests, build) | **PASS**, exit 0                                                          |
| Unit/RTL (`vitest run`)                                                                     | **708 / 708** тестов, **68** файлов                                       |
| `npm run contract:check`                                                                    | **PASS** — 46 paths / 52 operations / 85 schemas, `schema.d.ts` синхронен |
| E2E admin (`playwright test --config playwright.auth.config.ts admin.spec.ts`)              | **15 / 15**                                                               |
| axe (light + dark, 390/768/1440)                                                            | 0 serious/critical в RTL и E2E                                            |
| Backend/contracts/docs/design/schema.d.ts                                                   | не изменялись                                                             |

Прирост тестов: **672 → 708** (+36): API 5, ops-store +10, RTL actions 12, RTL audit 9.
E2E: **10 → 15** (+5 сценариев, включая mobile/confirm и dark-theme audit).

## Сделано

### 1. API client (typed, без изобретённых полей)

`src/api/endpoints.ts`, `src/api/types.ts`:

- `suspendUser(userId)` → `POST /admin/users/{userId}/suspend` (`204`);
- `activateUser(userId)` → `POST /admin/users/{userId}/activate` (`204`);
- `deleteChat(chatId)` → `DELETE /admin/chats/{chatId}` (`204`, soft-delete);
- `listAdminAudit({action?, cursor?, limit?})` → `GET /admin/audit` → `AdminAuditPage`;
- `AdminAuditEvent`/`AdminAuditPage` — только из `schema.d.ts`;
- `ListAdminAuditQuery` — `action` (точное имя, ≤120), `cursor` (opaque), `limit`.

`X-Device-Id` (и `Authorization`) добавляет общий authed-helper `ApiClient` для всех
запросов с известным device id; отдельного заголовка/поля не вводилось. Мутации
bodyless, `Content-Type` не выставляется; `Idempotency-Key` намеренно не
отправляется — контракт его для E11-операций не объявляет, а повтор даёт `409`.
Пустой `action` не передаётся (серверный default — все действия), `cursor` только
эхо `next_cursor`.

### 2. Users: suspend / activate (FR-ADM-15, FR-ADM-18)

`src/components/admin/AdminUsersSection.tsx`:

- новая колонка **«Действия»**: `ACTIVE` → «Приостановить», `SUSPENDED` →
  «Активировать», `DELETED` → неактивное «Нет действий» (эндпоинта восстановления в
  контракте нет — действие не выдумано);
- UI guard: кнопка `disabled` для собственной строки, платформенного админа и
  `DELETED`; причина видна текстом (`admin.users.action.self|platformAdmin|deleted`),
  а не только в `title`;
- confirm-диалог: email/display name цели, последствия (Keycloak disable + отзыв
  сессий; активация — без отзыва), запись в audit, destructive-стиль для suspend;
- состояние: оптимистичного переворота нет. После `204` чип меняется сразу
  (server-confirmed), затем страница перечитывается `GET /admin/users` —
  сервер остаётся источником истины. Ошибка не удаляет строку и не меняет чип;
- коды: `403` → диалог открыт с текстом про права; `404` → диалог закрывается,
  warning + refresh, строка остаётся; `409 USER_ALREADY_SUSPENDED|USER_ALREADY_ACTIVE`
  → состояние уже достигнуто: чип патчится, список перечитывается, warning;
  `409 SELF_ACTION_FORBIDDEN|LAST_PLATFORM_ADMIN` → warning (UI-guard обычно
  предотвращает); `503 AUTH_UNAVAILABLE` → «изменения не применены», кнопка
  «Повторить»; `5xx/network` → retry; прочие `409` → конфликт.

### 3. Chats: soft-delete (FR-ADM-16)

`src/components/admin/AdminChatsSection.tsx`:

- колонка «Действия» → «Удалить» (`button--danger-ghost`);
- confirm: имя/пространство чата, объяснение soft-delete (сообщения, вложения и
  E2EE-конверты физически не удаляются), аудит, полный id чата;
- после `204` строка убирается из выдачи, цепочка курсора перечитывается;
- `409 CHAT_ALREADY_DELETED` — согласованное состояние: warning «Чат уже удалён —
  список обновлён», строка убирается, refresh. `404` — то же с предупреждением.
  `403/503/5xx` — диалог остаётся, строка не удаляется; на `503` доступен retry.
  «Фантомного» удаления при ошибке нет.

### 4. Audit tab (FR-ADM-17)

Новые `AdminAuditSection.tsx`, `adminAudit.ts`, вкладка `?tab=audit` в `tabs.ts` и
`AdminScreen.tsx` (общий roving-tabindex `tablist`, deep link, Back/Forward):

- колонки **время / действие / актор / цель**; <1120 px — карточки с видимыми
  `<dt>`-метками (390 и 768 проверены);
- для известных действий — RU-метка + исходный код; актор — `actor_email` и
  короткий `actor_id` (полный id в `title` и `aria-label`), системные события —
  «Система»; цель — `target_type` + короткий `target_id` (полный id в `title` и
  `aria-label`);
- **только метаданные:** рендерятся ровно 7 полей `AdminAuditEvent`. `metadata`,
  `prev_hash`/`hash`, `request_id`, `scope_key`, тела сообщений, имена файлов и
  секреты отсутствуют by construction; в подсказке это явно сказано, тесты
  проверяют отсутствие строк `metadata`/`request_id`/`prev_hash` в таблице;
- фильтр — `<select>` из **известных** actions (значения взяты из backend
  audit-writer'а: `admin.user.suspended`, `admin.user.activated`,
  `admin.chat.deleted`, `admin.users.viewed`, `admin.chats.viewed`,
  `admin.storage.viewed`, `admin.audit.viewed`, `settings.updated`,
  `settings.test_email`, `setup.completed`, `user.provisioned`,
  `workspace.created`, `device.list.changed`, `chat.keys.changed`,
  `message.created`, `message.receipt`, `session.revoked`), «Все действия» и
  «Сбросить». Контракт не имеет enum — список курируется, а не изобретает
  значения; события вне списка видны в таблице без фильтра;
- cursor-пагинация «Показать ещё» (`next_cursor`, append + дедупликация `id`),
  отдельные `loadingMore`/`moreError`;
- skeleton, два empty-состояния (пустой журнал / нет совпадений), error + retry,
  сохранение уже загруженных строк при ошибке refresh; `403` на audit-чтении
  заменяет весь admin-surface на `AdminForbiddenScreen` (как остальные разделы).

### 5. Confirm-диалог и доступность

`src/components/admin/AdminConfirmDialog.tsx`:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` + `aria-describedby`;
- initial focus — на безопасном «Отмена»; focus trap по Tab/Shift+Tab; Esc и
  клик по backdrop закрывают (Esc/backdrop игнорируются, пока `busy`); возврат
  фокуса на триггер при закрытии; блокировка прокрутки body;
- destructive-кнопка использует soft-fill `--danger` (не solid), чтобы контраст
  оставался AA в light и dark;
- `role="alert"` для ошибки, `ErrorDetails` (code/request_id/status) — только при
  error-tone; warning-tone не раскрывает технические детали;
- `busy` блокирует оба действия и повторный submit.

### 6. Store и гонки

`src/ops/adminDirectory.ts` (+ `store.ts` wiring):

- новый срез `audit` (items/nextCursor/hasMore/status/error/loadingMore/moreError/
  action) с generation/token-guard'ами: смена фильтра начинает новую цепочку и
  отбрасывает устаревший in-flight ответ (как users/chats);
- `changeUserStatus` / `deleteChat` возвращают `AdminActionResult`
  `{ok, error, alreadyApplied}`; при `alreadyApplied`/`404` список
  реконсилируется и перечитывается; при прочих ошибках строки не трогаются;
- `dispose()`/`reset()` очищают audit и инвалидируют его запросы.

### 7. MSW/mock (dev + RTL + E2E)

`src/mocks/db.ts`, `handlers.ts`, `browser.ts`:

- handlers: `POST .../suspend|activate`, `DELETE /admin/chats/{id}`,
  `GET /admin/audit`; тот же порядок проверок, что в backend (guard → 400 UUID →
  404 → self → last-admin → already-in-state → mutate + audit);
- mock-эффекты: `userStatuses` (чип после refresh), `deletedChatIds` (скрытие
  soft-deleted чата), append audit-события после успешного действия;
- knobs: `auditEventsOverride`/`auditDelayMs`/`forceAuditError`,
  `forceUserActionError`/`forceChatDeleteError`, журналы запросов (включая
  `deviceId` для X-Device-Id);
- E2E-only `window.__krugAuditSeed` — детерминированные 30 строк для пагинации.

### 8. Contract guard

`scripts/check-contract.mjs` дополнен E11-инвариантами: счётчики 52 operations /
85 schemas уже соответствуют контракту; добавлены проверки, что три мутации
документируют `204` **без тела** и `403/404/409` (suspend/activate — ещё `503`),
что `AdminAuditEvent` **не содержит** `metadata`/`request_id`/`prev_hash`/`hash`/
`scope_key`, что `next_cursor` nullable, а `action` остаётся точной строкой
(≤120), не enum'ом, и `limit` — 30/100.

## Приёмка (TASKS-ADMIN-V2 E11 / FR-ADM-15…18 / AC-R08)

| Пункт                                                  | Статус                      |
| ------------------------------------------------------ | --------------------------- |
| Suspend/activate из users-таблицы                      | ✅                          |
| Confirm с email, self/platform-admin/ deleted disabled | ✅                          |
| Чип статуса обновляется, список перечитывается         | ✅                          |
| `403/404/409/503` и repeat-семантика                   | ✅                          |
| Self-suspend и last-admin не «проглатываются»          | ✅ (UI-guard + server-коды) |
| Soft-delete чата с confirm                             | ✅                          |
| `409 CHAT_ALREADY_DELETED` = удалён, без дубля         | ✅                          |
| Ошибка не удаляет строку                               | ✅ RTL/E2E                  |
| Audit tab в admin-nav, deep link, клавиатура           | ✅                          |
| Фильтр по action (известные actions) + сброс           | ✅                          |
| Cursor-пагинация, append + дедуп                       | ✅                          |
| Колонки time/action/actor/target, карточки <1120 px    | ✅ 390/768/1440             |
| Skeleton/empty/error/retry/403                         | ✅                          |
| Нет metadata/контента/секретов                         | ✅ контракт + тесты         |
| Focus trap/return, Esc, aria, destructive              | ✅ RTL/E2E                  |
| axe light/dark                                         | ✅                          |
| `npm run check` 672+                                   | ✅ 708                      |
| contract 52/85                                         | ✅                          |
| E2E admin actions                                      | ✅ 15/15                    |

## Тесты

- `src/api/adminActions.test.ts` (**5**) — method/path/`X-Device-Id`/
  `Authorization`, bodyless `204`, query audit (`action`/`cursor`/`limit`,
  пустой action опущен), `409 CHAT_ALREADY_DELETED` → типизированный `ApiError`.
- `src/ops/adminDirectory.test.ts` (**15**, было 5) — audit-цепочка, дедуп
  граничной строки, устаревший ответ при смене фильтра, 403 с сохранением rows;
  suspend/activate патчат строку и перечитывают страницу; 403 не меняет строку и
  не перечитывает; `409 USER_ALREADY_SUSPENDED` реконсилится; chat delete +
  refresh; `CHAT_ALREADY_DELETED` удаляет строку, `503` — нет; `404` удаляет и
  перечитывает.
- `src/components/admin/AdminActions.test.tsx` (**12**) — suspend/activate через
  confirm с email; disabled self/platform-admin/deleted без запросов; Esc +
  focus trap/return; `409` (already) → warning и чип; `403` → диалог открыт,
  строка на месте; `503` → retry и успех; `404` → warning + refresh без
  «фантомного» удаления; axe с открытым диалогом; chats: успех, `409`, `503`.
- `src/components/admin/AdminAudit.test.tsx` (**9**) — 7 полей, отсутствие
  metadata/hash/request_id, `aria-label` полного target id, фильтр/сброс,
  пагинация 25→30, skeleton, два empty-состояния, error+retry, сохранение строк
  при ошибке refresh, 403 → forbidden, axe.
- `src/components/admin/AdminDirectory.test.tsx` — обновлён ожидаемый набор
  колонок users (9, добавлены «Действия»), остальные E9-сценарии без изменений.
- `e2e/admin.spec.ts` (**15**, было 10) — suspend → activate с диалогом,
  Esc/фокус, red/blue axe, audit-событие после действия; soft-delete чата;
  audit 30 строк: 25→30, фильтр 15, отсутствие `metadata`/`request_id`;
  dark-theme audit axe; mobile 390: действия, метки карточек, диалог, нет
  клиппинга, 44 px табы, axe; tablet 768.

## Риски и ограничения

1. **Playwright-браузеры в этом окружении отсутствуют.** `npx playwright install`
   упирается в `EPERM` на `~/Library/Caches`; для проверки браузер был скачан в
   workspace-local `PLAYWRIGHT_BROWSERS_PATH` и **удалён** после прогона (артефакт
   не входит в поставку). Воспроизведение: `npx playwright install chromium`
   (или `PLAYWRIGHT_BROWSERS_PATH=... npx playwright install chromium`) и
   `npm run test:e2e:admin`.
2. **Список actions в фильтре курируется.** Контракт типизирует `action` как
   строку ≤120 без enum; UI предлагает 17 реальных действий backend-writer'а.
   Событие с иным action видно в таблице, но выбрать его фильтром нельзя. Если
   появятся новые действия — их нужно добавить в `adminAudit.ts` (и метку в ru.ts).
3. **Refresh после действия сбрасывает загруженные страницы.** Как и кнопка
   «Обновить» в E9, `loadUsers/loadChats({force:true})` перечитывает первую
   страницу: после «Показать ещё» прогресс схлопывается. Это осознанно: строка не
   должна показывать устаревший статус; при необходимости можно сохранять cursor
   chain отдельным изменением store.
4. **Два запроса на действие** (мутация + refresh) вместо optimistic update.
   Выбрано, чтобы UI не заявлял состояние, которое сервер не применил (503
   rollback, `409 already`). Цена — дополнительный GET.
5. **`409` на повторный DELETE — warning, не success.** Соответствует решению
   E11-B; UI отличает retry от успеха и убирает строку, потому что сервер уже
   считает чат удалённым.
6. **`actor_email` — PII, разрешённая контрактом только platform admin.** UI
   показывает её в audit-таблице; для системных событий (`actor_id`/`actor_email`
   = null) рендерится «Система». Других PII/контента в audit-ответе нет.
7. **UI-guard не заменяет сервер.** Кнопки self/platform-admin/`DELETED`
   отключены, но `SELF_ACTION_FORBIDDEN`, `LAST_PLATFORM_ADMIN`,
   `USER_ALREADY_*` обрабатываются и приходят с сервера (в т.ч. если UI-состояние
   устарело). Отдельного endpoint'а восстановления `DELETED`-пользователя или
   чата нет — UI таких действий не предлагает.
8. **Audit-чтение само аудируется** (`admin.audit.viewed`): каждый refresh
   добавляет событие, и первая страница «сдвигается». Это свойство E11-B;
   фильтр `admin.audit.viewed` позволяет увидеть такие события отдельно.
9. **Короткие id в audit-таблице.** Визуально показываются 8 символов; полный
   UUID доступен в `title` и `aria-label` (проверено тестом). Для копирования
   полного id в 1440 px места недостаточно — это осознанный компромисс.
10. **E2E-сид audit — mock-only.** `window.__krugAuditSeed` живёт только в
    `src/mocks/browser.ts` и не является частью продуктового API.
11. **`limit` audit = 25** (как и другие admin-страницы), серверный default 30
    не используется намеренно, чтобы страницы были предсказуемы.
12. **Нет e2e-проверки `409 already suspended`** (409 для чата покрыт E2E,
    пользовательский — RTL/store): сценарий требует гонки «список прочитан →
    статус изменён на сервере», которая в mock-браузере воспроизводится только
    через debug-контрол; RTL покрывает его точно.

## Файлы E11-F

- `src/api/endpoints.ts`, `src/api/types.ts`
- `src/api/adminActions.test.ts` (new)
- `src/ops/adminDirectory.ts`, `src/ops/adminDirectory.test.ts`, `src/ops/store.ts`
- `src/components/admin/AdminConfirmDialog.tsx` (new)
- `src/components/admin/actionErrors.ts` (new)
- `src/components/admin/adminAudit.ts` (new)
- `src/components/admin/AdminAuditSection.tsx` (new)
- `src/components/admin/AdminUsersSection.tsx`
- `src/components/admin/AdminChatsSection.tsx`
- `src/components/admin/AdminScreen.tsx`, `src/components/admin/tabs.ts`
- `src/components/admin/AdminActions.test.tsx` (new)
- `src/components/admin/AdminAudit.test.tsx` (new)
- `src/components/admin/AdminDirectory.test.tsx` (обновлены колонки users)
- `src/i18n/ru.ts`
- `src/styles/app.css`
- `src/mocks/db.ts`, `src/mocks/handlers.ts`, `src/mocks/browser.ts`
- `scripts/check-contract.mjs`
- `e2e/admin.spec.ts`
- `README.md` (раздел E11-F)
- `frontend/E11-F-REPORT.md` (этот файл)

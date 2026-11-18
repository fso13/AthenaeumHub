# E8-F — setup wizard, platform admin UI, chat creation, workspace switcher

> Зона сессии: `frontend/**`. `backend/**`, `contracts/**`, `docs/**`, `design/**` и
> `frontend/src/api/schema.d.ts` не изменялись. Auth BFF, media и E2EE-путь не
> переписывались; `VITE_E2EE_ENABLED` остаётся выключенным в проверках.

## Статус

**DONE в границах E8-F.** Реализованы R-01…R-04 клиентской части:

1. `/setup` — обязательный first-run wizard для platform admin, SMTP + test-email,
   бизнес-параметры, `complete_setup`, обработка `409 SETUP_ALREADY_COMPLETED`,
   отдельный экран «Установка не завершена» для non-admin.
2. `/admin` — серверно-защищённый раздел (UI-guard по `me.is_platform_admin`),
   overview, настройки, SMTP-тест, статус setup, audit hints, обработка 403.
3. Создание `GROUP`-чата из сайдбара: idempotency, `used/limit`,
   `409 CHAT_LIMIT_REACHED` (`scope/limit/used`), `422`, открытие чата.
4. Workspace switcher: явный select при ≥2 воркспейсах, per-device сохранение
   только `workspace_id`, сброс чатов/уведомлений при переключении.
5. MSW-моки, unit-тесты, Playwright + axe, `npm run check`.

## Что сделано

### 1. Setup wizard `/setup`

- **Public status.** `GET /setup/status` вызывается через `OpsStore` в
  authenticated shell (`PasswordApp`), без 401/refresh-петли; в dev-режиме setup
  не используется.
- **Гейт после входа.** Если `is_platform_admin && setup_required`, приложение
  принудительно ведёт на `/setup` (replace), любые другие маршруты показывают
  splash до редиректа. Non-admin при `setup_required` видит экран
  «Установка не завершена» с повтором проверки статуса и logout.
- **SMTP-поля.** host, port, username, password, from, starttls. Порт и строки
  валидируются по контрактным диапазонам; пустой порт = «не менять».
- **Test email.** Кнопка сначала сохраняет текущие SMTP-поля
  (`PATCH /admin/settings` без `complete_setup`), затем вызывает
  `POST /admin/settings/test-email`. Так тест использует значения, которые
  админ только что ввёл, а не старый снимок. `503 SMTP_UNAVAILABLE`
  показывается отдельным сообщением; успех — `sent`/`to`.
- **Бизнес-параметры.** `max_chats_per_user`, `max_chats_per_workspace`,
  `max_workspace_members`, `registration_open`; значения 1..1 000 000, чекбокс
  регистрации.
- **Завершение.** `PATCH /admin/settings` c `complete_setup=true`; при успехе —
  `/admin`. При `409 SETUP_ALREADY_COMPLETED` форма показывает сообщение,
  `OpsStore` перечитывает setup/settings, а при реальном завершении в другой
  вкладке гейт уводит на `/admin`.
- **Пароль.** Живёт только в локальном state формы. После сохранения/теста поле
  очищается, API никогда не возвращает пароль, показывается только
  `smtp_configured` (host + from) и подсказка «пусто = не менять».

### 2. Admin UI `/admin`

- **Guard.** UI проверяет `state.me.user.is_platform_admin`; non-admin получает
  отдельный 403-экран. Если сервер отвечает 403 на `/admin/*` (флаг на сервере
  изменился), UI тоже уходит в 403, а не продолжает показывать админку.
- **Overview.** `GET /admin/overview` — только агрегаты users/workspaces/chats,
  без содержимого чатов и E2EE; отдельные loading/error/retry состояния.
- **Settings.** Общая форма с `/setup`: SMTP, test-email, лимиты, регистрация;
  сохранение `PATCH /admin/settings`, `smtp_configured`, `updated_at`/`updated_by`.
- **Audit hints.** Блок «Аудит»: изменения и тестовые письма аудируются, пароль
  SMTP не возвращается API и не пишется в логи.
- **Ссылка.** Кнопка «Администрирование» в профиле сайдбара рендерится только при
  `me.is_platform_admin`; маршрут `/admin` доступен только через гейт.

### 3. Создание чата (R-01)

- Кнопка «+ Создать чат» в сайдбаре; доступна для `OWNER`/`ADMIN`
  (в dev-профиле role нет — не блокируем) и блокируется при достигнутом
  `max_chats_per_user`.
- Диалог: тип `GROUP`, имя 1..120 с counter/валидацией, `used/limit` из
  `GET /workspaces/{id}/limits` (`max_chats_per_user`, `chats_used`), прогресс-бар.
- `POST /workspaces/{id}/chats` с `{type:"GROUP", name}` и `Idempotency-Key`
  (UUID). Ключ переиспользуется при повторе того же имени; при смене имени
  генерируется новый. Ответ не создаёт optimistic-чат: список перечитывается,
  созданный чат открывается.
- `409 CHAT_LIMIT_REACHED`: разбираются `details.scope/limit/used`, показывается
  сообщение для `USER` или `WORKSPACE`, диалог остаётся открытым, лимиты
  перечитываются. `422` и 403 показываются человекочитаемо.
- **DIRECT UI не выдуман:** в контракте нет user directory/member API, поэтому
  MVP — GROUP-only; в диалоге явно указано, что личные чаты и добавление
  участников появятся позже. Это зафиксировано в Risks как долг, а не как
  скрытая реализация.

### 4. Workspace switcher (R-02)

- Select виден при ≥2 воркспейсах; текущее значение — `activeWorkspaceId`.
- `src/workspace/deviceWorkspace.ts` — единственный модуль с `localStorage`;
  хранится только `krug.workspace.id` (не токены/email/имена/контент). Ключ
  позволяет восстановить последний выбор после reload; сервер всегда проверяет
  membership, неизвестный/поддельный id откатывается на default из `/me`.
- Переключение использует существующий `activateWorkspace`: останавливает
  realtime, очищает chats/slices/activeChat, typing/presence, notifications,
  notification preferences, e2ee-чаты, лимиты и загружает данные нового
  воркспейса.
- `scripts/check-security.mjs` расширен allow-list только для этого модуля;
  правило для остального `src/**` по-прежнему запрещает `localStorage`.

### 5. API/types/mocks

- `src/api/types.ts` — типы `SetupStatus`, `AdminSettings`, `AdminSettingsPatch`,
  `AdminOverview`, `TestEmailRequest/Response`, `Chat`, `ChatCreateRequest` из
  сгенерированного contract-типа.
- `src/api/endpoints.ts` — `getSetupStatus`, `getAdminSettings`,
  `updateAdminSettings`, `sendTestEmail`, `getAdminOverview`, `createChat`.
  `createChat` передаёт `Idempotency-Key`; admin-PATCH не выдумывает
  Idempotency-Key, которого нет в контракте.
- `src/ops/store.ts` — состояние setup/admin, дедупликация запросов, `reset()` на
  logout, безопасная обработка 409/503/403.
- MSW: публичный `/setup/status`, `GET/PATCH /admin/settings`,
  `POST /admin/settings/test-email`, `GET /admin/overview`,
  `POST /workspaces/{id}/chats`, `chats_used` в limits. Добавлены mock-only
  controls: `admin.setPlatformAdmin`, `admin.setSetupRequired`,
  `admin.forceTestEmailError`, `chats.setMaxChatsPerUser`,
  `chats.setMaxChatsPerWorkspace`, `chats.forceCreateError`; init-флаги
  `__krugSetupRequired`, `__krugPlatformAdmin`.
- `schema.d.ts` не редактировался; `check-contract` синхронен с контрактом.

## Contract

| Операция                          | Использование                                                             |
| --------------------------------- | ------------------------------------------------------------------------- |
| `GET /setup/status`               | public gate; `setup_required`, `registration_open`                        |
| `GET /admin/settings`             | форма setup/admin; ответ без пароля                                       |
| `PATCH /admin/settings`           | сохранение, `complete_setup=true`, 409 `SETUP_ALREADY_COMPLETED`          |
| `POST /admin/settings/test-email` | SMTP test; 503 `SMTP_UNAVAILABLE`                                         |
| `GET /admin/overview`             | агрегаты users/workspaces/chats                                           |
| `GET /me`                         | `user.is_platform_admin`                                                  |
| `GET /workspaces/{id}/limits`     | `max_chats_per_user`, `chats_used`                                        |
| `POST /workspaces/{id}/chats`     | GROUP, idempotency, 409 `CHAT_LIMIT_REACHED` с `details.scope/limit/used` |

**Фактические contract-счётчики:** **38 paths / 44 operations / 74 schemas**.
`node scripts/check-contract.mjs` — passed, generated types in sync.
`schema.d.ts` побайтно не менялся в E8-F (E8-B уже регенерировал его).

## Security

- **Пароль SMTP** — только state формы; в `OpsStore`/`ChatStore`/localStorage/
  sessionStorage не попадает. Mock не хранит сырой пароль: только
  `smtpPasswordStored`; audit-запись мока редактирует `smtp_password` в
  `[redacted]`.
- **localStorage** — единственное исключение для per-device workspace id;
  `check-security` печатает явно, где разрешён `localStorage`. Auth-токены
  остаются в sessionStorage (`auth/storage.ts`), как и раньше.
- **Admin guard** — серверный (`PlatformAdminGuard` в E8-B) остаётся источником
  истины; UI-guard только UX. При серверном 403 админские экраны не
  показываются.
- **E2EE** — флаг false; админка не читает E2EE-контент, overview — только
  count-агрегаты.
- **Keycloak** — браузерных вызовов нет; используются только `/api/v1/auth/*`
  через существующий Auth BFF.
- **Логи** — новых `console.*` нет; security-check проходит.

## Тесты

### Unit / MSW (`vitest`)

- **63 files / 645 tests passed** (было 59/625; +4 файла, +20 тестов).
- Новые:
  - `src/ops/store.test.ts` (5): public setup status, атомарное завершение, повтор
    → 409, test-email 503/success, overview/settings, reset без пароля.
  - `src/components/admin/Admin.test.tsx` (5): admin `/setup` → SMTP test →
    complete → `/admin`; non-admin «Установка не завершена»; non-admin 403 на
    `/admin`; admin settings/audit/test-email; `SETUP_ALREADY_COMPLETED`.
  - `src/components/CreateChat.test.tsx` (7): GROUP create + idempotency,
    replay без дубля, лимит в сайдбаре, лимит в диалоге, 409 USER/WORKSPACE,
    422, локальная валидация.
  - `src/workspace/switcher.test.tsx` (3): persistence per-device + reload,
    fallback на default, сброс чатов/уведомлений.
- `src/files/limits.test.ts` дополнен новыми обязательными полями
  `WorkspaceLimits` (E8-B schema regen), без изменения поведения.

### Browser / Playwright + axe (mock)

- `npx playwright test` (default dev mock): **14/14 passed**.
- `npx playwright test --config playwright.auth.config.ts` (password mock):
  **7/7 passed** — 3 admin + 4 auth. Отдельный скрипт:
  `npm run test:e2e:admin`.
- Новые `e2e/admin.spec.ts`:
  - `/setup` mandatory → SMTP test → complete → `/admin` + axe;
  - non-admin setup incomplete + axe;
  - non-admin `/admin` → 403 + axe.
- Новые `e2e/chat-create.spec.ts`:
  - `+` → GROUP name → открыт новый чат + axe;
  - forced server `409 CHAT_LIMIT_REACHED` с `scope/limit/used` + axe.
- Причина запуска с `PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers`: в системном
  кэше не было chromium, в репозитории лежит bundled browser.

### Полный чек

```
cd frontend
npm run check   # exit 0
```

Пройдены: `lint`, `format:check`, `contract:check` (44 ops / 74 schemas),
`stickers:check`, `security:check` (213 files), `session-writers:check`,
`vitest` (645), `tsc` + `vite build`.

## Приёмка TASKS-ADMIN-SETTINGS (frontend)

| Пункт                                                                          | Статус                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `SetupWizard` на `/setup`; SMTP/test; business params; completion              | ✅                                               |
| `/admin` overview/settings; guard `me.is_platform_admin`; no E2EE content      | ✅                                               |
| Chat creation dialog: `+`, type, name, limit usage, `CHAT_LIMIT_REACHED`       | ✅ GROUP; members/DIRECT — долг                  |
| Workspace switcher: explicit, per-device, reset state                          | ✅                                               |
| Tests: setup, admin guard, create chat, limit, workspace switch; axe           | ✅                                               |
| `npm run check`                                                                | ✅ 645/645, contract 44/74                       |
| Fresh install: first user admin, `/setup` mandatory, SMTP test, settings saved | ✅ (mock/E2E)                                    |
| Chat limit enforced server-side and reflected in UI                            | ✅                                               |
| Workspace switch no data leak                                                  | ✅ (id-only preference; server membership check) |
| `/admin` inaccessible to non-admin                                             | ✅ UI 403 + server guard E8-B                    |

## Риски и долги

1. **DIRECT UI отсутствует.** В контракте нет user-directory/member API; выдумывать
   `peer_id`-каталог или `member_ids` нельзя. MVP — GROUP-only; диалог честно
   сообщает об этом. Добавление участников и DIRECT — следующий срез. Это
   осознанный долг, не `[BLOCKED]`: GROUP-сценарий полностью реализован.
2. **`max_workspace_members` не применяется сервером** (нет API добавления
   участников, E8-B caveat). Параметр сохраняется и отдаётся; в форме есть
   подсказка об этом.
3. **`setup_required` — advisory на бэкенде** (E8-B): сервер намеренно не
   блокирует API, иначе первый админ не настроил бы установку. Frontend
   обеспечивает обязательный UX-гейт; это не граница безопасности данных.
4. **Один platform admin** (partial unique index E8-B); второй админ — отдельная
   модель/аудит вне v1.1.
5. **SMTP test = save-then-test.** Форма сохраняет SMTP-поля перед тестом; это
   осознанно, чтобы проверять введённые значения. Пустой пароль = «не менять»;
   очистить сохранённый пароль через API нельзя (E8-B caveat).
6. **Workspace preference переживает logout на устройстве.** Хранится только id;
   при входе другого пользователя серверный `/me` не содержит чужой воркспейс,
   происходит fallback на default. Токенов/контента в localStorage нет.
7. **Mock `/me` — один demo-профиль.** Non-admin сценарии в тестах используют
   mock-флаг `__krugPlatformAdmin=false`; реальный backend читает persisted
   `auth.users.is_platform_admin`. Это ограничение мока, не production-кода.
8. **Vite chunk >500 kB** — предупреждение сборки, существовавшее до E8; не
   связано с функциональностью среза.

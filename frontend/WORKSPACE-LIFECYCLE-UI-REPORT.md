# WORKSPACE-LIFECYCLE-UI — отчёт

**Статус: DONE.**

Скоуп: только `frontend/**`. Backend #99 уже отдаёт
`DELETE /workspaces/{id}/members/me`, `DELETE /workspaces/{id}` и аддитивный
`ChatSummary.member_count`; контракт — **132 paths / 162 operations / 212 schemas**.
E2EE, контракт и серверные ручки не менялись.

## 1. Настройки → «Опасная зона»

`WorkspaceSettingsPanel` получил карточку `WorkspaceDangerZoneCard`:

- **«Покинуть пространство»** — доступна ACTIVE MEMBER/ADMIN/GUEST; для
  единственного OWNER кнопка `disabled` и показана честная причина
  `LAST_OWNER` (выйти нельзя, только передать владение или удалить
  пространство).
- **«Удалить пространство»** — только OWNER; для остальных ролей кнопка
  `disabled` с объяснением «может только владелец». Сервер всё равно
  перепроверяет право и отдаёт `403 WORKSPACE_PERMISSION_DENIED`.
- Подтверждение выхода называет пространство и перечисляет последствия
  (потеря чатов/файлов/участников, возврат только по приглашению).
- Удаление — **typed-name confirmation**: кнопка подтверждения включается
  только после точного ввода названия (с учётом регистра, `trim`); рядом
  предупреждение о необратимости. В тексте честно сказано, что строки
  чатов/сообщений/файлов сохраняются на сервере по retention-политике, но
  доступ исчезает сразу.
- Использованы Sova-стили: `.card`, `.danger-card`, `.btn--danger`,
  `AdminConfirmDialog`; новых «самодельных» модалок нет.

## 2. Switcher и rail

- `WorkspaceSwitcher`: в меню текущего пространства появился блок
  «Текущее пространство» с одним role-aware действием —
  OWNER → «Удалить пространство», MEMBER/ADMIN/GUEST → «Покинуть
  пространство». Для sole OWNER выход не показывается.
- `SpaceRail`: у каждого пространства есть компактная action-кнопка
  (`TrashIcon` для OWNER, `LogoutIcon` для остальных), видимая на
  hover/focus и всегда на touch. Для OWNER кнопки «Покинуть» нет; для
  не-OWNER нет «Удалить». Роль берётся из `RailSpace.role`; при неизвестной
  роли (dev-сессия) действие не рендерится.
- Оба входа открывают один и тот же `WorkspaceLifecycleDialogs` в
  `AppShell`, поэтому тексты, role gates и обработка ошибок совпадают с
  настройками.
- Ошибки показываются в диалоге и не закрывают его:
  `409 LAST_OWNER` → «Вы последний владелец…»; `403` → честный текст для
  leave/delete; `404`/сеть/5xx/429 → «недоступно/повторите».
- `AdminConfirmDialog` расширен аддитивным `confirmDisabled` — им управляет
  typed-name проверка; остальные вызовы не затронуты.

## 3. Состояние после leave/delete

`chatStore`:

- Новое состояние `workspaceLifecycle` (`workspaceId`, `action`, `status`,
  `error`) и методы `leaveWorkspace` / `deleteWorkspace` /
  `clearWorkspaceLifecycle`.
- На `204`:
  - workspace удаляется из `workspaces`, `workspaceUnread` и
    `unreadWorkspaceRequests`;
  - выполняется авторитетный `GET /me`, список и `default_workspace_id`
    приводятся к ответу сервера (при сбое `/me` остаётся локально
    согласованный список — успешный `204` не превращается в ошибку);
  - если удалён активный workspace — активируется следующий
    (`activateWorkspace`) либо открывается onboarding
    (`onboardingRequired: true`, `sessionStatus: ready`);
  - `enterWorkspaceOnboarding` останавливает realtime и звонки, сбрасывает
    files/overview/security/profile/avatars/bots, чистит chats/slices/threads,
    уведомления, упоминания, лимиты, typing/presence и device workspace id.
- «Никаких протухших сокетов/состояния»: добавлен `workspaceGeneration`,
  который инвалидирует поздний `listChats`/`activateWorkspace` после
  удаления; `loadWorkspaceUnread` больше не воскрешает badge удалённого
  workspace. Realtime останавливается до patch-а, подписки активного
  workspace пересоздаются только для нового активного.
- `chat/member_count refresh`: следующий workspace загружается через
  `GET /workspaces/{id}/chats`, поэтому точный `ChatSummary.member_count`
  сразу попадает в sidebar/header; после leave/delete старый чат-список и
  его счётчики не остаются в состоянии.

## 4. MSW и тесты

MSW (`src/mocks/handlers.ts`, `src/mocks/db.ts`):

- `DELETE /workspaces/:id/members/me` — литеральный `/me` зарегистрирован
  раньше `:userId`; `409 LAST_OWNER` для OWNER, `403` для не-участника,
  удаление workspace/чатов из mock-БД;
- `DELETE /workspaces/:id` — `403 WORKSPACE_PERMISSION_DENIED` для
  не-OWNER;
- журнал `workspaceLifecycleRequests` и инъекции
  `forceWorkspaceLeaveError` / `forceWorkspaceDeleteError`.

Новый `src/components/WorkspaceLifecycle99.test.tsx` (9 тестов, все зелёные):

1. MEMBER выходит после подтверждения с названием → onboarding, state clean.
2. Sole OWNER: leave disabled + объяснение, delete enabled.
3. Честный `409 LAST_OWNER` (форс через MSW): диалог открыт, workspace жив.
4. OWNER delete: кнопка disabled до точного имени, затем `DELETE`, onboarding.
5. ADMIN: leave enabled, delete disabled.
6. Rail: у OWNER нет leave, есть delete; открывается typed-confirm.
7. Rail/switcher: у MEMBER есть leave и нет delete; меню switcher открывает
   тот же диалог.
8. Delete активного workspace → переключение на следующий, его чаты
   загружены, `member_count = 5` прочитан из `ChatSummary`.
9. axe (serious/critical = 0) с открытым typed-delete диалогом.

Обновлён `Dashboard.test.tsx`: rail-селекторы сужены до
`^Пространство: …`, чтобы не пересекаться с новыми action-кнопками
(`Удалить/Покинуть пространство: …`).

## 5. Верификация

```bash
cd frontend
npm run lint              # 0 errors (1 pre-existing warning)
npm run format:check
npm run contract:check    # 162 operations / 212 schemas, types in sync
npm run security:check
npm run session-writers:check
npm test                  # 141 files / 1358 tests passed
npm run build             # tsc --noEmit + vite build
npm run check             # всё выше, exit 0
```

Было 1349 тестов, стало **1358** (+9). Полный `npm run check` — exit 0.

## 6. Файлы

Новые:

- `frontend/src/components/WorkspaceLifecycleDialogs.tsx`
- `frontend/src/components/WorkspaceLifecycle99.test.tsx`
- `frontend/src/workspace/lifecycle.ts`
- `frontend/WORKSPACE-LIFECYCLE-UI-REPORT.md`

Изменённые:

- `frontend/src/api/endpoints.ts` — `leaveWorkspace` / `deleteWorkspace`
- `frontend/src/store/chatStore.ts` — lifecycle state, cleanup, generation guard
- `frontend/src/components/AppShell.tsx` — единая точка диалогов
- `frontend/src/components/workspace/WorkspaceSettingsPanel.tsx` — danger zone
- `frontend/src/components/pages/SettingsPage.tsx` — проброс действия
- `frontend/src/components/SpaceRail.tsx`, `WorkspaceSwitcher.tsx`, `Sidebar.tsx`
- `frontend/src/components/admin/AdminConfirmDialog.tsx` — `confirmDisabled`
- `frontend/src/i18n/ru.ts` — тексты lifecycle
- `frontend/src/mocks/db.ts`, `frontend/src/mocks/handlers.ts`
- `frontend/src/styles/app.css` — rail action / switcher danger / typed input
- `frontend/src/components/Dashboard.test.tsx` — уточнённые rail-селекторы

## 7. Ограничения

- В текущей схеме ровно один OWNER, поэтому self-leave владельца всегда
  `409 LAST_OWNER`; UI не предлагает ему выход в rail/switcher и показывает
  disabled-кнопку с объяснением в настройках.
- Удаление soft: контент и S3-байты остаются до retention/export job; UI
  предупреждает об этом и о необратимости доступа.
- Глобальные Keycloak-сессии не отзываются (общая сессия на несколько
  воркспейсов); доступ отзывается серверной перепроверкой membership, а
  клиент сразу удаляет workspace-scoped состояние и останавливает realtime.

## Итог

**DONE** — UI выхода/удаления пространства, role gates, подтверждения,
очистка состояния, переключение/onboarding, MSW и тесты (включая axe)
реализованы; `npm run check` зелёный, 1358 тестов.

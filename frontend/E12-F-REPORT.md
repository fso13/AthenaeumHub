# E12-F — workspace members management (list / add / role / remove)

> Формат — `docs/TASKS.md` §5. Зона сессии: только `frontend/**`.
> `backend/**`, `contracts/**`, `docs/**`, `design/**` и
> `frontend/src/api/schema.d.ts` не менялись. Git-репозитория в рабочем дереве нет,
> поэтому «одним PR» проверить нельзя — изменения согласованы в рабочем дереве.

## Статус

**DONE в границах E12-F.** Реализованы R-09 / FR-WS-4…FR-WS-7
(`docs/SYSTEM-ANALYSIS.md` §18.6, `docs/TASKS-ADMIN-V2.md` E12) на фронтенде:
типизированные `addWorkspaceMember` / `changeWorkspaceMemberRole` /
`removeWorkspaceMember`, диалог «Участники» из sidebar с поиском/refresh,
добавлением по email с ролью, сменой роли и удалением с confirm; OWNER/ADMIN-
контролы, read-only для MEMBER/GUEST, разбор серверных `403/404/409` без потери
строки. E9–E11 admin, E10 DIRECT и E2EE-флаг не затронуты; новых env-переменных
нет.

**Проверки (финальное дерево):**

| Проверка                                                                                    | Результат                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run check` (lint, format, contract, stickers, security, session-writers, tests, build) | **PASS**, exit 0                                                          |
| Unit/RTL (`vitest run`)                                                                     | **730 / 730** тестов, **71** файл                                         |
| `npm run contract:check`                                                                    | **PASS** — 47 paths / 55 operations / 87 schemas, `schema.d.ts` синхронен |
| Новые тесты E12-F                                                                           | **12** (`src/components/WorkspaceMembers.test.tsx`)                       |
| axe (RTL, диалог участников)                                                                | 0 serious/critical violations                                             |
| Backend/contracts/docs/design/schema.d.ts                                                   | не изменялись                                                             |

Прирост тестов: **718 → 730** (+12). `check-contract.mjs` уже содержал
E12-инварианты и счётчики 47/55/87; в этой сессии скрипт не менялся.

## Сделано

### 1. Typed API (только контрактные формы)

`src/api/types.ts`:

- `AssignableMemberRole = Exclude<WorkspaceMemberRole, 'OWNER'>`;
- `AddWorkspaceMemberRequest`, `ChangeWorkspaceMemberRoleRequest` — алиасы
  сгенерированных схем (ни одного hand-written поля).

`src/api/endpoints.ts`:

- `addWorkspaceMember(workspaceId, body)` → `POST /workspaces/{workspaceId}/members`
  → `201 WorkspaceMember`;
- `changeWorkspaceMemberRole(workspaceId, userId, body)` →
  `PATCH /workspaces/{workspaceId}/members/{userId}` → `200 WorkspaceMember`;
- `removeWorkspaceMember(workspaceId, userId)` →
  `DELETE /workspaces/{workspaceId}/members/{userId}` → `204`.
- `X-Device-Id` и `Authorization` добавляет общий `ApiClient`;
  `Idempotency-Key` не выдуман — контракт его для этих мутаций не объявляет.
- Ошибки проходят через общий `withReauth`/`problem` (`ApiError {status, code,
details, request_id}`), без собственного парсинга.

### 2. Store: сервер — источник истины

`src/store/chatStore.ts`:

- новый срез `workspaceMemberAdmin`:
  `addStatus/addError`, `rolePendingUserId/roleError`, `removePendingUserId/removeError`;
- `addWorkspaceMember(email, role)` — клиентская проверка формата email
  (≤254, `format: email`) и запрета `OWNER`, затем `POST`; после `201` первая
  страница **перечитывается** с сервера (`display_name ASC, user_id ASC`), поэтому
  строка не «дорисовывается» оптимистично;
- `changeWorkspaceMemberRole(userId, role)` — `PATCH`; строка заменяется
  **ответом `200`**, при ошибке роль/строка не меняются; `OWNER` отклоняется и
  на клиенте (defense in depth);
- `removeWorkspaceMember(userId)` — `DELETE`; после `204` список перечитывается,
  при ошибке строка остаётся;
- race guards: `clearWorkspaceMembers()`/workspace switch инвалидируют старые
  ответы; forced refresh после мутации начинает новую цепочку даже при
  in-flight-запросе (`!options.force` в guard'е);
- `reset()` и `activateWorkspace()` очищают `workspaceMemberAdmin`; смена
  workspace не переносит чужие строки/ошибки;
- 401 обрабатывается общим `handleFailure`; 429 — общим `handleRateLimit`.

### 3. Members UI

Новый `src/components/WorkspaceMembersDialog.tsx`:

- вход — кнопка **«Участники»** рядом с переключателем workspace в sidebar
  (`src/components/Sidebar.tsx`), доступна и при одном workspace; рендерится
  только при `sessionStatus === 'ready'`;
- диалог: `role="dialog"`, `aria-modal`, `aria-labelledby`/`aria-describedby`,
  заголовок «Участники пространства», lead с именем workspace;
- список: `display_name`, роль, `joined_at` (через `formatDateTime`), аватар;
  **email в списке не рендерится** — только в форме добавления;
- поиск — literal `query` к серверу (debounce 300 мс, ≤80 символов), refresh,
  cursor-пагинация по `has_more`/`next_cursor` («Показать ещё»);
- **OWNER/ADMIN**: форма «Добавить участника» (email + роль), select роли в
  управляемых строках, «Удалить» с confirm;
- **MEMBER/GUEST**: тот же серверный список read-only; форма, select'ы и кнопки
  удаления не рендерятся;
- `OWNER` не предлагается: OWNER-актор видит в add/edit `ADMIN/MEMBER/GUEST`,
  ADMIN-актор — только `MEMBER/GUEST`; строки OWNER и себя read-only, ADMIN не
  управляет другим ADMIN;
- смена роли — `onChange` select; при `409/403` select остаётся на прежней роли,
  под строкой `role="alert"` с понятным текстом;
- удаление — только через `AdminConfirmDialog` (имена цели, последствия,
  аудит, destructive-кнопка). Отмена/Esc не удаляют; ошибка оставляет диалог и
  строку; после `204` confirm закрывается, список перечитывается;
- состояния: skeleton, empty (без поиска и «по запросу … никого не нашли»),
  error + retry, ошибка refresh при уже загруженных строках, ошибка load-more,
  `role=status` для счётчика/успеха, `role=alert` для ошибок;
- успех add/role/remove показывается `role="status"` («Участник добавлен»,
  «Роль обновлена», «Участник удалён»).

### 4. Ошибки и лимит

- `403` → «Недостаточно прав для управления участниками»;
  `403 ROLE_CHANGE_FORBIDDEN` → «Недостаточно прав для этой роли»;
- `404 USER_NOT_FOUND` → «Пользователь не найден или неактивен; приглашения
  пока не поддерживаются»; `404 MEMBER_NOT_FOUND` → «Обновите список»;
- `409 MEMBER_ALREADY_EXISTS` → «Этот пользователь уже состоит в пространстве»;
- `409 WORKSPACE_MEMBER_LIMIT_REACHED` → серверные `details.used`/`details.limit`
  («Достигнут лимит участников: 4 из 4»); без details — общий текст лимита;
- `409 LAST_OWNER` / `SELF_ACTION_FORBIDDEN` → отдельные понятные тексты;
- `400/422` → валидация email/полей; `5xx/network` → `describeError` + retry.

`WorkspaceLimits` не содержит `max_workspace_members`, поэтому UI **не изобретает**
счётчик «участников из лимита»: usage показывается только из серверного `409`, как
и требует задача («иначе показать ошибку сервера»).

### 5. Доступность и адаптивность

- Focus trap по Tab/Shift+Tab, initial focus на поиске, Esc закрывает диалог;
  при открытом confirm Esc закрывает **только** confirm (у него свой trap и
  возврат фокуса на кнопку удаления);
- закрытие возвращает фокус на кнопку «Участники»; после успешного удаления
  (триггер исчез) фокус уходит на поиск;
- backdrop закрывает только при отсутствии in-flight-мутаций; body scroll lock;
- 390 px: toolbar и действия строки складываются вертикально, диалог
  `width: min(760px, 100%)`, `padding` 8–12 px, без горизонтального скролла;
  touch-targets ≥44 px на coarse pointer (общие токены); новых hex-значений нет;
- axe в RTL: 0 serious/critical; ошибки/успех — `alert`/`status`.

### 6. MSW / dev-моки

`src/mocks/fixtures.ts`, `db.ts`, `handlers.ts`:

- `buildMemberUsers()` — mock-only каталог зарегистрированных email (включая
  текущих участников и двух кандидатов `olga@krug.test` / `pavel@krug.test`);
- `POST /workspaces/{id}/members`: OWNER/ADMIN guard, `OWNER`/ADMIN→ADMIN запрет,
  `404 USER_NOT_FOUND`, `409 MEMBER_ALREADY_EXISTS`, атомарный
  `max_workspace_members` → `409` с `details.scope/limit/used`;
- `PATCH /workspaces/{id}/members/{userId}`: `403/404/409` для
  self/last-owner/ADMIN-vs-ADMIN, no-op `200`, `OWNER` не назначается;
- `DELETE /workspaces/{id}/members/{userId}`: soft-removal в mock-модели,
  self/last-owner/ADMIN-vs-ADMIN guards, `204`;
- журналы запросов (`memberAddRequests`, `memberRoleRequests`,
  `memberRemoveRequests`, включая `deviceId`) и knobs
  `forceMemberAddError`/`forceMemberRoleError`/`forceMemberRemoveError`;
- GET остаётся ACTIVE-only и отдаёт только `user_id/display_name/role/joined_at`.

### 7. Тесты

`src/components/WorkspaceMembers.test.tsx` (12):

1. OWNER добавляет существующего пользователя по email; в списке нет email,
   форма очищается, запрос/роль проверены;
2. duplicate → `409 MEMBER_ALREADY_EXISTS`, email и строка сохранены;
3. limit → `409 WORKSPACE_MEMBER_LIMIT_REACHED` с `4 из 4`, строка не добавлена;
4. ADMIN-актор видит только `MEMBER/GUEST`, не управляет OWNER/другим ADMIN;
5. MEMBER — read-only: нет add-формы, select'ов и destructive-кнопок;
6. серверный `403` на add → alert, строки не меняются;
7. успешная смена роли применяется после `200` (запрос + серверный ответ);
8. `409 LAST_OWNER` при смене роли и `409 SELF_ACTION_FORBIDDEN` при удалении
   оставляют строку/роль/confirm;
9. удаление: отмена сохраняет строку, confirm → `204` + refresh, строка исчезает;
10. поиск по имени, empty-state «никого не нашли», refresh;
11. Esc/focus trap/return, confirm поверх списка;
12. axe для открытого диалога.

Покрыты требования: add/role/remove, limit, duplicate, 403, last-owner/self,
keyboard/axe, сохранение строки при ошибке.

### 8. README

`frontend/README.md` дополнен разделом **E12-F** (API, права, ошибки, доступность,
тесты), обновлены архитектура, покрытые состояния, счётчики тестов и контракта.

## Риски / follow-up

- **Нет предварительного usage-счётчика участников**: `WorkspaceLimits` не
  содержит `max_workspace_members`, а `/admin/settings` доступен только platform
  admin. UI честно показывает лимит из `409 details`; отдельный публичный
  members-limit в контракте — follow-up backend/contract.
- **`USER_NOT_FOUND` — email-existence oracle** для OWNER/ADMIN workspace
  (требование FR-WS-5). UI показывает его только в форме добавления; публичного
  раскрытия нет, но при внешнем развёртывании стоит помнить.
- **Actor role из `/me`**: после смены роли другим админом UI может показывать
  устаревшие контролы до refresh; сервер всё равно отвечает `403/409`, строка не
  теряется. В dev-режиме workspace-role projection нет — диалог открывается
  read-only (осознанно, чтобы не показывать destructive-контролы без роли).
- **Удаление — soft**: строка членства сохраняется, повторный add даёт `409`
  `MEMBER_ALREADY_EXISTS` (поведение backend E12-B); UI не обещает «пригласить
  заново». Восстановление/передача OWNER — вне scope.
- **Confirm-ошибка `404 MEMBER_NOT_FOUND`** оставляет строку (требование «сохранять
  строку при ошибке»); пользователь может нажать refresh. Автоматического
  удаления «фантомной» строки нет.
- **E2E не расширялся**: покрытие E12-F — RTL + MSW + axe. При необходимости
  двух-девайс сценарий F7B (добавление второго пользователя) можно добавить в
  `e2e/` отдельным срезом.
- **Приглашения** на незарегистрированный email и SCIM — v1.1 (в UI прямо
  сказано, что приглашения появятся позже).

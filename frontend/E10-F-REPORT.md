# E10-F — member directory + DIRECT chats (frontend)

> Срез **E10-F** по `docs/TASKS-ADMIN-V2.md` (E10) и R-01 из
> `docs/SYSTEM-ANALYSIS.md` §17.1. Зона — `frontend/**`; `backend/**`,
> `contracts/**`, `docs/**`, `design/**` и `src/api/schema.d.ts` не менялись.
> E9 admin/media/auth и E2EE-флаг (`VITE_E2EE_ENABLED=false`) не затронуты.

## Статус

**DONE в границах E10-F.** DIRECT-чат создаётся через member picker:
`GET /workspaces/{workspaceId}/members` типизирован (cursor/search), диалог
переключает GROUP/DIRECT, DIRECT отправляет только `{type:'DIRECT', peer_id}`,
после успеха список обновляется и чат открывается. Все проверки — ниже.

- `npm test`: **672/672** (65 files; было 661, +11 net).
- `npm run check`: **PASS** — lint, prettier, contract, stickers, security,
  session-writers, tests, production build.
- `npm run contract:check`: **PASS** — **42 paths / 48 operations /
  83 schemas**, `schema.d.ts` синхронен; member operation входит в проверяемый
  список.
- Backend/contract файлы не изменялись; backend suite E10-B (434) не
  перезапускался в этой сессии.

## API

`src/api/types.ts`:

- `WorkspaceMember` (`user_id`, `display_name`, `role`, `joined_at`) — из
  `schema.d.ts`;
- `WorkspaceMemberPage` (`items`, `next_cursor`, `has_more`);
- `WorkspaceMemberRole` (`OWNER | ADMIN | MEMBER | GUEST`).

`src/api/endpoints.ts`:

- `ListWorkspaceMembersQuery { query?, cursor?, limit? }`;
- `ChatApi.listWorkspaceMembers(workspaceId, query?) : Promise<WorkspaceMemberPage>`;
- `query` тримится и не отправляется пустым (сервер применяет default 50);
  `cursor` только echo `next_cursor`; `limit` = 50;
- `X-Device-Id` добавляет существующий `ApiClient`, поэтому endpoint проходит
  `requireAuth` и в MSW, и в реальном контуре. Поля не изобретались.

Store (`src/store/chatStore.ts`):

- `workspaceMembers` — отдельный slice (`items`, `query`, `status`, `error`,
  `nextCursor`, `hasMore`, `loadMoreStatus`, `loadMoreError`);
- `loadWorkspaceMembers({query, force})`, `searchWorkspaceMembers(query)`,
  `loadMoreWorkspaceMembers()`, `clearWorkspaceMembers()`;
- смена поиска начинает новую cursor-цепочку и инвалидирует старый in-flight
  ответ; страницы append + дедупликация по `user_id`;
- состояние сбрасывается на workspace switch/logout и при открытии диалога;
- `createChat` принимает `string` (GROUP, обратная совместимость) или
  `{type:'GROUP', name}` / `{type:'DIRECT', peerId}`; для GROUP сохраняет
  прежнее поведение и optimistic-free refresh.

## CreateChatDialog

- **Тип чата** — нативная radio-группа в `fieldset`/`legend`; стрелки, Tab,
  `:focus-within`, `disabled` для GROUP без роли `OWNER`/`ADMIN`.
- **GROUP** — имя 1..120, счётчик, локальная валидация, payload
  `{type:'GROUP', name}`, никакого `peer_id`.
- **DIRECT** — member picker:
  - поиск с debounce 300 мс, `maxLength=80`, literal-семантика сервера;
  - список `display_name` + роль, single-select radio, **self исключён**;
  - skeleton (3 строки, `role=status`), empty для пустого каталога и поиска,
    error + retry, «Показать ещё» + retry для `loadMoreError`;
  - ArrowDown из поиска фокусирует первый radio; список ограничен по высоте;
  - payload `{type:'DIRECT', peer_id}`, без `name`.
- **Идемпотентность** — `Idempotency-Key` генерируется при открытии диалога и
  переиспользуется только для идентичного fingerprint (тип + имя/peer). Новое
  открытие/смена выбора — новый ключ. После успеха: refresh `GET /chats`,
  `setActiveChat`, закрытие; optimistic-чат не вставляется.
- **Ошибки** — `CHAT_LIMIT_REACHED` (`scope=USER|WORKSPACE`, `limit`, `used`),
  `400`/`422` peer/name (`details.field=peer_id` → peer-сообщение), `403`;
  диалог остаётся открытым, введённые данные не теряются.
- **Имя DIRECT-чата** — `ChatSummary.name` nullable. `domain/chatLabel.ts`
  резолвит peer по загруженному каталогу; sidebar/header/aria-label не
  показывают название предыдущего group-чата. Если каталог ещё не загружен
  (например, после reload), используется нейтральное «Личный чат».

## UX / доступность / 390 px

- Видимые labels, `aria-describedby` только на существующие узлы,
  `aria-invalid` для имени, `role=alert` для ошибок, `role=status` для
  счётчика/skeleton, `progressbar` для лимита.
- Focus-trap и Escape сохранены; после открытия фокус уходит в поле имени для
  GROUP и в поиск для DIRECT; после закрытия фокус возвращается на элемент,
  который открыл диалог (кнопка «+»).
- CSS — только токены E9-F (`--accent*`, `--radius*`, `--line*`); на ≤480 px
  диалог прижат к низу, actions переносятся, список скроллится внутри, без
  горизонтального скролла на 390 px.
- Email/устройства/ключи не рендерятся и не запрашиваются: в контракте их нет,
  в UI нет placeholder-полей.

## Тесты

`src/components/CreateChat.test.tsx` — **18** тестов (было 7):

1. GROUP-создание: payload, idempotency UUID, refresh + open, без dialog.
2. Replay того же `Idempotency-Key` не создаёт дубль.
3. DIRECT: загрузка каталога, self исключён, email отсутствует, limit=50.
4. Поиск уходит на сервер literal-строкой и обновляет список.
5. DIRECT-создание: `{type:'DIRECT', peer_id}`, без `name`, +1 чат, active chat,
   заголовок peer-имени.
6. Fresh `Idempotency-Key` на каждое открытие диалога.
7. `400 peer_id` — сообщение, диалог открыт, чат не создан.
8. Empty: в каталоге только self → empty state, submit disabled.
9. Error + retry: 500 → error, retry → список.
10. Load more: `next_cursor` уходит обратно, строки append.
11. `MEMBER`: DIRECT доступен, GROUP radio disabled, диалог открывается на DIRECT.
12. Лимит в sidebar: при `used >= max` кнопка создания disabled.
13. Лимит в диалоге обновляется после `loadChatLimits(true)`.
14. `409` USER и WORKSPACE для GROUP, без optimistic-чата.
15. `409` для DIRECT.
16. `422` GROUP name, диалог открыт.
17. Локальная валидация пустого имени без API-вызова.
18. axe (serious/critical = 0) для DIRECT picker.

Полный `npm test`: **672/672**. `npm run check`: **PASS**. Contract guard:
**42/48/83** и `schema.d.ts` в синхроне.

E2E `e2e/chat-create.spec.ts` — **3/3 PASS** (Chromium из
`frontend/.playwright-browsers`, `VITE_USE_MOCKS=true`): GROUP-создание,
409 CHAT_LIMIT_REACHED и DIRECT через member picker на **390 px** с axe
(WCAG 2.0/2.1 A/AA) и проверкой `scrollWidth <= clientWidth`.

## Приёмка E10

| Пункт                                                           | Статус             |
| --------------------------------------------------------------- | ------------------ |
| `listWorkspaceMembers(workspaceId,{query,cursor,limit})` typed  | ✅                 |
| Cursor pagination (`next_cursor`, `has_more`, append/дедуп)     | ✅                 |
| GROUP/DIRECT accessible radios                                  | ✅                 |
| GROUP: имя как раньше                                           | ✅ регрессия       |
| DIRECT: search, display_name/role, self excluded, single select | ✅                 |
| DIRECT: load/empty/error/retry/load more                        | ✅                 |
| Submit: DIRECT `{type,peer_id}` без name; GROUP `{type,name}`   | ✅ тесты payload   |
| Fresh idempotency key per dialog                                | ✅                 |
| `409 CHAT_LIMIT_REACHED`, `400` peer, `422`                     | ✅                 |
| Refresh list/open chat/close, no optimistic chat                | ✅                 |
| Keyboard, aria, skeleton, 390 px, focus                         | ✅ + axe           |
| No email leak                                                   | ✅ контракт + тест |
| Backend/contract не менялись                                    | ✅                 |
| README                                                          | ✅ раздел E10-F    |

## Риски и вопросы

1. **Имя DIRECT-чата после reload.** `ChatSummary.name` для DIRECT равен
   `null`, а каталог загружается только при открытии DIRECT-диалога. Сразу
   после создания имя peer есть (каталог в памяти), после перезагрузки до
   первого открытия picker — нейтральное «Личный чат». Полное решение —
   отдельный кэш имён или загрузка каталога на bootstrap; в E10-F не делалось,
   чтобы не добавлять лишний запрос на каждый вход.
2. **Mock member directory статичен** и общий для всех workspace; реальный
   backend фильтрует по active membership/RLS и отдаёт `403`. UI-контракт
   (403 → сообщение) покрыт, но mock не моделирует разные составы пространств.
3. **Поиск/пагинация** — debounce 300 мс и страница 50; для очень больших
   пространств пользователь листает «Показать ещё». Cursor opaque и не
   подписан (общий риск cursor-страниц, см. E10-B).
4. **Self-check на клиенте** (`peerId === viewerId`) — только UX; сервер
   отклоняет self-peer независимо от UI.
5. **GROUP-права.** В dev-режиме нет `activeWorkspace.role`, поэтому GROUP
   разрешён (как и раньше); в password-режиме роль приходит из `/me` и
   `MEMBER` видит GROUP disabled. Сервер остаётся источником истины.
6. **E2EE.** Флаг выключен; DIRECT в E2EE-workspace унаследует режим на
   сервере. Picker не запрашивает устройства/ключи и не показывает их.

## Файлы E10-F

- `frontend/src/api/types.ts`
- `frontend/src/api/endpoints.ts`
- `frontend/src/store/chatStore.ts`
- `frontend/src/components/CreateChatDialog.tsx`
- `frontend/src/components/CreateChat.test.tsx`
- `frontend/src/components/Sidebar.tsx`
- `frontend/src/components/ChatHeader.tsx`
- `frontend/src/components/ChatScreen.tsx`
- `frontend/src/domain/chatLabel.ts`
- `frontend/src/i18n/ru.ts`
- `frontend/src/styles/app.css`
- `frontend/src/mocks/db.ts`
- `frontend/src/mocks/fixtures.ts`
- `frontend/src/mocks/handlers.ts`
- `frontend/e2e/chat-create.spec.ts`
- `frontend/README.md`
- `frontend/E10-F-REPORT.md`

# #79 Участники канала, invite-ссылки и блокировки — отчёт frontend

> Зона сессии: только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**` и `schema` не менялись. `contracts/openapi.yaml` уже содержал
> операции и схемы #79 (`ChatMember`, `ChatMemberIds`, `ChatInvite*`,
> `InviteAcceptResult`, `BlockedUser*`), а `src/api/schema.d.ts` был
> регенерирован backend-сессией; ручных DTO поверх контракта не добавлено.
> `npm run contract:check` подтверждает синхронность. Git-репозитория в
> рабочем дереве нет; проверка — типами, линтом, MSW-тестами, axe и полной
> сборкой.

## Статус

**DONE.** В «Настройках чата» появился настоящий экран участников канала:
список с `display_name`/ролью/статусом/датой вступления, добавление ACTIVE
участника пространства с поиском и ролью, смена роли по правилам
OWNER/ADMIN, удаление и выход. В «Основном» и «Участниках» работают
invite-ссылки (роль, срок, лимит вступлений, одноразовый показ токена, список
ACTIVE/EXPIRED/EXHAUSTED/REVOKED, отзыв), добавлен маршрут `/invite/:token` с
явным принятием приглашения. В DIRECT работает блокировка контакта, а
заблокированные пользователи видны в профиле и настройках с разблокировкой.

## 1. API: типы и операции

`src/api/types.ts` — типы строго из `schema.d.ts`:

- `ChatMember`, `ChatMemberRole`, `ChatMemberStatus`, `ChatMembersResponse`;
- `AddChatMemberRequest`, `ChangeChatMemberRoleRequest`;
- `ChatInvite`, `ChatInviteRole`, `ChatInviteStatus`, `ChatInviteCreated`,
  `ChatInviteCreateRequest`, `ChatInviteList`, `InviteAcceptResult`;
- `BlockedUser`, `BlockedUserList`.

`src/api/endpoints.ts` — все операции #79:

| Операция                                    | Метод клиента                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /chats/{chatId}/members`               | `listChatMembers` (теперь `ChatMembersResponse`: `members[]` + совместимый `user_ids[]`) |
| `POST /chats/{chatId}/members`              | `addChatMember`                                                                          |
| `PATCH /chats/{chatId}/members/{userId}`    | `changeChatMemberRole`                                                                   |
| `DELETE /chats/{chatId}/members/{userId}`   | `removeChatMember`                                                                       |
| `POST /chats/{chatId}/leave`                | `leaveChat`                                                                              |
| `GET/POST /chats/{chatId}/invites`          | `listChatInvites`, `createChatInvite`                                                    |
| `DELETE /chats/{chatId}/invites/{inviteId}` | `revokeChatInvite`                                                                       |
| `POST /invites/{token}/accept`              | `acceptChatInvite`                                                                       |
| `POST/DELETE /users/{userId}/block`         | `blockUser`, `unblockUser`                                                               |
| `GET /me/blocked`                           | `listBlockedUsers`                                                                       |

`Idempotency-Key` для этих операций не изобретался: контракт его не требует
(create-invite специально не использует ключ, иначе пришлось бы хранить сырой
токен). Токен accept-ссылки кодируется один раз через `encodeURIComponent`.
Групповой звонок продолжает читать `listChatMembers().user_ids` через store,
поэтому #77 не затронут.

## 2. Store: сервер — единственный источник истины

`src/store/chatStore.ts`:

- Новые срезы состояния:
  - `chatMembers` — `chatId`, список, status/error, add/role/remove/leave
    feedback и ошибки по конкретной строке;
  - `chatInvites` — список, одноразовый `created` (сырой токен), create/revoke
    feedback;
  - `blockedUsers` — собственные блокировки, pending/action error;
  - `inviteAccept` — статус/результат/ошибка принятия ссылки.
- Новые методы: `loadChatMembers`, `addChatMember`, `changeChatMemberRole`,
  `removeChatMember`, `leaveChat`, `clearChatMembers`,
  `loadChatInvites`, `createChatInvite`, `revokeChatInvite`,
  `clearChatInvites`, `loadBlockedUsers`, `blockUser`, `unblockUser`,
  `acceptChatInvite`, `openInviteTarget`, `resetInviteAccept`.
- Никаких оптимистичных строк/ролей: add/PATCH/DELETE заменяют состояние
  только после `201/200/204`; ошибка сохраняет строку и код для честного
  сообщения.
- Гонки закрыты generation-токенами для участников и ссылок; ответ для
  другого чата/воркспейса отбрасывается. Переключение workspace, `reset()`,
  закрытие диалога инвалидируют запросы.
- `leaveChat` после `204` убирает канал из локального списка, удаляет slice и
  выбирает следующий чат; при ошибке канал остаётся.
- `openInviteTarget` перечитывает список чатов активного workspace и
  открывает принятый канал; для другого workspace используется
  `selectWorkspace`.
- Доменные помощники: `isChatManagerRole`, `assignableChatRoles`,
  `canManageChatMember`, `isChatRole`; роли канала не подменяются ролями
  workspace.

## 3. «Настройки чата» → «Участники»

`src/components/ChatSettingsDialog.tsx`,
`src/components/chat-settings/ChatMembersPanel.tsx`.

- Список — `GET /chats/{id}/members`: аватар, `display_name`, метка «Вы»,
  роль, статус (`Активен`), `joined_at` в локализованном формате. Email,
  устройства и ключи не запрашиваются и не рендерятся.
- Состояния: skeleton при первой загрузке, empty, error + «Повторить»,
  stale-error с retry при уже загруженных строках, notice после успеха.
- Добавление:
  - поиск по ACTIVE-участникам пространства через существующий
    `GET /workspaces/{id}/members` (debounce 300 мс, literal query);
  - select кандидата, уже состоящие в канале исключены; состояния
    «Загружаем…», «Никого не нашли», «Все уже в канале», error + retry;
  - select роли; OWNER канала может назначить любую роль (включая OWNER),
    ADMIN — только MODERATOR/MEMBER/GUEST;
  - `POST`, после `201/200` строка берётся из ответа сервера.
- Смена роли — select у строки; варианты ограничены ролью зрителя канала;
  своя строка и (для ADMIN) строки OWNER/ADMIN не редактируются. `409
LAST_OWNER`, `409 SELF_ACTION_FORBIDDEN`, `403 ROLE_CHANGE_FORBIDDEN`
  показываются у строки, значение не подменяется.
- Удаление — `AdminConfirmDialog` с последствиями; после `204` строка
  исчезает. `403/404/409/422` остаются в диалоге.
- Выход — своя кнопка «Покинуть канал» с подтверждением и честным
  `LAST_OWNER`; после успешного `leave` диалог закрывается, канал исчезает из
  списка. В «Опасной зоне» та же операция доступна отдельной карточкой.
- Для DIRECT вкладки «Участники» нет; добавление/роли/выход туда не
  отправляются (`422 CHAT_MEMBERSHIP_UNSUPPORTED` остаётся честным, если
  сервер всё же ответит).
- Вложенные confirm-диалоги владеют Escape/фокусом; родительский focus trap
  на это время приостанавливается, фокус возвращается на триггер.

## 4. Invite-ссылки и маршрут принятия

`src/components/chat-settings/ChatInvitesPanel.tsx`,
`src/components/InviteAcceptPage.tsx`, `src/App.tsx`,
`src/components/auth/AuthGate.tsx`.

- «Участники»: форма создания (роль, срок 1 ч/1 д/7 д/30 д, лимит
  без ограничения/1/5/10/25/100), кнопка «Создать ссылку», ошибки 403/422/429.
- Сырой токен показывается **один раз** в поле «Ссылка-приглашение» как
  `${origin}/invite/<token>`; кнопка «Копировать» пишет в clipboard и даёт
  статус «Ссылка скопирована»/честную ошибку. Список метаданных токен и hash
  не содержит и повторно не восстанавливает.
- Список: роль, статус ACTIVE/EXPIRED/EXHAUSTED/REVOKED, `used/max` (или
  «без лимита»), дата истечения и создания; отзыв только у ACTIVE, с
  подтверждением, после `204` строка становится REVOKED.
- «Основное»: компактный блок ссылки — до создания ведёт в «Участники», после
  создания показывает тот же одноразовый URL с копированием.
- `/invite/:token`: `App` разбирает pathname (роутер приложения минимальный),
  `InviteAcceptPage` рендерится в обоих auth-контурах. `AuthGate` сохраняет
  invite-путь через логин, иначе редирект на `/login` терял бы токен.
- Принятие явное (кнопка «Принять приглашение», без молчаливого join):
  `POST /invites/{token}/accept`, `already_member` показывается как «Вы уже
  участник», иначе — «Вы вступили в канал» + роль. `410` разложен на
  `INVITE_EXPIRED`/`INVITE_REVOKED`/`INVITE_EXHAUSTED`; `404`, `403`, `429`
  и сетевые ошибки переведены отдельно. «Открыть канал» перечитывает список
  чатов и открывает `chat_id`; ошибка не выдаёт ложный переход.
- Email-приглашений нет ни в UI, ни в запросах; OWNER по ссылке не выдаётся.

## 5. Блокировки

- DIRECT → «Опасная зона»: карточка контакта реально вызывает
  `POST /users/{peerId}/block` после подтверждения; при загруженном
  `/me/blocked` и уже активной блокировке кнопка становится
  «Разблокировать контакт» (`DELETE`). Ошибки сервера остаются в карточке/
  confirm.
- `src/components/BlockedUsersCard.tsx` — в профиле и на вкладке «Профиль»
  настроек: `GET /me/blocked`, только `user_id` + `blocked_at` (никаких
  выдуманных имён/email), loading/empty/error+retry, разблокировка с
  pending-состоянием и ошибкой по строке.
- После успешной блокировки список перечитывается, а не дополняется
  выдуманным `blocked_at`.

## 6. MSW, фикстуры и тесты

`src/mocks/fixtures.ts`, `src/mocks/db.ts`, `src/mocks/handlers.ts`:

- сид участников GROUP (OWNER/ADMIN/GUEST/MEMBER) и DIRECT; `peer_id` у
  DIRECT-фикстуры;
- сид ссылок ACTIVE/EXPIRED/EXHAUSTED/REVOKED и mock-токены для accept;
- handlers: список/добавление/роль/удаление/leave, create/list/revoke/accept,
  block/unblock/list; серверные ограничения повторены (OWNER/ADMIN ceiling,
  self, last owner, DIRECT 422, роли ссылки, лимиты, 410-коды, idempotent
  accept/block/revoke), плюс инъекция ошибок и наблюдаемые request-записи.

Новые тесты (24):

- `src/components/ChatMembers.test.tsx` — 7: полный список/статусы/дата, add
  с поиском и ролью, смена роли + 409/403 без потери строки, ADMIN ceiling,
  удаление с confirm + 403, LAST_OWNER и успешный leave, forced 403/422 + axe.
- `src/components/ChatInvites.test.tsx` — 12: список статусов без токена,
  create role/expiry/max + одноразовый URL + clipboard, 403 на create,
  переход из «Основного», idempotent accept, реальный join + открытие канала,
  410 expired/revoked/exhausted, malformed URL, 404 unknown, axe.
- `src/components/BlockedUsers.test.tsx` — 5: DIRECT block/unblock, ошибка
  блокировки, список в профиле + unblock, error+retry списка, axe.
- `src/components/ChatSettings.test.tsx` обновлён: нативный список участников
  вместо делегирования в E12, leave доступен, archive/delete по-прежнему
  выключены.

Итог полного прогона: **100 файлов / 1079 тестов passed** (базовая линия
1055; +24 новых).

## 7. Проверки

`npm run check` (exit 0):

- `eslint .` — 0 errors (два прежних warning вне зоны #79);
- `prettier --check .` — все файлы;
- `contract:check` — **97 operations / 134 schemas**, generated types in sync;
- `stickers:check`, `security:check`, `session-writers:check` — passed;
- `vitest run` — 100 files / 1079 tests passed;
- `tsc --noEmit && vite build` — passed.

## 8. Файлы

- `src/api/types.ts`, `src/api/endpoints.ts`
- `src/store/chatStore.ts`
- `src/components/ChatSettingsDialog.tsx`
- `src/components/chat-settings/ChatMembersPanel.tsx`
- `src/components/chat-settings/ChatInvitesPanel.tsx`
- `src/components/chat-settings/errors.ts`
- `src/components/BlockedUsersCard.tsx`
- `src/components/InviteAcceptPage.tsx`
- `src/App.tsx`, `src/components/auth/AuthGate.tsx`, `src/components/AppShell.tsx`
- `src/components/ProfileDialog.tsx`, `src/components/pages/SettingsPage.tsx`
- `src/i18n/ru.ts`, `src/styles/app.css`
- `src/mocks/fixtures.ts`, `src/mocks/db.ts`, `src/mocks/handlers.ts`
- `src/components/ChatMembers.test.tsx`, `src/components/ChatInvites.test.tsx`,
  `src/components/BlockedUsers.test.tsx`, `src/components/ChatSettings.test.tsx`
- `scripts/check-contract.mjs` — только prettier-переформатирование, чтобы
  `format:check` оставался зелёным; счётчики/логика контракта не менялись.

## 9. Границы

- Архивация и удаление чата остаются выключенными: серверных операций в этом
  срезе нет (текст «Опасной зоны» обновлён).
- Workspace-level invite-ссылки (`/workspaces/{id}/invites`) не реализованы —
  это другой срез; настройки пространства по-прежнему честно говорят об
  отсутствии API.
- Блокировка сохраняется и отображается, но не меняет доставку сообщений/
  создание DIRECT: это вне scope backend #79.
- Приглашения не отправляются по email; ссылку пользователь копирует сам.
- В `ChatDetails` кнопки выхода/блокировки остаются выключенными, но подсказки
  обновлены и ведут в «Настройки чата → Опасная зона»; отдельного API-дубля
  там нет.

**DONE.**

# D1.1 (#76) — реальные действия плагинов: опросы, задачи, перевод

> Зона: только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**` и `frontend/src/api/schema.d.ts` не менялись. Контракт в дереве —
> источник истины; новые DTO/операции взяты из уже сгенерированного
> `src/api/schema.d.ts` (`npm run api:types` не потребовался).

## Статус

**DONE.** Включённые плагины теперь имеют реальные серверные действия, а не
только переключатели: опросы с голосованием и закрытием, задачи с
выполнением/переоткрытием и фильтрами, перевод managed `TEXT`-сообщений.
Все результаты приходят из API; оптимистичных голосов/задач нет. При
выключенном плагине или в E2EE кнопок действий нет.

- full frontend suite — **1021/1021**, 95 test files; добавлено 30 тестов
  (10 API + 6 store + 14 UI/a11y);
- `npm run check` — **exit 0**: lint, prettier, contract, stickers, security,
  session-writers, tests, production build;
- `contract:check` — **75 operations / 115 schemas** (63 paths), generated types
  in sync; frontend-guard обновлён под новые пути #76;
- marketplace/install/выполнение кода плагинов отсутствуют.

## 1. API (typed)

`src/api/types.ts` — алиасы сгенерированной схемы: `Poll`, `PollOption`,
`PollList`, `PollCreate`, `PollVoteRequest`, `PollCloseRequest`, `Task`,
`TaskList`, `TaskCreate`, `TaskUpdate`, `TranslationRequest`, `Translation`.

`src/api/endpoints.ts` — `ChatApi` и реализация:

| Метод                                           | Контракт                                              | Возврат       |
| ----------------------------------------------- | ----------------------------------------------------- | ------------- |
| `listPolls(chatId)`                             | `GET /chats/{chatId}/polls`                           | `PollList`    |
| `createPoll(chatId, body)`                      | `POST /chats/{chatId}/polls`                          | `Poll`        |
| `closePoll(chatId, pollId, {closed:true})`      | `PATCH /chats/{chatId}/polls/{pollId}`                | `Poll`        |
| `votePoll(chatId, pollId, {option_id})`         | `POST /chats/{chatId}/polls/{pollId}/votes`           | `Poll`        |
| `listTasks(chatId)`                             | `GET /chats/{chatId}/tasks`                           | `TaskList`    |
| `createTask(chatId, body)`                      | `POST /chats/{chatId}/tasks`                          | `Task`        |
| `updateTask(chatId, taskId, {done})`            | `PATCH /chats/{chatId}/tasks/{taskId}`                | `Task`        |
| `translateMessage(chatId, messageId, {target})` | `POST /chats/{chatId}/messages/{messageId}/translate` | `Translation` |

Все вызовы идут через общий `withReauth` и `X-Device-Id` клиента; path-сегменты
кодируются `encodeURIComponent`. Idempotency-Key для этих операций контрактом не
предусмотрен.

## 2. Store (`src/plugins/actionsStore.ts`)

Отдельный `PluginActionsStore` подключён к `ChatStore` (`store.pluginActions`,
dispose/reset при logout), хуки `usePluginActionsStore` /
`usePluginActionsState` — в `ChatProvider`.

Состояние: `polls/tasks` + статусы/ошибки, `pendingPollIds`, `closingPollIds`,
`pendingTaskIds`, `pollErrors/taskErrors`, `createPollPending/Error`,
`createTaskPending/Error`, `translations` (`chatId:messageId` → `loading/ready/error`).

- **Нет оптимистичных голосов и задач.** `votePoll`/`closePoll`/`updateTask`
  только помечают строку pending; карточка/чекбокс меняются после ответа сервера.
  Ошибка оставляет последний серверный агрегат и кладёт inline-ошибку.
- `createPoll`/`createTask` вставляют **ответ `201`**, а не введённые поля;
  сортировка — presentation поверх серверных `created_at`/`done`
  (опросы новые первыми, задачи: открытые → выполненные).
- Смена чата (`enterChat`) сбрасывает строки и переводы прошлого чата; токены
  запросов отбрасывают поздние ответы. Для перевода есть per-message token,
  поэтому быстрая смена языка не перезаписывается устаревшим ответом.
- `reset()` очищает всё при выходе/смене аккаунта.

## 3. UI (только managed, только при включённом плагине)

`src/plugins/gate.ts` — `usePluginGate(chatId, e2ee)`: действия доступны только
когда per-chat строки загружены и сервер вернул `enabled && available`; E2EE
всегда отсекается. `ChatScreen` подгружает состояние плагинов активного
managed-чата; в E2EE запрос не делается.

### Опросы

- кнопка **«Опрос»** в плагин-баре над composer (`PluginActionsBar`);
- модалка (`PollCreateDialog`): вопрос 1..500, 2–10 вариантов по 1..200,
  уникальность, plain-text guard; `201` закрывает модалку и открывает панель;
- панель в `ChatDetails` (`PollPanel`): карточки, результаты и проценты,
  «мой голос», повторное голосование/смена варианта, закрытие создателем,
  состояние «Опрос закрыт», пусто/loading/error+retry, inline-ошибки vote/close.
  Закрытые опросы не голосуются, кнопка закрытия исчезает.

### Задачи

- кнопка **«Задача»** в том же баре;
- модалка (`TaskCreateDialog`): заголовок 1..500, необязательные исполнитель
  (ACTIVE-участники из существующего directory) и `due_at` (`datetime-local`);
- панель (`TaskPanel`): чекбокс выполнить/переоткрыть, исполнитель, срок,
  кто выполнил, фильтры **Открытые/Выполненные**, пусто/loading/error+retry,
  inline-ошибка. При ошибке сервера чекбокс остаётся прежним.
- Права: UI даёт affordance по workspace OWNER/ADMIN + создатель/исполнитель;
  окончательно решает сервер (`403` показывается честно).

### Перевод

- кнопка **«Перевести»** в `MessageActions` только для живого managed `TEXT`
  и только при включённом `translate`; для стикера/удалённого/E2EE её нет;
- меню target **ru/en**; inline-блок (`TranslatedMessage`) с loading, текстом,
  скрытием и retry;
- `503 TRANSLATION_UNAVAILABLE` показывается как честная ошибка провайдера с
  `Retry-After`, без локально придуманного перевода;
- блок исчезает при выключении плагина и никогда не рендерится в E2EE.

Flat feed не менялся структурно: перевод — дополнительный блок под текстом
сообщения; панели живут в существующем details-аккордеоне. Добавлены мобильные
правила (плагин-бар скроллится, карточки не ломают ширину).

## 4. MSW

`src/mocks/db.ts` / `handlers.ts`: `polls`/`tasks`/`votes`, лог запросов,
инъекции ошибок (`forcePollListError`, `forcePollCreateError`,
`forcePollMutationError`, `forceTaskListError`, `forceTaskCreateError`,
`forceTaskUpdateError`, `forceTranslationError`), `translationAvailable` для
контрактного `503`, reset в `resetMockDb`.

Хендлеры повторяют серверные правила: gate `PLUGIN_NOT_ENABLED` /
`PLUGIN_NOT_AVAILABLE`, E2EE `E2EE_METADATA_FORBIDDEN` для перевода, валидация
тел, `POLL_OPTION_INVALID`/`POLL_CLOSED`/`POLL_STATE_INVALID`,
`TASK_ASSIGNEE_INVALID`, права на close/update, серверные `creator_id`,
`completed_by/completed_at`, уникальный голос на пользователя и пересчёт
агрегата. Ответ перевода — детерминированная заглушка MSW; реальный backend по
умолчанию отдаёт `503`, и UI это честно обрабатывает.

## 5. Тесты

| Файл                                         | Что покрыто                                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/pluginActions.test.ts` (10)         | create/list/vote/change vote/close/create task/order/complete/reopen/assignee/403/gate/E2EE/translate 200/503/422                                                                                  |
| `src/plugins/actionsStore.test.ts` (6)       | отсутствие оптимистичных голосов/задач, сохранение агрегата при ошибке, честная ошибка перевода, очистка при смене чата                                                                            |
| `src/components/PluginActions.test.tsx` (14) | poll flow + validation + empty/error; task flow + filters + no-optimism + empty/error; translation ru/en + 503 + hide + sticker/E2EE; gate disabled; **axe** на dialogs, panels и translated block |

Axe-аудиты используют существующий паттерн (`color-contrast` отключён, serious/
critical = 0). `npm run check` проходит с production build.

Остаются только pre-existing lint-warnings в `ChatDetails`/`CreateChatDialog`/
`e2ee/app/chatBridgeSupport.test.ts`; новых ошибок/предупреждений нет.

## 6. Ограничения

- У опросов/задач нет realtime-событий в контракте: изменения другого участника
  появляются при открытии/повторной загрузке панели, мутации — по ответу сервера.
- `ChatSummary` не содержит chat-role, поэтому UI-подсказка прав на задачу
  использует workspace-роль; серверный `403` остаётся авторитетным.
- Панели опросов/задач — групповые поверхности, как и существующая страница
  плагинов; перевод во включённом плагине доступен в любом managed-чате.
- Внешний провайдер перевода в реальном контуре не настроен по умолчанию —
  это ожидаемый `503`, а не дефект UI.

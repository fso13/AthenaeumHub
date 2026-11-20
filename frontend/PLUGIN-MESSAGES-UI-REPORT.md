# #95 — POLL/TASK messages в плоской ленте (frontend)

> Зона: только `frontend/**`. Контракт `contracts/**` уже содержал проекции
> `Message.poll` / `Message.task` и `message_id` в `Poll`/`Task` (синхронизация
> #95); в этой задаче контракт и backend не менялись. `backend/PLUGIN-MESSAGES-REPORT.md`
> в дереве отсутствовал, поэтому приёмка шла по контракту, `ws-protocol.md` и
> MSW-мокам.

## Статус

**DONE.** Серверные `POLL`/`TASK`-сообщения теперь рендерятся в основной ленте
карточками (не пузырями), голосование/закрытие/выполнение/переоткрытие идут
через существующие API, ответ сервера заменяет встроенный объект в самом
сообщении (без второй строки и без дубля в панели деталей). Создание из диалога
закрывает диалог, подтягивает `message_id` и скроллит/фокусирует новую карточку.
История, WS и catch-up/replay дают одну и ту же карточку.

- `npm run check` — **exit 0**: lint (0 errors), prettier, contract (144
  operations / 191 schema), stickers, security, session-writers, tests,
  production build.
- Unit/integration: **1204 passed / 112 files**. Старый panel-набор (14 тестов)
  заменён на 10 UI/a11y-тестов ленты; дополнительно 8 guard-тестов.
- `contract:check` — generated types in sync; `npm run api:types` не потребовал
  изменений.
- Playwright e2e не запускался (в этой задаче не требовался; UI проверен
  RTL/Axe).

## 1. Контракт, типы и guard'ы

Используются уже сгенерированные `src/api/schema.d.ts`:

- `Message.type: TEXT | STICKER | SYSTEM | POLL | TASK`;
- `poll_id`/`poll` и `task_id`/`task` (nullable; у tombstone — `null`);
- `Poll.message_id` / `Task.message_id` — только в ответе `201` на create.

Новый `src/plugins/messageCards.ts` (чистые функции, без React):

| Функция                                    | Назначение                                              |
| ------------------------------------------ | ------------------------------------------------------- |
| `pluginMessageKind(message)`               | `'POLL' \| 'TASK' \| null` по типу строки               |
| `embeddedPoll(message)`                    | валидный `Poll` или `null`                              |
| `embeddedTask(message)`                    | валидный `Task` или `null`                              |
| `isPollMessage` / `isTaskMessage`          | type guards                                             |
| `sortPollOptions(poll)`                    | порядок по серверному `position` + стабильный tie-break |
| `pollPercent(votes, total)`                | целый процент, clamp `0..100`                           |
| `canVotePoll(poll)`                        | только открытый опрос                                   |
| `canToggleTask(task, viewerId, canManage)` | создатель / исполнитель / OWNER-ADMIN                   |
| `pluginMessageText(message)`               | question/title для поиска по ленте                      |
| `pluginTitleId(messageId)`                 | общий id заголовка карточки и `aria-labelledby`         |

Guard'ы fail-closed: tombstone, `poll_id`/`poll.id` mismatch, пустой вопрос/заголовок,
`poll.options < 2`, `poll: null` → карточка «недоступно», а не выдуманный объект.
E2EE-чат исключён и на уровне guard'ов, и в `MessageRow` (`e2eeChat` никогда не
рендерит серверную проекцию).

## 2. Карточки в ленте

`src/components/plugins/PluginMessageCards.tsx`:

- `PollMessageCard` — бейдж «Опрос», вопрос, статус (идёт/закрыт + время),
  `Голосов: N`, варианты с Count/percent-bar, `aria-pressed` для «моего» голоса,
  подпись «Ваш голос: «…»», кнопка «Закрыть опрос» только создателю.
- `TaskMessageCard` — бейдж «Задача», чекбокс, заголовок, исполнитель, срок,
  «Выполнил(а): …», чип «Выполнено».
- `PluginMessageFallback` — если сервер не прислал `poll`/`task`, показывается
  честное «Опрос/Задача недоступна» без действий и без текста-пузыря.

`MessageRow` (`msg-row--plugin`) сохраняет автора/аватар/время/цитату, но контент —
карточка `.poll-card`/`.task-card`, а не `.msg-text`/bubble. `aria-labelledby`
строки указывает на `h3` внутри карточки; удалённые сообщения идут обычным
tombstone-путём.

`MessageList`:

- ищет по `question`/`title` (не только по `text`);
- передаёт `pollsEnabled`/`tasksEnabled`/`canManageTasks`/`memberNames`;
- `focusRequest` после создания: `scrollIntoView({block:'center'})`, `focus()`,
  кратковременная подсветка `.is-focused`, затем `onFocusHandled`;
- дедупликация остаётся в `mergeMessages` (id + seq).

Мобильная версия: карточка на всю ширину, touch-высота вариантов 42px,
уменьшенные отступы/шрифты в пределах Sova-токенов (`app.css`, блок `#95`).

### Панель деталей — без дубля

`PollPanel.tsx` и `TaskPanel.tsx` удалены. В `ChatDetails` секции «Опросы»/«Задачи»
остались компактным **индексом**: количество из серверного списка, подсказка
«Опросы/Задачи показываются карточками в ленте чата» и кнопка «Показать в ленте»
(скролл к последней загруженной карточке). Полной карточки в панели нет, поэтому
один опрос/задача не рендерится дважды. Счётчики подгружаются через
`ensurePolls`/`ensureTasks` при открытии панели; ошибка списка остаётся честной с
retry.

## 3. Действия и правила сообщений

- **Голосование/закрытие** — `POST /polls/{id}/votes`, `PATCH /polls/{id}`;
  **выполнение/переоткрытие** — `PATCH /tasks/{id}`. Оптимистичных переключений
  нет: pending блокирует контролы, UI меняется после ответа.
- `PluginActionsStore` получил `onPollChanged`/`onTaskChanged`; `ChatStore`
  заменяет `message.poll`/`message.task` **в существующем сообщении** по
  `poll_id`/`task_id` (или `message_id` из ответа create). Второго сообщения не
  создаётся.
- **Реакции разрешены** на POLL/TASK (как и на остальных не-SYSTEM сообщениях),
  работают через существующий `ReactionBar`/`message.reaction.changed`.
- **Редактирование запрещено**: кнопка остаётся disabled с подсказкой «Можно
  редактировать только текстовые сообщения»; пустой текст в edit-диалоге
  по-прежнему не сохраняется.
- **Reply/thread скрыты** для структурированных карточек: у них нет plain-text
  тела для цитаты, а тред — разговорная механика; это осознанное UI-решение.
- **Удаление**: для POLL/TASK доступно только «Удалить у себя» (карточка
  скрывается локально, сам опрос/задача у участников остаются). Delete-for-all
  не предлагается, чтобы не осиротить объект, у которого после удаления не
  остаётся представления в ленте. Обычные TEXT/STICKER сохраняют прежние правила.
- **Pin** остаётся доступен; **E2EE** — никаких плагин-действий и карточек.

## 4. Создание: диалог → карточка

`PollCreateDialog`/`TaskCreateDialog` после `201` вызывают `onCreated`, диалог
закрывается. `ChatScreen.focusCreatedPluginMessage`:

1. ищет сообщение по `message_id`, затем по `poll_id`/`task_id` в загруженном
   слайсе;
2. если WS-кадр ещё не пришёл — один `refreshTail(chatId)` (`GET messages?after_seq=lastSeq`)
   и повторный поиск;
3. очищает фильтр поиска, ставит `focusRequest` → `MessageList` скроллит и
   фокусирует карточку.

Сообщение никогда не добавляется локально: источник — WS `message.created` или
`after_seq` catch-up; `mergeMessages` дедуплицирует по id/seq. Поэтому сценарий
«диалог + панель + лента» больше не даёт третьей копии.

`readApiMessage` (WS-валидатор в `chatStore`) расширен на `POLL`/`TASK` — без
этого live/replay-кадры с #95 молча отбрасывались.

## 5. MSW: seed, create, WS, history

`src/mocks/fixtures.ts`:

- seq 36 — `POLL` («Куда идём на обед в пятницу?», 3 голоса, мой голос «Суши»),
  seq 42 — `TASK` («Подготовить демо для команды», исполнитель Анна, срок 25 ноя).
  Два TEXT-черновика заменены, поэтому история остаётся 45 сообщений и старые
  pagination/thread-тесты не меняются;
- `buildSeedPoll`, `buildSeedPollVotes`, `buildSeedTask` — детерминированные
  серверные записи.

`src/mocks/db.ts`:

- `MockPollRecord`/`MockTaskRecord` засеяны в `createMockDb`/`resetMockDb`;
- `insertMockPluginMessage` создаёт POLL/TASK-строку с корректным `seq`,
  `poll_id`/`poll` или `task_id`/`task` (как backend в одной транзакции).

`src/mocks/handlers.ts`:

- `POST /polls` и `POST /tasks` создают timeline-сообщение, публикуют
  `message.created` и возвращают `message_id` в `201`;
- голос/закрытие/update задачи обновляют встроенный `poll`/`task` в мок-истории
  (следующее history/replay-чтение видит актуальное состояние). Отдельный
  `message.updated` для плагинов не публикуется — контракт этого не требует.

## 6. Тесты

Новый/обновлённый набор:

- `src/plugins/messageCards.test.ts` — 8 guard-тестов (валидность, mismatch,
  tombstone, сортировка, проценты, права, поиск).
- `src/components/PluginActions.test.tsx` — 10 интеграционных тестов:
  seed-карточки, голос/смена голоса/закрытие с проверкой embedded-объекта и
  отсутствия дубля строки, create poll + закрытие диалога + scroll/focus + один
  `message_id`, create task + complete/reopen, read-only при выключенных
  плагинах, реакции/disabled edit/только delete-for-me, индекс деталей и переход
  в ленту, live WS POLL, Axe (лента, индекс, оба диалога).
- `src/api/pluginActions.test.ts` — обновлён под seed-записи и проверяет
  `message_id`, `type=POLL|TASK`, `text=null`, обновление history-проекции без
  второй строки.
- Старые panel-тесты заменены; других регрессий в 1204 тестах нет.

Axe: `serious`/`critical` violations = 0 на ленте с карточками, индексе деталей и
обоих диалогах.

## 7. Сопутствующие правки, необходимые для зелёного check

Это не изменения контракта, а приведение клиента к уже сгенерированной схеме:

- `MessageCreateBody`: `mention_all` сделан необязательным на уровне алиаса
  (`Omit<…,'mention_all'> & { mention_all?: boolean }`). Генератор помечает поле
  обязательным из-за `default: false`; контракт разрешает не передавать его (и
  E2EE его запрещает). Запросы по-прежнему не отправляют поле, пока в composer
  нет @all.
- `FilesPage`: клик «В чат» проверяет `item.chat_id` (в схеме он nullable),
  кнопка disabled без chat id.
- `readApiMessage`: разрешены `POLL`/`TASK` (см. §4).
- `scripts/check-contract.mjs` отформатирован Prettier (семантика не менялась).

## 8. Ограничения и решения

- **Один источник карточки — лента.** Индекс в деталях не дублирует карточку;
  для опросов/задач, которых нет в загруженной истории, показывается только
  количество (пользователь может догрузить историю). Это цена отказа от
  дублирования.
- **Delete-for-all на POLL/TASK скрыт** (см. §3). Если продукт захочет удалять
  карточку у всех, нужно решить, что происходит с самим опросом/задачей.
- **Чужие голоса/выполнение задач не приходят live-кадром** — контракт #95
  говорит, что сервер не переписывает сообщение; актуальная проекция приходит
  при следующем history/replay/catch-up. Свой ответ обновляет карточку сразу.
- **E2EE** — серверные плагины недоступны; UI дополнительно не рендерит такие
  проекции.
- **Backend #95**: `PLUGIN-MESSAGES-REPORT.md` отсутствовал на момент работы;
  интеграция проверена на контракте и MSW. При расхождении backend-ответа
  (например, create вернёт полное `Message` вместо `message_id`) клиент всё
  равно найдёт строку по `poll_id`/`task_id` после catch-up.

## 9. Файлы

Новые:

- `src/plugins/messageCards.ts`, `src/plugins/messageCards.test.ts`
- `src/components/plugins/PluginMessageCards.tsx`
- `PLUGIN-MESSAGES-UI-REPORT.md`

Изменены: `MessageRow.tsx`, `MessageList.tsx`, `MessageActions.tsx`,
`ChatScreen.tsx`, `ChatDetails.tsx`, `plugins/actionsStore.ts`,
`store/chatStore.ts`, `mocks/{fixtures,db,handlers}.ts`, `i18n/ru.ts`,
`styles/app.css`, `api/types.ts`, `api/pluginActions.test.ts`,
`components/PluginActions.test.tsx`, `components/pages/FilesPage.tsx`,
`scripts/check-contract.mjs` (format).

Удалены: `components/plugins/PollPanel.tsx`, `components/plugins/TaskPanel.tsx`.

## Итог

**DONE** — лента, действия, create-flow, mock/WS/replay, a11y и полный
`npm run check` (1204 теста) зелёные; дубля «панель + лента» нет.

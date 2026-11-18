# D1-FE3 — threads UI (managed-only)

> Зона сессии: `frontend/**`. `backend/**`, `contracts/**`, `docs/**`, `design/**` не
> менялись; `frontend/src/api/schema.d.ts` не регенерировался и остался синхронен
> контракту D1-C1/BE1. E2EE-флаг в этом срезе `false`; треды — только managed.

## Статус

**DONE в границах D1-FE3.** Реализованы типизированный API, thread slices в store,
десктопная правая панель и мобильный full-screen sheet, live-обновление счётчика по
WS, пагинация ответов, ошибки/retry и честно выключенные треды в E2EE.

Полный `npm run check` — **769/769** тестов (73 файла), `contract:check` —
**47 paths / 55 operations / 87 schemas**, `vite build` зелёный.

## 1. Типизированный API

`frontend/src/api/endpoints.ts`:

- `ListMessagesQuery.threadRootId?: string` → query `thread_root_id` рядом с
  существующими `after_seq`/`before_seq`/`limit` (без изменения их поведения);
- `sendMessage` не менял сигнатуру: `MessageCreate.thread_root_id` уже входит в
  сгенерированный `MessageCreateBody`, store прокидывает его в теле ответа в тред.

`frontend/src/api/types.ts`:

- `ThreadSummary = NonNullable<ApiMessage['thread_summary']>` — алиас на поля контракта,
  без изобретённых полей. `schema.d.ts` синхронен; contract delta этого среза не
  требовалась.

## 2. Store

`frontend/src/store/chatStore.ts`:

- `ThreadSlice` (chatId/rootId/status/replies/outbox/hasMore/beforeSeq/loadMore*/
  error/unavailable/lastSeq) и `ActiveThread`; ключ — `threadKey(chatId, rootId)`.
  `threads` и `activeThread` добавлены в `AppState`, очищаются при logout/reset и
  смене workspace; смена чата закрывает панель.
- `threadsAvailable(chatId)` — false для E2EE (`ChatSummary.security_mode` или
  локальный E2EE-маркер/крипто-строки). `openThread`/`loadThread`/`sendThreadReply`
  отказывают в E2EE, plaintext в панель не попадает.
- `openThread` создаёт срез, ставит `activeThread` и загружает первую страницу
  (`limit = historyPageSize`). Корень остаётся в `ChatSlice.messages`; ответы — только
  в `ThreadSlice.replies`.
- `loadMoreThread` листает назад по `beforeSeq` и мёржит по id/seq без дублей;
  `retryThread` перезагружает страницу.
- `sendThreadReply` переиспользует существующий optimistic outbox,
  `Idempotency-Key`, ретраи `IDEMPOTENCY_IN_PROGRESS` и `OutgoingRow`. Ответ
  появляется в панели как pending, серверный `id`/`seq` — только из `201`; ошибка
  сохраняет строку и даёт retry/restore. Никаких «оптимистичных» server-id нет.
- `applyMessageCreated` маршрутизирует `thread_root_id` в thread slice, обновляет
  кэш summary корня (`reply_count`, `last_reply_at`, `last_reply_author_id`,
  `last_reply_excerpt` ≤ 160 code points, без разрыва surrogate pair) и двигает
  `lastSeq` чата (ответы — часть seq-потока, нужны для subscribe/ack).
- Защита от двойного счёта: `known` по id (REST после WS) и гейт
  `reply.seq > ChatSummary.last_seq` (replay/поздняя доставка не инкрементируют
  summary повторно). Это осознанный компромисс: при редком рассинхроне summary
  лучше недосчитать до reload, чем удвоить счётчик.
- Основная лента не содержит ответов на всех путях: серверный main GET, фильтр в
  `loadChat`/`loadMore`/`catchUp`, отдельная WS-ветка и защитный фильтр в
  `MessageList`. Удалённые ответы не рендерятся (BE1 §6.4), summary сервера их не
  считает.
- Ошибки: `THREAD_ROOT_DELETED` → `unavailable='deleted'`, `THREAD_ROOT_NOT_FOUND`/
  `404` → `'not_found'`; панель показывает объяснение, композер выключен. Ошибка
  «показать ещё» не теряет уже загруженные ответы. `describeError` получил
  `THREAD_*`/`THREADS_E2EE_UNSUPPORTED` (title/text, restore где уместен).

## 3. UI

Новые компоненты:

- `ThreadLink.tsx` — кнопка под корнем: склоняемый счётчик, превью последнего
  ответа (автор + excerpt), время; fallback «Вложение или стикер» при пустом excerpt
  (стикер/вложение), `aria-label` с точным числом.
- `ThreadPanel.tsx` — `role="dialog"`, `aria-modal`, labelled heading, `role="log"`
  для ответов. Focus trap по Tab, `Esc`, возврат фокуса на триггер при закрытии.
  Содержимое: корень, список ответов (quote-reply навигация без вложенных тредов),
  «Более ранние ответы», empty/loading/error/root-deleted состояния, `OutgoingRow`.
- `ThreadComposer.tsx` — текстовый композер (вложения/стикеры вне среза), label,
  Enter/Shift+Enter, `maxLength 8000`, блокировки offline/rate-limit/недоступный
  тред, `role=status` для причины блокировки.

Правки:

- `MessageRow` — ThreadLink + действия «В тред»/«Открыть тред»; при наличии ответов
  ссылка является единственным entry point (без дубля accessible name), при
  E2EE — disabled-кнопка с объяснением. У ответов в панели нет quote-reply.
- `MessageList` — фильтр `thread_root_id`, резолв имени автора последнего ответа,
  проброс thread props.
- `ChatScreen` — обёртка `chat__main`, класс `chat--thread-open`, рендер
  `ThreadPanel`; композер канала не менялся.
- `styles/app.css` — inline link, правая колонка, `≤900px` full-screen sheet,
  light/dark переменные, safe-area, отсутствие горизонтального скролла на 390.
- `i18n/ru.ts` — thread-keys и локализованные ошибки.

E2EE: ссылка/действие disabled с текстом «Треды недоступны в E2EE-чате…»,
`openThread` → `false`, summary `null`, plaintext корня/ответов не рендерится даже
при принудительно открытой панели (defence in depth).

## 4. MSW

`frontend/src/mocks/handlers.ts`:

- `GET /chats/{chatId}/messages`: `thread_root_id` валидируется (UUID, корень в том же
  чате, не ответ, не deleted, не E2EE) и отдаёт 422 `THREAD_ROOT_NOT_FOUND`/
  `THREAD_NESTING_UNSUPPORTED`/`THREAD_ROOT_DELETED`/`THREADS_E2EE_UNSUPPORTED`;
  main GET фильтрует `thread_root_id = null`; каждому managed-корню считается
  `thread_summary` (включая `reply_count = 0`), ответам — `null`.
- `POST /chats/{chatId}/messages`: те же guard'ы до создания строки, `thread_root_id`
  пишется в сообщение и WS-payload; idempotent replay возвращает тот же shape.
- `frontend/src/mocks/db.ts`: `insertMockThreadReply` и `forceThreadError` (точечный
  сбой thread-страниц, не ломающий main feed) для RTL.

## 5. Тесты

`src/components/Threads.test.tsx` — **11** тестов:

|   # | Что покрыто                                                                                          |
| --: | ---------------------------------------------------------------------------------------------------- |
|   1 | открытие пустого треда, отправка ответа, `thread_root_id` в теле, рост счётчика, main feed без дубля |
|   2 | `before_seq`-пагинация 35 ответов, порядок seq, скрытие кнопки после последней страницы              |
|   3 | live WS-ответ: панель, счётчик корня, main feed без ответа, второй ответ                             |
|   4 | REST+WS один и тот же ответ → summary `1`, не `2`                                                    |
|   5 | Esc, close-кнопка, focus trap и возврат фокуса на триггер                                            |
|   6 | mobile (390, `matchMedia`) — sheet и `Назад`                                                         |
|   7 | ошибка загрузки треда + retry                                                                        |
|   8 | ошибка «показать ещё» без потери загруженных + retry                                                 |
|   9 | root deleted (422 `THREAD_ROOT_DELETED`): объяснение, readOnly-композер                              |
|  10 | E2EE: disabled-действие, `threadsAvailable=false`, `openThread=false`, панель не открывается         |
|  11 | axe (light, color-contrast off) — без serious/critical                                               |

Регрессий в существующих 758 тестах нет. Итог: **769** тестов, 73 файла.

## 6. Безопасность

- E2EE: треды не открываются/не грузятся/не отправляются; summary не запрашивается и
  не рендерится; server plaintext в E2EE-панели не выводится.
- Только контрактные поля; excerpt обрезается по code points, рендерится текстовым
  узлом (React escaping), без `dangerouslySetInnerHTML`.
- Ответ — обычное сообщение: права/лимиты/seq/идемпотентность остаются серверными;
  клиент не изобретает `id`/`seq` и не обходит 422.
- Focus trap/`aria-modal` не дают увести фокус за панель; ссылки/кнопки имеют
  accessible name.

## 7. Риски / follow-up

1. **Unread включает ответы** (риск BE1 #3): бейдж чата может быть больше числа
   видимых корней, пока тред закрыт. Продуктовое решение по «непрочитанным в тредах»
   — D1.1; текущий срез не меняет unread-модель.
2. **Summary при редком рассинхроне** может недосчитать до reload (гейт против
   двойного инкремента). Источник истины — серверный summary при следующей загрузке
   чата.
3. **Browser history back** не пушится: закрытие — `Esc`, кнопка закрытия и мобильный
   «Назад». Полноценный route/deep-link треда — отдельная задача (D1.1).
4. **Нет серверного kill-switch тредов**: managed-треды включены, E2EE отсекается
   always-on. Клиентский feature flag не добавлялся, чтобы не расходиться с BE1;
   общий флаг — D1.1/ops.
5. **Вложения/стикеры в тред-композере** вне среза: отправка только текста. Если в
   тред пришёл стикер/вложение, он рендерится, а preview даёт fallback.
6. **`aria-modal` на desktop**: панель ведёт себя как диалог с focus trap, но
   background не помечается `inert`. Для скринридеров это осознанное упрощение;
   альтернатива — отдельный `role=complementary` без trap.
7. **Удалённый корень** остаётся tombstone'ом в main feed (текущая лента не фильтрует
   deleted), ссылка на тред скрыта; прямой API-ответ даёт 422, панель показывает
   состояние. Поведение согласовано с BE1 §6.4.
8. **`lastSeq` чата теперь учитывает ответы** (нужно для subscribe/ack). Это
   изменение затронуло `loadChat`/`catchUp`/send/E2EE-send; существующие
   realtime/sync тесты зелёные, но при будущих изменениях курсора это инвариант.

## 8. Изменённые файлы

```
frontend/src/api/endpoints.ts
frontend/src/api/types.ts
frontend/src/store/chatStore.ts
frontend/src/domain/errors.ts
frontend/src/i18n/ru.ts
frontend/src/components/Icons.tsx
frontend/src/components/ThreadLink.tsx          (new)
frontend/src/components/ThreadPanel.tsx         (new)
frontend/src/components/ThreadComposer.tsx      (new)
frontend/src/components/Threads.test.tsx        (new)
frontend/src/components/MessageRow.tsx
frontend/src/components/MessageList.tsx
frontend/src/components/ChatScreen.tsx
frontend/src/styles/app.css
frontend/src/mocks/handlers.ts
frontend/src/mocks/db.ts
frontend/README.md
frontend/D1-FE3-REPORT.md                       (new)
```

Не менялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`.

## 9. Проверка

```bash
cd frontend
npm run check
# lint + format + contract:check + stickers:check + security:check +
# session-writers:check + vitest run + tsc/vite build
# Test Files 73 passed (73) / Tests 769 passed (769)
# Contract check passed: 55 operations, 87 contract schemas
# vite build — success
```

Ручной сценарий (dev/mock): открыть managed-чат → «В тред» у сообщения → отправить
ответ → счётчик «1 ответ» и превью в ленте → `Esc`/«Назад» закрывают панель; в
E2EE-чате действие «Треды недоступны» disabled.

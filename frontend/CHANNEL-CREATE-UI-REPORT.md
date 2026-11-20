# #78 PUBLIC/PRIVATE GROUP-каналы: создание с выбором состава — отчёт frontend

> Зона сессии: только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `schema` не менялись. Контракт `contracts/openapi.yaml` уже
> содержал `ChatCreateRequest.visibility/member_ids`, `Chat.visibility` и
> `ChatSummary.visibility`; `src/api/schema.d.ts` регенерировать не
> потребовалось (проверка `contract:check` подтвердила синхронность).
> `backend/CHANNEL-VISIBILITY-REPORT.md` в дереве отсутствует, поэтому
> frontend реализован строго по контракту. Git-репозитория в рабочем дереве
> нет; проверка — типами, линтом, unit/axe-тестами и полной сборкой.

## Статус

**DONE.** Создание GROUP-канала теперь поддерживает выбор состава:
PUBLIC (все текущие и будущие участники пространства) и PRIVATE (только
выбранные активные участники, минимум 1). DIRECT не затронут. Создавать
GROUP может любой активный участник пространства, а не только OWNER/ADMIN.
После создания диалог закрывается, новый канал выбирается, а в заголовке и
панели деталей показывается честный чип видимости.

## 1. API, типы и store

`src/api/types.ts`

- `ChatVisibility = NonNullable<ChatSummary['visibility']>` — единый тип
  `'PUBLIC' | 'PRIVATE'` из контракта;
- `ChatSummary.visibility` и `ChatCreateRequest.member_ids/visibility` уже
  приходили из сгенерированного `schema.d.ts`, ручных DTO не добавлено.

`src/store/chatStore.ts`

- `ChatCreateInput` для GROUP расширен:
  `{ type: 'GROUP'; name; visibility?: ChatVisibility; memberIds?: string[] }`;
  строка `store.createChat('name', key)` продолжает работать и трактуется как
  PUBLIC;
- `createChat` валидирует перед запросом:
  - имя 1..120 (как раньше);
  - `visibility` только `PUBLIC`/`PRIVATE`, по умолчанию `PUBLIC`;
  - PRIVATE требует 1..100 **уникальных** id, self-исключение, ключ
    `member_ids` отправляется только для PRIVATE;
  - PUBLIC отправляет `{ type, name, visibility }` без `member_ids`;
  - DIRECT по-прежнему отправляет только `{ type: 'DIRECT', peer_id }` —
    ни имени, ни visibility, ни состава;
- `toChatSummary` и `chatSummaryFromChat` переносят `visibility` из `Chat` в
  `ChatSummary`; `PATCH /chats/{id}` не теряет видимость канала;
- ошибка лимита `CHAT_LIMIT_REACHED` и 403/422 обрабатываются как раньше.

`src/api/endpoints.ts` менять не потребовалось: `createChat` передаёт
`ChatCreateRequest` в тело один-в-один, `Idempotency-Key` уже пробрасывался.

## 2. Диалог создания (CreateChatDialog)

GROUP (по умолчанию):

- название 1..120 с прежним счётчиком и локальной валидацией;
- сегментированный выбор видимости:
  - «Все участники пространства» (PUBLIC) с пояснением, что канал появится у
    всех текущих участников и будущих присоединившихся;
  - «Выбранные участники» (PRIVATE) с пояснением, что доступ только у
    создателя и выбранных;
- PRIVATE:
  - поиск по имени через существующий серверный
    `GET /workspaces/{id}/members` (debounce 300 мс, literal query);
  - чек-лист только ACTIVE-участников, self отфильтрован на клиенте;
  - «Выбрать всех» (в пределах загруженной страницы/поиска, максимум 100) и
    «Снять выбор»;
  - счётчик «Выбрано: N» (`role="status"`);
  - состояния loading (skeleton), empty, error + retry, stale error + retry,
    load-more с retry;
  - минимум 1 участник: submit заблокирован, показывается подсказка, после
    blur/submit — `role="alert"`;
  - максимум 100: чекбоксы сверх лимита блокируются, показывается пояснение;
- тело запроса: `{ type: 'GROUP', name, visibility }` для PUBLIC и
  `{ type: 'GROUP', name, visibility: 'PRIVATE', member_ids }` для PRIVATE;
- idempotency key живёт в `requestRef` и переиспользуется только для
  идентичного логического payload: `GROUP:name:visibility:sorted(member_ids)`.
  Повтор после ошибки с теми же данными реплеит один и тот же ключ; изменение
  состава/видимости создаёт новый ключ;
- группы доступны всем: проверка `OWNER/ADMIN` удалена, роль больше не
  блокирует GROUP. Серверный 403 по-прежнему показывается честно.

DIRECT:

- тот же пикер, что и раньше: radio, один `peer_id`, self исключён, поиск,
  loading/empty/error/retry/load-more;
- селектор видимости и чек-лист состава не рендерятся;
- при переключении на DIRECT выбранный приватный состав и видимость
  сбрасываются, чтобы старые id не утекли в тело.

## 3. После создания и чипы видимости

- store после успешного `201` обновляет список, создаёт slice, выбирает новый
  канал (`setActiveChat`), перечитывает лимиты; диалог закрывается;
- `ChatHeader` показывает чип «Публичный канал»/«Приватный канал», если
  `ChatSummary.visibility` присутствует;
- `ChatDetails` показывает тот же чип рядом с «Групповой чат»;
- для DIRECT и старых GROUP без настройки (`visibility = null`) чипов нет.

## 4. MSW

`src/mocks/handlers.ts`, `src/mocks/db.ts`

- `POST /workspaces/{id}/chats`:
  - GROUP: `visibility` по умолчанию PUBLIC; PUBLIC отклоняет непустой
    `member_ids`; PRIVATE требует 1..100 уникальных id, все — ACTIVE-участники
    пространства, создатель в списке запрещён; неизвестный/неактивный id → 422
    `VALIDATION_FAILED`;
  - DIRECT: `visibility`/`member_ids` запрещены (422);
  - возвращаемый `Chat` и сохраняемый `ChatSummary` содержат `visibility`;
  - запись канала хранит `memberIds` (создатель + выбранные), а
    `GET /workspaces/{id}/chats` не отдаёт PRIVATE-канал пользователю, которого
    нет в этом списке (RLS-симуляция);
- `GET /workspaces/{id}/members` уже поддерживал literal-поиск, cursor и
  активный справочник — переиспользован без изменений контракта;
- фикстуры `ChatRecord` получили `memberIds: []` (существующие GROUP/DIRECT
  остаются видимыми).

## 5. Тесты

`src/components/CreateChat.test.tsx` — 23 теста (было 18), в том числе:

- PUBLIC body: `{ type: 'GROUP', name, visibility: 'PUBLIC' }`, ключ
  идемпотентности, закрытие диалога и выбор канала;
- PRIVATE: выбор двух участников, тело с `member_ids`, `summary.visibility`,
  `memberIds` содержит создателя и выбранных и не содержит невыбранных,
  чип «Приватный канал»;
- минимум 1: submit disabled, подсказка, API не вызывается;
- «Выбрать всех» / «Снять выбор» и счётчик;
- серверный поиск в PRIVATE-чек-листе;
- non-admin (MEMBER): GROUP доступен и создаётся, DIRECT остаётся доступен;
- существующие тесты лимита 409 (USER/WORKSPACE), 422, retry, load-more,
  DIRECT и idempotency сохранены;
- axe-аудит PRIVATE-селектора и чек-листа (как и прежний DIRECT-аудит).

## 6. Полная проверка

`cd frontend && npm run check` — **успешно, exit 0**:

- `eslint .` — 0 errors (2 pre-existing warnings: `ChatDetails.tsx`,
  `chatBridgeSupport.test.ts`);
- `prettier --check .` — все файлы отформатированы;
- `contract:check` — 76 операций, 116 схем, generated types in sync;
- `stickers:check`, `security:check` (326 файлов), `session-writers:check`
  (222 production-файла) — passed;
- `vitest run` — **97 files / 1053 tests passed** (базовая линия 1046+,
  добавлено 7 тестов);
- `vite build` — успешно (прежнее предупреждение о размере чанков).

## 7. Ограничения и заметки

- Приглашений по ссылке нет и не добавлялось: PRIVATE выбирает только уже
  активных участников пространства; сервер остаётся источником истины по
  составу и RLS.
- `Chat.visibility`/`ChatSummary.visibility` опциональны в контракте; UI
  рендерит чип только при наличии значения.
- BACKEND-отчёт `backend/CHANNEL-VISIBILITY-REPORT.md` на момент работы
  отсутствовал; поведение сверено с `contracts/openapi.yaml`.
- BACKEND-ограничения (лимиты, проверка ACTIVE-членства, выдача списка чатов)
  не дублируются на клиенте сверх описанной валидации; 403/422/409
  показываются пользователю.

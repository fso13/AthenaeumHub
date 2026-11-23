# #107 — Аудио/видео режим комнат (backend)

> Зона: `backend/**`, `contracts/**`, `frontend/src/api/schema.d.ts`.
> Срез аддитивный: V61 добавляет `room.rooms.media_mode`, #105-контракт комнат и
> presence/call signaling не меняются. E2EE не добавлялся.

## Статус

**DONE в границах backend-среза #107.**

* `room.rooms.media_mode` — `text NOT NULL DEFAULT 'VIDEO'` с CHECK
  `AUDIO|VIDEO`; существующие строки читаются как `VIDEO` без backfill.
* `POST /workspaces/{id}/rooms` принимает необязательный `media_mode`
  (`VIDEO` по умолчанию), `PATCH` — частичное обновление `name` и/или
  `media_mode` (хотя бы одно поле); `Room` во всех ответах содержит
  `media_mode`.
* Менять режим может создатель комнаты или workspace `OWNER`/`ADMIN`
  (та же матрица, что у переименования). Закрытая комната — `409 ROOM_CLOSED`.
* Режим — **только метаданные**: сервер не хранит состояние звонка, SDP/ICE,
  SFU, запись или медиа. Backing-канал, история, вложения, presence и
  существующий call signaling не затрагиваются. Фронтенд по-прежнему сам
  выбирает `video: true|false` в call signaling.
* Тесты: `RoomsIT` **10/10**, `ArchitectureTest` **11/11**, полный backend suite
  **1094/1094** (0 failures, 0 errors, 0 skipped, JDK 21).
* Контракт: **135 paths / 167 operations / 214 schemas** (счётчики не выросли:
  `media_mode` встроен в существующие схемы), generated types в sync.

## 1. Схема данных (V61)

`backend/src/main/resources/db/migration/V61__rooms_media_mode.sql`

```sql
ALTER TABLE room.rooms
  ADD COLUMN media_mode text NOT NULL DEFAULT 'VIDEO';

ALTER TABLE room.rooms
  ADD CONSTRAINT ck_rooms_media_mode CHECK (media_mode IN ('AUDIO', 'VIDEO'));

COMMENT ON COLUMN room.rooms.media_mode IS
  '#107 AUDIO|VIDEO room media mode (default VIDEO); metadata only, no call/SFU/media state.';
```

* **Аддитивно**: не изменяются и не удаляются существующие колонки, индексы,
  constraints, policies, функции и гранты. `GRANT` на таблицу покрывает новую
  колонку.
* `NOT NULL DEFAULT 'VIDEO'` — на PostgreSQL 11+ добавление колонки с
  non-null default не переписывает таблицу; старые строки читаются как
  `VIDEO`, data-backfill не нужен.
* `CHECK ck_rooms_media_mode` — DB-backstop для значений; выбран стиль
  `text + CHECK` (как у `room.rooms.status`), а не PostgreSQL enum type,
  чтобы будущее расширение оставалось аддитивным.
* Комментарий на колонку и forward-only rollback plan — в миграции.
* RLS/гранты `krug_app`, `room.room_scope`, `presence_directory` и
  `presence_cleanup` не менялись.

## 2. Домен и репозиторий

`Room.MediaMode` (`AUDIO`, `VIDEO`) в домене комнаты:

* `MediaMode.defaulted(raw)` — `null`/отсутствие поля → `VIDEO`;
  `MediaMode.parse(raw)` — строгий разбор только `AUDIO`/`VIDEO`
  (нижний регистр и неизвестные значения → `400 VALIDATION_FAILED`);
* `Room.create(...)` и `Room.reconstitute(...)` принимают режим;
  `Room.rename(...)`/`Room.close(...)` сохраняют его;
* `Room.changeMediaMode(mode, at)` меняет только режим и `updated_at`;
* `canBeEditedBy(...)` по-прежнему покрывает создателя и workspace
  `OWNER`/`ADMIN`; `canBeClosedBy(...)` не менялся (создатель/`OWNER`).

`RoomRepository`:

* `save`, `findActiveRooms`, `findById` читают/пишут `media_mode`;
* новый `changeMediaMode(workspaceId, roomId, mediaMode, at)` выполняет
  `UPDATE ... SET media_mode, updated_at ... WHERE ... AND status = 'ACTIVE'`
  и возвращает `false`, если ACTIVE-комната исчезла конкурентно.

Никаких изменений в `chat`-контексте, `RoomChannelPort`/`RoomChannelService`
и call signaling нет.

## 3. API

### 3.1 `POST /api/v1/workspaces/{workspaceId}/rooms`

```json
{ "name": "Планёрка", "media_mode": "AUDIO" }
```

`media_mode` необязателен; отсутствие поля (или JSON `null`) → `VIDEO`.
Ответ — `201` + `Room` с `media_mode`. Остальные правила #105 не изменились
(имя 1..120 после trim, любой ACTIVE-участник, лимиты чатов,
`409 E2EE_GROUP_NOT_SUPPORTED` для E2EE-workspace).

### 3.2 `GET /api/v1/workspaces/{workspaceId}/rooms` и `GET /api/v1/rooms/{roomId}`

Оба ответа (`Room`/`RoomList`) содержат `media_mode` у каждой комнаты;
presence/TTL, `participant_count`, `my_present` и `status` не изменились.

### 3.3 `PATCH /api/v1/workspaces/{workspaceId}/rooms/{roomId}`

Частичное обновление, хотя бы одно поле:

```json
{ "media_mode": "AUDIO" }
{ "name": "Новое имя" }
{ "name": "Новое имя", "media_mode": "VIDEO" }
```

* `media_mode` без `name` не трогает имя и backing-канал; `name` без
  `media_mode` не трогает режим.
* Повтор текущего значения — идемпотентный `200` без записи в БД и без аудита.
* Пустое тело `{}` — `400 VALIDATION_FAILED` (`fields: name, media_mode`).
* Неизвестный/нижний регистр (`MUSIC`, `audio`) — `400 VALIDATION_FAILED`.
* Создатель или workspace `OWNER`/`ADMIN`; обычный участник — `403`.
* Закрытая комната — `409 ROOM_CLOSED`; чужая/неизвестная — `404`.
* При смене имени backing-канал переименовывается как раньше; при смене
  только режима канал и его история не затрагиваются.

Пример ответа (fragment):

```json
{
  "id": "…",
  "workspace_id": "…",
  "chat_id": "…",
  "name": "Планёрка",
  "media_mode": "AUDIO",
  "created_by": "…",
  "created_at": "2026-11-23T10:00:00Z",
  "updated_at": "2026-11-23T10:05:00Z",
  "status": "ACTIVE",
  "participants": [],
  "participant_count": 0,
  "my_present": false
}
```

## 4. Права и аудит

| Операция | Кто |
|---|---|
| `POST /workspaces/{id}/rooms` (в т.ч. `media_mode`) | любой ACTIVE-участник |
| `PATCH .../rooms/{roomId}` (`name` и/или `media_mode`) | создатель комнаты или workspace `OWNER`/`ADMIN` |
| `GET`/presence/`DELETE` | без изменений (#105) |

Audit:

* `room.created` — без изменений (`chat_id`, `status`);
* `room.renamed` — без изменений, metadata только `chat_id`;
* **новый** `room.media_mode_changed` — `target_type=room`, metadata только
  `media_mode` (`AUDIO`/`VIDEO`); ни имени, ни участников, ни канала,
  ни контента.

## 5. Контракт и generated types

`contracts/openapi.yaml` (аддитивно, без новых paths/operations/schemas):

| Элемент | Изменение |
|---|---|
| `Room` | обязательное `media_mode`: enum `AUDIO|VIDEO` |
| `RoomCreateRequest` | необязательное `media_mode` (enum), серверный default `VIDEO` в описании |
| `RoomUpdateRequest` | `name` и `media_mode` необязательны, `minProperties: 1`, `additionalProperties: false` |
| `PATCH .../rooms/{roomId}` | описание частичного обновления и неизменности calls/presence |

`frontend/src/api/schema.d.ts` регенерирован `npm run api:types`
(`openapi-typescript`): `Room.media_mode` обязателен,
`RoomCreateRequest.media_mode?`, `RoomUpdateRequest.name?/media_mode?`.

Примечание: в OpenAPI не выставлен `default: VIDEO`, потому что
`openapi-typescript` при `default` делает поле обязательным в TS-типе
(`--default-non-nullable`), а сервер принимает отсутствие поля. Серверный
default задокументирован в описании, реализован в домене и покрыт тестами.

Guard `frontend/scripts/check-contract.mjs` обновлён: `Room.media_mode`
добавлен в required-fields, `RoomUpdateRequest` больше не требует `name`,
добавлена явная проверка enum/`minProperties`/необязательности `media_mode`
при создании. Счётчики остались **135/167/214**;
`node scripts/check-contract.mjs` — `Contract check passed`.

## 6. Тесты

### 6.1 `RoomsIT` (10/10)

Новые:

| Тест | Что проверяет |
|---|---|
| `createsRoomsWithDefaultAndExplicitMediaMode` | default `VIDEO` без поля, explicit `AUDIO`/`VIDEO`, JSON `null` → `VIDEO`, list и detail содержат режим, БД совпадает с ответом |
| `updatesMediaModeWithCreatorOwnerAdminPermissionsAndValidation` | mode-only PATCH создателем, `403` обычному участнику, `ADMIN`/`OWNER` меняют режим, `OWNER` меняет имя+режим одним PATCH, name-only сохраняет режим, повтор идемпотентен, `MUSIC`/`audio`/`{}` → `400` без изменений, `409` для закрытой комнаты, аудит `room.media_mode_changed` только с `media_mode`, `room.renamed` только с `chat_id`, backing-канал не пересоздаётся |
| `mediaModeMigrationIsNotNullDefaultedAndConstrained` | `information_schema` (`text`, `NOT NULL`, default `VIDEO`), named CHECK `ck_rooms_media_mode`, legacy INSERT без колонки → `VIDEO`, прямой UPDATE в `AUDIO`, отказ на `MUSIC` и `NULL` |

Существующий `createsRoomWithBackingManagedChannelForEveryActiveMember`
дополнен проверками `media_mode=VIDEO` в ответе, БД и detail. Остальные
7 тестов #105 не менялись.

### 6.2 Полный прогон

* `mvn -o -Dmaven.repo.local=.m2repo test` на **JDK 21**:
  **Tests run: 1094, Failures: 0, Errors: 0, Skipped: 0** — BUILD SUCCESS.
* `ArchitectureTest` — **11/11** (изоляция контекста `room` и границы слоёв
  не нарушены; новых зависимостей api → domain нет).
* `RoomsIT` — **10/10**.
* Frontend: `npx tsc -p tsconfig.json --noEmit` — OK;
  `RoomsPage.test.tsx` — **24/24**.
* Contract guard — `Contract check passed` (135/167/214).

Примечание по прогону: первый полный запуск дал один несвязанный flaky-тест
`BotEventsIT.appMentionFiresForTextMentionAndForServerValidatedAll`
(ожидал outbox-событие, которого ещё не было); изолированно `BotEventsIT`
прошёл 6/6, повторный полный прогон — 1094/1094 чисто. К комнатам/режиму
отношения не имеет.

## 7. Файлы

Новые:

* `backend/src/main/resources/db/migration/V61__rooms_media_mode.sql`;
* `backend/src/main/java/ru/krug/backend/room/application/usecase/UpdateRoomService.java`;
* `backend/ROOMS-MEDIA-MODE-REPORT.md` (этот отчёт).

Изменённые:

* `backend/src/main/java/ru/krug/backend/room/domain/model/Room.java` —
  `MediaMode`, поле, фабрики, `changeMediaMode`;
* `backend/src/main/java/ru/krug/backend/room/domain/repository/RoomRepository.java`;
* `backend/src/main/java/ru/krug/backend/room/infrastructure/persistence/RoomRepositoryAdapter.java`;
* `backend/src/main/java/ru/krug/backend/room/application/usecase/CreateRoomService.java`;
* `backend/src/main/java/ru/krug/backend/room/application/model/RoomView.java`;
* `backend/src/main/java/ru/krug/backend/room/api/dto/CreateRoomRequest.java`,
  `UpdateRoomRequest.java`, `RoomResponse.java`;
* `backend/src/main/java/ru/krug/backend/room/api/mapper/RoomApiMapper.java`;
* `backend/src/main/java/ru/krug/backend/room/api/RoomController.java`;
* `backend/src/test/java/ru/krug/backend/integration/RoomsIT.java`;
* `contracts/openapi.yaml`;
* `frontend/src/api/schema.d.ts` (регенерирован);
* `frontend/scripts/check-contract.mjs` (guard: required/partial-PATCH/enum);
* `frontend/src/mocks/handlers.ts` (одна строка `media_mode: 'VIDEO'` в
  mock-проекции, чтобы сгенерированный обязательный `Room.media_mode`
  не ломал `tsc`; UI/mocks — вне продуктовой зоны среза).

Удалённые:

* `backend/src/main/java/ru/krug/backend/room/application/usecase/RenameRoomService.java`
  — заменён на `UpdateRoomService` (PATCH теперь обновляет имя и/или режим).

## 8. Ограничения среза

* Сервер не проверяет, что фактический звонок соответствует `media_mode`:
  call signaling остаётся relay, `video`-флаг по-прежнему приходит от
  клиента. Режим комнаты — это сохранённое предпочтение для UI.
* Нет UI выбора режима, аудио-звонков в интерфейсе и серверного enforcement:
  срез backend-only, готовы контракт и TS-типы.
* Нет SFU, записи, истории звонков, E2EE — как и в #105.
* Смена режима не трогает presence, backing-канал и историю; это сознательно:
  комната остаётся той же, меняется только предпочтение медиа.
* Mock-проекция комнат пока всегда отдаёт `VIDEO`; это не влияет на backend
  и будет заменено в UI-срезе комнат.

## 9. Итог

**DONE.**

# #105 — Комнаты (backend)

> Зона: `backend/**`, `contracts/**`, `frontend/src/api/schema.d.ts`.
> UI комнат не входил в срез. В рабочем дереве параллельно уже был срез V59
> (удаление music-room); #105 использует **V60** и не меняет V59, music-room код и
> его таблицы.

## Статус

**DONE в границах backend-среза #105.**

* Отдельный контекст `room`: `room.rooms` + `room.presence`.
* Комната создаёт backing managed GROUP-канал: имя комнаты, все ACTIVE-участники
  workspace, создатель `OWNER`, `PUBLIC`/`OPEN`, `MANAGED`. `chat_id` используется
  существующим call signaling без нового WS-протокола.
* Список комнат отдаёт только `ACTIVE`-комнаты и участников, у которых
  `last_seen_at` не старше 30 секунд; `participant_count` и `my_present`
  вычисляются сервером.
* REST presence: `POST /rooms/{roomId}/presence` — вход/heartbeat,
  `DELETE /rooms/{roomId}/presence` — идемпотентный выход. Websocket-presence не
  нужен: фронтенд опрашивает список каждые 5 секунд.
* На сервере **нет** состояния звонка, SDP/ICE, SFU, медиа или записи. Presence —
  единственное серверное «живое» состояние.
* Никакого E2EE: комнаты `MANAGED`-only, E2EE-workspace получает
  `409 E2EE_GROUP_NOT_SUPPORTED`.
* Тесты: `RoomsIT` **7/7**, `ArchitectureTest` **11/11**, полный backend suite
  **1091/1091** (0 failures, 0 errors, 0 skipped, JDK 21).
* Контракт: **135 paths / 167 operations / 214 schemas**, generated types в sync.

## 1. Схема данных (V60)

`backend/src/main/resources/db/migration/V60__rooms_presence.sql`

### 1.1 `room.rooms`

```sql
CREATE TABLE room.rooms (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by   uuid NOT NULL,                 -- no FK: удаление user не теряет комнату
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'CLOSED')),
  CONSTRAINT uq_rooms_chat UNIQUE (chat_id)
);
```

* `UNIQUE(chat_id)` — один канал не может быть backing-каналом двух комнат.
* `ix_rooms_workspace_status_created (workspace_id, status, created_at DESC, id DESC)` —
  основной запрос списка.
* `ENABLE/FORCE ROW LEVEL SECURITY`, policy `p_rooms_tenant` по
  `ops.current_workspace_id()`.
* Дополнительная read-policy `p_rooms_member_read`: ACTIVE-участник может прочитать
  комнату своего workspace до установки workspace GUC (паттерн V6 для Keycloak-токенов
  без workspace claim).
* `GRANT SELECT, INSERT, UPDATE, DELETE ... TO krug_app`.

### 1.2 `room.presence`

```sql
CREATE TABLE room.presence (
  room_id      uuid NOT NULL REFERENCES room.rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
```

* TTL-индексы:
  * `ix_room_presence_room_seen (room_id, last_seen_at DESC)` — чтение присутствующих;
  * `ix_room_presence_seen (last_seen_at)` — физическая cleanup-очистка.
* `ENABLE/FORCE ROW LEVEL SECURITY`; policy `p_presence_tenant` выводит tenancy из
  `room.rooms` (`workspace_id = ops.current_workspace_id()`), потому что в контрактной
  схеме у presence нет `workspace_id`, а `PK(room_id,user_id)` фиксирован.
* `GRANT SELECT, INSERT, UPDATE, DELETE ... TO krug_app`.

### 1.3 Функции

* `room.room_scope(room_id, user_id) → workspace_id, workspace_role, room_status,
  created_by, chat_id` — узкий `SECURITY DEFINER` lookup для `/rooms/{roomId}` и
  `/rooms/{roomId}/presence`: URL не содержит workspaceId (Keycloak-токен может не
  содержать claim). Возвращает строку только ACTIVE-участнику ACTIVE-workspace;
  `p_user_id = ops.current_user_id()` не даёт подменить актора.
* `room.presence_directory(workspace_id, viewer_id, cutoff) → room_id, user_id,
  display_name, joined_at, last_seen_at` — TTL-выборка присутствующих с
  `display_name`, без email/device/key. Проверяет ACTIVE-членство viewer и
  ACTIVE-статус workspace; возвращает только `ACTIVE`-комнаты.
* `room.presence_cleanup(cutoff) → integer` — bounded `DELETE` просроченных строк;
  cross-tenant по назначению, поэтому `SECURITY DEFINER`. Вызывается планировщиком
  (по умолчанию раз в минуту) и может вызываться вручную.

Комментарии на схему/таблицы/колонки/функции и forward-only rollback plan —
в самой миграции.

## 2. Модель комнаты и backing-канал

`chat.application.port.RoomChannelPort` + `chat.application.usecase.RoomChannelService`:

* создаёт `Chat.createGroup(..., MANAGED)` с именем комнаты;
* `ChatMember.owner` — создатель;
* `saveChannelSettings(PUBLIC)` выставляет `PUBLIC` + join policy `OPEN` и
  seed-ит дефолтную матрицу прав;
* `addActiveWorkspaceMembers` добавляет всех ACTIVE-участников workspace;
* проверяет installation-лимиты чатов в той же транзакции под
  `chatRepository.lockChatCreation(workspaceId)`;
* пишет существующий `chat.created` audit с metadata только
  `visibility`/`member_count`;
* `renameBackingChannel` переименовывает канал вместе с комнатой;
* `closeBackingChannel` мягко удаляет канал (`deleted_at`), сохраняя сообщения,
  вложения и байты.

`room`-контекст владеет только метаданными комнаты и presence; call signaling,
история, права и вложения остаются в chat-контексте. Границы контекстов проверяет
ArchUnit (домен `room` не зависит от доменов других контекстов).

## 3. API

### 3.1 `GET /api/v1/workspaces/{workspaceId}/rooms`

Только ACTIVE-участник workspace (иначе `403` без раскрытия существования).
Возвращаются только `ACTIVE`-комнаты, новые сверху, hard cap 200 (пагинации в срезе
нет).

```json
{
  "items": [
    {
      "id": "…",
      "workspace_id": "…",
      "chat_id": "…",
      "name": "Планёрка",
      "created_by": "…",
      "created_at": "2026-11-23T10:00:00Z",
      "updated_at": "2026-11-23T10:00:00Z",
      "status": "ACTIVE",
      "participants": [
        {
          "user_id": "…",
          "display_name": "Анна",
          "joined_at": "2026-11-23T10:01:00Z",
          "last_seen_at": "2026-11-23T10:01:20Z"
        }
      ],
      "participant_count": 1,
      "my_present": false
    }
  ]
}
```

`participants` содержит только heartbeat внутри 30-секундного TTL. `my_present` —
присутствует ли вызывающий. `chat_id` — канал для существующего call signaling.

### 3.2 `POST /api/v1/workspaces/{workspaceId}/rooms`

```json
{ "name": "Планёрка" }
```

Любой ACTIVE-участник. Имя trim-ится, 1..120 code points. В одной транзакции
создаются канал и строка комнаты. Ответ — `201` + `Room` (participants пустые,
`my_present=false`).

Коды:

* `400` — пустое/слишком длинное имя;
* `403` — не ACTIVE-участник workspace;
* `409 CHAT_LIMIT_REACHED` — installation-лимит чатов, `details.scope=USER|WORKSPACE`,
  `details.limit`, `details.used`;
* `409 E2EE_GROUP_NOT_SUPPORTED` — E2EE-workspace (комнаты MANAGED-only).

### 3.3 `GET /api/v1/rooms/{roomId}` (optional detail)

ACTIVE-участник workspace комнаты; workspace определяется сервером по `room_id`.
Закрытая комната возвращается со `status=CLOSED` и пустым списком присутствующих.
Чужая/неизвестная комната — `404`.

### 3.4 `PATCH /api/v1/workspaces/{workspaceId}/rooms/{roomId}`

```json
{ "name": "Новое имя" }
```

Создатель комнаты или workspace OWNER/ADMIN. Имя меняется и у комнаты, и у
backing-канала. Закрытая комната — `409 ROOM_CLOSED`. Чужая/неизвестная — `404`.
Аудит `room.renamed` содержит только `chat_id`.

### 3.5 `DELETE /api/v1/workspaces/{workspaceId}/rooms/{roomId}`

Мягкое закрытие: `room.rooms.status = 'CLOSED'`, backing-канал получает
`deleted_at`, поэтому комната исчезает и из списка комнат, и из списка чатов;
сообщения/вложения/байты сохраняются. Разрешено создателю комнаты или workspace
OWNER (ADMIN без создания комнаты закрыть её не может). Идемпотентно для
авторизованного актора — `204`. Аудит `room.closed`.

### 3.6 `POST /api/v1/rooms/{roomId}/presence`

Вход/ heartbeat. ACTIVE-участник workspace, комната `ACTIVE` (закрытая —
`409 ROOM_CLOSED`). Идемпотентный upsert:

* первый вызов фиксирует `joined_at`;
* heartbeat внутри TTL обновляет `last_seen_at`, сохраняя `joined_at`;
* heartbeat после истёкшего TTL сбрасывает `joined_at` (старая сессия не «висит»
  часами);
* SQL-guard требует ACTIVE-членство workspace в момент вставки, поэтому
  конкурентное удаление участника не оставляет presence.

Ответ `204`. Никакого состояния звонка не создаётся.

### 3.7 `DELETE /api/v1/rooms/{roomId}/presence`

Идемпотентный выход: удаляет строку, отсутствие строки — тоже `204`. Разрешён и для
закрытой комнаты (это только очистка эфемерного presence). Чужая/неизвестная
комната — `404`.

## 4. TTL, polling и cleanup

* TTL — **30 секунд** (`RoomPresencePolicy.TTL`). Все read-запросы фильтруют
  `last_seen_at > now - 30s`; просроченная строка не видна, даже если физически ещё
  лежит в таблице.
* Фронтенд: heartbeat раз в 5 секунд, список комнат — polling раз в 5 секунд.
  Websocket-presence, online-флаги и call-state на сервере не нужны.
* `RoomPresenceCleanupService` + `RoomPresenceCleanupScheduler` раз в минуту
  (настраивается `krug.rooms.presence-cleanup-interval`, отключается
  `krug.rooms.presence-cleanup-enabled=false`) вызывают `room.presence_cleanup`.
  В test-profile scheduler выключен, cleanup-сервис тестируется напрямую.
* Закрытая комната сразу перестаёт отдавать presence (directory выбирает только
  `ACTIVE`-комнаты); строки presence удаляются каскадом только при удалении комнаты,
  а до этого их убирает TTL-cleanup.

## 5. Права и аудит

| Операция | Кто |
|---|---|
| `GET /workspaces/{id}/rooms` | ACTIVE-участник workspace |
| `POST /workspaces/{id}/rooms` | любой ACTIVE-участник workspace |
| `GET /rooms/{id}` | ACTIVE-участник workspace комнаты |
| `PATCH /workspaces/{id}/rooms/{roomId}` | создатель комнаты или workspace OWNER/ADMIN |
| `DELETE /workspaces/{id}/rooms/{roomId}` | создатель комнаты или workspace OWNER |
| `POST/DELETE /rooms/{id}/presence` | ACTIVE-участник workspace; join — только ACTIVE-комната |

Audit:

* `chat.created` — как у любого PUBLIC GROUP-канала (metadata `visibility`,
  `member_count`);
* `room.created` — `target_type=room`, metadata только `chat_id`, `status`;
* `room.renamed` — metadata только `chat_id`;
* `room.closed` — metadata только `chat_id`, `status`;
* heartbeat/leave не аудируются (это high-frequency ephemeral-события).

Имена пользователей, email, устройства, ключи и содержимое сообщений в audit не
попадают.

## 6. RLS и tenant-изоляция

* Обе таблицы `ENABLE + FORCE ROW LEVEL SECURITY`, гранты `krug_app` только
  `SELECT/INSERT/UPDATE/DELETE`.
* `room.rooms`: tenant-policy по `workspace_id` + read-policy для ACTIVE-членства.
* `room.presence`: policy через `EXISTS (room.rooms ... workspace_id = current)`.
* `PRIMARY KEY(room_id,user_id)`, FK на `room.rooms`/`auth.users`, `UNIQUE(chat_id)`
  и `CHECK` имени/статуса — DB-backstops.
* `RoomsIT#roomsPresenceAndFunctionsRespectTenantRls` проверяет флаги RLS, гранты,
  FK/PK/UNIQUE, изоляцию SELECT-ов между двумя workspace, `WITH CHECK` на
  cross-tenant INSERT, `room_scope`/`presence_directory` для чужого viewer и
  cross-tenant cleanup.

## 7. Контракт и сгенерированные типы

`contracts/openapi.yaml` (аддитивно):

| Элемент | Изменение |
|---|---|
| `GET/POST /workspaces/{workspaceId}/rooms` | `listRooms`, `createRoom` |
| `PATCH/DELETE /workspaces/{workspaceId}/rooms/{roomId}` | `updateRoom`, `closeRoom` |
| `GET /rooms/{roomId}` | `getRoom` |
| `POST/DELETE /rooms/{roomId}/presence` | `joinRoomPresence`, `leaveRoomPresence` |
| `RoomParticipant` | `user_id`, `display_name`, `joined_at`, `last_seen_at` |
| `Room` | id/workspace/chat/name/creator/timestamps/status/participants/count/my_present |
| `RoomList` | `items` |
| `RoomCreateRequest`, `RoomUpdateRequest` | `name` 1..120 |
| `RoomId` parameter | path-параметр |

`frontend/src/api/schema.d.ts` регенерирован `npm run api:types`
(`openapi-typescript`). Guard `frontend/scripts/check-contract.mjs` обновлён на
**135 paths / 167 operations / 214 schemas** и получил явные проверки новых
операций/схем; `node scripts/check-contract.mjs` — `Contract check passed`.

Примечание: правка `check-contract.mjs` формально вне заявленной зоны, но без неё
`npm run contract:check` падал бы на аддитивных путях/схемах; продуктовый
frontend-код не менялся.

## 8. Тесты

### 8.1 `RoomsIT` (7/7)

| Тест | Что проверяет |
|---|---|
| `createsRoomWithBackingManagedChannelForEveryActiveMember` | 201, room + GROUP/MANAGED/PUBLIC/OPEN канал, создатель OWNER, все ACTIVE-участники, счётчик/права, audit `room.created`/`chat.created`, list/detail |
| `listsOnlyPresentParticipantsInsideTheTtlAndReportsMyPresent` | heartbeat → participant_count/my_present; TTL 31s → участник исчезает; cleanup удаляет строку; новый heartbeat возвращает |
| `heartbeatPreservesJoinedAtAndLeaveIsIdempotent` | heartbeat сохраняет joined_at внутри TTL, leave/повторный leave, новый joined_at после ре-join |
| `enforcesRenameAndClosePermissionsAndClosedRoomRules` | member 403; ADMIN rename 200, close 403; OWNER rename/close; creator close; closed room 409; outsiders 403/404 |
| `enforcesInstallationChatLimitsWithoutPartialRooms` | USER/WORKSPACE `CHAT_LIMIT_REACHED`, отсутствие partial room/chat, успешное создание после сброса лимита |
| `rejectsInvalidNamesAndE2eeWorkspaces` | 400 на blank/121 символ; E2EE workspace → `E2EE_GROUP_NOT_SUPPORTED`, без room/chat |
| `roomsPresenceAndFunctionsRespectTenantRls` | FORCE RLS, гранты, FK/PK/UNIQUE, tenant isolation, WITH CHECK, scope/directory, cross-tenant cleanup |

### 8.2 Полный прогон

* `mvn -o -Dmaven.repo.local=.m2repo test` на **JDK 21**:
  **Tests run: 1091, Failures: 0, Errors: 0, Skipped: 0** — BUILD SUCCESS.
* `ArchitectureTest` — **11/11** (включая изоляцию нового контекста `room`).
* `RoomsIT` — **7/7**.
* Contract guard — **135 paths / 167 operations / 214 schemas**, generated types
  in sync.

Примечание по окружению: запуск на JDK 26 даёт ошибки Mockito inline-mock в
существующих unit-тестах (`WorkspaceSessionServiceTest` и др.) — это ограничение
JDK 26, не среза; CI/`pom.xml` используют Java 21, где прогон чистый.

## 9. Файлы

Новые (29):

* `backend/src/main/resources/db/migration/V60__rooms_presence.sql`;
* `backend/src/main/java/ru/krug/backend/room/domain/model/Room.java`,
  `RoomParticipant.java`, `RoomPresencePolicy.java`, `RoomScope.java`;
* `backend/src/main/java/ru/krug/backend/room/domain/repository/RoomRepository.java`;
* `backend/src/main/java/ru/krug/backend/room/application/model/RoomView.java`,
  `RoomParticipantView.java`, `RoomListView.java`;
* `backend/src/main/java/ru/krug/backend/room/application/usecase/CreateRoomService.java`,
  `ListRoomsService.java`, `GetRoomService.java`, `RenameRoomService.java`,
  `CloseRoomService.java`, `RoomPresenceService.java`, `RoomAccessService.java`,
  `RoomPresenceCleanupService.java`;
* `backend/src/main/java/ru/krug/backend/room/infrastructure/persistence/RoomRepositoryAdapter.java`;
* `backend/src/main/java/ru/krug/backend/room/infrastructure/scheduling/RoomPresenceCleanupScheduler.java`;
* `backend/src/main/java/ru/krug/backend/room/api/RoomController.java`;
* `backend/src/main/java/ru/krug/backend/room/api/dto/CreateRoomRequest.java`,
  `UpdateRoomRequest.java`, `RoomResponse.java`, `RoomParticipantResponse.java`,
  `RoomListResponse.java`;
* `backend/src/main/java/ru/krug/backend/room/api/mapper/RoomApiMapper.java`;
* `backend/src/main/java/ru/krug/backend/chat/application/port/RoomChannelPort.java`,
  `backend/src/main/java/ru/krug/backend/chat/application/usecase/RoomChannelService.java`;
* `backend/src/test/java/ru/krug/backend/integration/RoomsIT.java`.

Изменённые:

* `backend/src/main/java/ru/krug/backend/shared/error/ErrorCode.java` (`ROOM_NOT_FOUND`,
  `ROOM_CLOSED`);
* `backend/src/main/resources/application-test.yml` (scheduler off в тестах);
* `backend/src/test/java/ru/krug/backend/ArchitectureTest.java` (контекст `room`);
* `contracts/openapi.yaml`;
* `frontend/src/api/schema.d.ts` (регенерирован);
* `frontend/scripts/check-contract.mjs` (счётчики/явные проверки).

## 10. Ограничения среза

* Нет пагинации списка комнат: hard cap 200, сортировка `created_at DESC, id DESC`.
* Нет аватарок/обложек/приглашений/паролей комнат — это обычные workspace-комнаты.
* Нет SFU, серверного микширования, записи, истории звонков и состояния звонка:
  только presence и существующий WebRTC signaling в backing-канале.
* Комнаты MANAGED-only; E2EE-workspace не поддерживается.
* Закрытие комнаты мягко удаляет backing-канал (история/байты остаются в БД, но
  канал исчезает из списка чатов).
* `GET /rooms/{roomId}` отдаёт и закрытую комнату (`status=CLOSED`), чтобы UI мог
  показать состояние; в списке закрытых комнат нет.
* UI комнат — вне зоны backend-среза; готовы контракт и типы.

## 11. Итог

**DONE.**

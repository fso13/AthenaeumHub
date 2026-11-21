# #94 — Music Room (backend)

> Zone: `backend/**`, additive `contracts/**`, regenerated `frontend/src/api/schema.d.ts`.
> Frontend UI не редактировался. `frontend/src/i18n/ru.ts` уже был изменён до начала
> среза и оставлен как есть. Дополнительно обновлены ожидаемые счётчики существующего
> guard-скрипта `frontend/scripts/check-contract.mjs` — иначе `npm run contract:check`
> падал бы на аддитивных путях/схемах; продуктовый frontend-код не менялся.

## Статус

**DONE в границах #94.**

* В built-in каталог добавлен плагин `music-room` (`MANAGED`, permissions
  `FILES`/`MESSAGES`, версия среза **1.0.0**).
* `POST /api/v1/workspaces/{workspaceId}/music-room` — идемпотентный find-or-create
  единственной музыкальной комнаты воркспейса. Создатель — `OWNER`, все ACTIVE-участники
  воркспейса добавлены, видимость `PUBLIC`, join policy `OPEN`, плагин включён в канале.
  Ответ — `Chat` + plugin state; `201` при создании, `200` при повторном открытии.
* `GET /api/v1/chats/{chatId}/music-room` — при включённом плагине отдаёт AUDIO-вложения
  канала через file center: id, filename, mime, duration, artwork, title/artist, размер,
  message_id, created_at. Никаких object key, sha256, presigned URL и байтов.
* Никакого серверного аудио, playback state, SFU или сигналинга в этом срезе нет:
  фронтенд перечисляет AUDIO-вложения и микширует звук в звонок локально.
* Дубликат канала на воркспейс невозможен: PK `(workspace_id, plugin_id)` +
  advisory-лок + `UNIQUE(chat_id)`; конкурентный тест подтверждает ровно один канал.
* Тесты: `MusicRoomIT` **7/7**, `ArchitectureTest` **10/10**, полный backend suite
  **912/912** (0 failures, 0 errors, 0 skipped).

## 1. Схема данных (V52)

`backend/src/main/resources/db/migration/V52__music_room_plugin.sql` (V51 занят
параллельным срезом #95).

### 1.1 Seed built-in плагина

```sql
INSERT INTO plugin.catalog
  (id, name, description, icon, permissions, modes, state, sort_order)
VALUES
  ('music-room', 'Музыкальная комната',
   'Совместное прослушивание музыки: аудиофайлы канала и общий плеер.',
   'music', ARRAY['FILES', 'MESSAGES']::text[], ARRAY['MANAGED']::text[],
   'ACTIVE', 60)
ON CONFLICT (id) DO NOTHING;
```

| Поле | Значение |
|---|---|
| `id` | `music-room` |
| `permissions` | `FILES`, `MESSAGES` |
| `modes` | `MANAGED` |
| `state` | `ACTIVE` |
| `sort_order` | `60` (после пяти существующих built-in) |
| `kind` | `BUILTIN` |

**Про версию 1.0.0.** По дизайну V44 built-in строки `plugin.catalog` не хранят
package version (`ck_plugin_catalog_external_metadata`: `kind='BUILTIN' ⇒ version IS
NULL`). Версия `1.0.0` — версия этого среза; она отдаётся в
`MusicRoomPlugin.version` и зафиксирована здесь/в комментарии миграции. Менять
V44-констрейнт и ломать модель built-in/external ради колонки не стали.

### 1.2 Тег комнаты

```sql
CREATE TABLE chat.plugin_rooms (
  workspace_id uuid NOT NULL,
  plugin_id    text NOT NULL REFERENCES plugin.catalog(id) ON DELETE RESTRICT,
  chat_id      uuid NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  created_by   uuid NOT NULL,             -- no FK: удаление пользователя не теряет тег
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, plugin_id),
  CONSTRAINT uq_plugin_rooms_chat UNIQUE (chat_id)
);
```

* `PRIMARY KEY (workspace_id, plugin_id)` — БД-backstop «одна комната на воркспейс».
* `UNIQUE (chat_id)` — один чат не может быть комнатой двух плагинов.
* `ENABLE/FORCE ROW LEVEL SECURITY`, policy `p_plugin_rooms_tenant` по
  `ops.current_workspace_id()`; `GRANT SELECT, INSERT, UPDATE, DELETE TO krug_app`.
* Мягко удалённый чат оставляет тег; следующее открытие переустанавливает ссылку на
  новый живой канал. Это не создаёт второй живой музыкальной комнаты.
* Комментарии на таблицу/колонки и forward-only rollback plan — в миграции.

## 2. API

### 2.1 `POST /api/v1/workspaces/{workspaceId}/music-room`

Идемпотентный find-or-create.

Алгоритм:

1. `TenantContext.activate` + `WorkspaceAccessPort.requireActiveMember` — только ACTIVE
   участник воркспейса.
2. Плагин читается из каталога; `PluginAvailabilityPolicy` проверяет kill switch и режим.
   `DISABLED` → `422 PLUGIN_DISABLED`; E2EE-воркспейс → `422 PLUGIN_NOT_AVAILABLE`.
3. `pg_advisory_xact_lock(hashtextextended('plugin.room|<ws>|<plugin>', 0))` —
   сериализация find-or-create.
4. Поиск тега в `chat.plugin_rooms`.
   * тег есть и канал живой → возвращается существующий канал (`200`);
   * тег есть, канал soft-deleted → создаётся новый канал, тег переустанавливается;
   * тега нет → создаётся новый канал (`201`).
5. Канал создаётся chat-контекстом через `MusicRoomChannelPort`:
   `chat.create|ws` advisory lock, проверка лимитов, `Chat.createGroup`,
   `ChatMember.owner`, `saveChannelSettings(PUBLIC)` (join policy `OPEN` + default
   permissions), `addActiveWorkspaceMembers`.
6. `chatPlugins.setEnabled(..., true)` и audit `music.room.opened` с metadata только
   `{"created": boolean}`.

Ответ `MusicRoomOpen`:

```json
{
  "chat": { "id": "...", "type": "GROUP", "security_mode": "MANAGED",
            "visibility": "PUBLIC", "name": "Музыкальная комната",
            "join_policy": "OPEN", "last_seq": 0, "unread_count": 0,
            "created_at": "..." },
  "plugin": { "plugin_id": "music-room", "enabled": true,
              "available": true, "version": "1.0.0" },
  "created": true
}
```

Коды: `201` создано, `200` существующая комната, `401`, `403` (не ACTIVE участник
воркспейса), `409 CHAT_LIMIT_REACHED` (только при фактическом создании), `422`
(`PLUGIN_DISABLED`/`PLUGIN_NOT_AVAILABLE`).

### 2.2 `GET /api/v1/chats/{chatId}/music-room`

Гейт — общий `PluginActionGate`: ACTIVE-членство в чате, наличие плагина, доступность в
режиме чата, включённый per-chat toggle.

* выключенный плагин → `422 PLUGIN_NOT_ENABLED`;
* kill switch каталога → `422 PLUGIN_DISABLED`;
* серверный плагин в E2EE → `422 PLUGIN_NOT_AVAILABLE`;
* неизвестный/удалённый/чужой чат или удалённый участник → `404` (существование не
  раскрывается); не-участник воркспейса → `403`.

Ответ `MusicRoomTracks`:

```json
{
  "chat_id": "...",
  "plugin": { "plugin_id": "music-room", "enabled": true,
              "available": true, "version": "1.0.0" },
  "items": [
    { "id": "...", "message_id": "...", "filename": "song.mp3",
      "mime_type": "audio/mpeg", "duration_ms": 240000,
      "artwork_url": "https://cdn.example.com/art.jpg",
      "title": "Song", "artist": "Artist",
      "size_bytes": 123456, "created_at": "..." }
  ],
  "has_more": false
}
```

Источник данных — существующий `FileCenterQueryPort`:

* фильтр `chat_id` + `kind=AUDIO` + `scan_status=CLEAN`;
* тот же SQL проверяет ACTIVE-членство в чате, `MANAGED`-режим, живое сообщение,
  delete-for-me и исключает E2EE;
* выбираются только метаданные; object key, sha256, presigned URL, байты и содержимое
  чужих чатов недоступны;
* `artwork_url` — клиентский URL из ID3/метаданных; сервер его не загружает и не
  резолвит (как и в file center);
* сортировка `created_at DESC`, лимит 100, `has_more` показывает, что более старые
  треки не вошли. Курсора в этом срезе нет.

`GET` намеренно chat-scoped: он работает в любом канале, где менеджер включил плагин,
а не только в канале, созданном через `POST`. Это позволяет использовать один контракт
для «музыкального режима» любого канала; `POST` по-прежнему гарантирует одну комнату на
воркспейс.

## 3. Идемпотентность и конкурентность

| Механизм | Роль |
|---|---|
| `chat.plugin_rooms` PK `(workspace_id, plugin_id)` | БД-инвариант: одна комната на воркспейс |
| `UNIQUE(chat_id)` | Чат не может быть комнатой двух плагинов |
| `pg_advisory_xact_lock('plugin.room|...')` | Сериализует find-or-create в одной транзакции |
| `chat.create|ws` lock в chat-контексте | Лимиты и вставка чата наблюдаются в одном снапшоте |
| `ON CONFLICT ... DO UPDATE ... WHERE chat_id IS DISTINCT` | Идемпотентная переустановка тега |

`MusicRoomIT#concurrentOpensCreateExactlyOneChannel` запускает два параллельных HTTP-
запроса: ровно один `201`, один `200`, один `chat_id`, `tagCount=1`.

Лимиты проверяются **только при создании**. Повторное открытие существующей комнаты
проходит даже при исчерпанном лимите (проверено `MusicRoomIT#respectsInstallationChatLimits...`).

## 4. Права и аудит

| Операция | Кто |
|---|---|
| `POST /workspaces/{id}/music-room` | ACTIVE-участник воркспейса |
| `GET /chats/{id}/music-room` | ACTIVE-участник чата |
| Включение/выключение плагина | ACTIVE chat OWNER/ADMIN (существующий endpoint) |

Audit:

* `chat.created` — как у любого PUBLIC GROUP-канала, metadata только
  `visibility`/`member_count`;
* `music.room.opened` — `target_type=chat`, metadata только `created` (boolean).

Имена, user ids, содержимое файлов и artwork URL в audit не попадают.

## 5. Почему нет SFU / виртуального аудио

В этом срезе сервер **не** хранит и не воспроизводит аудио, не создаёт SFU-сессию, не
выдаёт RTP-токены и не синхронизирует playback. Музыкальная комната — это обычный
managed GROUP-канал плюс метаданные AUDIO-вложений. Фронтенд:

* получает список треков через `GET /chats/{chatId}/music-room`;
* скачивает выбранный трек обычным путём `attachmentDownloadUrl`;
* локально микширует его в звонок (WebAudio/MediaStream) — серверный микс не нужен.

Это осознанная граница #94; SFU/серверный микс — отдельный будущий срез.

## 6. Контракт

`contracts/openapi.yaml` (аддитивно):

| Элемент | Изменение |
|---|---|
| `POST /workspaces/{workspaceId}/music-room` | новая операция `openMusicRoom` |
| `GET /chats/{chatId}/music-room` | новая операция `getMusicRoom` |
| `MusicRoomPlugin` | `plugin_id`, `enabled`, `available`, `version`, optional `reason` |
| `MusicRoomOpen` | `chat` (`Chat`), `plugin`, `created` |
| `MusicRoomTrack` | метаданные AUDIO-вложения без секретов |
| `MusicRoomTracks` | `chat_id`, `plugin`, `items`, `has_more` |

`frontend/src/api/schema.d.ts` регенерирован через `openapi-typescript`
(`npm run api:types`). Guard `check-contract.mjs` обновлён на **146 operations / 195
schemas** и получил явные проверки новых операций/схем; `node scripts/check-contract.mjs`
— `Contract check passed`.

## 7. Тесты

### 7.1 Новые тесты — `MusicRoomIT` (7/7)

| Тест | Что проверяет |
|---|---|
| `opensTheRoomIdempotentlyWithOwnerAllMembersAndPluginEnabled` | 201/200, тот же chat id, OWNER + все ACTIVE, PUBLIC/OPEN, plugin enabled, один тег, audit `chat.created`/`music.room.opened`, повтор любым участником |
| `onlyActiveWorkspaceMembersCanOpenOrReadTheRoom` | не-участник воркспейса → 403/404, ACTIVE-участник → 200, удалённый из чата → 404 без дубля, удалённый из воркспейса → 403 |
| `respectsInstallationChatLimitsOnlyWhenCreatingTheRoom` | `CHAT_LIMIT_REACHED` для USER и WORKSPACE, отсутствие тега после отказа, повтор существующей комнаты при исчерпанном лимите |
| `listsOnlyCleanAudioAttachmentsWithMetadataAndNoSensitiveFields` | только AUDIO, только CLEAN, duration/artwork/title/artist, порядок DESC, нет object key/sha256/url/content, не-аудио исключено |
| `disabledPluginAndCatalogKillSwitchBlockTheRoom` | `422 PLUGIN_NOT_ENABLED`, повторный POST включает обратно, `422 PLUGIN_DISABLED` на GET и POST |
| `concurrentOpensCreateExactlyOneChannel` | два параллельных POST → один `201`, один `200`, один chat id, один тег |
| `schemaSeedsPluginAndProtectsTheRoomTagWithRls` | seed/поля каталога, FORCE RLS, гранты, FK/UNIQUE, tenant-изоляция, PK/WITH CHECK backstops |

### 7.2 Изменённые тесты

Каталог вырос с 5 до 6 built-in, поэтому обновлены существующие ожидания:

* `ChatPluginsIT` — `plugin.catalog` count 6, active 6;
* `PluginCatalogIT` — `PLUGIN_IDS` + `music-room`;
* `E2eePluginsIT` — 6 в каталоге/состояниях;
* `PluginPackagesIT` — 6 built-in после uninstall, 7 с установленным external.

### 7.3 Прогоны (JDK 21, PostgreSQL 16 Testcontainers)

* Целевой: `MusicRoomIT` **7/7**.
* `MusicRoomIT` + `ChatPluginsIT` + `PluginCatalogIT` + `E2eePluginsIT` +
  `PluginPackagesIT` + `ArchitectureTest` — **34/34**.
* Полный backend suite: `mvn -o -Dmaven.repo.local=.m2repo test` —
  **Tests run: 912, Failures: 0, Errors: 0, Skipped: 0** (BUILD SUCCESS, 01:35).
  Требование «905+» выполнено.
* ArchUnit: **10/10** (domain purity, application/api layering, cross-context domain
  isolation, controllers/entities placement).
* Contract guard: **146 operations / 195 schemas**, generated types in sync.
* Frontend guards: `check-security` 393 files OK, `check-stickers` OK,
  `check-session-writers` OK, `prettier --check` OK для изменённых файлов.

## 8. Файлы

Новые (23):

* `backend/src/main/resources/db/migration/V52__music_room_plugin.sql`;
* `backend/src/main/java/ru/krug/backend/plugin/domain/model/MusicRoom.java`;
* `backend/src/main/java/ru/krug/backend/plugin/domain/repository/MusicRoomRepository.java`;
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/persistence/MusicRoomRepositoryAdapter.java`;
* `backend/src/main/java/ru/krug/backend/plugin/application/model/MusicRoomChatView.java`,
  `MusicRoomPluginStateView.java`, `MusicRoomOpenView.java`, `MusicRoomTrackView.java`,
  `MusicRoomTracksView.java`;
* `backend/src/main/java/ru/krug/backend/plugin/application/port/MusicRoomTrackPort.java`;
* `backend/src/main/java/ru/krug/backend/plugin/application/usecase/OpenMusicRoomService.java`,
  `GetMusicRoomService.java`;
* `backend/src/main/java/ru/krug/backend/plugin/infrastructure/adapter/MusicRoomTrackAdapter.java`;
* `backend/src/main/java/ru/krug/backend/plugin/api/MusicRoomController.java`;
* `backend/src/main/java/ru/krug/backend/plugin/api/dto/MusicRoomChatResponse.java`,
  `MusicRoomPluginResponse.java`, `MusicRoomOpenResponse.java`,
  `MusicRoomTrackResponse.java`, `MusicRoomTracksResponse.java`;
* `backend/src/main/java/ru/krug/backend/plugin/api/mapper/MusicRoomApiMapper.java`;
* `backend/src/main/java/ru/krug/backend/chat/application/port/MusicRoomChannelPort.java`;
* `backend/src/main/java/ru/krug/backend/chat/application/usecase/MusicRoomChannelService.java`;
* `backend/src/test/java/ru/krug/backend/integration/MusicRoomIT.java`.

Изменённые: `contracts/openapi.yaml`, `frontend/src/api/schema.d.ts`,
`frontend/scripts/check-contract.mjs`, четыре теста каталога (см. 7.2).

## 9. Ограничения среза

* Список треков ограничен 100 последними AUDIO-вложениями; пагинация/курсор — не в этом
  срезе.
* `DELETE /chats/{chatId}/music-room/track/{attachmentId}` не реализован (помечен
  опциональным в задаче); удаление идёт обычными message/file-путями.
* Отдельного upload endpoint нет: музыкальные файлы загружаются существующим file flow
  и отправляются вложениями в канал.
* Нет playback state, синхронизации позиции, SFU/микса и серверного аудио.
* `GET` не проверяет, что `chatId` — именно канал из `chat.plugin_rooms`; он работает для
  любого канала с включённым плагином (см. 2.2).
* Версия `1.0.0` отдаётся API, но не хранится в `plugin.catalog`: built-in rows по
  дизайну V44 не имеют package version.
* UI музыкальной комнаты — вне зоны backend-среза; готовы контракт и типы.

## 10. Итог

**DONE.**

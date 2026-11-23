# Music Room removal — backend

> Задача: полностью удалить встроенный плагин **Music Room** (`music-room`, #94) из
> backend, контракта и БД, не трогая незавершённую работу **Rooms (#105)** и не
> удаляя созданные ранее GROUP-каналы.

## Статус

**DONE в границах Music Room.** Backend-код плагина, его порты, адаптеры, DTO и тесты
удалены; добавлена forward-only миграция `V59`, очищающая каталог и тег комнаты.
Каналы, созданные старым endpoint'ом, остаются обычными managed GROUP-чатами.

## 1. Удалённый backend-код (22 файла)

| Слой | Файлы |
|---|---|
| domain | `plugin/domain/model/MusicRoom.java`, `plugin/domain/repository/MusicRoomRepository.java` |
| application | `plugin/application/model/MusicRoomChatView.java`, `MusicRoomOpenView.java`, `MusicRoomPluginStateView.java`, `MusicRoomTrackView.java`, `MusicRoomTracksView.java`; `plugin/application/port/MusicRoomTrackPort.java`; `plugin/application/usecase/OpenMusicRoomService.java`, `GetMusicRoomService.java` |
| infrastructure | `plugin/infrastructure/adapter/MusicRoomTrackAdapter.java`, `plugin/infrastructure/persistence/MusicRoomRepositoryAdapter.java` |
| API | `plugin/api/MusicRoomController.java`; `plugin/api/dto/MusicRoomChatResponse.java`, `MusicRoomOpenResponse.java`, `MusicRoomPluginResponse.java`, `MusicRoomTrackResponse.java`, `MusicRoomTracksResponse.java`; `plugin/api/mapper/MusicRoomApiMapper.java` |
| chat-контекст | `chat/application/port/MusicRoomChannelPort.java`, `chat/application/usecase/MusicRoomChannelService.java` |
| tests | `integration/MusicRoomIT.java` (7 тестов) |

После удаления `grep -ri music backend/src` не находит ничего, кроме:
* `AudioMetadataParser.java` — музыкальный **жанр** ID3 (`"Musical"`), не плагин;
* исторических миграций `V52`/`V59` (см. ниже).

## 2. Миграция `V59__remove_music_room_plugin.sql`

`V52` **не редактировалась**: на существующих установках она уже применена, Flyway
хранит её checksum. Удаление выполнено новой аддитивной миграцией `V59`; на чистой БД
Flyway прогоняет `V52` (seed) → `V59` (cleanup), и итоговый каталог совпадает с
обновлённой установкой.

Порядок и содержание:

```sql
-- 1. Тег комнаты. DROP удаляет RLS policy и гранты krug_app на таблицу.
DROP TABLE IF EXISTS chat.plugin_rooms;

-- 2. Per-chat toggle плагина. FK plugin_id → plugin.catalog ON DELETE RESTRICT,
--    поэтому строки удаляются до строки каталога. Таблица — FORCE RLS, поэтому на
--    время cleanup снимается FORCE (владелец таблицы обходит policy), затем
--    восстанавливается точное состояние V34.
ALTER TABLE chat.chat_plugins NO FORCE ROW LEVEL SECURITY;
DELETE FROM chat.chat_plugins WHERE plugin_id = 'music-room';
ALTER TABLE chat.chat_plugins FORCE ROW LEVEL SECURITY;

-- 3. Строка built-in каталога.
DELETE FROM plugin.catalog WHERE id = 'music-room';
```

Почему это безопасно:

* `chat.plugin_rooms` — таблица только этого плагина; на неё нет ссылок из других
  таблиц, её удаление не затрагивает `chat.chats`, участников, сообщения и файлы.
* `chat.chat_plugins` чистится только для `plugin_id = 'music-room'`; state других
  built-in и external-пакетов не меняется.
* `plugin.catalog` теряет ровно одну строку; внешние пакеты (`kind='EXTERNAL'`) и
  остальные пять built-in остаются.
* **GROUP-каналы не удаляются.** Канал, созданный через `POST /workspaces/{id}/music-room`,
  больше не помечен как комната, но остаётся обычным managed GROUP-чатом со своей
  историей, участниками и AUDIO-вложениями. File center от плагина не зависит.

Rollback plan зафиксирован в комментарии миграции: повторно применить `V52` из VCS;
каналы после rollback остаются обычными и автоматически не перетегируются.

## 3. Обновлённые ожидания каталога

| Тест | Было | Стало |
|---|---|---|
| `PluginCatalogIT.PLUGIN_IDS` | 6 id c `music-room` | 5 id: `polls, tasks, translate, telegram, dlp` |
| `ChatPluginsIT.schemaHasRlsGrantsSeed...` | `count(plugin.catalog)=6`, active=6 | 5 / 5 |
| `E2eePluginsIT` | catalog 6, chat states 6 | 5 / 5 |
| `PluginPackagesIT` | 6 built-in + external = 7; после uninstall 6 | 5 + external = 6; после uninstall 5 |

`ArchitectureTest` контексты не менялись: `plugin` по-прежнему используется
(polls/tasks/translate/telegram/dlp), поэтому удалять контекст из ArchUnit не требовалось.
Контекст `room` — работа параллельного среза #105, он не затрагивался.

## 4. Контракт

Из `contracts/openapi.yaml` удалены:

* `POST /workspaces/{workspaceId}/music-room` (`openMusicRoom`);
* `GET /chats/{chatId}/music-room` (`getMusicRoom`);
* схемы `MusicRoomPlugin`, `MusicRoomOpen`, `MusicRoomTrack`, `MusicRoomTracks`.

`frontend/src/api/schema.d.ts` регенерирован. Guard `check-contract.mjs` больше не
содержит music-room операций/схем и проверок версии `1.0.0`.

Вклад именно этого среза в счётчики: **−2 path, −2 operation, −4 schema**
(было 133/162/213 → 131/160/209). На момент финальной проверки в общей ветке уже
присутствует параллельный #105, поэтому guard проходит на
**135 paths / 167 operations / 214 schemas** — это наши 131/160/209 плюс 4/7/5
путей/операций/схем Rooms. Music Room в этом наборе отсутствует.

## 5. Проверка

JDK 21, PostgreSQL 16 Testcontainers, `mvn -o -Dmaven.repo.local=.m2repo`:

* целевые: `PluginCatalogIT`, `ChatPluginsIT`, `E2eePluginsIT`, `PluginPackagesIT`,
  `ArchitectureTest` — **28/28**, ArchUnit **11/11**;
* полный backend suite на снимке объединённого дерева (Music Room removal + untracked
  Rooms #105 + V59/V60) — **Tests run: 1091, Failures: 0, Errors: 0, Skipped: 0**,
  BUILD SUCCESS (01:54), ArchUnit **11/11**. Миграции V1…V60, включая V59 cleanup,
  применяются на чистой БД;
* отдельный прогон `MigrationsIT, ChatPluginsIT, PluginCatalogIT, PluginPackagesIT,
  E2eePluginsIT` на объединённом дереве — **30/30**; после V59 в `plugin.catalog`
  пять built-in, `chat.plugin_rooms` отсутствует, грантов на неё нет;
* после финальной правки V59 (FORCE RLS-safe cleanup) отдельно перепроверены
  `MigrationsIT` + `ChatPluginsIT` — **19/19**, включая проверку, что у
  `chat.chat_plugins` восстановлен `relforcerowsecurity = true`;
* финальный полный прогон после этой правки — снова **1091/1091**, BUILD SUCCESS
  (01:56). Промежуточные прогоны дважды поймали pre-existing флейки в bot-тестах
  (`BotEventsIT`, `BotCommandEventDomainTest` — случайный UUID в assert); оба теста
  проходят изолированно и в финальном прогоне, к Music Room отношения не имеют.

### Замечание о параллельном #105

В рабочем дереве параллельно появились **untracked** файлы Rooms (#105)
(`backend/src/main/java/ru/krug/backend/room/`, `RoomChannelPort/Service`,
`V60__rooms_presence.sql`, `RoomsIT`). Они не трогались и не удалялись. На раннем этапе
их код временно ломал общий `mvn compile` (`ErrorCode.ROOM_CLOSED` ещё не был добавлен);
к моменту финальной проверки они добавили константы и контракт. Чтобы не мешать
параллельному агенту и не писать в общий `target/`, прогоны выполнены на изолированной
копии текущего дерева. Сначала Music Room срез проверен отдельно (1084/1084 без #105),
затем объединённый снимок с #105 — **1091/1091**. Наш V59 не конфликтует с их V60;
порядок миграций V52 → V59 → V60 корректен.

## 6. Ограничения

* Старые отчёты `backend/MUSIC-ROOM-REPORT.md` и `frontend/MUSIC-ROOM-UI-REPORT.md`
  удалены как документация снятой фичи. Исторический комментарий в неизменяемой `V52`
  ссылается на старый отчёт — это допустимая историческая ссылка, `V52` не
  редактируется из-за checksum Flyway.
* Issue #94 не закрыт из этой сессии: `gh`/`GITHUB_TOKEN`/`GH_TOKEN` недоступны,
  сетевой GitHub API без токена не даёт закрыть issue. Закрытие выполняет агент/владелец
  репозитория после merge.

## 7. Итог

**DONE.**

# #94 — Music Room (frontend UI + host relay)

> Zone: `frontend/**`. Backend #94 (`POST /workspaces/{id}/music-room`,
> `GET /chats/{id}/music-room`, built-in plugin `music-room`) already shipped;
> this slice consumes the contract and adds the UI/player/call relay.
> Status: **DONE**.

## 1. Что сделано

### 1.1 PluginsPage — «Открыть музыкальную комнату»

- На карточке built-in плагина `music-room` появилась кнопка
  **«Открыть музыкальную комнату»** (`aria-label` и title совпадают, иконка
  `MusicIcon`).
- Действие вызывает `POST /workspaces/{workspaceId}/music-room` через
  `MusicRoomStore.open()`. Кнопка блокируется на время запроса
  («Открываем комнату…»), для E2EE-воркспейса и без активного воркспейса
  показывается честная причина.
- Idempotency: повторный клик/повторный вход возвращает **тот же** канал
  (`created=false` на сервере), второй канал не создаётся. In-flight promise
  дедуплицируется в сторе, PK/advisory-lock на сервере остаются backstop.
- После `201`/`200` список чатов перечитывается
  (`ChatStore.reloadChats()`), новый/существующий канал выбирается в
  селекторе «Чат» и становится активным; пользователь переходит в чат.
- Ошибки открытия показываются `role=alert` с отдельными текстами для `403`,
  `409 CHAT_LIMIT_REACHED`, `422 PLUGIN_DISABLED` / `PLUGIN_NOT_AVAILABLE` и
  кнопкой «Повторить». Никакого оптимистичного создания канала нет.

### 1.2 Панель «Музыкальная комната» в ChatDetails

- Строка-аккордеон «Музыкальная комната» в правой панели чата. Она видна
  **только** для GROUP + MANAGED, когда сервер сообщает
  `enabled && available` для `music-room` (`usePluginGate`); в E2EE, DIRECT и
  при выключенном плагине строки нет. В счётчике строки — число треков из
  `GET /chats/{chatId}/music-room`, `—` пока данные не загружены.
- Внутри — `MusicRoomPanel` (`src/components/music/MusicRoomPanel.tsx`):
  - список треков: title/artist (fallback — filename/«Неизвестный
    исполнитель»), `duration_ms` в `m:ss`, `size_bytes` в человекочитаемом
    виде, artwork из безопасного http(s) URL или иконка;
  - play/pause, next/prev, текущий трек, громкость (range 0–100), состояние
    «Сейчас играет», кнопка повтора при ошибке воспроизведения;
  - пустое состояние («В комнате пока нет аудио»), loading, error + retry,
    подсказка при `has_more` (сервер отдаёт максимум 100 последних треков);
  - «Прикрепить аудио в чат» вызывает существующий file picker композера
    (`#file-input`), «Все файлы» ведёт на страницу Files. Отдельного upload
    endpoint нет и не придумано — треки остаются обычными AUDIO-вложениями.
- Доступность: `section` с `aria-labelledby`, список с `aria-label`,
  `aria-current` на играющем треке, `role=status`/`role=alert`,
  `aria-live` для текущего трека, все иконки `aria-hidden`, axe-аудит панели
  проходит (serious/critical = 0).

### 1.3 Плеер и autoplay

- `MusicRoomStore` (`src/music/store.ts`) — read model + локальный плеер.
  Чтение: `ensureTracks`, `loadTracks`, `retryTracks`, `open`. Плеер:
  `playTrack`, `toggle`, `pause`, `resume`, `next`, `previous`, `stop`,
  `setVolume`, `getStream`.
- Звук идёт через `HTMLAudioElement`. **Autoplay запрещён**: ни `play()`, ни
  создание `Audio` не вызываются на mount/при открытии панели; воспроизведение
  стартует только из клика play/трека. Пустой клик play запускает первый трек
  только после явного действия.
- `src/music/audioGraph.ts` — Web Audio граф: `MediaElementSource` → локальный
  `ctx.destination` (слышит владелец) и `MediaStreamDestination` (музыкальный
  `MediaStream` для звонка). Без Web Audio плеер продолжает играть локально, а
  панель честно пишет, что участники не слышат музыку.

### 1.4 Интеграция со звонком — honest host relay

- `CallController.setIncomingMusicStream(stream | null): boolean`
  (`src/calls/CallController.ts`) — публичный контракт для UI/стора.
- Когда звонок активен и музыка играет:
  - `createWebAudioMusicMixer()` (`src/calls/musicMix.ts`) собирает
    `MediaStreamDestination` из **микрофона + музыки**;
  - `replaceAudioSender` заменяет исходящий audio-трек через
    `RTCRtpSender.replaceTrack` на **каждом** `RTCPeerConnection` — 1:1 и все
    ноги GROUP mesh; новые пиры/ноги получают микс сразу после `addTrack`
    (`addLocalTracks`), новые участники конференции — тоже;
  - `CallState.musicActive` становится `true` только когда микс реально
    применён (или поставлен для ещё подключающихся пиров). UI не утверждает
    больше, чем произошло.
- `setIncomingMusicStream(null)`/pause/stop/конец звонка: микшер
  освобождается, на все живые sender'ы возвращается исходный микрофонный
  трек. `resetResources()` (hangup/reject/fail/leave последнего пира) делает
  это до закрытия peer connection, затем очищает `incomingMusicStream`.
- Конец звонка останавливает музыку (требование «stop music/restore mic»):
  `MusicRoomStore.handleCallState` получает каждое изменение `CallState` из
  `ChatStore` и на переходе в `idle` вызывает `stop()`.
- **Нет SFU, нет серверного микса, нет серверного бота.** Сервер не хранит
  аудио и playback state; всё это — локальный host relay одного из
  участников. Если звонка нет, музыка играет только локально.
- Подписи в UI: «DJ Сова» в панели и в звонке; «Музыку слышат участники
  звонка.» — только при подтверждённом миксе; «Музыку слышите только вы:
  микрофон звонка не изменён.» — если Web Audio недоступен; «Без звонка
  музыка слышна только вам.» — без звонка. Формулировок про независимого
  серверного бота нет.

## 2. Контракт и API

- `contracts/openapi.yaml` / `schema.d.ts` уже содержали операции; backend
  guard: **146 operations / 195 schemas**. `contract:check` проходит.
- Добавлены типы `MusicRoomPlugin`, `MusicRoomOpen`, `MusicRoomTrack`,
  `MusicRoomTracks` (`src/api/types.ts`).
- `ChatApi.openMusicRoom(workspaceId)` → `POST
/workspaces/{workspaceId}/music-room`; `ChatApi.getMusicRoom(chatId)` →
  `GET /chats/{chatId}/music-room`. Оба идут через существующий
  `withReauth`/Bearer/X-Device-Id.

## 3. MSW

`src/mocks/db.ts` / `handlers.ts`:

- в каталог добавлен шестой built-in плагин `music-room` (MANAGED,
  `FILES`/`MESSAGES`, иконка `music`);
- `POST /workspaces/:workspaceId/music-room`: find-or-create, один канал на
  воркспейс, `201 created=true` / `200 created=false`, PUBLIC/OPEN GROUP,
  плагин включён, `403` для чужого воркспейса, `422` для DISABLED/E2EE,
  инъецируемые задержка/ошибка/лог запросов с `X-Device-Id`;
- `GET /chats/:chatId/music-room`: гейт ACTIVE-членства + `music-room`
  enabled, метаданные только AUDIO, seed из двух треков, `404` для чужого
  чата, `422 PLUGIN_NOT_ENABLED`/`PLUGIN_NOT_AVAILABLE`;
- счётчики плагинов в существующих тестах обновлены с 5 до 6 (каталог вырос
  на сервере).

Тестовые швы плеера: `callMusic`-совместимые `musicCreateElement`,
`musicCreateGraph`, `musicResolveUrl` в `ChatStoreDeps`/`renderApp` —
jsdom не умеет `HTMLMediaElement.play()` и Web Audio, а тесты не должны
подменять продуктовый код.

## 4. Тесты

Новые:

| Файл                                    | Что покрывает                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/musicRoom.test.ts` (5)         | идемпотентный POST (200/201, один канал, concurrent), список AUDIO без секретов, 404/422, ошибки open (DISABLED/E2EE)                                             |
| `src/music/store.test.ts` (5)           | загрузка/retry, идемпотентный open, отсутствие autoplay, play/pause, старт/стоп микса, stop на конце звонка, volume/next/prev                                     |
| `src/calls/CallController.test.ts` (+3) | `setIncomingMusicStream`: микс в audio sender, все GROUP-пиры, local-only без звонка, восстановление микрофона и dispose на hangup                                |
| `src/components/MusicRoom.test.tsx` (6) | список/метаданные, play/pause/next, loading/error/retry/empty, скрытие без плагина и в E2EE, idempotent open из PluginsPage + выбор чата, honest 409 + retry, axe |

Полный прогон: **`npm run check` → exit 0**:

- `eslint`: 0 errors (2 pre-existing warnings вне новых файлов);
- `prettier --check`: OK;
- `contract:check`: 146 operations / 195 schemas, generated types in sync;
- `stickers:check`, `security:check`, `session-writers:check`: OK;
- `vitest`: **125 test files, 1285 tests passed** (требование 1266+);
- `vite build`: OK (570 modules).

## 5. Файлы

Новые:

- `src/music/store.ts`, `src/music/audioGraph.ts`;
- `src/calls/musicMix.ts`;
- `src/components/music/MusicRoomPanel.tsx`;
- `src/api/musicRoom.test.ts`, `src/music/store.test.ts`,
  `src/components/MusicRoom.test.tsx`.

Изменённые:

- `src/api/types.ts`, `src/api/endpoints.ts`;
- `src/calls/CallController.ts`, `src/calls/types.ts`;
- `src/components/ChatDetails.tsx`, `src/components/ChatScreen.tsx`,
  `src/components/CallLayer.tsx`, `src/components/Icons.tsx`,
  `src/components/pages/PluginsPage.tsx`;
- `src/store/chatStore.ts`, `src/store/ChatProvider.tsx`;
- `src/mocks/db.ts`, `src/mocks/handlers.ts`;
- `src/i18n/ru.ts`, `src/styles/app.css`;
- `src/test/callFakes.ts`, `src/test/renderApp.tsx`;
- существующие тесты счётчиков каталога: `src/components/Plugins.test.tsx`,
  `src/components/Dashboard.test.tsx`, `src/api/plugins.test.ts`.

## 6. Ограничения / честные границы

- Нет SFU, серверного аудио, синхронизации позиции/плейлиста и серверного
  бота. «DJ Сова» — подпись локального ведущего, чей клиент микширует музыку
  в свой исходящий трек.
- Список треков — до 100 последних AUDIO-вложений (`has_more`), без пагинации
  (курсора в контракте этого среза нет).
- Участники слышат музыку, только пока ведущий в звонке и его Web Audio
  доступен. При ошибке микса UI показывает «микрофон звонка не изменён» и не
  делает вид, что музыка доставлена.
- Треки загружаются существующим file flow (композер/Files); отдельного
  music upload endpoint нет.
- Микрофон восстанавливается при pause/stop/hangup; на конце звонка музыка
  останавливается по требованию среза (а не продолжает играть локально).
- Web Audio нужен для relay; локальное воспроизведение работает и без него.

## 7. Итог

**DONE.**

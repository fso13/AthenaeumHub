# Music Room removal — frontend

> Задача: полностью удалить Music Room UI, локальный плеер, host-relay микширование в
> звонке, API-клиент, типы, моки, i18n/CSS и тесты; не затронуть E2EE и незавершённую
> работу **Rooms (#105)**.

## Статус

**DONE в границах Music Room.** В `frontend/src` больше нет Music Room кода, путей,
типов, строк и CSS. `MusicIcon` и `SongCard` сохранены: это общий UI аудио-вложений
(file center / #97), а не музыкальная комната.

## 1. Удалённые файлы/модули (7)

| Файл                                      | Что удалено                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/music/store.ts`                      | `MusicRoomStore`: open/ensureTracks, локальный `<audio>`-плеер, очередь, volume, call-relay, `handleCallState` |
| `src/music/audioGraph.ts`                 | Web Audio graph `<audio>` → `MediaStreamDestination`                                                           |
| `src/music/store.test.ts`                 | 5 тестов store                                                                                                 |
| `src/components/music/MusicRoomPanel.tsx` | панель «Музыкальная комната» в `ChatDetails`                                                                   |
| `src/components/MusicRoom.test.tsx`       | 6 UI/axe-тестов панели и idempotent open из PluginsPage                                                        |
| `src/api/musicRoom.test.ts`               | 5 API-тестов open/list                                                                                         |
| `src/calls/musicMix.ts`                   | `CallMusicMixer` / `MixedCallAudio`, Web Audio mic+music                                                       |

## 2. `CallController` — восстановлен обычный микрофонный путь

Удалено:

- опция `musicMixer` и поле `musicMixer`, импорт `musicMix`;
- `setIncomingMusicStream()`, `applyIncomingMusic()`, `applyMusicToPc()`,
  `ensureMixedAudio()`, `replaceAudioSender()`, `stopMixedAudio()`;
- поля `incomingMusicStream` / `mixedAudio`;
- восстановление микрофона в `resetResources()` (спец-логики больше нет);
- `addLocalTracks()` оставлен в прежнем простом виде: `pc.addTrack(track, stream)`
  для каждого трека;
- `CallState.musicActive` и его значение в `idleCallState()`;
- music-тесты из `CallController.test.ts` и лишний параметр `musicMixer` в `setup()`.

`src/test/callFakes.ts` не редактировался: в нём не было Music Room-хуков; фейки
`FakeMediaStream`/`RTCPeerConnection` остаются общими для звонков и конференций.

## 3. UI и интеграции

- `ChatDetails.tsx` — удалены строка-аккордеон «Музыкальная комната», `MusicRoomPanel`,
  `useMusicRoomState`, `musicEnabled`/`musicCount`, вариант `'music'` в типе раскрытой
  панели и prop `onAttachAudio`.
- `ChatScreen.tsx` — удалена передача `onAttachAudio`; composer/file picker не изменён.
- `PluginsPage.tsx` — удалены кнопка «Открыть музыкальную комнату» на карточке,
  `musicRoom*` props, store/state комнаты, `openMusicRoom()`, error-баннер, `music`
  icon-token и ставшие ненужными `useLocation`/`withView`.
- `CallLayer.tsx` — удалён статус `musicActive` («DJ Сова · Музыку слышат участники…»)
  и импорт `MusicIcon`.
- `Icons.tsx` — удалены только music-room-иконки `SkipBackIcon`, `SkipForwardIcon`,
  `VolumeIcon`. `MusicIcon` остаётся для аудио-вложений (`SongCard`, media fallback),
  `PlayIcon`/`PauseIcon` — для voice/upload UI.
- `ChatProvider.tsx` — удалены `useMusicRoomStore`/`useMusicRoomState`.
- `chatStore.ts` — удалены `music` store, deps `musicCreateElement/musicCreateGraph/
musicResolveUrl`, call-мьюзик хук в `onChange`, `music.dispose()`, публичный
  `reloadChats()` (использовался только open-кнопкой; приватный
  `reloadChatsForWorkspace` сохранён для остальных сценариев).
- `test/renderApp.tsx` — удалены music-сеймы из `TestCallOptions` и `createTestStore`.
- `api/endpoints.ts` / `api/types.ts` — удалены `openMusicRoom`, `getMusicRoom` и типы
  `MusicRoomPlugin/Open/Track/Tracks`.
- `api/schema.d.ts` — регенерирован (`npm run api:types`), `MusicRoom*` отсутствуют.

## 4. i18n / CSS / моки / контракт

- `i18n/ru.ts` — удалены **35** ключей `music.*` и комментарий-баннер #94.
- `styles/app.css` — удалён блок `#94 music room panel` (**321** строка: `.music-room*`,
  `.music-track*`, `.call-music`, адаптивные правила).
- `mocks/db.ts` — удалены `music-room` из `pluginCatalog`, `buildMusicRoomTracks()`,
  `musicRoomChats/Tracks/OpenRequests/TrackRequests`, задержки и forced errors.
- `mocks/handlers.ts` — удалены `POST /workspaces/:workspaceId/music-room` и
  `GET /chats/:chatId/music-room`, импорты `MusicRoomOpen/Tracks`.
- `api/plugins.test.ts`, `components/Plugins.test.tsx`, `components/Dashboard.test.tsx` —
  каталог уменьшен с 6 до 5 built-in: убраны `music-room`/«Музыкальная комната»,
  счётчики 6→5, тексты «1 из 6»→«1 из 5», «2 из 6»→«2 из 5».
- `scripts/check-contract.mjs` — удалены music-room операции, схемы и проверка версии
  `1.0.0`. Вклад среза: −2 operation, −4 schema, −2 path. Итоговый guard сейчас
  проходит на **135 paths / 167 operations / 214 schemas**: это наш результат
  (131/160/209) плюс параллельный #105 (4/7/5). Music Room в контракте отсутствует.

## 5. Проверка

- `tsc -p tsconfig.json --noEmit` — OK, мёртвых импортов/неиспользуемых символов нет
  (TypeScript + ESLint это ловят).
- Полный `vitest run` — **139 files / 1373 tests passed**, 0 failed.
- `npm run build` (`tsc --noEmit` + Vite production build) — OK, 581 модуль,
  `dist/` собран без ошибок (только стандартное предупреждение о размере чанка).
- `eslint .` — 0 errors; единственный warning — существовавший ранее
  `consistent-type-imports` в `src/e2ee/app/chatBridgeSupport.test.ts`, не относится
  к срезу.
- `prettier --check` — все файлы соответствуют стилю (изменённые отформатированы).
- Guard'ы: `check-contract.mjs` — passed, `check-security.mjs` — 425 files OK,
  `check-stickers.mjs` — OK, `check-session-writers.mjs` — OK.
- E2EE-код, E2EE-флаги и E2EE-тесты не менялись; Music Room не был E2EE-функцией.

### Параллельный #105

В дереве параллельно появляются untracked-файлы Rooms (#105). Они не редактировались.
Общий `target/` и их тесты не затрагивались; проверки выше относятся к Music Room
срезу и общему frontend-коду.

## 6. Ограничения

- `gh`/GitHub-токены в среде недоступны, поэтому issue #94 не закрыт из этой сессии;
  закрытие выполняет владелец репозитория/агент после merge.
- Удалён старый `frontend/MUSIC-ROOM-UI-REPORT.md` как документация снятой фичи.

## 7. Итог

**DONE.**

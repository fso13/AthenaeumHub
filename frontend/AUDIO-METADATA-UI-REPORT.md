# #97 — UI серверных аудиометаданных и обложек

**Статус: DONE**

## 1. Итог

Фронтенд переведён на серверные метаданные #97 и аутентифицированные обложки:

- добавлен `getAttachmentArtwork(attachmentId)` — бинарный `GET /attachments/{id}/artwork`
  через существующий API-клиент (bearer + `X-Device-Id`, `Accept: image/...`);
- байты кэшируются по `attachmentId` как `blob:` object URL; URL отзываются при
  инвалидации, смене workspace, `reset()`/`dispose()`; in-flight запросы дедуплицируются;
- `media.artwork_url` больше **нигде** не попадает в `<img src>`/`<video poster>`:
  серверный URL — это аутентифицированный endpoint, прямой запрос браузера даёт `401`;
- song card (чат) и строка файлового центра показывают `title/artist/album/year/duration`
  из `media`, включая `metadata_source=SERVER`; при отсутствии тегов остаётся честный
  fallback (filename + «Неизвестный исполнитель» + обложка по умолчанию);
- обложка резолвится в порядке: публичный `artwork_url` → серверные байты → локальный
  ID3-кэш → иконка по умолчанию;
- загрузка через FilesPage после ответа сервера обновляет `GET /files`, поэтому строка
  сразу показывает серверные теги и обложку (mock тоже отдаёт `media` в `201`);
- покрытие: 7 новых компонентных тестов + 3 unit-теста политики URL; MSW отдаёт
  аутентифицированный artwork и умеет `401/404`.

Контракт не менялся: `GET /api/v1/attachments/{attachmentId}/artwork` уже присутствует
в `contracts/openapi.yaml` и `frontend/src/api/schema.d.ts` (155 операций, 204 схемы).

## 2. Что и где изменено

| Файл                                                                                                                                                                                                | Изменение                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/http.ts`                                                                                                                                                                                   | `getBlob(path, query, { accept })`: заголовок `Accept` для растровых типов; ошибки по-прежнему конвертируются в `ApiError`.                                                                                                                                |
| `src/api/endpoints.ts`                                                                                                                                                                              | `ChatApi.getAttachmentArtwork(attachmentId): Promise<Blob>`; реализация через `client.getBlob` (никакого токена в URL, authorization добавляет клиент).                                                                                                    |
| `src/files/media.ts`                                                                                                                                                                                | `isServerArtworkUrl`, `usesServerArtwork`, `externalArtworkUrl`, `songMetaLine` — единая политика «публичный URL vs аутентифицированный endpoint» + компактная строка тегов.                                                                               |
| `src/store/filesStore.ts`                                                                                                                                                                           | Кэш обложек per attachment: `getAttachmentArtworkUrl(id, {force})`, `invalidateArtwork`, LRU-потолок 100, отзыв object URL при delete/workspace switch/reset/dispose, защита от гонки устаревшего ответа. Валидируются только растровые MIME из контракта. |
| `src/hooks/useArtwork.ts`                                                                                                                                                                           | `useArtwork(id, media)` + `useLocalArtworkFallback`; приоритет сервер/внешний URL, `404/401/409/423` → `empty` без error-surface.                                                                                                                          |
| `src/components/ArtworkImage.tsx`                                                                                                                                                                   | Переиспользуемый `<img>` для обложек: публичный URL напрямую, серверный — через blob, `onError` → fallback.                                                                                                                                                |
| `src/components/SongCard.tsx`                                                                                                                                                                       | Серверная обложка через blob, затем локальный ID3, затем `MusicIcon`; `SERVER` без тегов больше не теряет song-card fallback.                                                                                                                              |
| `src/components/AttachmentCard.tsx`                                                                                                                                                                 | `metadata_source=SERVER` включает song card; `video poster` резолвится через `useArtwork`, а не из `artwork_url`.                                                                                                                                          |
| `src/components/pages/FilesPage.tsx`                                                                                                                                                                | `useThumbnail`: CLEAN-изображение — presigned preview, иначе серверная обложка (AUDIO/IMAGE/VIDEO), иначе расширение; строка AUDIO показывает `title · artist · album · year · duration`.                                                                  |
| `src/components/pages/OverviewPage.tsx`, `src/components/ChatDetails.tsx`, `src/components/ChatSettingsDialog.tsx`, `src/components/ImageFilePicker.tsx`, `src/components/music/MusicRoomPanel.tsx` | Все оставшиеся прямые `<img src=media.artwork_url>` заменены на `ArtworkImage`/`useArtwork`.                                                                                                                                                               |
| `src/styles/app.css`                                                                                                                                                                                | `.file-name small.file-media-meta` — компактная строка тегов в Sova-стиле (токены темы, ellipsis).                                                                                                                                                         |
| `src/mocks/db.ts`                                                                                                                                                                                   | `attachmentArtworks`, `artworkRequests`, `forceArtworkError` + сброс в `resetMockDb`.                                                                                                                                                                      |
| `src/mocks/handlers.ts`                                                                                                                                                                             | `GET /attachments/:id/artwork` (auth, AV-гейты `409/423/410`, `404` без обложки, `401` при потере токена); `POST /workspaces/:id/files` эмулирует #97-извлечение тегов/обложки и возвращает `media` в `201`.                                               |
| `src/components/AudioArtwork97.test.tsx`                                                                                                                                                            | 7 тестов: серверные теги + blob-обложка, fallback на локальный ID3, `401`, FilesPage cover/tags, метаданные после upload-refresh, кэш/revoke, axe.                                                                                                         |
| `src/files/media.test.ts`                                                                                                                                                                           | +3 unit-теста: распознавание endpoint, политика AUDIO/SERVER vs VIDEO poster, `songMetaLine`.                                                                                                                                                              |

## 3. Приоритет обложки

1. **Публичный** `media.artwork_url` (клиентский ID3-импорт) — рендерится напрямую,
   только после `safeHttpUrl` (absolute http(s), без `data:`/`blob:`).
2. **Серверная обложка** — если `metadata_source=SERVER` для AUDIO или `artwork_url`
   указывает на `.../attachments/{id}/artwork`: байты забираются API-клиентом,
   кэшируются per attachment, в разметку попадает только `blob:` object URL.
3. **Локальный ID3-кэш** (`artworkCache`, IndexedDB) — если сервер ответил `404`/`401`
   или внешний URL не декодировался.
4. **Обложка по умолчанию** (`MusicIcon` / расширение файла).

`401`, `404`, `409` (сканирование), `410`, `423` не показываются как ошибка: обложка
декоративна, карточка/строка остаётся работоспособной, а скачивание и плеер не зависят
от наличия обложки.

## 4. Файловый центр и загрузка

- Список `GET /files` остаётся metadata-only; превью CLEAN-изображения по-прежнему идёт
  через `GET /attachments/{id}/download-url` (presigned).
- Для AUDIO-строк обложка берётся из `GET /attachments/{id}/artwork`; прямой
  `<img src=artwork_url>` исключён.
- `uploadFile` уже вызывал `reloadFileCenter()` после `POST /workspaces/{id}/files`;
  теперь mock возвращает `media` в `201`, поэтому после обновления строка сразу
  показывает `title/artist/album/year/duration` и обложку — без отдельного клиентского
  парсинга.
- Видео/изображения без серверной обложки сохраняют прежнее поведение (presigned
  preview / бейдж расширения).

## 5. Безопасность

- Токен никогда не попадает в URL: обложка запрашивается `fetch` через `ApiClient`
  (`Authorization: Bearer`, `X-Device-Id`), ответ — `Blob`.
- `isServerArtworkUrl` отличает аутентифицированный endpoint от публичного URL;
  серверный URL не рендерится в `src` ни в одном компоненте.
- `blob:` object URL создаются только для MIME из allowlist контракта
  (`jpeg/png/webp/gif/bmp/avif`), пустые/не-растровые ответы игнорируются.
- Object URL отзываются: `invalidateArtwork` (delete/ошибка), смена workspace,
  `FilesStore.reset()`/`dispose()`, LRU-вытеснение и forced reload.
- Никаких новых `localStorage`/`console`/`eval`; XSS-поверхность не расширена —
  title/artist/album рендерятся как текст.
- E2EE не затрагивается: у E2EE-вложения нет `media`/`artwork_url`, запрос обложки
  не выполняется.

## 6. Тесты

Новые тесты #97:

| Набор                     | Кол-во | Покрытие                                                                                                                           |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AudioArtwork97.test.tsx` | 7      | server tags + blob cover; local ID3 fallback; `401`; FilesPage cover/tags + `404`; metadata после upload-refresh; кэш/revoke; axe. |
| `media.test.ts`           | +3     | `isServerArtworkUrl`/`usesServerArtwork`/`externalArtworkUrl`/`songMetaLine`.                                                      |

Затронутые существующие наборы переиспользованы без ослабления:
`MediaMessages` (5), `MediaPreview` (6), `FilesPage` (6), `FilesUpload83` (4),
`FilesChat` (11), `MusicRoom` (6), `OverviewPage`, `ChatSettings*`.

### Полный прогон

| Команда                                       | Результат                                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                               | **passed, exit 0**: `lint` (0 errors, 1 pre-existing warning в `src/e2ee/app/chatBridgeSupport.test.ts`), `format:check`, `contract:check` (155 operations / 204 schemas), `stickers:check`, `security:check`, `session-writers:check`, `vitest run`, `build`. |
| `npx vitest run`                              | **1313 passed / 130 files** (в полном прогоне `check`; отдельный повтор с `--maxWorkers=2` под нагрузкой общего workspace — тоже 1313/1313).                                                                                                                   |
| `npm run lint`                                | 0 errors.                                                                                                                                                                                                                                                      |
| `npm run format:check`                        | passed для всех файлов.                                                                                                                                                                                                                                        |
| `npm run contract:check`                      | passed: 155 operations, 204 schemas, generated types in sync.                                                                                                                                                                                                  |
| `npm run security:check`                      | passed: 412 files, no XSS sinks/token logs.                                                                                                                                                                                                                    |
| `npm run build` (`tsc --noEmit` + vite build) | passed.                                                                                                                                                                                                                                                        |

> Общий workspace параллельно используется другими агентами: промежуточные прогоны
> под load average ≈ 60 давали единичные таймауты axe-тестов в **сторонних** наборах
> (`WorkspaceBots`, `PluginActions`); каждый такой файл отдельно проходит, а финальный
> `npm run check` и полный прогон с низкой параллельностью — зелёные.

## 7. Ограничения и осознанные решения

1. **`409` во время сканирования не ретраится автоматически на той же карточке.**
   Обложка декоративна; после смены `scan_status` она подхватится при следующем
   монтировании/обновлении списка. Ошибка пользователю не показывается.
2. **Кэш обложек ограничен 100 object URL.** Это защита от роста памяти; при
   вытеснении видимая обложка может замениться fallback-иконкой. Для файлового центра
   (страницы по 50) запаса достаточно.
3. **Серверный `artwork_url` без `artwork_id`-поля.** Endpoint вызывается по
   `attachmentId`, поэтому пустой `KRUG_FILES_ARTWORK_BASE_URL` не мешает показу
   обложки, если клиент знает `media.metadata_source=SERVER`.
4. **`SERVER`-видео с публичным poster остаётся прямым URL.** Сервер извлекает
   обложки только из AUDIO, поэтому `kind=VIDEO` + внешний `artwork_url` не переводится
   на blob-endpoint.
5. **Локальный ID3-кэш остаётся вторым fallback'ом.** Он не отправляется на сервер и
   не конфликтует с серверной обложкой: сервер всегда выигрывает, если ответил байтами.

## 8. Откат

Изменения аддитивные, контракт и схема БД не менялись:

1. убрать `getAttachmentArtwork`/`getBlob({accept})` и `useArtwork`-путь, вернуть
   `song-card`/`file-row` на прежний локальный artwork;
2. удалить `artworkUrls`/`invalidateArtwork` из `FilesStore` и mock-поля
   `attachmentArtworks`/`artworkRequests`/`forceArtworkError` (вместе с MSW-handler);
3. удалить `AudioArtwork97.test.tsx` и CSS `.file-media-meta`;
4. серверные `media.metadata_source=SERVER` останутся читаемыми — UI просто покажет
   их как обычные поля медиа.

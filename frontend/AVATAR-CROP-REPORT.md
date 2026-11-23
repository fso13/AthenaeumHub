# #106 — Avatar Cropper / Profile Picture Cropper + Thumbnail Editor

**Итог: DONE.**

Зона изменений — только `frontend/**`. Серверные контракты, storage и E2EE не
менялись. Кроппер готовит PNG и отдаёт его в существующий `POST /media/images`;
`file_id` по-прежнему применяется существующими сеттерами аватара/логотипа/
иконки. Никакой «фейковой» загрузки: тип, размер, magic bytes, анимация и
scan-статус остаются на сервере.

---

## 1. Что сделано

### 1.1 Reusable `ImageCropper`

Новый компонент `frontend/src/components/ImageCropper.tsx` (modal и inline):

| Требование                                  | Реализация                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Выбор файла → preview                       | `<img>` c object URL, `onLoad` даёт natural size; отдельные object URL для кроппера и для превью загрузки                                                              |
| Квадратное/заданное окно                    | `aspect` (по умолчанию `1`), сцена `260×(260/aspect)`; для обложек передаётся `16/9`                                                                                   |
| Zoom 1..4×                                  | range-slider, `clampCropZoom`, значение `1.00×…4.00×`                                                                                                                  |
| Drag/pan                                    | Pointer Events + `setPointerCapture`, pan в пикселях вьюпорта, `clampCropPan`                                                                                          |
| Keyboard arrows                             | стрелки ±10 px, `Shift` — ±30 px; фокус на области кадрирования                                                                                                        |
| Rotate 90°                                  | `nextCropRotation`, поворот на canvas и в CSS                                                                                                                          |
| Reset                                       | zoom=1, pan=0, rotation=0                                                                                                                                              |
| 48/96 px thumbnails + «как будет выглядеть» | два thumbnail-превью 96 px и 48 px, масштабированная копия той же сцены, круглая маска для 1:1                                                                         |
| Apply → canvas → PNG File                   | `drawCrop` + `canvas.toBlob('image/png')`, максимум 1024 px, ≤5 MiB                                                                                                    |
| Replace original / «Без обрезки»            | «Применить» загружает кроп; «Без обрезки» отдаёт исходный `File` в тот же upload-path                                                                                  |
| Object URLs revoke                          | revoke на смене `file` и на unmount (и в кроппере, и в `DeviceImageUpload`)                                                                                            |
| a11y/focus trap, Esc/cancel                 | `role="dialog"`, `aria-modal`, label/description, capture-фазовый Escape/Tab-trap, возврат фокуса, блокировка scroll; Escape не закрывает родительский диалог настроек |
| Мобильность                                 | `width: min(420px, 100%)`, full-width actions < 560 px, `touch-action: none` на сцене                                                                                  |

Особенности:

- **Escape в nested modal.** `ProfileDialog`/`ChatSettingsDialog` слушают
  `keydown` на bubble-фазе. Кроппер перехватывает `Escape`/`Tab` в capture-фазе
  и останавливает propagation, поэтому закрывается только кроппер, а не
  родительские настройки.
- **Отмена во время рендера PNG.** Пока canvas/PNG готовится, закрытие
  отключено (`aria-busy`), чтобы не осиротить асинхронный apply.
- **PNG ≤5 MiB.** Если PNG больше лимита, размер выхода уменьшается на 25 % и
  рендер повторяется (до 6 попыток). Выход никогда не апскейлится: максимум —
  видимые исходные пиксели, но не более 1024 px по длинной стороне.

### 1.2 Чистая геометрия кропа

`frontend/src/files/imageCrop.ts` — вся математика вынесена из React:

- `rotatedImageSize`, `coverScale`, `panBounds`, `clampCropPan`,
  `clampCropTransform`, `cropOutputSize`, `drawCrop`, `cropFileName`;
- `coverScale` = `max(viewport/rotatedImage)` — окно всегда полностью покрыто,
  без пустых краёв;
- `cropOutputSize` = видимые исходные пиксели, cap 1024, без апскейла;
- `drawCrop` один в один повторяет CSS-трансформацию
  `translate(pan) → rotate → scale(coverScale×zoom)` с поправкой на масштаб
  output-канваса.

Это позволяет тестировать zoom/pan/output без реального canvas.

### 1.3 Интеграция в `DeviceImageUpload`

`DeviceImageUpload` получил `aspect?: number` (по умолчанию `1`) и
`crop?: boolean` (по умолчанию `true`). Поток:

```
<input type=file> → validateImageFile(type/size)
    → ImageCropper (aspect)
        → Apply: canvas PNG File → validateImageFile → POST /media/images (with chat_id)
        → «Без обрезки»: original File → POST /media/images
    → server file_id → existing onUploaded setter
```

Прогресс, abort, локальные/серверные ошибки и preview остались прежними.
`onUploaded(file_id)` не изменился, поэтому все существующие сеттеры работают
без нового API.

### 1.4 Матрица интеграции

| Аватар             | Где                                                                | Aspect | Сеттер                              |
| ------------------ | ------------------------------------------------------------------ | ------ | ----------------------------------- |
| User avatar        | `ProfileDialog` → `ImageFilePicker` → `DeviceImageUpload`          | 1:1    | `POST /me/avatar`                   |
| Workspace logo     | `WorkspaceSettingsPanel` → `ImageFilePicker` → `DeviceImageUpload` | 1:1    | `POST /workspaces/{id}/avatar`      |
| Chat/channel icon  | `ChatSettingsDialog` → `DeviceImageUpload`                         | 1:1    | `POST /chats/{id}/avatar`           |
| Chat/channel cover | `ChatSettingsDialog` → `DeviceImageUpload`                         | 16:9   | `POST /chats/{id}/cover`            |
| Room avatar        | `RoomsPage` → `DeviceImageUpload`                                  | 1:1    | `POST /chats/{room.chat_id}/avatar` |

Существующий выбор изображения из файлового центра (`ImageFilePicker`)
сохранён: он применяет уже загруженный `file_id` и не создаёт новое вложение.
Кроппер применяется к **новым** файлам с устройства; повторная обрезка
существующего вложения потребовала бы создавать новый `file_id` и выходит за
рамки запроса.

### 1.5 Аватар комнаты

`RoomsPage` теперь:

1. Показывает `Avatar` комнаты из **backing-канала** `room.chat_id`:
   `useAvatarsStore().ensureChat(room.chat_id)` + `useAvatarsState()`.
   Один дедуплицированный GET на чат; 404 = инициалы, не ошибка.
2. Показывает «Изменить аватар» для room creator / workspace OWNER / ADMIN
   (та же видимость, что у rename комнаты). Сервер по-прежнему проверяет
   chat-роль OWNER/ADMIN в `POST /chats/{chatId}/avatar`.
3. Открывает inline-редактор с `DeviceImageUpload chatId={room.chat_id}`.
4. На `onUploaded` вызывает существующий `chatStore.setChatAvatar(room.chat_id,
file_id)`, затем `roomsStore.load(true)` — список комнат обновляется из
   сервера, без оптимистичных правок. Аватар-байты инвалидируются/перечитываются
   тем же `AvatarStore`.
5. Ошибки контракта (`403`, `404`, `409/423`, `422`, `CHAT_AVATAR_INVALID`)
   переводятся в честные RU-сообщения; успех — `Аватар комнаты «…» обновлён.`.

Mock-инфраструктура: у seed-комнат backing-канал не лежит в `db.chats` (чтобы
комнаты не появлялись в сайдбаре), поэтому добавлена карта
`MockDb.roomChatAvatars` и ветка в mock-обработчиках `/chats/:chatId/avatar`.
`/media/images` теперь принимает `chat_id` такой комнаты. Это только тестовая
инфраструктура, реальный API не менялся.

---

## 2. i18n

Добавлены ключи (RU):

- `crop.*` — 20 ключей: title/hint/stage/panHint/loading/loadError/zoom/
  zoomValue/rotate/reset/preview/howItLooks/apply/applying/useOriginal/cancel/
  outputError/close;
- `rooms.avatar.*` — 13 ключей: change/changeAction/close/closeAction/section/
  sectionTitle/hint/saved/error/forbidden/notFound/notReady/invalid.

Стили: `.image-cropper*` (modal/inline, сцена, overlay-frame, zoom, thumbnails,
actions, mobile), `.room-card__identity`, `.room-avatar-editor*` в
`frontend/src/styles/app.css`.

---

## 3. Тесты

Добавлено 19 тестов:

### `src/files/imageCrop.test.ts` — 7 unit

- поворот/нормализация 90°;
- cover-scale и clamp zoom 1..4;
- pan bounds и clamp (включая non-finite);
- output size: zoom, cap 1024, отсутствие апскейла, 16:9;
- `drawCrop`: zoom/pan translate, scale, drawImage, save/restore;
- поворот canvas;
- санитизация имени PNG.

### `src/components/ImageCropper.test.tsx` — 7 component

- preview + zoom + arrow-pan + rotate + reset;
- 48/96 px thumbnails;
- Apply → canvas → PNG `File` (проверяются имя, mime, размеры, `drawImage`);
- «Без обрезки» → original `File`;
- Escape + Tab focus trap;
- revoke object URL на unmount;
- inline-режим и aspect 16:9.

### `src/components/AvatarCropper.test.tsx` — 5 integration

- профиль: upload → crop → `POST /media/images` (chat_id=null) → `POST /me/avatar`;
- workspace logo: crop → `POST /workspaces/{id}/avatar`;
- chat icon: crop → chat-scoped upload (`chat_id`) → `POST /chats/{id}/avatar`;
- room: существующий аватар backing-канала отображается; «Изменить аватар» →
  crop → `POST /chats/{room.chat_id}/avatar` → refresh room list;
- axe: 0 serious/critical при открытом кроппере.

Обновлён `src/components/TwoFactorQrUpload.test.tsx`: контрактные тесты
`POST /media/images` теперь проходят через «Без обрезки» (исходные байты,
прежние имена/размеры), что подтверждает отсутствие регрессии upload-path.

### Результат

```
Test Files  143 passed (143)
Tests       1416 passed (1416)
```

Базлайн до задачи: 1397/1397 → +19 тестов, без падений.

---

## 4. Проверки

```
npm run check
```

проходит полностью: lint, format:check, contract:check, stickers:check,
security:check, session-writers:check, test (1416), build.

- Без новых сетевых endpoints и без изменений `contracts/`.
- `security:check` проходит: нет `dangerouslySetInnerHTML`, `eval`,
  `localStorage`/`sessionStorage`/cookies, токенов в логах.
- object URLs создаются только из локального `File`/`Blob` и всегда
  освобождаются.
- E2EE не затрагивался; кроппер работает только с MANAGED image upload путём,
  который уже используется аватарами.

---

## 5. Ограничения / заметки

1. **Файловый центр.** Выбор уже загруженного изображения (`ImageFilePicker`)
   по-прежнему применяет готовый `file_id` без кропа: это существующий
   контракт выбора, а не device-upload. Если потребуется кропать и его, нужен
   отдельный сценарий «скачать blob → кроп → новый `POST /media/images`».
2. **Права комнаты.** UI показывает действие по room creator / workspace
   OWNER/ADMIN; финальное решение — за chat-ролью OWNER/ADMIN на сервере.
   Если workspace ADMIN не является admin-ом backing-канала, сервер вернёт 403,
   и UI покажет `rooms.avatar.forbidden`.
3. **Отдельной room page нет.** В текущем frontend комната — карточка в
   `RoomsPage`; аватар отображается в карточке. Любая будущая room page может
   переиспользовать `useAvatarsStore().ensureChat(room.chat_id)` и
   `DeviceImageUpload chatId={room.chat_id}`.
4. **PNG.** Выход всегда PNG (требование задачи). Для фотографий это может
   давать больший файл, поэтому включён retry с уменьшением размера; серверный
   лимит 5 MiB остаётся последним рубежом.

---

## 6. Файлы

Новые:

- `frontend/src/files/imageCrop.ts`
- `frontend/src/files/imageCrop.test.ts`
- `frontend/src/components/ImageCropper.tsx`
- `frontend/src/components/ImageCropper.test.tsx`
- `frontend/src/components/AvatarCropper.test.tsx`

Изменённые:

- `frontend/src/components/DeviceImageUpload.tsx`
- `frontend/src/components/ImageFilePicker.tsx`
- `frontend/src/components/ProfileDialog.tsx`
- `frontend/src/components/workspace/WorkspaceSettingsPanel.tsx`
- `frontend/src/components/ChatSettingsDialog.tsx`
- `frontend/src/components/pages/RoomsPage.tsx`
- `frontend/src/components/TwoFactorQrUpload.test.tsx`
- `frontend/src/i18n/ru.ts`
- `frontend/src/styles/app.css`
- `frontend/src/mocks/db.ts`
- `frontend/src/mocks/handlers.ts`

---

**DONE**

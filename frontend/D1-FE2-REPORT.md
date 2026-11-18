# D1-FE2 — voice / audio / video / song UI + ID3

> Зона сессии: `frontend/**`. `backend/**`, `contracts/**`, `docs/**`, `design/**`
> и `frontend/src/api/schema.d.ts` не менялись. Срез использует уже сгенерированные
> контрактные типы D1-BE2 (`AttachmentRef.media`, `UploadInitRequest.media`).
> E2EE-флаг в срезе `false`; медиа-метаданные — managed-only.

## Статус

**DONE в границах D1-FE2.** Реализованы запись голосовых через `MediaRecorder`,
передача `media` в upload init (ID3/CLIENT/NONE), клиентский ID3v2-парсер с
локальной обложкой, карточки voice/audio/video/song, honest disabled в E2EE и
тесты (unit + RTL + axe). Новых зависимостей нет: ID3-парсер — чистый TypeScript.

Полный `npm run check` — **832/832** тестов (79 файлов), `contract:check` —
**47 paths / 55 operations / 87 schemas**, `vite build` зелёный.
`backend/D1-BE2-REPORT.md` (486 тестов) не менялся.

## 1. Контракт и типы

`frontend/src/api/types.ts` (только алиасы на сгенерированные схемы, без
изобретённых полей):

- `UploadMediaMetadata = NonNullable<UploadInitRequest['media']>`;
- `MediaKind`, `MediaMetadataSource`;
- `AttachmentMedia = NonNullable<ApiAttachment['media']>`.

`schema.d.ts` не редактировался: `media.kind`, `duration_ms`, `width/height`,
`title/artist/album/year/genre`, `artwork_url`, `metadata_source` берутся
непосредственно из контракта D1-BE2. Новые WS-поля не вводились — `message.created`
несёт тот же `AttachmentRef`, что и REST.

## 2. ID3v2-парсер (`src/files/id3.ts`)

Чистый TypeScript, без зависимостей. Поддерживает ID3v2.3/2.4:

- текстовые кадры `TIT2`, `TPE1`, `TALB`, `TYER`/`TDRC`, `TCON`, `TLEN`;
- `APIC` (front cover) → `{ mime, bytes }`;
- кодировки 0 (ISO-8859-1), 1 (UTF-16 + BOM), 2 (UTF-16BE), 3 (UTF-8);
- extended header, глобальный/frame-level unsynchronisation, grouping/DLI,
  v2.4-совместимость с ошибочным big-endian размером кадра;
- несколько значений в текстовом кадре соединяются через `, `.

Защитные лимиты:

| Ограничение             | Значение                                    |
| ----------------------- | ------------------------------------------- |
| Весь тег (с заголовком) | `MAX_ID3_TAG_BYTES = 8 МиБ`                 |
| Кадр обложки            | `MAX_ARTWORK_BYTES = 2 МиБ`                 |
| Текстовый кадр          | `64 КиБ` (больше — пропуск)                 |
| Текст                   | trim, collapse whitespace, ≤255 (genre ≤64) |
| `year`                  | ровно 4 цифры                               |
| `duration_ms`           | `1..604 800 000`                            |

`readId3Tags(file)` читает сначала 10 байт заголовка и только потом ровно тело
тега (`file.slice`), поэтому многочасовая аудиозапись не попадает в память.
Любая structural-ошибка (обрезанный кадр, размер за границей буфера, битый
`APIC`, oversized tag) → `status: 'malformed'` / `none`, без исключения.
Текст санитизируется от `<`, `>`, C0/C1-control, bidi-control и BOM — сервер
дополнительно отклоняет HTML, а React рендерит значения только как text nodes.
Обложка ограничена безопасными raster MIME (`jpeg/png/webp/gif/avif/bmp`);
`image/svg+xml` и прочие типы игнорируются. MIME может определяться и по
magic bytes (JPEG/PNG/GIF/WebP).

## 3. Upload init: `media` из ID3/CLIENT/NONE

`src/files/media.ts`:

- `planUploadMedia(file)` — audio → `readId3Tags`; есть текстовые теги →
  `metadata_source: 'ID3'`, иначе `'NONE'`; video/image → только `kind` с
  `metadata_source: 'NONE'`; обычные файлы/PDF/архивы → `media` не отправляется
  (payload E4 не меняется);
- строки проходят те же bounds, что и на сервере (`<`/`>`/control, 255/64,
  `year` 4 цифры), поэтому «грязный» тег не приводит к `422 MEDIA_METADATA_INVALID`;
- `voiceMediaMetadata(durationMs)` → `kind: 'AUDIO'`, `metadata_source: 'CLIENT'`,
  `duration_ms` в `1..600 000` (10 минут, как в D1-BE2);
- `artwork_url` не отправляется: hosted-обложки пока нет (server extraction —
  D1.1), а байты обложки в контракт не входят.

`src/store/filesStore.ts`:

- `UploadTask.media` и `UploadTask.artwork`; `addFiles(files, chatId, options)`
  принимает параллельный массив `{ media, artwork }`;
- upload init body содержит `media` (только при наличии), retry/restart сохраняют
  те же metadata и idempotency body;
- `readyAttachments`/`waitForReady` возвращают `ApiAttachment` с `media` — optimistic
  карточка выглядит так же, как серверная;
- при `READY` обложка складывается в локальный кэш по `attachment_id`.

MSW (`src/mocks/db.ts`, `handlers.ts`) теперь хранит `MockUpload.media`, копирует
его в `AttachmentRef` на complete и отдаёт в сообщениях — RTL проверяет реальный
путь `init → complete → message`, а не только форму запроса.

## 4. Голосовая запись

`src/hooks/useVoiceRecorder.ts`:

- никакого доступа к микрофону до явного клика (`start`);
- проверки: `window.isSecureContext !== false`, наличие `MediaRecorder` и
  `navigator.mediaDevices.getUserMedia`; иначе честная причина disabled-кнопки
  (`voice.insecure` / `voice.unsupported` / `voice.noMediaDevices`);
- `getUserMedia({ audio: true })`, выбор MIME из
  `audio/webm;codecs=opus → audio/webm → audio/ogg;codecs=opus → audio/ogg`;
- таймер 500 мс, длительность измеряется локально и зажимается в `1..600 000` мс
  (у WebM часто нет duration metadata);
- `stop` = остановить и отдать `File` + `media` + intent `send`; `cancel` =
  остановить треки, выбросить чанки, ничего не отправлять; авто-stop на 10-й
  минуте;
- микрофон/треки освобождаются на cancel, error, auto-stop, смене чата и unmount;
- ошибки `NotAllowedError`/`NotFoundError`/`NotReadableError`/`NotSupportedError`
  маппятся в конкретные русские сообщения, без «тихого» no-op.

`src/components/RecordingBar.tsx`:

- `role="group"`, `role="timer"` с `aria-label`, `role="status" aria-live="polite"`;
- кнопки «Отменить запись» / «Остановить и отправить»; ошибка — «Попробовать снова» /
  «Закрыть»; `Esc` отменяет/закрывает; primary-кнопка получает фокус, после
  закрытия фокус возвращается на микрофон;
- `prefers-reduced-motion` отключает пульсацию точки.

`Composer.tsx` получает кнопку с `MicIcon` (`aria-pressed`, `title` с причиной),
`RecordingBar` рендерится внутри композера. `ChatScreen` при `stop&send`:
`addFiles([file], { media }) → waitForReady → store.send(..., [attachment])`;
если загрузка отклонена/истекла, сообщение не отправляется, а ошибка остаётся в
`UploadTray`. Смена чата во время записи отменяет её.

E2EE: `canAttach=false`, кнопка видима, но disabled, `title` —
«Голосовые в E2EE недоступны: медиа в этом контуре обрабатывается только сервером
(managed-only)». Автозапуска нет; запись в E2EE не начинается.

## 5. Карточки

- `VoiceMessage` — бейдж «Голосовое сообщение», измеренная длительность,
  декоративная waveform (aria-hidden) и нативный `<audio>`; без autoplay.
- `AudioAttachment` — нативный player, `preload="metadata"`, label «Аудио: …».
- `VideoAttachment` — `<video controls preload="metadata" playsInline>`, без
  autoplay; `poster` только из `media.artwork_url` после `safeHttpUrl`
  (http/https), иначе атрибута нет (как и раньше).
- `SongCard` — обложка 64×64 (fallback-иконка), title/artist/album/year/genre,
  duration, нативный player, label «Песня: …». Без ID3 — fallback: имя файла,
  «Неизвестный исполнитель», «Без альбома», дефолтная обложка (без выдуманных
  полей). Все строки — text nodes; `onerror`/`<script>` из тега инъекцией не
  становятся.
- `AttachmentCard` сохраняет прежние image-lightbox (focus trap, Esc, возврат
  фокуса), video/audio preview, scan badge, retry/download, presigned TTL.
  Добавлены duration (`media.duration_ms` или `loadedmetadata`), `width×height`,
  и выбор варианта song/voice/generic. Для PENDING/INFECTED URL/player не
  запрашиваются, как и раньше.
- E2EE-local: `src/files/artworkCache.ts` хранит `APIC`-байты в IndexedDB
  (`krug-media`, ≤100 записей) или в памяти, если storage недоступен; на сервер
  байты не уходят. Managed-обложка из `media.artwork_url` имеет приоритет, при
  ошибке загрузки берётся локальная. Для E2EE-сообщений вложения в этом срезе
  вообще не рендерятся (D1-BE2: E2EE+attachment → 422), поэтому plaintext-обложка
  не может попасть в ленту.

## 6. Тесты

Новые и расширенные тесты (49):

| Файл                                     |   # | Покрытие                                                                                                                                                                                                |
| ---------------------------------------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/files/id3.test.ts`                  |  15 | v2.3/v2.4, UTF-8/UTF-16/latin1, APIC, TLEN, year, padding, truncated frame, oversize tag/APIC, malformed APIC, hostile text, big-endian v2.4, `readId3Tags` (prefix read, no tag, oversize, read error) |
| `src/files/media.test.ts`                |  10 | kind mapping, ID3→media, NONE fallback, video/image kind, plain file без media, sanitizers, duration clamp, songDisplay/filename fallback                                                               |
| `src/hooks/useVoiceRecorder.test.tsx`    |  11 | permission, timer, stop/send, cancel, denied/no-device/unsupported/insecure, auto-stop, unmount release, recorder error, MIME/error helpers                                                             |
| `src/components/MediaMessages.test.tsx`  |   5 | ID3 payload + song card + local cover + API copy, MP3 fallback, XSS, video poster/duration + image dims/lightbox, axe                                                                                   |
| `src/components/VoiceRecording.test.tsx` |   6 | no pre-prompt, record→AUDIO upload→auto-send, permission error + focus, cancel, E2EE honest disabled, axe                                                                                               |

Ранее существовавшие `MediaPreview.test.tsx` (6) проходят без изменения
ожиданий: image lightbox, video без autoplay/poster, audio preview, SVG/HTML
filtration, quarantine, retry presigned URL. `FilesChat`/`filesStore` тесты
проверяют, что generic-файлы по-прежнему не шлют `media`.

## 7. Проверки и ограничения

```bash
cd frontend
npm run check
# lint + format:check + contract:check + stickers + security + session-writers
# + 832 теста (79 файлов) + tsc/vite build — зелёные
```

Осознанные границы среза:

- серверная экстракция ID3/ffprobe и hosted `artwork_url` — D1.1; сейчас
  managed-обложка после reload берётся из локального IndexedDB того же браузера,
  а не из API;
- у MP3 без `TLEN` длительность появляется только после `loadedmetadata` в
  браузере; в карточке до этого показывается `—`;
- waveform декоративная (не анализ амплитуды), без тяжёлых зависимостей;
- голосовое stop&send не отправляет черновик текста и не поддерживает reply/thread
  (вложения в тредах вне среза D1-FE3);
- E2EE: вложения/медиа по-прежнему невозможны (D1-BE2), UI это честно показывает;
- запись ограничена 10 минутами и лимитами workspace (preflight/quota/scan
  используют существующий pipeline).

Итоговый статус: **DONE** в границах `frontend/**` по D1-FE2.

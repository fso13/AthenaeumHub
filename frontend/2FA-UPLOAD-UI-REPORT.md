# #93 — QR для 2FA, server-wide enrollment и загрузка изображений с устройства

**Verdict: DONE.**

## 1. Итог

Сделаны три связанные части:

1. **Локальный QR** для `otpauth_uri`: настоящий QR строится в браузере из `qrcode`
   (`QRCode.create`), рисуется inline SVG (не `<canvas>`, без внешнего QR-сервиса),
   имеет доступное имя и `<title>`. QR, секрет и коды показываются только в текущем
   setup-flow и стираются при подтверждении/закрытии/выходе.
2. **Server-wide 2FA**: admin-тумблер `require_2fa` с предупреждением; login `202`
   `mode=ENROLL` ведёт в enrollment (QR + секрет + код + recovery-коды), `mode=TOTP` —
   в прежний challenge; `POST /auth/verify-email` тоже понимает `202`; `403
TWO_FACTOR_REQUIRED` при refresh блокирует продление сессии и возвращает на вход.
3. **Загрузка с устройства**: PNG/JPEG/WebP ≤5 MiB через `POST /media/images`
   (multipart `file` + необязательный `chat_id`), локальный мгновенный preview,
   прогресс/отмена/ошибки, затем существующие `POST /me/avatar`,
   `/workspaces/{id}/avatar`, `/chats/{id}/cover|avatar` с полученным `file_id`.
   Существующий выбор изображений из файлов сохранён.

Контракт синхронизирован с backend-срезом #91/#92; `frontend/src/api/schema.d.ts`
перегенерирован (`npm run api:types`), `npm run contract:check` проходит.

## 2. QR

- Новый `src/components/QrCode.tsx`: `QRCode.create(payload)` → SVG-модули, quiet zone
  4 модуля, `role="img"`, `aria-label`, `<title>`, `data-qr-modules` для теста.
  Поддерживается и `qr_payload` в виде data-URI (тогда `<img alt=...>`), но текущий
  контракт отдаёт `otpauth_uri`/`qr_payload` строкой.
- `TwoFactorCard` (профиль) показывает QR перед секретом/URI.
- `TwoFactorEnrollPanel` (login ENROLL и blocking gate) показывает QR, секрет с копией,
  6-значный ввод, затем одноразовые recovery-коды с копированием.
- Секрет/URI/коды не пишутся в `localStorage`/`sessionStorage`, не логируются и не
  уходят во внешние запросы. Тесты проверяют отсутствие секрета/кодов в DOM и storage
  после завершения flow.

## 3. Server-wide 2FA

### Контракт

- `AdminSettings.require_2fa` / `AdminSettingsPatch.require_2fa` (boolean / boolean|null).
- `AuthTwoFactorChallenge.mode: TOTP | ENROLL`; `POST /auth/2fa/enroll/start`
  (`{challenge_id}` → `TwoFactorSetup`), `POST /auth/2fa/enroll/verify`
  (`{challenge_id, code}` → `AuthSession`).
- `POST /auth/verify-email` может вернуть `202` challenge.
- `POST /auth/refresh` может вернуть `403 TWO_FACTOR_REQUIRED`.
- `/media/images` (`file`, optional `chat_id`) → `UploadedImage`
  `{file_id,width,height,mime,size}`; `X-Device-Id` обязателен.

### UI / client

- `AdminSettingsForm` (только admin-режим): чекбокс «Требовать двухфакторную
  аутентификацию для всех» и предупреждение (роль `alert` при включении) о том, что
  пользователи без TOTP не войдут, а отключение политики не снимает уже настроенные
  ключи. Значение сохраняется вместе с остальными настройками.
- `PasswordAuthProvider`:
  - нормализует `mode`/`enrollment_required`/`ENROLL` в method;
  - автоматически запускает enrollment на `/2fa`;
  - после `enroll/verify` держит сессию **в памяти**, отдельно запрашивает
    `POST /me/2fa/recovery-codes` свежим access-token (пароль ещё в памяти с шага
    входа), показывает коды и коммитит сессию только по кнопке «Я сохранил коды»;
  - при `403 TWO_FACTOR_REQUIRED` на refresh очищает сессию и ведёт на
    `/login?2fa=required` с объяснением; следующий вход обязан пройти ENROLL/TOTP;
  - `verify-email` `202` обрабатывается тем же challenge-механизмом.
- `TwoFactorChallengeScreen`: ветка ENROLL с QR/секретом/кодом/кодами; TOTP-ветка
  (TOTP + recovery) сохранена.
- `TwoFactorEnrollmentGate` (app shell): дополнительный blocking-экран для уже
  аутентифицированной сессии. В опубликованном контракте `GET /me/2fa` пока нет поля
  политики, поэтому gate открывается только при аддитивном
  `required`/`enrollment_required`; без него реальное принуждение обеспечивают login
  ENROLL и refresh `403` (см. §7).

## 4. Загрузка изображений

- `src/files/imageUpload.ts`: allowlist `image/png|jpeg|webp`, лимит 5 MiB, проверка
  пустого файла; `accept="image/png,image/jpeg,image/webp"`; SVG/GIF не принимаются.
- `src/components/DeviceImageUpload.tsx`:
  - «Загрузить с устройства» + file input;
  - мгновенный preview через `URL.createObjectURL` (revoke при замене/unmount);
  - прогресс (`role="progressbar"`, `aria-valuenow`), отмена через `AbortController`;
  - ошибки типа/размера/пустого файла — до запроса; серверные 413/415/422/503 —
    человеческим текстом; `file_id` передаётся в `onUploaded`;
  - ничего не пишет в storage; байты не попадают в app-store.
- `src/api/endpoints.ts`: `uploadImage(file, {chatId,onProgress,signal})` —
  `postFormData('/media/images')`, Bearer + `X-Device-Id` (клиент уже добавляет),
  multipart `file` и `chat_id`; ответ нормализуется терпимо к `file_id`/`mime`/`size`.
- Встроено:
  - `ProfileDialog` → avatar (`ImageFilePicker` внутри показывает upload);
  - `WorkspaceSettingsPanel` → logo (тот же `ImageFilePicker`);
  - `ChatSettingsDialog` → cover и channel avatar (их собственные picker-секции).
- Существующий список CLEAN/SKIPPED изображений, текущие кнопки удаления и
  server-side проверки не изменены.

## 5. MSW

- `POST /auth/2fa/enroll/start|verify`: ENROLL-only, TTL/attempts, pending secret,
  включение TOTP, возврат bare `AuthSession`; recovery-коды затем выдаются реальным
  `POST /me/2fa/recovery-codes`.
- login: `202` `mode=TOTP` при включённом аутентификаторе, `mode=ENROLL` при
  `require_2fa=true` и отсутствии TOTP; `methods`/`enrollment_required` согласованы.
- `verify-email`: `202 ENROLL` при policy.
- `/media/images`: multipart `file` (+ `chat_id`), MIME/размер/пустой файл, запись
  `MockMediaImageRecord` (CLEAN, без object key), `UploadedImage`-ответ;
  `X-Device-Id` требуется; force-error/delay для тестов.
- `GET /me/2fa` и admin settings отдают `required`/`require_2fa` (mock-only
  аддитивные поля, см. §7).
- `imageFileView`/`chatImageFileView` принимают direct-image записи, поэтому
  avatar/cover/logo-сеттеры работают с результатом upload.

## 6. Тесты

Новый `src/components/TwoFactorQrUpload.test.tsx` — **10/10**:

- локальный QR действительно кодирует payload (сверка размера модулей и числа
  тёмных модулей с `QRCode.create`), доступное имя, нет внешних URL;
- профиль показывает QR + секрет;
- login ENROLL: QR, неверный код, recovery-коды, вход в приложение, секрет/коды не
  остаются в DOM/storage;
- blocking gate: старая сессия → enrollment → unlock;
- axe для blocking-экрана (0 serious/critical);
- admin `require_2fa`: warning + сохранение;
- upload профиля: preview, progressbar, файл/mime/size, `SET` с `file_id`;
- отказ SVG и >5 MiB без запросов;
- 503 без применения `file_id`;
- upload обложки канала и логотипа пространства.

`src/components/auth/authFlow.test.tsx` — добавлены 2 кейса (verify-email 202 → ENROLL;
refresh `403 TWO_FACTOR_REQUIRED` → login с объяснением), итого **22/22**.

Полный прогон: **1200 passed / 111 files**.

## 7. Ограничения / честные допущения

- В финальном `GET /me/2fa` нет `required`/`enrollment_required`, а backend #91
  сознательно не отзывает старые access-токены и применяет политику на следующем
  login/refresh. Поэтому authenticated-session gate — дополнительная защита для
  серверов, которые добавят это аддитивное поле; на текущем контракте он не активен,
  а блокировку обеспечивают login ENROLL и refresh `403 TWO_FACTOR_REQUIRED`.
- Recovery-коды при login enrollment не входят в `AuthSession`; клиент получает их
  отдельным `POST /me/2fa/recovery-codes` свежим токеном + паролем из памяти шага
  входа. Если сервер откажет, UI честно показывает, что коды нужно перевыпустить в
  профиле, и не блокирует вход.
- Mock не проверяет magic bytes (только MIME/расширение/размер): браузерный слой
  отвечает за allowlist, реальный backend — за magic/APNG/EXIF-политику; AV-gap для
  direct-image задокументирован backend-срезом #92.
- Mock-состояние in-memory (как и все MSW-сценарии), production-контракт не менялся.

## 8. Проверки

- `npx tsc -p tsconfig.json --noEmit` — OK.
- `npm run lint` — 0 errors (2 pre-existing warnings в `ChatDetails.tsx` и
  `chatBridgeSupport.test.ts`, не относятся к #93).
- `npm run format:check` — OK.
- `npm run contract:check` — OK: 136 operations / 176 schemas, generated types in sync.
- `npm run build` — OK.
- `npm run test` — 1200 passed (см. §6).
- Полный `npm run check` — **OK, exit 0**: lint (0 errors), format, contract, stickers,
  security, session-writers, **1200 tests / 111 files**, build (`built in 1.62s`).
  Параллельный Sova-sticker срез к моменту финального прогона обновил свой guard;
  #93-код под него не менялся.

## 9. Файлы

**Новые:** `src/components/QrCode.tsx`, `src/components/DeviceImageUpload.tsx`,
`src/components/auth/TwoFactorEnrollPanel.tsx`,
`src/components/auth/TwoFactorEnrollmentGate.tsx`, `src/files/imageUpload.ts`,
`src/profile/twoFactorErrors.ts`, `src/components/TwoFactorQrUpload.test.tsx`.

**Изменены:** `src/App.tsx`, `src/api/{authApi,endpoints,http,types}.ts`,
`src/api/schema.d.ts`, `src/auth/{AuthContext,PasswordAuthProvider,types}.ts`,
`src/components/{ProfileDialog,ChatSettingsDialog,ImageFilePicker}.tsx`,
`src/components/auth/{LoginScreen,TwoFactorChallengeScreen}.tsx`,
`src/components/profile/TwoFactorCard.tsx`,
`src/components/admin/AdminSettingsForm.tsx`, `src/store/chatStore.ts`,
`src/mocks/{db,handlers}.ts`, `src/i18n/ru.ts`, `src/styles/app.css`,
`src/components/auth/authFlow.test.tsx`, `src/api/authApi.test.ts`,
`package.json`/`package-lock.json` (`qrcode`, `@types/qrcode`).

## 10. DONE / PARTIAL / BLOCKED

**DONE** для #93 frontend. Полный `npm run check` прошёл (1200 тестов), контракт и
сгенерированные типы синхронизированы, QR строится локально, upload/2FA-flow покрыты
RTL+axe+MSW.

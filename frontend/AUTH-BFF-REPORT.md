# Frontend Auth BFF — собственные формы + email TOTP

> **Зона:** только `frontend/**`. `backend/**`, `contracts/**`, `docs/**`,
> `design/**`, `deploy/**` и `src/api/schema.d.ts` не изменялись. Git-репозитория
> в workspace нет, поэтому diff/one-PR подтвердить нельзя.
>
> **Вход:** `docs/TASKS-AUTH-BFF.md`, auth-часть `contracts/openapi.yaml`,
> `backend/AUTH-BFF-REPORT.md`, `frontend/E7-F5G-REPORT.md`,
> `frontend/MEDIA-PREVIEW-REPORT.md`.

## Статус

**DONE по frontend-скоупу:** AuthMode `dev | password`, typed `/auth/*`-клиент,
формы login/register/verify, refresh-on-401, logout с отзывом refresh, удалён
OIDC/Keycloak-редирект, обновлены RTL и Playwright (mock) сценарии, `npm run check`
зелёный (625 тестов), `contract:check` — 39 operations / 68 schemas.

**Не проверено вживую:** compose-стек (Mailpit + реальный Keycloak через BFF) не
поднимался; фронтовый E2E идёт против MSW-мока `/auth/*`. Поведение реального
backend подтверждено его 391 тестом и отчётом BFF, но не браузерным прогоном из
этой сессии.

## 1. AuthMode: `dev | password`

- `src/config/env.ts`: `AuthMode = 'dev' | 'password'`; `VITE_AUTH_MODE=password`
  включает формы, любое другое/пустое значение — `dev` (F-01 `/dev/session`).
  Legacy `keycloak` больше не распознаётся: он не может случайно включить
  OIDC-путь.
- `OidcConfig`/`VITE_OIDC_*` удалены из `AppConfig`, `ImportMetaEnv`, CSP,
  `.env.example` и `Dockerfile` (default `VITE_AUTH_MODE=password`).
- Провайдера-мока в production больше нет: удалены `RealOidcProvider`,
  `MockOidcProvider`, `oidc.ts`, `oidc.test.ts`. Моки — только MSW
  (`VITE_USE_MOCKS=true`, dev/E2E/Vitest).

## 2. API client `/auth/*`

`src/api/authApi.ts` — typed-обёртки над `ApiClient` для
`register`, `verify-email`, `resend-email-code`, `login`, `refresh`, `logout`.
Все вызовы идут с `auth: false` (контракт: `security: []`), refresh/logout
передают токен в теле, не в URL; Authorization/X-Device-Id на эти запросы не
уходят.

`src/auth/errors.ts` нормализует контрактные ошибки в `AuthErrorInfo`:

| code                                | status | UI/поведение                          |
| ----------------------------------- | ------ | ------------------------------------- |
| `INVALID_CREDENTIALS`               | 401    | generic «Неверный email или пароль»   |
| `EMAIL_NOT_VERIFIED`                | 403    | `details.verification_id` → `/verify` |
| `CODE_INVALID`                      | 422    | `details.attempts_left` в тексте      |
| `CODE_EXPIRED`                      | 410    | «Срок действия кода истёк»            |
| `EMAIL_TAKEN`                       | 409    | «Email уже зарегистрирован»           |
| `RATE_LIMITED`                      | 429    | `Retry-After` → «Повторите через N с» |
| `REGISTRATION_CLOSED`               | 403    | «Регистрация временно закрыта»        |
| `VALIDATION_FAILED`                 | 422    | «Сервер отклонил данные»              |
| `AUTH_UNAVAILABLE`                  | 503    | «Сервис входа временно недоступен»    |
| `NOT_FOUND` / `NETWORK` / `UNKNOWN` | 404/0  | безопасный generic-текст              |

Сырые `message`/URL/тело/`request_id` в auth-формах не показываются; в DOM
попадают только переведённые тексты.

## 3. Формы

- **Login** (`/login`): email + пароль, show/hide (`aria-pressed`,
  `aria-label`), loading (`Входим…`), generic-ошибка, ссылка «Регистрация»,
  сообщение «Вы вышли из аккаунта». Клиентская валидация только формата/пустоты;
  пароль не проверяется по длине, чтобы не блокировать существующих пользователей.
- **Register** (`/register`): имя, email, пароль, подтверждение; DoS/contract
  лимиты (`display_name` 1..80, email ≤254, password 10..128), совпадение
  паролей, понятные field-errors, `aria-invalid`/`aria-describedby`. Успех `202`
  → `/verify` (сессия не создаётся). Terms checkbox отсутствует (явно вне scope).
- **Verify** (`/verify`): 6 цифр (`inputMode=numeric`, `autocomplete=one-time-code`,
  фильтрация нецифр), `CODE_INVALID` с остатком попыток, `CODE_EXPIRED`,
  `429` после 5 попыток, TTL-таймер, resend с обратным отсчётом 60 с
  (`resend_after`), успех → `AuthSession` и приложение. Pending verification
  хранится в sessionStorage (id/email/дедлайны, без кода).
- **Logout**: `POST /auth/logout {refresh_token}` → очистка токенов/device id/
  E2EE-состояния текущего аккаунта → `/login?logged_out=1`. Кнопка «Выйти» — в
  sidebar.

## 4. Жизненный цикл сессии

- Токены: `StoredAuthSession {accessToken, refreshToken, expiresAt, user}` в
  namespaced sessionStorage (`krug.auth.session`), только через
  `src/auth/storage.ts`; memory-копия access token — в `auth/runtime.ts`.
  `localStorage` не используется, пароли/коды не сохраняются.
- Bootstrap: сохранённая сессия сразу даёт `authenticated`; store делает
  `GET /me` → `POST /devices` → workspace/chats. `/verify` без pending
  редиректит на `/login?verification=missing`.
- 401: `withReauth` вызывает `POST /auth/refresh` один раз, сохраняет
  ротированную пару и повторяет исходный запрос; параллельные 401 делят одну
  попытку, 5-секундный cooldown исключает цикл. Неудачный refresh очищает
  токены и возвращает `/login` (E2EE-состояние не стирается — это не logout).
- Logout отзывает refresh на backend (best-effort) и очищает sessionStorage,
  memory token, device id и E2EE-состояние аккаунта через существующий
  `clearE2eeAccountStateOnLogout` (E7-F5F).
- Никаких Keycloak-редиректов, `/auth/callback`, `/realms`, `:8180` в
  production-коде. `/auth/callback` больше не маршрут приложения.

## 5. Обновлённые точки входа

`AuthRoot` → `PasswordAuthProvider` (только `authMode=password`; `dev` без
провайдера). `AuthGate` рендерит `/login`, `/register`, `/verify` для
анонимного пользователя и редиректит аутентифицированного на `/`. `App`
переименован в `PasswordApp` (убран callback-экран), `LoginScreen`/
`AuthStatusScreens` обновлены. `chatStore` использует
`runPasswordBootstrap()` для не-dev режима.

## 6. Тесты

- `src/components/auth/authFlow.test.tsx` — **18** RTL-тестов: guard, generic
  login error, register → verify → chat, клиентская валидация без сети,
  unverified login → `/verify`, `CODE_INVALID` (attempts), `CODE_EXPIRED`,
  5 попыток → 429, resend после countdown/reload, bootstrap из сохранённой
  сессии через `/me`, 401 → refresh + replay, refresh failure → `/login`,
  logout с отзывом refresh, `X-Device-Id`, onboarding, 403 workspace,
  workspace switcher, полный lifecycle register → verify → logout → login →
  refresh → logout; отдельно проверяется отсутствие запросов к `:8180`/`/realms`
  и отсутствие пароля/кода в sessionStorage.
- `src/api/authApi.test.ts` — **8**: contract-body, отсутствие
  Authorization/X-Device-Id на `/auth/*`, все коды ошибок, refresh rotation,
  logout revoke, 503/422.
- `src/auth/storage.test.ts` — **6** (round-trip, malformed, pending без кода,
  очистка), `src/auth/runtime.test.ts` — **4** (dev/password, memory vs
  storage, device id), `src/config/env.test.ts` — **6** (password/dev,
  legacy-keycloak → dev, отсутствие OIDC-полей в конфиге).
- Playwright `e2e/auth.spec.ts` — **4 passed** на MSW: полный
  register → verify → chat → logout с axe WCAG AA на login/register/verify/
  chat; invalid credentials; unverified login → verify → wrong code → correct;
  onboarding без workspace. `playwright.auth.config.ts` теперь
  `VITE_AUTH_MODE=password`, `VITE_USE_MOCKS=true`, без OIDC env.

## 7. Файлы

Новые:

- `src/api/authApi.ts`
- `src/auth/PasswordAuthProvider.tsx`, `src/auth/errors.ts`
- `src/auth/storage.test.ts`, `src/auth/runtime.test.ts`,
  `src/config/env.test.ts`
- `src/components/auth/RegisterScreen.tsx`, `VerifyEmailScreen.tsx`
- `frontend/AUTH-BFF-REPORT.md` (этот файл)

Изменены:

- `src/config/env.ts`, `src/vite-env.d.ts`, `vite.config.ts` (CSP без OIDC),
  `.env.example`, `Dockerfile` (default `password`, без OIDC args)
- `src/auth/{AuthContext,AuthRoot,auth storage,runtime,session,types,mockProfile}`,
  `src/auth/reauth.ts` (без изменений API)
- `src/components/auth/{AuthGate,LoginScreen,AuthStatusScreens}`, `src/App.tsx`,
  `src/main.tsx`, `src/api/{endpoints,types}.ts`, `src/store/chatStore.ts`,
  `src/i18n/ru.ts`, `src/styles/app.css`
- `src/mocks/{db,handlers,fixtures}.ts`, `src/test/{setup,renderApp}.tsx`
- `src/api/authApi.test.ts`, `src/components/auth/authFlow.test.tsx`,
  `e2e/auth.spec.ts`, `playwright.auth.config.ts`, `tsconfig.json`,
  `package.json` (`test:e2e:keycloak` удалён; `oidc-client-ts` и
  `react-oidc-context` удалены как неиспользуемые), `README.md`
- Удалены: `src/auth/{RealOidcProvider.tsx,MockOidcProvider.tsx,oidc.ts,oidc.test.ts}`,
  `playwright.keycloak.config.ts`, `e2e/keycloak.real.spec.ts`

## 8. Проверки

| Команда                         | Результат                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run check`                 | **DONE:** lint + format + contract + stickers + security + session-writers + 625 tests + build — без ошибок |
| `npm test`                      | **625 passed** (59 files), было 603 (удалены 4 OIDC-теста, добавлены auth-тесты)                            |
| `npm run contract:check`        | **passed: 39 operations, 68 schemas**, generated types in sync                                              |
| `npm run security:check`        | passed: 203 files, no XSS sinks, no localStorage, no token logs                                             |
| `npm run session-writers:check` | passed (138 production files)                                                                               |
| `npm run build`                 | `tsc --noEmit` + `vite build` — успешно                                                                     |
| `npm run test:e2e:auth`         | **4 passed** (Playwright + axe, mock `/auth/*`)                                                             |
| `npm run test:e2e` (mock dev)   | **12 passed** — dev F-01, files, media, stickers, notifications, WS; регрессий нет                          |

## 9. Contract

Изменений контракта нет. Использованы ровно документированные пути/схемы
`AuthRegisterRequest/Response`, `AuthVerifyEmailRequest`,
`AuthResendEmailCodeRequest/Response`, `AuthLoginRequest`, `AuthRefreshRequest`,
`AuthLogoutRequest`, `AuthSession`, `AuthSessionUser`; `schema.d.ts` не
редактировался вручную. `contract:check` уже содержал обновлённые владельцем
frontend константы 34/68 и 39 operations — дополнительная правка не потребовалась.
Refresh/logout — токен в теле; никаких query/header-токенов.

## 10. Безопасность

- Пароль и 6-значный код не пишутся в storage/logs; в sessionStorage только
  access/refresh, user-view и pending id/email/дедлайны. `security:check`
  проходит; `localStorage` запрещён, `sessionStorage` — только в
  `src/auth/storage.ts`.
- Нет `fetch` к Keycloak/`:8180`/`/realms`; CSP больше не разрешает OIDC
  origin/frame; E2E явно проверяет отсутствие таких запросов.
- Браузер не видит `client_secret`, admin-токены и SMTP; все внешние вызовы —
  за backend-BFF.
- Logout сохраняет E2EE-гарантии: сначала отзыв refresh, затем очистка
  auth-материала и E2EE-состояния текущего аккаунта; `VITE_E2EE_ENABLED` не
  включался, media/E2EE-пути не менялись.
- `credentials: 'omit'`, `cache: 'no-store'`, `X-Request-Id` — сохранены.

## 11. Риски и ограничения

1. **Живой E2E с backend/Mailpit/Keycloak не запускался.** Frontend проверен
   против MSW; реальные TOTP-письма, `503 AUTH_UNAVAILABLE` при недоступном
   Keycloak/SMTP и поведение pending-session в памяти процесса не воспроизведены
   в браузере. Backend покрывает это интеграционными тестами (391), но браузерный
   smoke остаётся follow-up.
2. **Refresh в sessionStorage** — AUTH-D-06 остаётся: пароль из браузера убран,
   OIDC-редирект убран, но HttpOnly refresh cookie вне scope. XSS-риск
   sessionStorage документирован.
3. **Logout ждёт backend-отзыв** (до `requestTimeoutMs`, 10 с); при недоступном
   backend локальные токены очищаются после таймаута/ошибки, но кнопка может
   «зависнуть» на время запроса. Для мгновенного UX нужен фоновый revoke —
   осознанно не менял порядок «revoke → clear → login».
4. **Mock-код `123456` и demo-пароль** существуют только в MSW
   (`src/mocks/*`, `VITE_USE_MOCKS=true`); production-сборка их не содержит.
5. **`deploy/docker-compose.yml` вне зоны** всё ещё может передавать
   `VITE_OIDC_*`; Dockerfile эти args больше не объявляет (docker выдаст
   warning об unused build arg). Обновление compose/nginx — follow-up владельцу
   deploy; на браузер это не влияет, т.к. фронт их игнорирует.
6. **Поведение `503 sign_in_required`** (потерянная pending-сессия backend)
   показывается как «Сервис входа временно недоступен»; пользователь может
   войти паролем. Отдельного экрана «войдите заново после verify» нет — backend
   сообщает причину в `details.reason`, но UI её не раскрывает.
7. **Rate limit throttling** на login/register/resend показывается по
   `Retry-After`; кнопки не блокируются на N секунд (пользователь может
   повторить и снова получить 429). Это безопасно, но не идеальный UX.
8. **`npm run test:e2e` (dev/mock F-01)** не входит в `npm run check`; прогон
   вынесен отдельно (см. Checks). `test:e2e:real`/`keycloak` требуют внешних
   стендов.

## 12. Что дальше

1. Поднять compose (Keycloak internal + Mailpit) и прогнать браузерный
   register → Mailpit code → verify → `/me`, а также 401 refresh/logout против
   реального BFF.
2. Обновить `deploy/**` (убрать `VITE_OIDC_*`, `VITE_AUTH_MODE=password`) и
   nginx — вне зоны этой сессии.
3. Production follow-up backend: service account вместо master `admin-cli`,
   Redis для pending session/rate limit — UI не меняется.
4. Рассмотреть фоновый logout-revoke и явный экран для `AUTH_UNAVAILABLE` с
   `details.reason=sign_in_required`.

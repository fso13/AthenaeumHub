# E2EE-PILOT-1 — clean-stack F7B fixture (#29)

> **Зона:** только `frontend/**` (`e2e/`, README, этот отчёт). Не изменялись
> `backend/**`, `contracts/**`, `docs/**`, `design/**`, `src/api/schema.d.ts`,
> base-флаги и compose-файлы. Production-поведение не менялось: весь новый код —
> test-only fixture/harness, запускаемый только при `E2EE_REAL=1`.
>
> **Вход:** `docs/E2EE-REVIEW-13.md` (условие 2, P2-01/P2-02),
> `frontend/e2e/e2ee.real.spec.ts`, `playwright.e2ee-real.config.ts`,
> `frontend/E7-F7B-REPORT.md`, `frontend/E2EE-PILOT-2-REPORT.md`,
> `backend/.../auth/**`, Mailpit API, `deploy/docker-compose*.yml`.

## 1. Итог

Условие 2 REVIEW-13 закрыто фикстурой, а не отчётом:

- оба fixture-пользователя создаются на чистом стенде через **реальный BFF**:
  `POST /auth/register` → TOTP из Mailpit API → `POST /auth/verify-email`;
  на повторном прогоне verified-аккаунты переиспользуются. Pre-seeded
  `test@krug.local` / leftover `pickle-ui-…` больше не нужны;
- destructive SQL **выключен по умолчанию**. `E2EE_REAL_RESET=1` (alias
  `E2EE_REAL_ALLOW_DESTRUCTIVE=1`) включает pre-login device reset, удаление
  stale `E2EE F7B …` workspace старше часа и удаление workspace текущего прогона;
- без reset тест создаёт уникальные users/workspace/chat и не выполняет ни
  одного `UPDATE`/`DELETE`;
- F7B прогнан **2/2** в Chromium и Firefox на overlay-стеке в трёх режимах:
  fresh BFF-аккаунты, повторное использование аккаунтов, destructive reset;
- `npm run check` — **EXIT 0**, 81 файл / **865 тестов**, build 445 модулей.

**Статус #29: DONE.**

## 2. Clean-stack fixture

### 2.1. Поток провижининга

Новый модуль `frontend/e2e/e2ee-real-fixture.ts`:

1. `POST /api/v1/auth/login` с fixture-кредами.
   - `200` — аккаунт существует и verified → **reuse**;
   - `403 EMAIL_NOT_VERIFIED` + `details.verification_id` — предыдущий прогон
     остановился до verify → код берётся из Mailpit, verify завершается
     (**resume**);
   - `401 INVALID_CREDENTIALS` — аккаунта нет → регистрация;
   - `429` / `5xx` — явная ошибка с `retry-after` / `reason`, без подстановки
     другого пользователя.
2. `POST /api/v1/auth/register`
   `{email, display_name, password}` → `202 {verification_id, expires_in,
resend_after}`. Пароль по умолчанию ≥ 10 символов (требование BFF), в логи не
   попадает.
3. TOTP читается из Mailpit:
   `GET /api/v1/messages?limit=100` → фильтр по `To[].Address` и `Created` →
   `GET /api/v1/message/{id}` → regex `подтверждения: (\d{6})`. Код живёт только
   в памяти процесса Playwright.
4. `POST /api/v1/auth/verify-email {verification_id, code}`.
   - `410` (код истёк) → один `POST /auth/resend-email-code`, ожидание
     `Retry-After` при `429`, затем повторное чтение **нового** письма;
   - `422/429` → тест падает, код не подбирается.
5. Браузер логинится через обычную UI-форму BFF. Для clean-пользователя без
   workspace допускается onboarding-экран: keyed device регистрируется до
   проверки `me.workspaces`, поэтому `krug.device.id` уже доступен. E2EE-workspace
   затем создаётся через E12 API и открывается reload’ом.

Fixture никогда не использует SQL для создания пользователя, не читает
Keycloak-админку и не логирует email-код/пароль/токены.

### 2.2. Ошибки при недоступном Mailpit/registry

Проверено негативным запуском с `E2EE_REAL_MAILPIT_URL=http://127.0.0.1:9`:

```
Error: E2EE fixture cannot reach Mailpit at http://127.0.0.1:9.
Start deploy/docker-compose.yml (mailpit service) or set E2EE_REAL_MAILPIT_URL.
Underlying error: fetch failed
```

Похожие явные сообщения предусмотрены для:

| Ситуация                          | Сообщение/поведение                                           |
| --------------------------------- | ------------------------------------------------------------- |
| BFF недоступен                    | `cannot reach the Auth BFF at …`, подсказка про стек/base URL |
| Keycloak/registry 5xx             | `identity registry (Keycloak) is unavailable (reason=…)`      |
| Mailpit 5xx                       | `Mailpit /api/v1/… returned HTTP …`                           |
| Письмо не пришло за timeout       | подсказка `SPRING_MAIL_HOST=mailpit`, сервис, base compose    |
| Аккаунт существует, пароль другой | `EMAIL_TAKEN` + указание сменить email/пароль, без fallback   |
| Rate limit                        | `retry-after` и требование подождать, без обхода              |

`E2EE_REAL_MAIL_TIMEOUT_MS` (default 45 000) управляет ожиданием письма.

## 3. Destructive SQL — только opt-in

| Операция                                                 | Условие                                | Где                             |
| -------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| `UPDATE auth.devices … REVOKED` (fixture users)          | `E2EE_REAL_RESET=1` **и** `DB_CHECK`   | `resetFixtureDevices()`         |
| `DELETE` stale `E2EE F7B …` workspace/messages/envelopes | `E2EE_REAL_RESET=1` **и** `DB_CHECK`   | `cleanupStaleWorkspaces()`      |
| `DELETE` workspace текущего прогона                      | `E2EE_REAL_RESET=1` **и** `DB_CHECK`   | `deleteWorkspace()` в `finally` |
| Post-login `DELETE /devices/{id}` (API)                  | всегда, только свои устройства fixture | `pruneOtherDevices()`           |

- Без `E2EE_REAL_RESET=1` ни один `UPDATE`/`DELETE` не выполняется. В отчёте
  Playwright появляется аннотация
  `off: no destructive SQL executed (no device reset, no workspace cleanup)`.
- `E2EE_REAL_DB_CHECK=0` отключает и read-only DB/log проверки, и destructive SQL
  (для удалённого стека); при запрошенном reset это явно аннотируется.
- API-`DELETE /devices` не является SQL и не трогает других пользователей; он
  поддерживает ровно одно ACTIVE-устройство fixture-пользователя. На чистом
  стенде это no-op.
- Unique naming: `E2EE F7B <epoch-ms>-<random8>`; slug не конфликтует, повторный
  прогон не требует очистки. `Idempotency-Key` для `POST` уже генерируется
  существующим `api()`.
- `cleanupStaleWorkspaces()` удаляет только `name LIKE 'E2EE F7B %'` и
  `created_at < now() - 1 hour`, сообщения/envelopes — до workspace, потому что
  у `message.messages` нет FK на `chat.chats`.

## 4. Воспроизводимость

### 4.1. Стенд

Собран ровно test-only overlay из base compose:

```bash
cd deploy
# в песочнице DSH buildx не пишет в ~/.docker:
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml build frontend
DOCKER_CONFIG=/tmp/docker-config docker-compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml \
  up -d --no-deps --force-recreate backend frontend
```

Проверено:

| Проверка                    | Результат                                                                  |
| --------------------------- | -------------------------------------------------------------------------- |
| `KRUG_E2EE_ENABLED` backend | `true` (только overlay)                                                    |
| SPA asset                   | `assets/index-D7muZoMM.js`, sha256 `56fe46c9…e7aac8`                       |
| SPA flag                    | asset содержит `VITE_E2EE_ENABLED:"true"`                                  |
| image                       | `sha256:29540350239863a4b6…cabc9b`, created `2026-11-19T06:15:51Z`         |
| base `deploy/.env`          | `KRUG_E2EE_ENABLED=false` (не менялся)                                     |
| `/api/v1/health`            | `200 {"status":"ok"}`                                                      |
| возврат в base              | backend `KRUG_E2EE_ENABLED=false`; SPA `VITE_E2EE_ENABLED:"false"`         |
| base image / asset          | `sha256:754ff9640ce0…abedca`; `index-CA2c5sJw.js` sha256 `ea85f604…6ec6eb` |

### 4.2. Запуск F7B

```bash
cd frontend
RUN=$(date +%s)
E2EE_REAL_USER_A_EMAIL="e2ee-clean-a-${RUN}@krug.local" \
E2EE_REAL_USER_B_EMAIL="e2ee-clean-b-${RUN}@krug.local" \
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home \
MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 \
npm run test:e2e:e2ee:real
# npm script сам выставляет E2EE_REAL=1
```

Без destructive SQL (default). Для opt-in cleanup на одноразовом стенде:

```bash
E2EE_REAL_RESET=1 \
E2EE_REAL_USER_A_EMAIL=… E2EE_REAL_USER_B_EMAIL=… \
npm run test:e2e:e2ee:real
```

Переменные: `E2EE_REAL_BASE_URL`, `E2EE_REAL_MAILPIT_URL`,
`E2EE_REAL_USER_{A,B}_{EMAIL,PASSWORD,NAME}`, `E2EE_REAL_MAIL_TIMEOUT_MS`,
`E2EE_REAL_DB_CHECK`, `E2EE_REAL_RESET` (alias
`E2EE_REAL_ALLOW_DESTRUCTIVE`), `E2EE_REAL_{PG,BACKEND}_CONTAINER`.

### 4.3. Результаты прогонов

| Режим                           | Результат | Аннотации (JSON reporter)                                                                |
| ------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| fresh BFF-аккаунты, reset off   | **2/2**   | Chromium: `A=registered, B=registered`; Firefox: `A=existing, B=existing`; `reset off`   |
| повторные аккаунты, reset off   | **2/2**   | `A=existing, B=existing`; `reset off`                                                    |
| `E2EE_REAL_RESET=1`             | **2/2**   | `on: revoked 2 active fixture device(s), deleted 867 stale E2EE F7B row(s)` (1-й проект) |
| Mailpit недоступен              | fail      | явная ошибка `cannot reach Mailpit…`, без skip/fake pass                                 |
| gate off (`E2EE_REAL` не задан) | 2 skipped | ожидаемо                                                                                 |

Свежий прогон (JSON `/tmp/f7b-clean.json`):

```
status= passed
  E2EE_FIXTURE_USERS => registered/reused via BFF+Mailpit: A=registered, B=registered
  E2EE_REAL_RESET => off: no destructive SQL executed (no device reset, no workspace cleanup)
status= passed
  E2EE_FIXTURE_USERS => registered/reused via BFF+Mailpit: A=existing, B=existing
  E2EE_REAL_RESET => off: no destructive SQL executed (no device reset, no workspace cleanup)
stats: expected 2, skipped 0, unexpected 0, flaky 0
```

Первый проект доказывает полный BFF+Mailpit register/verify path, второй —
reuse в том же прогоне. Сценарий внутри по-прежнему проверяет keyed
registration/prekeys, DIRECT E2EE-чат, send/decrypt в обе стороны, reload,
R-15, safety number, envelopes-only DB и отсутствие plaintext в DB/WS/logs.

## 5. DB evidence

- Clean-прогоны создали 6 workspace (`E2EE F7B <ts>-<rand>`) в трёх reset-off
  прогонах; reset-прогон удалил свои workspace в `finally` — сейчас в БД ровно
  6 свежих `E2EE F7B` workspace, старых (>1 ч) нет.
- Reset-прогон удалил **867** строк envelopes+messages+workspaces старых
  `E2EE F7B`-фикстур (только `E2EE F7B %`, только старше часа, только при
  явном `E2EE_REAL_RESET=1`).
- В БД есть 6 fixture-пользователей `e2ee-clean-*@krug.local` (3 пары A/B),
  `auth.users.status=ACTIVE`; они созданы BFF, не SQL.
- DB-ассерты сценария для каждого прогона: все сообщения тестового чата
  `E2EE_PAIRWISE`, `body_ciphertext IS NULL`, `content_meta='{}'`, envelopes
  `PAIRWISE_X3DH_DR`, plaintext-маркеров нет в messages/envelopes/backend logs/WS.

## 6. Проверки

`npm run check` — **EXIT 0**:

```
lint                  ok
format:check          ok
contract:check        ok
stickers:check        ok
security:check        ok (279 files)
session-writers:check ok (191 production files)
vitest                81 files / 865 tests passed
tsc --noEmit          clean
vite build            445 modules, built
```

`npx playwright test --config playwright.config.ts --list` — 15 tests / 7 files;
F7B и helper в base-конфиг не попадают. Gate off — `2 skipped`.

## 7. Файлы

Новые:

- `frontend/e2e/e2ee-real-fixture.ts` — BFF/Mailpit fixture, gated destructive
  SQL, read-only psql/log helpers;
- `frontend/E2EE-PILOT-1-REPORT.md` — этот отчёт.

Изменены (только `frontend/**`):

- `frontend/e2e/e2ee.real.spec.ts` — clean-stack fixture step, onboarding-aware
  login, unique workspace name, reset annotations, cleanup в `finally`;
- `frontend/README.md` — clean-stack/Mailpit/reset переменные и команды.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, base-флаги, compose-файлы, crypto/KAT/wire/`Idempotency-Key`.

## 8. Остаточные риски / ограничения

1. **DB volume не пересоздавался.** Clean-path доказан новыми BFF-аккаунтами и
   уникальным workspace на существующем одноразовом volume; старые unrelated
   строки не влияли на fixture. Полный empty-volume прогон — задача release-CI
   (условие 8), а не блокер этой фикстуры.
2. **Onboarding UI предлагает только Managed.** Clean-пользователь без
   workspace видит onboarding с managed-режимом; fixture создаёт E2EE-workspace
   через E12 API. Это не менялось в #29 и остаётся продуктовым gap для пилота.
3. **Reset-off workspace’ы накапливаются** (по дизайну, без destructive SQL).
   `E2EE_REAL_RESET=1` удаляет stale (>1 ч) и свой workspace; для CI нужен
   периодический reset/чистая БД.
4. **Fixture-пользователи накапливаются** в Keycloak/`auth.users` (3 пары за
   этот прогон). Их удаление не входит в задачу; для CI — reset стенда.
5. **Дефолтные fixture-креды статичны** (`e2ee-f7b-a/b@krug.local`). Для
   изоляции используйте `E2EE_REAL_USER_*`, чтобы не делить аккаунт между
   параллельными стендами. Пароли/коды/токены не логируются.
6. **Rate limits BFF** (register 20/IP/ч, login 30/IP/мин) могут потребовать
   паузы при очень частых прогонах; fixture не обходит их, а сообщает
   `retry-after`.
7. **Mailpit-парсинг** рассчитан на текущий plain-text шаблон
   «Ваш код подтверждения: …»; при смене шаблона нужен fallback/обновление
   regex (сейчас есть общий 6-значный fallback).
8. **API-`DELETE /devices`** — не SQL, но destructive для устройств
   fixture-пользователя. Он выполняется всегда и не затрагивает других
   пользователей; на чистом стенде no-op.
9. **Reset удаляет старое F7B-evidence** (867 строк) — это осознанный opt-in
   на одноразовом стенде; не запускать на общем стенде.
10. **Firefox в песочнице DSH** требует `TMPDIR`/`CFFIXED_USER_HOME` и
    отключения sandbox; это артефакт среды, не проекта.
11. **Стенд возвращён в base** после прогонов: `KRUG_E2EE_ENABLED=false`,
    SPA `VITE_E2EE_ENABLED:"false"`, image `sha256:754ff9640ce0…`, asset
    `index-CA2c5sJw.js`; base `.env`/compose не менялись.

---

**Статус #29: DONE.** Clean-stack fixture с BFF/Mailpit register/verify,
destructive SQL только по `E2EE_REAL_RESET=1`, unique workspace/chat,
F7B 2/2 в Chromium/Firefox (fresh + reuse + reset), `npm run check` 865/865.

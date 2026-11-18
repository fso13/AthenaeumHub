# E7-F7B — real two-device E2EE E2E (Chromium / Firefox)

> **Зона:** только `frontend/**` (e2e/конфиг/README/тесты + минимальная правка
> клиентского E2EE-хранилища и store) и этот отчёт. Не изменялись `backend/**`,
> `contracts/**`, `docs/**`, `design/**`, `src/api/schema.d.ts`, `src/config/env.ts`.
> Base E2EE flag остаётся **false**: `deploy/.env` — `KRUG_E2EE_ENABLED=false`,
> base `docker-compose.yml` — `${KRUG_E2EE_ENABLED:-false}` и
> `VITE_E2EE_ENABLED=${KRUG_E2EE_ENABLED:-false}`. Включался только тестовый
> overlay `deploy/docker-compose.e2ee-test.yml`.
>
> **Вход:** `frontend/E7-F6-REPORT.md`, `frontend/E7-F7A-REPORT.md`,
> `docs/ADR-26-E2EE-BROWSER-FLOOR.md`, `docs/E2EE-SPEC.md` §5,
> `deploy/docker-compose.e2ee-test.yml`, `deploy/README.md` (E2EE test mode),
> `src/e2ee/app/chatBridge.ts`, `src/store/chatStore.ts`, `e2e/**`,
> `backend/E7-B3-B4-REPORT.md`.
>
> **Итог:** сквозной E2EE между двумя реальными браузерными контекстами
> (Chromium 159 / Firefox 159) против собранного стека работает: keyed
> registration + prekeys, `GET /devices` `e2ee_capable`, DIRECT E2EE-чат,
> send/decrypt в обе стороны, reload-персистентность, R-15 reset, safety number,
> envelopes-only в PostgreSQL и отсутствие plaintext в БД/WS/backend-логах.
> По ходу найден и исправлен реальный дефект reload-персистентности **входящих**
> сообщений. Негативный key-change/TOFU-путь (same device id с другими ключами)
> в реальном браузере не форсировался — **PARTIAL** по этому подпункту.

## 1. Стенд и проверка overlay

Поднят ровно тестовый overlay (base stack не менялся):

```bash
cd deploy
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
```

Проверено:

| Проверка                            | Результат                                        |
| ----------------------------------- | ------------------------------------------------ |
| `docker inspect krug-backend`       | `KRUG_E2EE_ENABLED=true`                         |
| собранный SPA (`assets/index-*.js`) | `VITE_E2EE_ENABLED:"true"`                       |
| base `deploy/.env`                  | `KRUG_E2EE_ENABLED=false`                        |
| base `docker-compose.yml`           | default `false` для backend и frontend build arg |
| `/api/v1/health`                    | `200 {"status":"ok"}`                            |

**Важно про origin.** Base URL теста — `http://localhost:8088`, а не
`127.0.0.1`. Backend проверяет `Origin` WebSocket по `PUBLIC_URL`
(`http://localhost:8088`); с `127.0.0.1` handshake `/ws` возвращает 403, и
realtime уходит в бесконечный reconnect. Это не E2EE-дефект, а конфигурация
origin; в spec/config зафиксирован `localhost`.

## 2. Fixture (test-only, документирован в spec)

Два реальных пользователя из задачи:

- `test@krug.local` / `Test1234!` (OWNER);
- `pickle-ui-1794919305193@krug.local` / `CorrectHorseBattery42!` (MEMBER).

Что делает fixture:

1. **SQL reset устройств перед login.** `UPDATE auth.devices SET status='REVOKED',
revoked_at=now(), revoked_reason='E2EE_F7B_TEST_RESET' WHERE user_id=... AND
status='ACTIVE'`. Нужно, чтобы повторный прогон не упирался в лимит
   `MAX_ACTIVE_DEVICES=5` до того, как тест успеет почистить устройства через
   API. Это одноразовый тестовый стек; `E2EE_REAL_DB_CHECK=0` отключает SQL.
2. **Два browser context** логинятся через реальную BFF-форму. Store с
   `VITE_E2EE_ENABLED=true` создаёт E2EE bridge, регистрирует keyed device
   (`Ed25519+X25519`), загружает SPK + 100 OPK и переключает `X-Device-Id` на
   этот device.
3. **Проверка `GET /devices`:** для текущего device `e2ee_capable=true`,
   `signed_prekey != null`, `one_time_prekeys_available > 0`.
4. **Свежее E2EE-пространство на каждый прогон** `E2EE F7B <timestamp>`:
   `POST /workspaces {security_mode:"E2EE"}` + `POST /workspaces/{id}/members
{email, role:"MEMBER"}` (E12 members API). Свежее пространство даёт пустую
   историю DIRECT-чата — иначе decrypt-loop прошлых прогонов гоняется с
   R-15-инъекцией.
5. После login — страховочный `GET /devices` + `DELETE /devices/{id}` для всех
   ACTIVE, кроме текущего; проверяется, что остался ровно один.
6. DB/log evidence читаются `docker exec krug-postgres psql` и
   `docker logs krug-backend --since <start>`. Для удалённого стека —
   `E2EE_REAL_DB_CHECK=0` (тогда SQL-фикстура и DB/log-ассерты не выполняются,
   это явно аннотируется в отчёте Playwright).

Пространства и устройства после прогона остаются в тестовой БД (delete API
пространства нет); это осознанная цена одноразового стенда.

## 3. Harness

Новые файлы:

- `e2e/e2ee.real.spec.ts` — gated-сценарий (chromium/firefox), оба контекста,
  UI-проверки + network/DB/log/WS assertions;
- `playwright.e2ee-real.config.ts` — `testMatch` только этот spec, `workers:1`,
  без `webServer`, `baseURL=localhost:8088`, **trace/screenshot/video off**
  (чтобы падение E2EE-теста не писало расшифрованный текст на диск), проекты
  только Chromium и Firefox (WebKit исключён ADR-26).

Изменения конфигурации:

- `package.json`: `test:e2e:e2ee:real` = `E2EE_REAL=1 playwright test --config
playwright.e2ee-real.config.ts`;
- `playwright.config.ts` и `playwright.real.config.ts`: новый spec добавлен в
  `testIgnore`, поэтому обычные `npm run test:e2e`/`test:e2e:real` его не запускают;
- `tsconfig.json`: новый config в `include`;
- `README.md`: раздел «Real two-device E2EE (E7-F7B)»;
- `.gitignore`/`.prettierignore`/`eslint.config.js`: временные
  `.pw-tmp`/`.pw-home` (Firefox TMPDIR в песочнице) исключены из проверок.

Gate: без `E2EE_REAL=1` оба проекта **skipped** (проверено: `2 skipped`).
`npm run test:e2e -- --list` не содержит `e2ee.real`.

### 3.1. Что именно проверяет сценарий

1. **Registration:** keyed device + prekeys + `GET /devices` `e2ee_capable`.
2. **Chat:** A создаёт/открывает DIRECT E2EE-чат через UI; B после reload
   открывает тот же чат; composer enabled только когда E2EE state ready и
   `peerDeviceIds > 0`; оба realtime `Онлайн`.
3. **A → B:** A отправляет уникальный marker. Проверяется:
   - `POST /messages` body: `text` отсутствует, `type=TEXT`, `envelopes[1..]`;
   - ответ: `text:null`, `crypto:null`, `envelope_coverage.peer_covered>=1`;
   - marker виден в UI A и B (count-based assertion, чтобы не печатать plaintext).
4. **B → A:** то же в обратную сторону; A видит ответ.
5. **Reload:** оба контекста перезагружаются; оба сообщения снова видны на обеих
   сторонах (включая уже принятые входящие — см. §4).
6. **R-15:** у B очищается **только** object store `sessions` в IndexedDB
   (`krug-e2ee`) + reload. History-decrypt упирается в отсутствующую сессию
   (`NO_SESSION`), B отправляет зашифрованный `SESSION_RESET`, A перешифровывает
   failed-окно в новой prekey-сессии, B читает замену. Проверяется:
   - A показывает баннер «Сообщения переотправлены в новую сессию»;
   - B снова видит ранее принятый marker;
   - у B появилась сессия (`sessions > 0`);
   - новый marker после reset доходит до B.
7. **TOFU / safety number:** A и B независимо открывают диалог «Код
   безопасности»; коды совпадают и соответствуют `^\d{5}( \d{5}){11}$`
   (60 цифр, 12 групп).
8. **DB:** в `message.messages` для тестового чата:
   - все строки `crypto_scheme=E2EE_PAIRWISE`, `type=TEXT`,
     `body_ciphertext IS NULL`, `content_meta='{}'`, без sticker/reply;
   - ни в одной строке (через `row_to_json`) нет plaintext-маркеров;
   - у каждого сообщения есть envelope;
   - все envelope-строки `PAIRWISE_X3DH_DR`, `session_id` 16 B, ciphertext
     272..33040 B, есть sender/recipient device;
   - минимум один prekey-envelope;
   - в envelope JSON/bytes нет plaintext-маркеров.
9. **WS/логи:** все `framereceived` кадры обоих сокетов и backend-логи с момента
   старта теста не содержат ни одного из plaintext-маркеров. Кадры хранятся
   только в памяти и не печатаются.

## 4. Найденный и исправленный дефект: reload входящих сообщений

### 4.1. Симптом

В первом прогоне после reload каждый контекст видел **только свои** сообщения:
A видел A, но не B; B видел B, но не A. То есть исходящие восстанавливались из
local copy, а принятые — исчезали.

### 4.2. Причина

`decryptE2eeSlice` при reload заново прогоняет всю историю через
`bridge.receive`. Для уже принятого сообщения ratchet законно отвечает
`DUPLICATE_OR_OLD_MESSAGE` → bridge возвращает `kind:'none'` → store помечал
сообщение `superseded` и **не смотрел local copy**. Входящая local copy при этом
существовала, но была запечатана под случайным `localMessageId` и без
`client_message_id`, поэтому найти её по серверному `Message.client_message_id`
было нельзя.

### 4.3. Исправление (frontend, без изменения crypto/KAT)

- `E2eeIncomingEnvelopeInput.clientMessageId` пробрасывается в
  `commitIncomingE2eeMessage` и сохраняется в sealed incoming local copy (AAD
  привязан к `client_message_id`).
- `outboxStore.lookupIncomingLocalCopy(storage,kStorage,chatId,senderDeviceId,
clientMessageId)` читает namespace `direction='incoming'` + sender device +
  `c:<client_message_id>`; проверяет scope и возвращает расшифрованную копию.
  Чужой peer-controlled id не может резолвиться в outgoing-копию локального
  отправителя (P1-02 сохранён: namespace разделён по direction/sender).
- `E2eeBridge.lookupIncomingLocalCopy` + fake bridge.
- `chatStore.decryptE2eeSlice`: на `kind:'none'` сначала пробует incoming local
  copy; найденная копия → `decrypted`, отсутствующая → `unavailable` (раньше
  было `superseded`). Для reset-replaced сообщений копии нет, поэтому «no
  duplicate visible reset» не ломается.
- Тесты: `sessionSendReceive.test.ts` +1 (incoming copy переживает
  replay/duplicate, outgoing lookup её не видит), `e2eeChat.test.ts` +2
  (store восстанавливает duplicate из incoming copy и не рендерит восстановленный
  `SESSION_RESET` control как сообщение).

Crypto/KAT не ослаблялись: ratchet, ключи, envelope/AAD, `K_storage` и нормативные
векторы не менялись; изменился только способ адресации уже расшифрованной
входящей копии. `session-writers:check` зелёный.

## 5. R-15 и TOFU / key-change

### 5.1. R-15 — покрыт в реальном браузере

Сценарий описан в §3.1(6). Fault injection — тестовый: очищается только
`sessions` store (не identity, prekeys, pins, local copies), поэтому
криптографические проверки не ослабляются. На стенде R-15 проходит: A
показывает completed-баннер, B читает замену, затем новый текст идёт по новой
сессии. Это подтверждено и отдельным probe, и финальными прогонами.

В тесте есть два защитных приёма, оба относятся к harness, а не к продукту:

- fault injection делает **двойной clear** после короткой паузы, чтобы
  in-flight IndexedDB-транзакция не восстановила сессию между clear и reload;
- если live control-frame `SESSION_RESET` не дошёл до A за 15 с, spec
  перезагружает A: его история содержит тот же зашифрованный reset, и
  `decryptE2eeSlice` доводит перешифровку. Это catch-up, а не обход: reset
  по-прежнему проходит через `NO_SESSION` → `SESSION_RESET` → re-encrypt.

### 5.2. TOFU — положительный путь покрыт

Первый контакт создаёт пин; safety number на обеих сторонах совпадает
(60 цифр). Повторный reload не меняет код. Пиннинг/`KEY_CHANGE_DETECTED`
на уровне F3/F4 покрыт unit-тестами, но **негативный real-browser key-change**
не форсировался.

### 5.3. Key-change negative — PARTIAL

Чтобы реально получить «тот же `device_id`, другие identity-ключи», нужно
подменить ключи устройства в БД и сгенерировать валидную
`identity_binding_signature`, которую приватные ключи браузера B уже не
подтверждают. Это:

- ломает B как устройство (он больше не может расшифровывать/подписывать);
- требует out-of-band мутации серверных ключей, а не пользовательского сценария;
- не покрывается безопасным тестовым fixture без риска повредить стенд.

Поэтому негативный путь не инсценировался. **PARTIAL** по этому подпункту:
TOFU положительный + safety number проверены, key-change warning/accept —
только unit/UI-тесты предыдущих срезов. Для полного закрытия нужен отдельный
gate со стендом, который умеет легитимно ротировать identity устройства
(или согласованный test-only key-substitution fixture).

## 6. Результаты

### 6.1. Финальный прогон

```bash
cd frontend
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
TMPDIR=$PWD/.pw-tmp CFFIXED_USER_HOME=$PWD/.pw-home \
MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GPU_SANDBOX=1 \
npm run test:e2e:e2ee:real
```

```
2 passed (23.1s)
  ✓ [chromium] ... (9.5s)
  ✓ [firefox]  ... (11.9s)
```

Оба проекта проходят весь сценарий: registration/prekeys → workspace/member →
DIRECT E2EE chat → A↔B send/decrypt → reload → R-15 → safety number → DB/WS/log
no-plaintext.

### 6.2. Стабильность

- Chromium: **10/10** последовательных прогонов (после перехода на свежее
  workspace и SQL-reset devices).
- Firefox: **5/5**.
- Совместно `npm run test:e2e:e2ee:real`: **3/3** (2 passed каждый).
- Gate off: **2 skipped**, exit 0.
- До стабилизации наблюдались две категории флаков, обе устранены:
  1. история прошлых прогонов в общем чате гонялась с R-15-инъекцией →
     теперь на каждый прогон создаётся новое E2EE-пространство;
  2. повторные быстрые прогоны упирались в auth rate limit 429 → fixture
     больше не делает два лишних API-login, а UI-login получил retry с backoff.

### 6.3. DB evidence (пример последнего тестового чата)

```
chat: E2EE F7B 1794996849866, security_mode=E2EE
message.messages: 5 rows, все crypto_scheme=E2EE_PAIRWISE,
  body_ciphertext IS NULL, content_meta='{}', sticker_id/reply_to_id NULL
message.message_envelopes: у каждого сообщения 1 envelope,
  ciphertext 272 B, scheme=PAIRWISE_X3DH_DR, session_id 16 B;
  prekey есть у первых конвертов каждой стороны
plaintext markers: 0 rows в messages, 0 в envelopes, 0 в backend logs,
  0 в WS frames
```

### 6.4. `npm run check`

**EXIT 0**:

```
lint                 0 errors (2 pre-existing warnings в CreateChatDialog)
format:check         ok
contract:check       55 operations, 87 contract schemas (74 checked), types in sync
stickers:check       ok
security:check       ok
session-writers:check ok (162 production files)
vitest               71 files / 733 tests passed
tsc --noEmit         clean
vite build           415 modules, built
```

KAT/crypto не менялись: `vectors.test.ts`, `kStorageKAT.test.ts`,
`sessionKAT.test.ts` входят в 733 и зелёные. `npm run test:e2e` (base config)
не содержит `e2ee.real` (проверено `--list`: 15 tests / 7 files).

## 7. Файлы

Новые:

- `frontend/e2e/e2ee.real.spec.ts` — real two-device E2EE spec;
- `frontend/playwright.e2ee-real.config.ts` — Chromium/Firefox, no webServer,
  artifacts off;
- `frontend/E7-F7B-REPORT.md` — этот отчёт.

Изменены:

- `src/e2ee/session/receive.ts` — `clientMessageId` в incoming local copy;
- `src/e2ee/outbox/outboxStore.ts` — `lookupIncomingLocalCopy`;
- `src/e2ee/app/chatBridge.ts` — bridge-метод и проброс `clientMessageId`;
- `src/store/chatStore.ts` — восстановление duplicate из incoming copy;
- `src/test/e2eeBridgeFake.ts` — fake-метод;
- `src/e2ee/sessionSendReceive.test.ts`, `src/store/e2eeChat.test.ts` — +3 теста;
- `package.json`, `tsconfig.json`, `playwright.config.ts`, `playwright.real.config.ts`,
  `README.md`, `.gitignore`, `.prettierignore`, `eslint.config.js`.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, `src/config/env.ts`, base флаг, wire v1,
`docs/E2EE-TEST-VECTORS.json`.

## 8. Риски / ограничения

1. **Тестовые пространства накапливаются.** На каждый прогон создаётся
   `E2EE F7B <timestamp>`; API удаления workspace нет, поэтому в одноразовой
   БД остаются пространства/чаты/сообщения. Для CI нужен reset БД или
   отдельный cleanup-job.
2. **SQL-reset устройств обходит API-события.** `UPDATE auth.devices` не
   эмитит `device.list.changed`/`session.revoked`, не меняет `key_generation`
   и не закрывает WS. Это допустимо только в одноразовом E2EE-стенде; на
   общем стенде используйте API-ревокацию.
3. **R-15 fault injection — тестовый.** Очистка `sessions` store извне — не
   пользовательский сценарий; двойной clear и свежее workspace снижают гонку,
   но это не product-путь. Продуктовый R-15 проверен по наблюдаемому результату
   (reset → re-encrypt → decrypt).
4. **Live control-frame race.** Если `SESSION_RESET` не доставлен по WS, A
   обработает его только после reload/повторного открытия чата: `runSync`
   catch-up добавляет сообщение в slice, но не вызывает decrypt. Spec делает
   reload A как документированный catch-up. Продуктово стоит обрабатывать
   control-сообщения и на sync/catch-up, а не только на live WS — иначе
   пропущенный кадр задерживает reset до перезагрузки. Это не блокер F7B, но
   риск для L3b/плохих сетей.
5. **Key-change negative — PARTIAL** (см. §5.3). Нужен отдельный стенд/фикстура
   для легитимной ротации identity.
6. **WebKit/Safari не покрыты** — ADR-26; F7B выполнен в Chromium/Firefox.
   Shipping Safari этой матрицей не сертифицирован.
7. **Firefox в песочнице DSH** требует writable `TMPDIR`/`CFFIXED_USER_HOME`
   и отключения content/GPU sandbox; это артефакт среды, не требование проекта
   и не зашито в config/script.
8. **Docker buildx в песочнице DSH** не мог писать в `~/.docker/buildx`;
   overlay собирался с workspace-local `DOCKER_CONFIG` и явным `DOCKER_HOST`.
   На обычной машине это не нужно. Base compose/флаги не менялись.
9. **Rate limiting.** При очень частых повторных прогонах auth BFF отдаёт 429;
   UI-login retry с backoff добавлен в spec. Это не обход auth, а тест-harness
   устойчивость.
10. **Старые incoming local copies не мигрируются.** До F7B входящая копия
    адресовалась случайным `localMessageId` без `client_message_id`; после
    исправления новые копии адресуются `(direction, sender_device,
client_message_id)`. Копии, созданные более старым клиентом, после reload
    не находятся и показываются как `unavailable`. E2EE-флаг в base всё ещё
    `false`, production-данных нет; при будущем включении флага нужна
    миграция/бэкфилл или явное принятие этого ограничения.
11. **Стенд оставлен с E2EE overlay.** Сейчас контейнеры собраны с
    `KRUG_E2EE_ENABLED=true` / `VITE_E2EE_ENABLED=true`. Для возврата к base
    перезапустите compose без `docker-compose.e2ee-test.yml`; файлы base
    по-прежнему `false`.

## 9. Быстрый воспроизводимый запуск

```bash
# 1. overlay
cd deploy
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build

# 2. real two-device E2EE
cd ../frontend
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
  npm run test:e2e:e2ee:real

# 3. обычный base check
npm run check
```

Для Firefox в песочнице DSH добавьте `TMPDIR=$PWD/.pw-tmp
CFFIXED_USER_HOME=$PWD/.pw-home MOZ_DISABLE_CONTENT_SANDBOX=1
MOZ_DISABLE_GPU_SANDBOX=1`.

## F7B status

**DONE (core two-device E2EE E2E), PARTIAL (negative key-change path).**

- Chromium и Firefox: **2 passed**; registration/prekeys, DIRECT E2EE-чат,
  A↔B send/decrypt, reload, R-15, safety number, envelopes-only DB, no plaintext
  в БД/WS/backend-логах.
- Найден и исправлен reload-дефект входящих local copies; +3 unit-теста.
- `npm run check` — 71 файл / 733 теста, build 415, EXIT 0.
- Base E2EE flag не включался; WebKit исключён по ADR-26; key-change negative
  не инсценировался и отмечен PARTIAL.

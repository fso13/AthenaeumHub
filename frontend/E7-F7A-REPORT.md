# E7-F7A — браузерная матрица WebCrypto + KAT (Chromium / Firefox / WebKit)

> **Зона:** только `frontend/**`. Не изменялись `backend/**`, `contracts/**`,
> `docs/**`, `design/**`, `src/api/schema.d.ts`, `src/config/env.ts`.
> `VITE_E2EE_ENABLED` остаётся **false**, backend `krug.e2ee.enabled=false`.
> Сетевых E2EE-вызовов и backend/Keycloak в тестах нет: поднимается только Vite.
>
> **Вход:** `docs/E2EE-TEST-VECTORS.json` (v4 + O-addendum),
> `docs/E2EE-SPEC.md` §1–§4, `frontend/E7-F6-REPORT.md`, `frontend/E7-F1-REPORT.md`
> (browser floor / R-07), `src/e2ee/**`, `playwright*.config.ts`.
>
> **Итог:** матрица реализована и прогнана в трёх реальных движках.
> Chromium 159 и Firefox 159 проходят feature detection, 22/22 KAT
> (128 проверок) и 10/10 негативных tamper-кейсов. Playwright WebKit 27.2
> поддерживает все примитивы и проходит 20/22 KAT, но **блокирован** на A2/B3:
> его WebCrypto Ed25519 подписывает недетерминированно (hedged nonce), а пустое
> сообщение подписывает и проверяет некорректно. Строгий байт-в-байт KAT не
> ослаблен; WebKit-строка помечена BLOCKED, а не skip. Статус F7A — **PARTIAL**.

## 1. Что сделано

1. `e2e/e2ee-browser.spec.ts` — gated (`E2EE_BROWSER_MATRIX=1`) Playwright-spec:
   - загружает приложение с Vite dev server;
   - динамически импортирует production-модули `src/e2ee/**`;
   - делает feature detection всех 8 примитивов (`random`, `sha256`, `sha512`,
     `hmacSha256`, `hkdfSha256`, `aesGcm256`, `x25519`, `ed25519`);
   - получает `docs/E2EE-TEST-VECTORS.json` **fetch-ем в браузере** (Playwright
     отдаёт файл через route fulfilment, копий значений в spec нет) и сверяет
     SHA-256 полученных байт с SHA-256 коммита;
   - прогоняет нормативные KAT A/B/C/D/F/G (22 вектора) и сравнивает байты;
   - прогоняет 10 негативных envelope/AEAD/preamble tamper-кейсов;
   - при отсутствии примитива падает с `E2EE_UNSUPPORTED_BROWSER` и
     evidence (UA, версия движка, `missing`), без JS/WASM-fallback;
   - отдельным диагностическим тестом классифицирует Ed25519-поведение движка,
     не ослабляя строгий KAT-gate.
2. `playwright.e2ee.config.ts` — три проекта (`chromium`, `firefox`, `webkit`),
   `workers: 1`, только Vite (`127.0.0.1:4175`), без backend/Keycloak.
3. `src/e2ee/test/browserKat.ts` — browser-safe KAT-runner (без `node:fs`),
   переиспользующий production-примитивы/кодеки; работает и в Node-тесте.
4. `src/e2ee/test/browserKat.test.ts` — Node/WebCrypto-страховка самого harness:
   22 KAT и 10 tamper-кейсов в `npm run check`.
5. `npm run test:e2e:e2ee` — гейт и запуск матрицы; описание browser floor — в
   `frontend/README.md`.

## 2. Как устроен источник векторов

`docs/E2EE-TEST-VECTORS.json` — единственный source of truth:

- spec не содержит ни одного ожидаемого значения;
- `page.route('**/__e2ee__/vectors.json')` отдаёт **сам файл** из `docs/`;
- страница делает `fetch('/__e2ee__/vectors.json', { cache: 'no-store' })`,
  парсит JSON и передаёт его в `runBrowserKat(file)`;
- SHA-256 и длина сравниваются с файлом на диске.

Evidence прогона: `bytes = 118817`,
`sha256 = 65aaac48b7a8ebd276ad66f689a1693ab869627c89cae134993f01c46da661f6`
(совпало во всех трёх движках). KAT-runner проверяет `meta.vector_set_version = 4`,
наличие и `normative`-флаг секций, counts `A=4, B=5, C=3, D=3, F=2, G=5`,
уникальность id и отсутствие «тихого skip» при пропавшем векторе.

## 3. Browser matrix

Playwright 1.65.1, macOS arm64, headless, Vite 7.3.8.

| Project  | Движок                          | Feature detection | KAT A/B/C/D/F/G                         | Negative tamper      | Итог        |
| -------- | ------------------------------- | ----------------- | --------------------------------------- | -------------------- | ----------- |
| chromium | Chrome for Testing 159.0.8154.6 | 8/8, `missing=[]` | **22/22**, 128 checks                   | **10/10**, 13 checks | **PASS**    |
| firefox  | Firefox 159.0                   | 8/8, `missing=[]` | **22/22**, 128 checks                   | **10/10**, 13 checks | **PASS**    |
| webkit   | WebKit 27.2 (Playwright build)  | 8/8, `missing=[]` | **20/22**, 121 checks; fail: `A2`, `B3` | **10/10**, 13 checks | **BLOCKED** |

Playwright-прогон: `11 passed, 1 failed`; единственный failed — строгий KAT в
WebKit. Chromium 4/4, Firefox 4/4, WebKit 3/4 (support, tamper и диагностика —
зелёные). Остальные 20 KAT-векторов WebKit проходит, включая B4 (проверка
подписи preamble), B5 (проверка identity binding), D2/D3 (AES-GCM), F1/F2
(байт-идентичный envelope JSON) и G1–G5.

## 4. Что именно сломано в WebKit (R-07 реализовался)

R-07 из `E7-F1-REPORT.md` («Ed25519 появился позже X25519») оказался не только
про наличие, но и про качество реализации WebCrypto Ed25519 в Playwright WebKit
27.2. Два независимых дефекта:

### 4.1. A2 — пустое сообщение (RFC 8032 TEST 1)

RFC 8032 TEST 1 подписывает **пустое** сообщение. В WebKit:

- `subtle.sign({name:'Ed25519'}, key, new Uint8Array(0))` возвращает 64 байта,
  которые **не проходят verify** даже публичным ключом этого же key pair;
- verify нормативной RFC-подписи над пустым сообщением возвращает `false`;
- две подписи одного и того же пустого сообщения различаются.

То есть у WebKit сломан именно empty-message путь и в sign, и в verify.
Протокол E2EE v1 никогда не подписывает пустые сообщения (SPK-сообщение 66 B,
preamble 323 B, IK-binding 88 B), поэтому на production-поведение это напрямую
не влияет, но нормативный KAT A2 пройти нельзя.

### 4.2. B3 — недетерминированная (hedged) подпись

Для непустого 66-байтового SPK-сообщения WebKit:

- генерирует подписи, которые **успешно проверяются** его же `verify` и
  Node 24 WebCrypto (кросс-проверка);
- но две подписи одного ключа/сообщения **различаются**;
- следовательно, подпись никогда не совпадёт байт-в-байт с RFC 8032-вектором.

Это не «невалидная подпись», а hedged/randomized nonce. Криптографически такие
подписи валидны (Ed25519 verify принимает их), но требование F7A — **byte
equality** с нормативным JSON — они нарушают. Ослаблять A2/B3 до «любая валидная
подпись» в этом срезе нельзя: это меняет смысл KAT и требует решения
владельца протокола/ADR и внешнего crypto-review (G4).

### 4.3. Что это значит для продукта

- WebKit 27.2 **не сертифицируется** этой матрицей как браузер с нормативным
  Ed25519. Строка BLOCKED; `npm run test:e2e:e2ee` на нём завершается exit 1
  (это осознанный gate, не флейк).
- Shipping Safari этой матрицей не проверялся: Playwright WebKit — отдельная
  сборка, а не shipping Safari. Перед объявлением Safari во floor нужно повторить тест
  на стабильном Safari/iOS и проверить, воспроизводится ли дефект.
- Если WebKit исправят, строгий KAT станет зелёным без изменения тестов. Если
  продуктово решат принять hedged-подписи, потребуется отдельный ADR/спека:
  KAT для подписей станет «verify нормативного вектора + verify свежей подписи»,
  а не byte equality; это **вне F7A** и не делалось.
- Остальные примитивы WebKit (X25519, HKDF, AES-GCM, SHA-256/512, HMAC,
  CSPRNG) и все проверки/расшифровки проходят, поэтому блокер локализован
  именно в Ed25519-подписи, а не во всём E2EE.

## 5. Feature detection и unsupported browser

- `detectE2eeSupport()` вызывается в браузере; User-Agent для решения о
  поддержке не используется.
- Если `available=false`, тест:
  - добавляет annotation `E2EE_UNSUPPORTED_BROWSER`;
  - прикладывает `webcrypto-support.json` (project, version, UA, primitives,
    missing);
  - падает с сообщением
    `E2EE_UNSUPPORTED_BROWSER: <project> <version> is missing WebCrypto primitives: ...`.
- JS/WASM-fallback отсутствует by design (E2EE-ADR-02).
- Проверка `E2EE_UNSUPPORTED_BROWSER` покрыта unit-тестом `support.test.ts`;
  в матрице ветка недоступна, потому что все три движка имеют все 8 примитивов.

## 6. Backend / Keycloak / feature flag

- `playwright.e2ee.config.ts` поднимает только `npm run dev` (Vite) на
  `127.0.0.1:4175`; `VITE_USE_MOCKS=true`, `VITE_AUTH_MODE=dev`,
  `VITE_DEV_SESSION=true`.
- Ни один тест не вызывает backend, Keycloak, `/devices`, `/keys`, `/messages`
  или WS.
- `VITE_E2EE_ENABLED` не включался и не переключался; default остаётся `false`.
  E2EE-модули импортируются напрямую, как библиотека, без UI-флага.
- Секретов/приватных ключей в тесте нет: используются только публичные
  test-векторы, у которых в JSON явно написано «public test material».

## 7. F7B — real two-device E2EE (явно вне scope)

F7A **не** проверяет сквозной E2EE между двумя устройствами и не симулирует его.
F7B должен закрыть минимум:

1. **Два реальных контекста/устройства:** два браузерных профиля (или два
   движка) с разными `device_id`, регистрацией через backend, claim prekey,
   отправкой envelope на peer-устройство и расшифровкой на другой стороне.
2. **Backend E2EE:** `krug.e2ee.enabled=true` (или тестовый backend-контур с
   `POST /devices`, prekeys, `POST /messages` envelopes, `GET /messages` crypto);
   без него two-device тест невозможен. Сейчас backend/flag — false.
3. **Session lifecycle:** X3DH handshake, Double Ratchet send/receive,
   simultaneous init (§5.7), crossed sends, in-flight loser envelope,
   reload/recovery, R-15 reset, late loser envelope после 5-минутного окна.
4. **Storage в реальном браузере:** IndexedDB durability, non-extractable
   `CryptoKey` после close/reopen, write staging/flush, Web Locks в фоне,
   kill-tab, quota, Safari flush. F7A этого не касается (KAT stateless).
5. **Auth/Keycloak и несколько аккаунтов** в одном профиле (P2-24), если
   двух устройств в одном аккаунте недостаточно.
6. **Safari/WebKit floor:** либо WebKit Ed25519 исправлен и строгий KAT зелёный,
   либо принято ADR-решение о hedged-подписях; до этого WebKit BLOCKED.
7. **Внешний crypto-review G4** и обновление `docs/E2EE-SPEC.md` §5.7 — условия
   включения флага, не F7A.

## 8. Проверки

- `cd frontend && npm run check` — **EXIT 0**:
  - lint — 0 errors, 2 pre-existing warnings в `CreateChatDialog.tsx`;
  - format:check / contract:check (52 operations, 85 schemas) / stickers:check — ok;
  - security:check — 238 files, без `console`/`Math.random`/network в `src/e2ee/**`;
  - session-writers:check — 161 production files, writers не расширены;
  - vitest — **70 files / 718 tests passed** (+2 теста `browserKat.test.ts`);
  - tsc --noEmit — clean; vite build — 414 modules.
- `npm run test:e2e:e2ee` (в этой среде — с `PLAYWRIGHT_BROWSERS_PATH`
  и sandbox-обходом для Firefox, см. Risks): **11 passed, 1 failed, EXIT 1**;
  Chromium 4/4, Firefox 4/4, WebKit 3/4; единственный failed — строгий KAT
  WebKit (by design).
- Gate off (`npx playwright test --config playwright.e2ee.config.ts` без
  `E2EE_BROWSER_MATRIX`): **12 skipped, EXIT 0**.
- `npm run test:e2e` (default config): e2ee-spec исключён, `--list` не содержит
  `e2ee-browser`.
- KAT: Chromium/Firefox 22/22 (128 checks), WebKit 20/22 (121 checks).
- Tamper: 10/10 (13 checks) во всех трёх.
- Docs hash: `65aaac48…` (118817 B) совпал во всех трёх.

## 9. Файлы

Новые:

- `src/e2ee/test/browserKat.ts` — browser-safe KAT + tamper runner;
- `src/e2ee/test/browserKat.test.ts` — Node-страховка harness (2 теста);
- `e2e/e2ee-browser.spec.ts` — Playwright matrix spec;
- `playwright.e2ee.config.ts` — 3 браузерных проекта, Vite-only;
- `frontend/E7-F7A-REPORT.md` — этот отчёт.

Изменены:

- `package.json` — `test:e2e:e2ee`;
- `tsconfig.json` — include нового config;
- `playwright.config.ts` — e2ee-spec исключён из обычного `test:e2e`;
- `README.md` — команда, матрица, browser floor.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`schema.d.ts`, `env.ts`, default флага, wire v1, `docs/E2EE-TEST-VECTORS.json`.

## 10. Risks / ограничения

1. **WebKit BLOCKED.** Главный риск: Playwright WebKit 27.2 не проходит
   нормативный Ed25519 KAT (недетерминированная подпись + пустое сообщение).
   Это может быть дефектом конкретной сборки Playwright, а не shipping Safari;
   нужна проверка на стабильном Safari/iOS. До этого WebKit не во floor.
2. **Матрица не заменяет два устройства.** F7A проверяет примитивы/кодеки в
   браузере, но не сессии, IndexedDB, сеть и UI. F7B обязателен.
3. **Дублирование логики KAT.** `browserKat.ts` повторяет stateless-проверки
   `vectors.test.ts` (22 вектора). Значения не дублируются (всё из JSON), но
   логика может разойтись; `browserKat.test.ts` в `npm run check` ловит поломку
   harness, а не изменение семантики. При правке `vectors.test.ts` нужно
   синхронно править runner.
4. **Attachments.** При `reporter: [['list']]` вложения (`webcrypto-support.json`,
   `kat-a-b-c-d-f-g.json`, `envelope-tamper.json`, `ed25519-behaviour.json`)
   не сохраняются на диск для зелёных тестов; они доступны в HTML/JSON reporter
   и в выводе failed-теста. Для CI-артефактов нужен reporter с outputDir.
5. **Vectors path.** Spec ищет `../docs/E2EE-TEST-VECTORS.json` от `cwd`
   (frontend), затем `docs/` и `../../docs/`. В CI нужен checkout с `docs/`
   рядом; иначе тест падает, а не skip-ается.
6. **Firefox в песочнице DSH.** Внешний sandbox запрещает `sandbox_init` самого
   Firefox; для прогона использовались `CFFIXED_USER_HOME` и
   `MOZ_DISABLE_CONTENT_SANDBOX=1`/`MOZ_DISABLE_GPU_SANDBOX=1`. Это артефакт
   среды, **не** требование проекта и не зашито в config/script. На обычной
   машине `npm run test:e2e:e2ee` работает без этих переменных.
7. **Нет performance/fuzz/DoS.** Матрица не измеряет скорость WebCrypto,
   большие ciphertext (33040 B), память, quota и поведение при kill-tab; это
   F7B/нагрузочные срезы.
8. **Нет Safari/Firefox-специфичных storage-тестов.** Non-extractable CryptoKey
   в IndexedDB, structured clone, Safari flush — не входят в F7A (stateless KAT).

## F7A status

**PARTIAL.**

- Реализовано: gated матрица, 3 проекта, feature detection, fetch+KAT из
  `docs/`, 22 вектора A/B/C/D/F/G, 10 tamper-кейсов, `E2EE_UNSUPPORTED_BROWSER`,
  Node-страховка harness, npm script, README/report, `npm run check` зелёный.
- Chromium 159 — **PASS**; Firefox 159 — **PASS**.
- WebKit 27.2 — **BLOCKED** по Ed25519 (A2/B3), с воспроизводимым evidence;
  остальные 20 KAT и все tamper-кейсы проходят.
- Real two-device E2EE не делался и не симулировался — это F7B.

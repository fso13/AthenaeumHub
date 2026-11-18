# E7-F1 — клиентское крипто-ядро E2EE 1:1 (отчёт по `docs/TASKS.md` §5)

> Зона: `frontend/**`. `docs/**`, `backend/**`, `contracts/**`, `design/**` и
> `frontend/src/api/schema.d.ts` не изменялись. Feature flag E2EE не включался,
> UI/сеть/E2E не добавлялись.

## Статус

**DONE в границах E7-F1.** Реализованы WebCrypto-примитивы с feature detection,
канонические кодеки envelope/AD/prekey-preamble/inner-payload, stateless KDF
(X3DH SK/SID, KDF_RK/KDF_CK, AEAD-параметры), safety number на пару устройств с QR
и verification hash v2, абстракция хранилища (IndexedDB + память) с
non-extractable `CryptoKey`, и типы/декодеры device keys/prekeys по контракту.
KAT проходит по всем **8 нормативным crypto-секциям** векторов v4 (24 вектора)
побайтово; F1/F2 envelope JSON сравнивается байт-в-байт.

Вне среза (как и требовалось): X3DH/DR **session state** и хранилище сессий (E7-F2),
TOFU/пиннинг, outbox/локальная копия, регистрация устройства и prekey upload (F3),
сетевые send/receive и handshake (F4/F5), safety-number UI (F6), Playwright/E2E (F7),
включение флага. `[BLOCKED]` нет: X25519/Ed25519 доступны в WebCrypto целевых
движков и в тестовом runtime (Node 24.20), fallback на WASM не понадобился.

## Сделано

- **Примитивы (`src/e2ee/crypto/*`):** X25519 (generate/import public+private,
  DH, вывод публичного ключа из seed через временный PKCS#8), Ed25519
  (generate/seed import/sign/verify), HKDF-SHA-256, AES-256-GCM, SHA-256/512,
  HMAC-SHA-256, CSPRNG. Приватные ключи — `extractable: false`; raw seed
  импортируется только через PKCS#8-обёртку, временный буфер обнуляется.
- **Feature detection (`crypto/support.ts`):** проба каждого примитива,
  кэш на `crypto`-объект, `E2EE_UNSUPPORTED_BROWSER` при нехватке; User-Agent не
  используется; JS/WASM-fallback отсутствует (E2EE-ADR-02).
- **Протокол (`src/e2ee/protocol/*`):** header 42 B, AD 163 B (смещения выводятся
  из длины домена), prekey preamble `313+L+M` (build/parse, подпись/проверка),
  SPK-подпись и `identity_binding_signature` (88 B), envelope-кодек: canonical
  b64u, точные длины 32/64/16, поколения 1..2^31-1, ciphertext 272..33040,
  form guard 65536 до decode, `additionalProperties:false` на всех уровнях,
  запрет self-envelope; inner payload framing (256-B padding, TEXT_JSON,
  1..8000 code points, C0/C1/bidi/`attachment_refs`/mentions).
- **Stateless KDF (`protocol/kdf.ts`, `protocol/x3dh.ts`):** `KDF_RK`, `KDF_CK`,
  `K_enc`/`N` из MK, X3DH `DH1..DH4 → IKM → SK → SID`. Сессий/состояния нет.
- **Verification (`src/e2ee/verification/*`):** fingerprint
  `SHA-256(D_FP||IK_sig||IK_dh)`, safety number на пару устройств
  (сортировка 64-байтовых записей, SHA-512, `mod 10^60`, 12×5 цифр), QR
  `krug://verify/v1`, VH v2 с `verifier_device_id`.
- **Storage (`src/e2ee/storage/*`):** интерфейс KV, IndexedDB-адаптер со всеми
  сторами (`keys/prekeys/sessions/outbox/localMessages/pins`) и in-memory адаптер
  для тестов; structured clone на чтении/записи; guard, запрещающий класть
  extractable private key; `KEY_STORAGE_UNAVAILABLE` без IndexedDB.
- **API (`src/e2ee/api/deviceKeys.ts`):** type-alias'ы `CryptoEnvelope`,
  `PrekeyBlock`, `PrekeyBundle`, `DeviceRegistration`, `DeviceKeyInfo` и
  декодеры b64u→bytes; сетевых вызовов нет.
- **Security guard:** в `scripts/check-security.mjs` добавлены scoped-правила для
  `src/e2ee/**` — запрет `console.*` и `Math.random` (плюс существующие запреты
  `localStorage`/`sessionStorage`).
- **README:** раздел «E7-F1 — крипто-ядро E2EE» с границами среза, командами и
  поддержкой браузеров.

## KAT

Векторы читаются напрямую из `docs/E2EE-TEST-VECTORS.json` (v4, 45 векторов,
17 секций), копий в frontend нет. `meta.vector_set_version === 4`, все id
уникальны; проверяются 8 нормативных crypto-секций — 24 вектора:

| Секция           | Векторы | Что сверено                                                                                           | Результат      |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| A-primitives     | A1–A4   | RFC 7748 §6.1, RFC 8032 §7.1, RFC 5869 TC1, NIST CAVP AES-256-GCM                                     | 4/4 byte-exact |
| B-x3dh           | B1–B5   | DH1..DH4/IKM/SK/SID (4-DH и 3-DH), SPK-подпись, preamble 323 B + sha256 + подпись, IK-binding 88 B    | 5/5 byte-exact |
| C-kdf            | C1–C3   | session-id, KDF_RK, три KDF_CK                                                                        | 3/3 byte-exact |
| D-aead           | D1–D3   | framing/padding 256, K_enc/N, ciphertext m1/m2 + расшифровка                                          | 3/3 byte-exact |
| E-double-ratchet | E1      | 4 сообщения, 2 DH-ratchet turn, AD/header/MK/ciphertext, расшифровка; публичные ratchet-ключи из seed | byte-exact     |
| E2-skipped-keys  | E2      | MK n=0..2, AD/ciphertext, доставка 0,2,1, сохранённый ключ n=1, состояние `Nr`/stored                 | byte-exact     |
| F-envelope       | F1–F2   | канонический JSON байт-в-байт (1310/756 B), preamble/AD/header/ciphertext/session_id из `decoded`     | 2/2 byte-exact |
| G-verification   | G1–G5   | fingerprint, safety number (digest/digits/display), QR, VH v2, два verifier-устройства                | 5/5 byte-exact |

E1/E2 требуют состояния, поэтому в `ratchet.test.ts` лежит **test-only** reference
walk (без сессионного модуля, персистенции и send/receive API). Он композирует
production-примитивы/кодеки и доказывает байты; F2 обязан переиспользовать
production AD/preamble/KDF, а не копировать walk.

Негативные/tamper-тесты (не входят в JSON, §8.4): non-canonical b64u (`=`, `+`,
4n+1, non-zero trailing bits), неизвестные поля на всех уровнях, `v=2`, self-envelope,
границы ciphertext 272/33040/form guard, partial prekey/opk, AD tamper,
ciphertext tamper, preamble tamper, неверный подписант; padding/body-length/
content-type/bidi/C0/C1/`attachment_refs`; `KEY_STORAGE_UNAVAILABLE`; отсутствие
WebCrypto; extractable private key в storage.

## Файлы

Новые (`frontend/src/e2ee/**`, ~2.9k строк production + ~2.6k тестов):

- `constants.ts`, `errors.ts`, `encoding/bytes.ts`, `encoding/base64url.ts`.
- `crypto/`: `support.ts`, `digest.ts`, `hkdf.ts`, `aead.ts`, `x25519.ts`,
  `ed25519.ts`, `random.ts`, `keyGuards.ts`, `bufferSource.ts`, `rawKeyBytes.ts`.
- `protocol/`: `guards.ts`, `header.ts`, `ad.ts`, `preamble.ts`, `signatures.ts`,
  `envelope.ts`, `payload.ts`, `kdf.ts`, `x3dh.ts`.
- `verification/`: `fingerprint.ts`, `safetyNumber.ts`, `verificationHash.ts`.
- `storage/`: `types.ts`, `memory.ts`, `indexedDb.ts`.
- `api/deviceKeys.ts`.
- Тесты: `vectors.test.ts` (24), `ratchet.test.ts` (4), `envelope.test.ts` (17),
  `payload.test.ts` (13), `safetyNumber.test.ts` (9), `storage.test.ts` (12),
  `storageUnavailable.test.ts` (4), `support.test.ts` (6), `api.test.ts` (5);
  loader `test/vectors.ts`.

Изменено:

- `frontend/package.json`, `frontend/package-lock.json` — devDependency
  `fake-indexeddb@^6.2.8` (только для теста IndexedDB-адаптера в jsdom).
- `frontend/scripts/check-security.mjs` — scoped-правила для `src/e2ee/**`.
- `frontend/README.md` — раздел E7-F1.
- `frontend/src/components/FilesChat.test.tsx` — **несвязанная стабилизация**:
  два `findByText` в pre-existing тесте retry получили `timeout: 4_000`; под
  полным прогоном (274 теста) тест флейкал по таймауту 1 s, изолированно зелёный.
  Продуктовый код не менялся.

Не изменялись: `backend/**`, `contracts/**`, `docs/**`, `design/**`,
`frontend/src/api/schema.d.ts`, `frontend/src/config/env.ts`.

## Проверки

```bash
cd frontend && npm run check
# EXIT 0: lint + format:check + contract:check + stickers:check + security:check
#   + vitest (32 files / 274 tests passed) + tsc --noEmit + vite build (331 modules)
# Contract check passed: 33 operations, 58 contract schemas (51 checked), types in sync
# Security check passed: 135 files, no XSS sinks, no localStorage, no token logs,
#   no E2EE console/Math.random

cd frontend && npx vitest run src/e2ee
# 9 files / 94 tests passed

cd frontend && npx tsc -p tsconfig.json --noEmit
# clean (strict, noUncheckedIndexedAccess)
```

`npm run check` выполнен дважды подряд после стабилизации — оба прогона зелёные.
Покрыто: 24 KAT-вектора (8 секций), envelope negative/tamper, payload boundaries,
safety-number/QR/VH свойства, memory+IndexedDB storage (CryptoKey
non-extractable), feature detection (включая отсутствие `crypto.subtle`), API
decoders. Все E2EE-тесты — чистые unit/KAT, без таймеров и сети.

## Контракт

| Что                            | Изменение | Зачем                                          |
| ------------------------------ | --------- | ---------------------------------------------- |
| `contracts/openapi.yaml`       | **нет**   | E2EE-схемы уже в I-01; F1 их только типизирует |
| `contracts/ws-protocol.md`     | **нет**   | вне среза                                      |
| `frontend/src/api/schema.d.ts` | **нет**   | не редактировался; `contract:check` in sync    |

Отклонений от контракта нет: wire-типы envelope повторяют `CryptoEnvelope`, но
клиент дополнительно строго валидирует canonical b64u/длины/поля.

## DDD

Frontend не использует DDD-слои; структура модуля по ответственности:

```
src/e2ee/
├── crypto/      примитивы и feature detection (нет протокольных знаний)
├── encoding/    байты/hex/base64url (canonical)
├── protocol/    wire-кодеки + stateless KDF
├── verification/ fingerprint/safety number/QR/VH
├── storage/     абстракция KV + IndexedDB/memory
├── api/         типы контракта и декодеры (без сети)
└── *.test.ts    KAT + негативные тесты; test/vectors.ts — loader
```

Зависимости направлены внутрь: `protocol → crypto/encoding`, `verification →
crypto/encoding`, `api → protocol`, `storage → crypto/keyGuards`. Обратных
импортов нет; UI/store/api-client модуль не импортируют.

## Риски и вопросы

- **Browser floor не зафиксирован этим срезом.** Runtime feature detection —
  источник истины; Ed25519: Firefox 129+, Safari 17+, Chrome 137+
  ([IPFS/Igalia, Aug 2025](https://blog.ipfs.tech/2025-08-ed25519/)), X25519
  детектируется отдельно. Точный floor и матрицу движков должен закрыть E7-F7
  (gate G2); до этого нельзя обещать поддержку в README продукта.
- **Вывод публичного ключа из seed** требует временного extractable-импорта
  (WebCrypto не принимает raw private). PKCS#8-буфер обнуляется, но JWK `d` —
  immutable-строка; это документированное «best-effort», не zeroize-гарантия
  (§3.4.5.1). Для генерации на устройстве используется `generateKey` с
  `extractable:false` и экспортом только public.
- **E1/E2 reference walk — тестовый.** Он не должен стать основой F2: сессии,
  skipped-key store, лимиты `MAX_SKIP`/`MAX_SKIPPED_TOTAL`/TTL, multi-tab locks,
  OPK/SPK-уничтожение и outbox/local copy — отдельная задача F2.
- **KAT зависит от пути к `docs/E2EE-TEST-VECTORS.json`.** Loader пробует
  `cwd`/`..`/`../..`; в CI frontend-джоба должна иметь docs рядом (репозиторный
  checkout). Это осознанный выбор «векторы — источник истины, без копий».
- **`fake-indexeddb` — новая devDependency.** Нужна для проверки реального
  IndexedDB-адаптера в jsdom; в production-бандл не попадает.
- **Внешний crypto-review (G4) ещё не пройден.** KAT ловят регрессии, но не
  ошибки дизайна; до G4 крипто-ядро нельзя считать готовым к включению E2EE.
- **Изменён один pre-existing тест** (`FilesChat.test.tsx`, timeout 4 s) из-за
  флейка под нагрузкой полного прогона; это не E7-F1-код и не продуктовое
  поведение, но требует внимания ревьюера.

## Что дальше

1. **E7-F2:** хранилище сессий/`K_storage`, outbox + локальная копия, Web Locks,
   уничтожение OPK/старых `DHs`/SPK (3/90), property-тест storage-scan.
2. **E7-F3:** регистрация устройства, `identity_binding_signature`, prekey
   upload/replenish; интеграция с `POST /devices` (без включения флага).
3. **E7-F4:** X3DH+DR handshake/send/receive на этих примитивах, TOFU-пиннинг,
   prekey↔bundle equality (P0-2b), fresh `DHs_A`; переиспользовать production
   `ad`/`preamble`/`kdf`/`x3dh`, не тестовый walk.
4. **E7-F7:** браузерная матрица (G2), векторы в CI, E2E двух устройств,
   tamper/crash-recovery; только после G4 — включение E2EE.

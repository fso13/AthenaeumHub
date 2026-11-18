# E7 — E2EE 1:1 milestone (spike → implementation)

> **Цель:** реализовать E2EE 1:1 без компромиссов: сервер не видит plaintext, клиент владеет ключами, multi-device и verification честные.  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §11, ADR-04/05/06, FR-SEC-2/4/5/6/9.  
> **Статус:** **G4c = GO WITH CONDITIONS; E7-F1 crypto core in progress; B3F3 hardening/regressions.**
> **Review 1:** [`docs/E2EE-REVIEW-01.md`](<E2EE-REVIEW-01.md>) — GO WITH CONDITIONS, 4 P0 + 12 P1.  
**Remediation:** [`docs/E2EE-S2-CHANGELOG.md`](<E2EE-S2-CHANGELOG.md>) — S2, 34 вектора, 189/0.  
**Review 2:** [`docs/E2EE-REVIEW-02.md`](<E2EE-REVIEW-02.md>) — GO WITH CONDITIONS; P0-2/P0-3 partial, 6 P1 partial.  
**Remediation 3:** [`docs/E2EE-S3-CHANGELOG.md`](<E2EE-S3-CHANGELOG.md>) — 43 вектора, 273/0, DDL smoke PG16.  
**Review 3:** [`docs/E2EE-REVIEW-03.md`](<E2EE-REVIEW-03.md>) — GO WITH CONDITIONS; P0 4/4 closed; P1-A/B/C/G partial.  
**Remediation 4:** [`docs/E2EE-S4-CHANGELOG.md`](<E2EE-S4-CHANGELOG.md>) — 45 векторов, 345/0, PG16 normal+degraded.  
**I-01:** applied in E7-B1 (28 paths / 33 ops / 58 schemas).  
**B1 report:** [`backend/E7-B1-REPORT.md`](<../backend/E7-B1-REPORT.md>).  
**Review 4:** [`docs/E2EE-REVIEW-04.md`](<E2EE-REVIEW-04.md>) — GO WITH CONDITIONS; P0 0, P1 6.  
**B1-fix:** [`backend/E7-B1-FIX-REPORT.md`](<../backend/E7-B1-FIX-REPORT.md>) — 300 tests, 6/6 P1.  
**G3b:** независимый reviewer не завершился; PM-targeted verification: 29/29 (`E2eeLimitsIT`, `E2eeRealtimeIT`, `E2eeClaimRateLimitIT`, `E2eeMigrationIT`, ArchUnit), полный B1F — 300/300.  
**B3/B4:** [`backend/E7-B3-B4-REPORT.md`](<../backend/E7-B3-B4-REPORT.md>) — 314 tests, E2EE send/history/WS, flag off.  
**Review 6 (G4):** [`docs/E2EE-REVIEW-06.md`](<E2EE-REVIEW-06.md>) — **NO-GO**: P0 percent-encoded path bypass, P1 payload-limit bypass, ciphertext floor.  
**B3F:** [`backend/E7-B3F-REPORT.md`](<../backend/E7-B3F-REPORT.md>) — 324 tests, P0/P1/P2 closed.  
**Review 7 (G4b):** [`docs/E2EE-REVIEW-07.md`](<E2EE-REVIEW-07.md>) — GO WITH CONDITIONS; P1-03 legacy envelope 500 on upgrade.  
**B3F2:** [`backend/E7-B3F2-REPORT.md`](<../backend/E7-B3F2-REPORT.md>) — 332 tests, legacy envelope quarantine/tolerant read.  
**Review 8 (G4c):** [`docs/E2EE-REVIEW-08.md`](<E2EE-REVIEW-08.md>) — GO WITH CONDITIONS; P1-03 closed, docs/test gaps.  
**B3F3:** DONE — 340 tests, P2-09/10/11/12 closed, V19 checksum note/V20 quarantine RLS.  
**E7-F2:** DONE — 362 tests (182 e2ee), atomic storage/outbox/locks.  
**E7-F3:** DONE — 471 tests, sealed pins, spkId, account cleanup; P1-03/04/05 closed.  
**E7-F2F:** DONE — 490 tests; CR1 P1-01/02/06/07 closed.  
**E7-CR1b:** DONE — GO WITH CONDITIONS; P1-01R/P1-03 open, P1-04/P1-07 partial, P2-02. F4 instructed.  
**E7-F2G:** после F4 — logout/user-scope/AAD normative/P2.  
**Review 2:** [`docs/E2EE-CLIENT-REVIEW-02.md`](<E2EE-CLIENT-REVIEW-02.md>).  
**E7-F4:** DONE — 527 tests; P1-01R/P1-03/P2-02 closed; PARTIAL R-15 reset + §5.7 winner deletion (F5).  
**E7-F2G:** DONE — 538 tests; P1-04/P1-07/P2-17/18 closed.  
**E7-CR1c:** DONE — GO WITH CONDITIONS; latent P1-01R-R (ns=0 nonce reuse), P1-04 residuals, SPK spec mismatch, R-15/§5.7 gaps.  
**E7-F5:** PARTIAL — 570 tests; wire-up/R-15/UI, 4 open: R-15 marker, SPK spec, per-account wipe, §5.7.  
**E7-F5F + CR1d:** в работе.  
**Review 3:** [`docs/E2EE-CLIENT-REVIEW-03.md`](<E2EE-CLIENT-REVIEW-03.md>).  
**E7-CR1:** DONE — GO WITH CONDITIONS; P0 0, 7 P1 (outbox sessionless, local-copy scope, SPK TTL, account scope, pins plaintext, locks, AAD).  
**E7-F1:** DONE — 94 E2EE tests, 274 total, KAT 24/24, WebCrypto primitives/envelope/safety number/storage.  
**E7-F2:** session storage/outbox/local copy/Web Locks — в работе.
**Артефакты:** [`docs/E2EE-SPEC.md`](<E2EE-SPEC.md>), [`docs/E2EE-TEST-VECTORS.json`](<E2EE-TEST-VECTORS.json>), [`docs/E2EE-SPIKE-NOTES.md`](<E2EE-SPIKE-NOTES.md>).

## 0. Правила

- E2EE нельзя «дописать на глаз»: сначала протокол, тест-векторы и ревью, затем реализация.
- Сервер не расшифровывает, не индексирует, не логирует контент и не хранит приватные ключи.
- Клиентские ключи — non-extractable CryptoKey/OS keychain; никаких ключей в localStorage/логах.
- Multi-device: до 5 устройств; каждое — отдельный ключевой набор; сервер хранит только публичные ключи и opaque envelopes.
- Группы/файлы/стикеры E2EE — следующие фазы; в E7 только 1:1.

## 1. E7-S — crypto spike (сначала)

**Владелец:** security/crypto-сессия  
**Выход:** `docs/E2EE-SPEC.md`, `docs/E2EE-TEST-VECTORS.json`, обновлённые ADR/вопросы.

### Scope

1. Протокол 1:1: identity keys, signed/one-time prekeys, X3DH-подобный handshake, Double Ratchet, AEAD, HKDF, подписи; точные параметры и порядок.
2. Multi-device: регистрация, fan-out конвертов, отзыв, key generation, поведение при смене ключа.
3. Wire format: `envelopes[]`, `header`, `ciphertext`, `epoch`/`key_generation`, лимиты размера; как сервер валидирует opaque bytes.
4. Storage: где публичные ключи/prekeys, как consume one-time, TTL, replenish; приватные — только клиент.
5. Verification: safety number/QR, что хранит сервер (hash metadata), UX предупреждений.
6. API delta: `POST /devices` (keys), `POST /keys/claim`, `GET /chats/{id}/keys`, `PUT /chats/{id}/keys/verification`, `POST /messages` envelopes; E2EE chat creation.
7. Test vectors: X25519/HKDF/DR/sender key (если применимо), envelope serialization, known-answer tests.
8. Угрозы/ограничения: нет PCS для sender keys, metadata, key loss, backup v1, key transparency v2; что не обещаем.
9. План реализации: backend/frontend задачи, оценки, порядок, что можно сделать без внешнего crypto-review (инфраструктура/контракты) и что нельзя.

### Вне scope spike

Production-код, изменение `backend/**`/`frontend/**`/`contracts/**`; только спека/векторы/ADR-предложения.

## 2. E7-B — backend (после spike)

- device keys/prekeys, claim, generation/revocation;
- E2EE chat/mode, envelopes storage/fan-out, no plaintext;
- key verification metadata;
- tests: opaque storage, no plaintext logs, device revoke, envelope fan-out;
- DDD; no server crypto.

## 3. E7-F — frontend (после spike)

- crypto core (WebCrypto/libsodium), X3DH/DR, key storage;
- device registration/prekeys, E2EE 1:1 send/receive, safety number;
- key-change warning, no plaintext analytics/search;
- test vectors + E2E two devices.

## 4. Acceptance (E2EE-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| E2EE-AC-01 | Device keys | публичные ключи/prekeys; приватные не уходят |
| E2EE-AC-02 | 1:1 send | envelope на каждое устройство; сервер не видит plaintext |
| E2EE-AC-03 | Decrypt | получатель расшифровывает; safety number |
| E2EE-AC-04 | Key change | предупреждение, verified сброшен |
| E2EE-AC-05 | Device revoke | сессии/WS/E2EE исключены; key_generation++ |
| E2EE-AC-06 | No server search/plugins | API не принимает/не индексирует plaintext |
| E2EE-AC-07 | Multi-device | каждое устройство получает свой envelope |
| E2EE-AC-08 | Logs/DB | нет plaintext/ключей |

## 5. Риски

- Крипто-ошибки не ловятся обычными тестами; нужен внешний review и known-answer vectors.
- Multi-device/ratchet state — источник потери сообщений.
- Потеря ключей = потеря истории до backup v1.
- Срок: spike 3–5 дней, реализация 3–4 недели; не обещать в один спринт.

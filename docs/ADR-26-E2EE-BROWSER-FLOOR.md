# ADR-26 — E2EE browser floor

- **Статус:** proposed; не включать флаг до G4.
- **Дата:** 2026-11-18.
- **Контекст:** E7-F7A прогнал строгие KAT в Chromium 159, Firefox 159 и WebKit 27.2 (Playwright).
- **Решение:** E2EE поддерживается в Chromium и Firefox. WebKit/Safari **не считается поддерживаемым** для E2EE, пока Ed25519 не проходит RFC 8032 A2/B3.
- **Причина:** WebKit 27.2 подписывает Ed25519 hedged/недетерминированно; A2 (empty message) даёт подпись, не совпадающую с RFC 8032, а verify нормативной подписи возвращает false. Строгий KAT не ослабляем.
- **Последствия:**
  - managed-режим работает в Safari;
  - E2EE UI в WebKit должен показывать `E2EE_UNSUPPORTED_BROWSER`/недоступность, без JS-fallback;
  - F7B two-device E2E выполнять в Chromium/Firefox; Safari — отдельный gate;
  - для включения E2EE нужен либо фикс WebKit, либо отдельное решение crypto-review о допустимости hedged Ed25519 (не рекомендуется без анализа).
- **Ссылки:** `frontend/E7-F7A-REPORT.md`, `docs/E2EE-SPEC.md` §2.4, `docs/E2EE-CLIENT-REVIEW-04.md`.

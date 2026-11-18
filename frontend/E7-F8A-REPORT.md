# E7-F8A — G4b P1-01 follow-up (sender superseded copy)

- **Статус:** DONE.
- **Причина:** G4b нашёл, что `markOutboxSuperseded` завершался на `stored.status === 'sent'`, поэтому после R-15 (`confirmSent` → `markSuperseded`) sealed outgoing copy оставалась `sent`. После reload A рендерил оригинал рядом с заменой.
- **Fix:** outbox-строка `sent` остаётся терминальной, но `updateLocalCopyStatus` переводит sealed copy в `superseded`. Для pending/failed строка тоже переходит в `superseded`; повторный вызов идемпотентен.
- **Test:** `outbox.test.ts` — `sent → superseded` + copy status; F7B добавляет reload A после R-15 и проверяет ровно один `markerA`/`markerR15`.
- **Evidence:** full frontend **756/756**, F7B Chromium+Firefox **2/2** (25.2 s) на финальном overlay image `sha256:7b3c182a…`, asset `index-BeQEVtf6.js`.
- **Base flags:** `.env`/base compose false; only test overlay true.
- **Остаётся:** negative key-change live, receiver R-15 v1.1, Safari/iOS app-level gate, clean-stack fixture, vectors v1.1, CI/checklist/git.

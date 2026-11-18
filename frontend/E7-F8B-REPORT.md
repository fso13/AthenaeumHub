# E7-F8B — G4c P1-01b/P2-15 follow-up

- **Статус:** DONE.
- **P1-01b:** `OutboxEntry.supersededAt` добавлен для строк, которые уже `sent`; `markOutboxSuperseded` проставляет timestamp, не ломая терминальный `sent`. `selectRetryWindow` исключает `supersededAt != null`, поэтому частично успешный batch больше не переотправляет уже заменённое сообщение. Regression: `resetRetry.test.ts` → partial batch даёт только `second`.
- **P2-15:** committed F7B reload-A теперь проверяет `markerA`, `markerLost`, `markerR15` ровно по одному.
- **Evidence:** full frontend **757/757**; F7B Chromium+Firefox **2/2** (16.4 s); overlay image `sha256:7bb3e54b…`.
- **Base flags:** false; overlay true only.

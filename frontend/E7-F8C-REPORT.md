# E7-F8C — G4d P1-01c/P1-05 follow-up

- **Статус:** DONE.
- **P1-01c:** anchor lookup теперь идёт по полному списку outbox (включая superseded) до фильтрации; partial batch с уже заменённым якорем находит окно, pending-сообщение не теряется.
- **P1-05:** добавлен durable `sendOrder`, назначаемый в `commitOutgoingMessage` по максимуму существующих записей; `selectRetryWindow` сортирует по нему, а не по per-chain `header.n`, который сбрасывается после ratchet.
- **Regression:** partial-batch test + cross-chain ordering covered by `sendOrder`; F7B A-reload `markerLost==1`.
- **Evidence:** full frontend **757/757**; F7B Chromium+Firefox **2/2** (16.6 s); overlay image `sha256:ccf7e985…`.
- **Base flags:** false; overlay true only.

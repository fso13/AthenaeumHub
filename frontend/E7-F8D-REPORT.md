# E7-F8D — committed cross-chain/partial-batch regression (G4e condition 1)

- **Статус:** DONE.
- `selectRetryWindowEntries` — pure anchor/order/supersede селектор; `selectRetryWindow` использует его.
- Committed test: durable `sendOrder` 1..4 при `createdAt` в обратном порядке; anchor second/third; superseded anchor; `maxBatch=2 → remaining=1`.
- P1-01c/P1-05 regression больше не держится только на ревьюерском harness.
- Evidence: full frontend **758/758**, F7B Chromium+Firefox **2/2** (16.5 s), overlay image `sha256:c16331a1…`.
- Base stack восстановлен: `KRUG_E2EE_ENABLED=false`.
- G4e: GO WITH CONDITIONS pilot-only; conditions 2–10 remain (clean-stack fixture, durable retry/drain, negative key-change, receiver R-15 v1.1, Safari/iOS, vectors, CI/git, legacy, rollout).

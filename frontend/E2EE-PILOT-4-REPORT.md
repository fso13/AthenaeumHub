# E2EE-PILOT-4 — receiver-side R-15 dedupe (v1.1)

- **Статус:** DONE.
- **Wire:** optional `retry_of_client_message_id` inside TEXT_JSON; normal v1 bodies unchanged; no framing/AD change; server never sees it.
- **Sender:** R-15 replacement carries original `client_message_id`; outbox already persisted it.
- **Receiver:** if marker points to an already-decrypted message, replacement is hidden as `superseded` (no UI duplicate/unread/notification); if original was failed/unavailable, replacement is shown and the failed row is hidden.
- **Vectors:** `vector_set_version=5`; canonical ciphertext 272..33040; D1 framing bytes unchanged.
- **Tests:** payload round-trip/validation; store dedupe; full frontend **869/869**.
- **Live:** F7B Chromium+Firefox **2/2**; F7A matrix **12/12** after v5.
- **Base flags:** false; overlay only for F7B. No backend/contracts changes.

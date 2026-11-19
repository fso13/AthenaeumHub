# Legacy E2EE outbox rows

Outbox records written before durable retry (#30) may lack two plaintext metadata fields:

| Field | Legacy behavior | Healed by |
|---|---|---|
| `sendOrder` | read as `0`; ordering falls back to `createdAt` + `clientMessageId` | new commits assign `max+1`; reconcile does not invent order |
| `supersededAt` | read as `null`; row may be `sent` while its local copy is `superseded` | `markOutboxSuperseded` / `reconcileOutbox` writes the timestamp |

Rules:

- No destructive migration: sealed payloads and idempotency keys are untouched.
- `readOutboxEntry` is fail-closed for malformed fields but accepts absent legacy fields.
- `retryOutboxEntry` never resurrects a row that has a replacement or is superseded.
- Reconcile is idempotent; a legacy row is upgraded on the next transition.
- Existing v1 bodies without `retry_of_client_message_id` remain valid; receiver dedupe applies only to v1.1 markers.

Tests: `frontend/src/e2ee/outbox.test.ts` (`legacy outbox rows`, sent→superseded, drain/reconcile).

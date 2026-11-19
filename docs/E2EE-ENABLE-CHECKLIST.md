# E2EE — production enable checklist

> **Issue:** [#35 CI/checklist/release](https://github.com/fso13/AthenaeumHub/issues/35) ·
> **Source of truth:** [`docs/E2EE-REVIEW-13.md`](E2EE-REVIEW-13.md) (2026-11-18) ·
> **Status of this document:** living checklist, last reviewed **2026-11-19**.
>
> **Current state: E2EE is OFF.** `KRUG_E2EE_ENABLED=false` in `deploy/.env.example`,
> in the base `deploy/docker-compose.yml`, and `ARG VITE_E2EE_ENABLED=false` in
> `frontend/Dockerfile`. The flag-on mode exists **only** as the disposable test
> overlay `deploy/docker-compose.e2ee-test.yml`.
>
> This checklist does not enable anything. It records what must be true, and which
> evidence must be attached, before a human flips the flag.
>
> _Path note:_ REVIEW-13 condition 8 names `deploy/E2EE-ENABLE-CHECKLIST.md`;
> per issue #35 the canonical location is `docs/E2EE-ENABLE-CHECKLIST.md`
> (deployment docs stay in `deploy/README.md`).

## 0. Non-negotiable rules

1. **Base stays false.** Never edit the base defaults to `true`, never ship a
   `deploy/.env` with `KRUG_E2EE_ENABLED=true`, never bake `VITE_E2EE_ENABLED=true`
   into a production SPA. CI enforces this with
   [`scripts/check-e2ee-base-flags.sh`](../scripts/check-e2ee-base-flags.sh).
2. **Overlay only.** The flag-on stack is
   `docker compose -f docker-compose.yml -f docker-compose.e2ee-test.yml`.
   It is a disposable stand: fixture users, no real data, destroyed after the run.
3. **Explicit GO.** Pilot and general enablement each need a recorded GO from the
   owner and the security reviewer. A green CI run is necessary, not sufficient.
4. **No secrets.** `deploy/.env` is gitignored; CI generates throwaway secrets
   in-job. No SMTP credentials, tokens or private keys in the repository.
5. **Chromium/Firefox first; Safari/iOS is a separate gate** (ADR-26 / condition 6).
6. **No E2EE means no E2EE.** Until the GO, `KRUG_E2EE_ENABLED` must remain `false`
   and the pilot must not receive real user content.

## 1. Gate status (REVIEW-13 conditions ↔ issues)

Review-13 has ten conditions. Issues #29–#37 map to conditions 2–10; #38 is the
enablement itself. Condition 1 is tracked outside that set.

| Gate | REVIEW-13 condition | Issue | Status (2026-11-19) | Evidence |
|---|---|---|---|---|
| 1 | Committed regression for P1-01c/P1-05 (cross-chain, `sendOrder`, `maxBatch`) | — (outside #29–#37) | **CLOSED in tree** — verify the mutation-check note in the closing issue | `frontend/src/e2ee/app/resetRetry.test.ts:175,254`; frontend 867 tests |
| 2 | Clean-stack F7B fixture (B via BFF/Mailpit, destructive opt-in) | [#29](https://github.com/fso13/AthenaeumHub/issues/29) | **OPEN** | REVIEW-13 P2-01/P2-02 |
| 3 | Durable retry/drain (no duplicate / silent loss after reload) | [#30](https://github.com/fso13/AthenaeumHub/issues/30) | **OPEN** | REVIEW-13 P2-16/P2-21 |
| 4 | Negative key-change/TOFU live + verified reset | [#31](https://github.com/fso13/AthenaeumHub/issues/31) | **CLOSED 2026-11-19** | closed issue #31 |
| 5 | Receiver R-15 v1.1 | [#32](https://github.com/fso13/AthenaeumHub/issues/32) | **DONE** | optional marker in TEXT; store dedupe |
| 6 | Safari/iOS + WebKit app-level UI | [#33](https://github.com/fso13/AthenaeumHub/issues/33) | **DONE** | runtime gate + `docs/E2EE-SAFARI-IOS.md` |
| 7 | Vectors v1.1 (`272..33040`, version 5) | [#34](https://github.com/fso13/AthenaeumHub/issues/34) | **DONE** | `vector_set_version=5` |
| 8 | Release CI/artifact, log-capture, full backend suite, this checklist, clean rebuild with digests | [#35](https://github.com/fso13/AthenaeumHub/issues/35) | **IN PROGRESS** — artifacts in tree; GitHub run + git tag pending | `.github/workflows/ci.yml`, `e2ee-gated.yml`, `scripts/release-check.sh`, `docs/E2EE-CI-REPORT.md` |
| 9 | Legacy/local state migration (`sendOrder`, `supersededAt`, `serverMessageId`) | [#36](https://github.com/fso13/AthenaeumHub/issues/36) | **DONE** | read fallback + heal + `docs/E2EE-LEGACY-OUTBOX.md` |
| 10 | Kill-switch/retention/rollout rehearsed | [#37](https://github.com/fso13/AthenaeumHub/issues/37) | **OPEN** | REVIEW-13 P2-09 |
| — | Enable the flag | [#38](https://github.com/fso13/AthenaeumHub/issues/38) | **BLOCKED** by #29–#37 | this checklist |

**Pilot gate (Chromium/Firefox only):** conditions 1–3 plus the release artifact
(item 8). **General flag-on gate:** all conditions 1–10. **Safari/iOS:** never
implicit — condition 6 must close on its own.

> REVIEW-13 verdict: pilot = GO WITH CONDITIONS; unconditional/base flag-on = **NO-GO**.

## 2. Preflight

Run from the repository root. Every box must be checked and linked.

- [ ] Release commit identified: `git rev-parse HEAD` = `________`; tag/bundle attached.
- [ ] CI green on that commit: `.github/workflows/ci.yml` run URL `________`.
- [ ] Frontend green: `npm run check` → 867 tests, lint/format/contract/security/build pass.
- [ ] Backend green: `mvn test` → 498 tests, ArchUnit 10/10.
- [ ] Contract unchanged or intentionally versioned: 48 paths / 56 operations / 88 schemas.
- [ ] `scripts/release-check.sh` passed; report attached (`release-*.md`) with image IDs and
      `Source: image:…` asset SHA-256.
- [ ] Base flags still false: `./scripts/check-e2ee-base-flags.sh` → exit 0.
- [ ] No secret files tracked: `.env`, `deploy/.env`, `*.pem`, `*.p12`, `*.key`.
- [ ] F7A matrix: Chromium/Firefox blocking green; WebKit expected-fail documented.
- [ ] F7B clean-stack 2/2 with `E2EE_REAL_RESET=0` on a clean fixture (#29).
- [ ] Log capture from F7B: zero plaintext/ciphertext markers in backend/frontend logs.
- [ ] Backup taken and **restore rehearsed** on a disposable stack (§3).
- [ ] V19/V20 verified on a copy of the target database (§4).
- [ ] Kill switch rehearsed on a canary (§6).
- [ ] GO record signed (§8).

## 3. Backup (before any flag change)

Server-side backup protects the opaque envelopes, metadata and Keycloak identity
data. It does **not** back up client keys: without a client backup (not in v1),
losing the device/profile loses the plaintext. Say this to pilot users.

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "backup/$STAMP"

# Application DB (owner/migrator role, logical dump).
docker exec krug-postgres pg_dump -U krug_migrator -d krug -Fc \
  > "backup/$STAMP/krug.dump"

# Keycloak DB (realm, users, clients).
docker exec krug-keycloak-postgres pg_dump -U keycloak -d keycloak -Fc \
  > "backup/$STAMP/keycloak.dump"

# Compose state, image IDs and config. deploy/.env contains secrets:
# copy it encrypted or omit it and re-enter secrets on restore.
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config \
  > "backup/$STAMP/compose.rendered.yml"
./scripts/release-check.sh --skip-frontend --skip-backend --out "backup/$STAMP"

# Optional: keep the exact images for rollback (no push).
docker image save -o "backup/$STAMP/images.tar" krug-backend:latest krug-frontend:latest
```

Restore rehearsal (disposable stack, never production):

```bash
docker exec -i krug-postgres pg_restore -U krug_migrator -d krug --clean --if-exists \
  < "backup/$STAMP/krug.dump"
docker exec -i krug-keycloak-postgres pg_restore -U keycloak -d keycloak --clean --if-exists \
  < "backup/$STAMP/keycloak.dump"
```

Checklist:

- [ ] Dumps created, sizes non-zero, `pg_restore --list` reads them.
- [ ] Restore on a disposable stack yields the same chats/messages/envelope counts.
- [ ] Backup copy stored outside the host; access restricted (contains metadata).
- [ ] Retention of the backup documented; no plaintext ever enters it (only ciphertext).

## 4. Migrations V19/V20 (preflight on a copy)

V19 and V20 are **forward-only** and already part of `V1–V20`.

| Migration | What it does | Risk / preflight |
|---|---|---|
| `V19__e2ee_legacy_envelope_quarantine.sql` | Copies legacy envelopes shorter than the canonical 272-byte floor into `message.message_envelopes_quarantine` (`legacy_short` / `legacy_out_of_range`), then deletes them and validates `ck_envelopes_ciphertext_min`. Lossless for valid rows. | Takes `NO FORCE RLS` on `message.message_envelopes`; needs a maintenance window and free disk. Check legacy row count first. |
| `V20__e2ee_envelope_quarantine_hardening.sql` | Enables RLS on the quarantine (no policy), revokes `PUBLIC`/`krug_app`, adds `message.purge_envelope_quarantine(retention_days)` and an index. | Verify `krug_app` cannot read the quarantine; retention scheduler flag off/on as intended. |

Preflight SQL (run as owner, read-only):

```sql
-- How many rows would V19 move?
SELECT count(*) AS legacy_short
FROM message.message_envelopes
WHERE octet_length(ciphertext) < 272;

-- Constraint and RLS state.
SELECT conname, convalidated
FROM pg_constraint
WHERE conname = 'ck_envelopes_ciphertext_min';

SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid IN ('message.message_envelopes'::regclass,
              'message.message_envelopes_quarantine'::regclass);

-- Runtime role must NOT be able to read quarantine rows.
SELECT has_table_privilege('krug_app',
         'message.message_envelopes_quarantine', 'SELECT') AS app_can_select;

-- Applied migrations.
SELECT version, description, success
FROM flyway_schema_history
ORDER BY installed_rank DESC
LIMIT 5;
```

- [ ] `legacy_short` on the target copy is known and acceptable (ideally 0).
- [ ] `convalidated = t` after V19; `relforcerowsecurity = t` on `message_envelopes`.
- [ ] `app_can_select = f` for the quarantine table.
- [ ] Disk/time estimate for V19 recorded; maintenance window agreed.
- [ ] Retention window for `purge_envelope_quarantine` matches policy (default 90 days).
- [ ] A restore point exists before migration (§3).

## 5. Observed metrics (acceptance)

Collect after the canary is up, before widening. Queries are read-only.

```sql
-- 1. No plaintext on E2EE messages.
SELECT count(*) AS bad_plaintext
FROM message.messages
WHERE crypto_scheme = 'E2EE_PAIRWISE'
  AND (body_ciphertext IS NOT NULL OR content_meta <> '{}'::jsonb);

-- 2. Envelope size stays inside the canonical floor/cap (272..33040 bytes).
SELECT count(*) AS bad_size
FROM message.message_envelopes
WHERE octet_length(ciphertext) < 272 OR octet_length(ciphertext) > 33040;

-- 3. Envelope scheme is the expected one.
SELECT scheme, count(*)
FROM message.message_envelopes
GROUP BY scheme;

-- 4. Quarantine is empty on a clean stand (or documented).
SELECT count(*) AS quarantine_rows
FROM message.message_envelopes_quarantine;
```

| Metric | Threshold | Evidence |
|---|---|---|
| Non-E2EE rows inside E2EE chats (`crypto_scheme='E2EE_PAIRWISE'` with plaintext/`content_meta`) | `0` | SQL 1 |
| Envelope size outside 272..33040 B | `0` | SQL 2; `ck_envelopes_ciphertext_min` validated |
| Plaintext/markers in backend + frontend logs and WS frames | `0` | F7B log-capture step |
| Quarantine rows on a clean stand | `0` (any >0 documented) | SQL 4 |
| E2EE REST/WS 5xx during canary | `0` for E2EE paths; no new 5xx class | access logs / dashboards |
| Managed-chat regression | parity with pre-canary (error rate, p95 latency) | dashboards |
| Stale WS replay | rejected with 409, `server_last_seq` does not go backwards | WS logs + SQL |
| Rate limits | active on E2EE claim/send paths | `429` in negative tests |

- [ ] SQL 1–4 results captured with timestamps and attached.
- [ ] Dashboards/log alerts cover E2EE 5xx, 409 rate, WS disconnect rate.
- [ ] No alert noise from expected negative-path errors (e.g. idempotency conflicts).
- [ ] Retention of envelopes/quarantine matches the stated policy (no silent deletion).

## 6. Rollout

The backend flag is **global per deployment** (`krug.e2ee.enabled`), not per
workspace. "E2EE-workspace pilot" therefore means a canary deployment plus
pilot users, not a UI-only toggle.

| Stage | What | Exit criterion |
|---|---|---|
| 0 | Base stack, flag `false` (current) | default state; no E2EE content |
| 1 | Disposable overlay: F7A matrix + F7B two-device (gated workflow) | 2/2 F7B on a clean stand; no markers in logs |
| 2 | Canary deployment, flag `true`, SPA rebuilt with `VITE_E2EE_ENABLED=true`; pilot users only; Chromium/Firefox only | conditions 1–3(+8) closed; metrics §5 green for the agreed soak (≥ 7 days proposed) |
| 3 | Wider flag-on (managed users unaffected; E2EE opt-in per workspace) | conditions 4–10 closed; #38 GO; rollback rehearsed |
| 4 | Safari/iOS | condition 6 closed independently |

Canary commands (never on production without a change window):

```bash
cd deploy
# keep the base .env, only the flag differs for the canary deployment
KRUG_E2EE_ENABLED=true docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.e2ee-test.yml up -d --build
```

> For a real production flag-on, use a separate canary stack/project name, not
> the test overlay. The overlay forces `VITE_E2EE_ENABLED=true` and is documented
> as test-only.

- [ ] Canary hostname/stack isolated from production data.
- [ ] Pilot user list and workspace list approved; Safari/iOS users excluded.
- [ ] Soak window and stop conditions agreed before enabling.
- [ ] On-call knows the kill switch (§7) and the rollback image digest.

## 7. Rollback and kill switch

**Kill switch = flip the backend flag off and rebuild the SPA with the flag off.**
Backend is runtime; the SPA flag is compile-time (`VITE_E2EE_ENABLED`), so an old
bundle can still show E2EE UI after only a backend flip — it will receive
`409 E2EE_DISABLED`, but rebuild for a clean UI.

```bash
# 1. Backend: runtime kill switch (no rebuild).
cd deploy
KRUG_E2EE_ENABLED=false docker compose --env-file .env up -d backend

# 2. SPA: rebuild with the flag off and restart nginx.
KRUG_E2EE_ENABLED=false docker compose --env-file .env up -d --build frontend

# 3. Verify.
curl -fsS http://localhost:8088/healthz
./scripts/check-e2ee-base-flags.sh
```

Expected flag-off behaviour (rehearse, do not assume):

- [ ] E2EE REST endpoints answer `409 E2EE_DISABLED` before parsing the body.
- [ ] E2EE WS history/replay path is disabled; managed messages still flow.
- [ ] `server_last_seq`/seq numbering does not go backwards for existing chats.
- [ ] SPA bundle no longer offers E2EE setup (rebuilt); stale bundles get 409.
- [ ] Envelopes are **not** deleted; re-enabling restores reads for devices that
      still hold keys.
- [ ] Retention/quarantine jobs keep running as configured.
- [ ] Rollback to the previous image digest (from `scripts/release-check.sh`)
      restores service if the canary itself is faulty.

If the failure is data-level, restore from §3 in a maintenance window; V19/V20 are
forward-only, so a DB restore also restores the schema version — roll back the
application image to match.

## 8. GO record (to be filled by the approver)

```text
Decision:        E2EE pilot / general flag-on (circle one)
Scope:           Chromium + Firefox; users: ______; workspaces: ______
Commit / tag:    ____________________
CI run:          ____________________
release-check:   ____________________ (report path + image digest + asset SHA-256)
F7A:             Chromium/Firefox __/__ ; WebKit: expected-fail / pass
F7B:             __/__ clean stack; log-capture clean: yes/no
Conditions:      1–3 (+8) / 1–10 closed — links: ____________________
Backup:          taken ____ ; restore rehearsed yes/no
Kill switch:     rehearsed yes/no ; owner: ______
Approved by:     ____________________  Date: __________
Security review: ____________________  Date: __________
```

## 9. References

- [`docs/E2EE-REVIEW-13.md`](E2EE-REVIEW-13.md) — verdict and conditions 1–10.
- [`docs/E2EE-SPEC.md`](E2EE-SPEC.md) — envelope/wire/spec, §3.5.1/§5.5 for R-15.
- [`docs/ADR-26-E2EE-BROWSER-FLOOR.md`](ADR-26-E2EE-BROWSER-FLOOR.md) — browser floor.
- [`docs/E2EE-CI-REPORT.md`](E2EE-CI-REPORT.md) — CI/checklist/release evidence.
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — blocking CI.
- [`.github/workflows/e2ee-gated.yml`](../.github/workflows/e2ee-gated.yml) — manual/label F7A/F7B.
- [`scripts/release-check.sh`](../scripts/release-check.sh) — rebuild + digest capture.
- [`deploy/docker-compose.e2ee-test.yml`](../deploy/docker-compose.e2ee-test.yml) — test-only overlay.

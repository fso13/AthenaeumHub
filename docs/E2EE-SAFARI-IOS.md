# Safari / iOS gate (E2EE)

E2EE is **not certified** in WebKit. This is enforced in the product, not only documented.

## Runtime gate

- `detectE2eeSupport()` runs an RFC 8032 Ed25519 known-answer test in addition to primitive detection.
- WebKit 27.2 fails A2/B3 (hedged/non-deterministic Ed25519); `ed25519` is marked unavailable.
- `requireE2eeSupport()` runs before keyed device registration; the bridge fails closed with `E2EE_UNSUPPORTED_BROWSER`.
- UI renders the honest unsupported banner and does not start E2EE; managed chat remains available.
- ADR: `docs/ADR-26-E2EE-BROWSER-FLOOR.md`.

## Supported matrix

| Browser | E2EE |
|---|---|
| Chromium (F7A/F7B) | certified for pilot |
| Firefox (F7A/F7B) | certified for pilot |
| Safari / WebKit | **blocked** until RFC 8032 fix or separate crypto-review |
| iOS WebView | not certified; same runtime gate |

## Manual check (Safari/iOS)

1. Open Pickle over HTTPS with `VITE_E2EE_ENABLED=true`.
2. E2EE settings/banner must say the browser is unsupported.
3. No E2EE compose/device registration; no plaintext fallback.
4. Managed chats still send/receive.
5. Verify `E2EE_UNSUPPORTED_BROWSER` in diagnostics; no key material in logs.

This gate is a **pilot** requirement; general enablement still needs G4 conditions.

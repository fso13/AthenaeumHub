# Media previews in messages — frontend report

**Date:** 2026-11-17
**Status:** **PARTIAL** — media-preview scope is implemented and all media tests are green; the aggregate `npm run check` is red only at `contract:check` because the contract is being expanded concurrently by the auth/BFF slice (see “Environment blocker”).
**Scope:** `frontend/**` only. `backend/**`, `contracts/**`, `docs/**`, `design/**`, `src/api/schema.d.ts`, `src/auth/**`, `src/components/auth/**` were not modified.

## What was done

### Images

- Kept the existing 48×48 raster thumbnail, now wrapped in a real `<button>`.
- Click / Enter / Space opens a lightbox (`MediaLightbox.tsx`):
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (filename) and `aria-describedby` (keyboard hint);
  - `<img>` with the mandatory `alt` (`Превью файла {name}`), `referrerPolicy="no-referrer"`;
  - close button, `Esc`, backdrop click;
  - manual focus trap (Tab/Shift+Tab), initial focus on “Закрыть просмотр”, focus return to the thumbnail;
  - download button inside the dialog with busy state and the same download error surface.
- Only `isSafePreviewImage` decides thumbnail/lightbox rendering. The helper is now an explicit raster allowlist (`PNG/JPEG/WebP/GIF/AVIF/BMP`), so SVG, `image/svg`, HTML and unknown subtypes never reach `<img>`.

### Video

- `CLEAN` + allowlisted MIME (`video/mp4`, `video/webm`, `video/ogg`) → inline:
  `<video controls preload="metadata" playsInline>` with the presigned URL.
- No `poster`, no `autoplay`, no iframe/external player. The card keeps its download/open button.

### Audio

- `CLEAN` + allowlisted MIME (`audio/mpeg|mp3|ogg|wav|x-wav|wave|webm|mp4|x-m4a|aac|flac`) → inline
  `<audio controls preload="metadata">`; filename, size, type and scan badge stay visible in the card body.

### Scan, URL and fallback states

- Presigned `GET /attachments/{id}/download-url` is requested **only** when `scan_status === CLEAN` and the type is previewable.
- `PENDING` / `INFECTED`: no URL request, no `<img>/<video>/<audio>`, no player, disabled download button, visible status note; `INFECTED` keeps the alert icon and quarantine wording.
- `FAILED` / `SKIPPED`: no preview, visible note, download remains a server decision.
- Preview fetch errors (409 `SCAN_PENDING`, 423 `ATTACHMENT_QUARANTINED`, 410 `ATTACHMENT_DELETED`, 5xx/network) render a translated `role="alert"` with details and:
  - “Обновить ссылку” for retryable/409 cases (`filesStore.invalidateDownloadUrl` drops the cached link first);
  - “Скачать файл” fallback always.
- Media element `error` (expired/blocked URL) switches to the same alert with retry/download; a broken lightbox image closes the dialog and leaves the card retry path.
- `ATTACHMENT_DOWNLOAD` errors keep the pre-existing `ErrorDetails` disclosure (`code`, `request_id`, status).

### i18n, responsive, dark, motion

- All new strings go through `src/i18n/ru.ts` (typed keys), no hardcoded UI text.
- CSS: responsive video height (320px → 220px on ≤640px), full-width players, lightbox capped at `92dvh`/`96dvh`, existing light/dark tokens.
- Lightbox explicitly resets `color: var(--ink)` because it is nested inside an outgoing bubble (`--bubble-out-ink` would otherwise fail contrast in light theme).
- No new animation; `prefers-reduced-motion` remains respected by the app-wide rules.

## Files

**Production**

- `src/components/AttachmentCard.tsx` — media fetch/gating, image thumbnail, inline players, retry/download states.
- `src/components/MediaLightbox.tsx` — new accessible image dialog.
- `src/files/format.ts` — raster/audio/video allowlists, MIME normalization (`; charset`, case), `isSafePreviewImage` tighten.
- `src/store/filesStore.ts` — `invalidateDownloadUrl(attachmentId)` for expired/failed media links.
- `src/i18n/ru.ts` — media/lightbox/scan strings.
- `src/styles/app.css` — card players, error actions, lightbox, mobile layout.
- `src/mocks/handlers.ts` — mock “presigned MinIO” endpoint serving uploaded bytes for media MIME types only (so browser/E2E previews work without S3; non-media → 404).

**Tests / docs**

- `src/components/MediaPreview.test.tsx` — new, 6 tests.
- `src/files/format.test.ts` — allowlists, SVG/HTML rejection.
- `src/store/filesStore.test.ts` — cache invalidation re-issues the URL.
- `e2e/media.spec.ts` — new mock Playwright scenario.
- `README.md` — files flow, security note, test/E2E list.
- `MEDIA-PREVIEW-REPORT.md` — this report.

## Tests

Verified in `frontend/`:

| Command                                                   | Result                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run lint`                                            | ✅                                                                    |
| `npm run format:check`                                    | ✅                                                                    |
| `npm run security:check`                                  | ✅ 199 files, no XSS sinks / localStorage / token logs / E2EE network |
| `npm run stickers:check`                                  | ✅                                                                    |
| `npm run session-writers:check`                           | ✅                                                                    |
| `npm test`                                                | ✅ **57 files / 603 tests passed** (incl. 6 new media tests)          |
| `npm run build`                                           | ✅ (only the pre-existing >500 kB chunk warning)                      |
| `npx playwright test e2e/media.spec.ts e2e/files.spec.ts` | ✅ **3 passed** (1 media + 2 files), Chromium, mock contour           |
| `npm run contract:check`                                  | ❌ concurrent auth/BFF contract expansion (see below)                 |

`npm run check` stops at `contract:check`, therefore the full chain was executed step-by-step; every step after contract was run separately and passed.

Media test coverage:

- image thumbnail → lightbox; `role=dialog`, `aria-modal`, alt, close label, Esc, backdrop, focus return, Tab/Shift+Tab trap, download from dialog;
- video `<video>` with `controls`, `preload=metadata`, `playsinline`, no `autoplay`, no `poster`, presigned `src`;
- audio `<audio>` with controls + filename/size/type;
- SVG + HTML attachments: card only, zero `img/video/audio` in attachment cards, zero download-url requests;
- `PENDING` + `INFECTED`: no media, no URL, disabled download, status notes;
- 409 preview failure → alert + “Обновить ссылку” → fresh URL loads; media `error` → retry/download fallback and a second URL request;
- Playwright: real browser lightbox open/Esc/focus return/backdrop, axe WCAG 2.1 AA in **light and dark** themes.

## Environment blocker (why PARTIAL)

`contracts/openapi.yaml` now contains **34 paths / 68 schemas** (auth/BFF endpoints `/auth/register`, `/verify-email`, `/login`, `/refresh`, `/logout`, …), while `scripts/check-contract.mjs` still asserts **28 paths / 58 schemas** and `src/api/schema.d.ts` is stale. This is the expected parallel auth work, not a media change; `contract:check` was re-run and still reports:

```
- src/api/schema.d.ts is out of date. Run `npm run api:types` and commit the result.
- Contract must expose exactly 28 paths (E6 + I-01)
- Contract must expose exactly 58 schemas (E6 + I-01)
```

Per the task, `schema.d.ts`/`contracts/**` were not edited. Once the auth/BFF slice regenerates the schema and updates the contract-check counts, `npm run check` should go green without any media changes.

## Risks / known debt

1. **Real playback not smoke-tested.** Backend E4-B/MinIO are absent in this copy; the mock serves the uploaded bytes without HTTP `Range`. Range-based seeking of real MP4 and `preload="metadata"` only-work-on-MinIO are therefore not verified end-to-end.
2. **URL renewal is reactive, not proactive.** A link is refreshed only after a media error or an explicit retry. A video/audio session that outlives the 5-minute presigned TTL will surface the retry/download alert instead of silently renewing (auto-renew would restart playback and is worse UX without a server-side stream token).
3. **Native player UI.** `<video>/<audio>` controls are browser-native; styling, keyboard behaviour and codec support vary by browser. No external players/iframes were added.
4. **Conservative codec allowlists.** `video/quicktime`, some `audio/*` codec variants and image formats such as TIFF/HEIC are intentionally not previewed; they remain normal downloadable files.
5. **No thumbnails/transcoding.** The full image/audio/video object is fetched (video is metadata-preloaded), so first paint of a large video depends on MinIO/Range and network speed. This is explicitly out of scope.
6. **jsdom does not decode media.** RTL asserts elements/attributes/URLs and state transitions; actual decoding/playback is covered only for the image lightbox in Playwright.
7. **Mock-only media endpoint.** `src/mocks/handlers.ts` gained a `localhost:9002/krug/:id` object stub. It serves only `image/*|video/*|audio/*` uploaded bytes and 404s everything else; production is untouched.
8. **Focus trap duplicated.** The lightbox has its own small focus-trap implementation (same pattern as the preferences/safety dialogs); extracting a shared dialog primitive is a reasonable follow-up.
9. **Forced-colors / high-contrast** is not separately tested for the lightbox; axe light/dark passes.

## Out of scope (unchanged)

E2EE files, transcoding, server thumbnails, CDN, E2EE file UI, backend/contract changes, auth/BFF changes, external players/iframes, `dangerouslySetInnerHTML`. `AttachmentCard` has no dependency on `src/auth/**`.

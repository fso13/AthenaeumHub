# #107 frontend — call controls + room media mode + profile accordion

**Status: DONE**

Scope: `frontend/**` only. No E2EE, no fake SFU — rooms and calls keep using the
existing `CallController` mesh over `call.signal`.

## 1. Call controls (1:1, GROUP mesh and rooms)

All controls are rendered only for a connected call and work for video and
audio-only calls alike (`CallLayer`).

- **Output volume 0..100** — a labelled range input (`Громкость звука`) applied
  to the 1:1 remote `<video>` and to every remote mesh tile. The value is
  persisted per browser/device in `localStorage` under
  `krug.calls.output.volume` (never a token, never sent to the server).
  Storage is isolated in `src/prefs/devicePreferences.ts`, which is the only new
  module allowlisted by `scripts/check-security.mjs`; malformed/quota/private-mode
  storage falls back to an in-memory value.
- **Output mute** — a separate button (`Выключить звук` / `Включить звук`,
  `aria-pressed`) independent of the microphone mute. It is session-local; the
  persisted value is only the volume.
- **Output device** — when the browser exposes both
  `navigator.mediaDevices.selectAudioOutput()` and
  `HTMLMediaElement.setSinkId()`, the UI shows `Устройство вывода`; the browser
  picker result is applied to every remote media element and the selected label
  is displayed. When either API is missing, the UI shows an honest
  `Системный звук` fallback with the explanation that the browser does not
  support output selection — no fake device list is rendered.
- **Microphone check** — an optional `Проверить микрофон` toggle feeds the local
  microphone stream through a real `AnalyserNode` (`useMicLevel`) and shows a
  `role="meter"` level in dBFS mapped 0..100. It is hidden when `AudioContext`
  is unavailable; no random/fake animation exists. The meter reports 0 when the
  microphone is muted.
- **Audio-only group fix** — remote mesh tiles now always render their media
  element even when the call has `video=false` (previously audio-only group
  calls had no element to play the remote audio). Video stays visually hidden
  and the avatar/initials tile is shown, so there are no black video tiles.
- **A11y/mobile** — native range keyboard support, explicit labels/titles,
  `aria-pressed` on toggles, live error `role="alert"`, focus-safe existing
  call dialog, responsive wrap/stack rules in `app.css` and safe-area padding.

## 2. Room audio/video (`media_mode`)

The contract now carries `Room.media_mode` (`AUDIO` | `VIDEO`); the frontend
consumes the current #107 contract (create optional field, partial PATCH).

- **Create** — the dialog has an explicit `Аудио` / `Видео` selector and sends
  `media_mode` with the name. Missing server value falls back to `VIDEO`.
- **Join** — `RoomsStore` reads the server mode and starts
  `CallController.startConference(..., video = mode === 'VIDEO', roomId)`.
  AUDIO rooms never request a camera (`getUserMedia({video:false})`); VIDEO
  rooms keep the previous behaviour. The room lobby preview also avoids asking
  for a camera in an AUDIO room.
- **Card chip** — every room card shows `Аудио` or `Видео` (with the matching
  speaker/video icon) from the server projection.
- **Change mode** — creator/workspace OWNER/ADMIN sees
  `Сделать аудио` / `Сделать видео`; it is a partial
  `PATCH {media_mode}` and the card updates from the server response, never
  optimistically. Members do not see the control, and a forbidden response
  keeps the old chip.
- **MSW** — room records, list projection, POST and PATCH now model
  `media_mode`; fixtures cover one VIDEO room (`Планёрка`) and one AUDIO room
  (`Дизайн-ревью`).

## 3. Profile accordion

`ProfileDialog` now renders the sections as six independent collapsible blocks
with real button headers:

1. `Аватар` — **first and open by default**
2. `Двухфакторная аутентификация` (status chip in the header)
3. `Устройства` — closed by default
4. `Активные сессии` — closed by default
5. `Уведомления`
6. `Блокировки`

- Triggers use `aria-expanded` + `aria-controls`; the panel is a labelled
  `role="region"` and is `hidden` while collapsed (no focusable ghost controls).
- Open state persists for the duration of one profile open; closing the dialog
  resets the defaults (avatar open, everything else collapsed).
- `TwoFactorCard` and `BlockedUsersCard` gained an `embedded` rendering mode so
  the accordion owns the only heading. The duplicate hero `Аватар` button and
  the standalone notifications card were removed; each control now has exactly
  one entry point (verified by a test).
- About/Contacts and the theme selector remain unchanged; the obsolete
  duplicated “Безопасность” summary card was removed.

## 4. Tests and verification

- `npm run check` — **passed** (lint, prettier, contract, stickers, security,
  session-writers, Vitest, `tsc --noEmit`, Vite production build).
- **144 test files / 1437 tests passed** (baseline 1416 + 21 new), including:
  - call output volume persistence/mute/device-picker/fallback/mic-meter tests;
  - audio-only mesh media/avatar test;
  - room create AUDIO, join `video=false`, chip, mode-change permission and
    PATCH tests, room-media fallback unit test;
  - profile accordion defaults/order, expand/collapse, state persistence,
    no-duplicate-controls and axe tests.
- Existing profile tests were updated to expand the now-collapsed sections
  before asserting their content (intentional UX change).

### Files (main)

- `src/components/CallLayer.tsx`, `src/calls/mediaOutput.ts`,
  `src/hooks/useMicLevel.ts`, `src/prefs/devicePreferences.ts`,
  `src/components/Icons.tsx`, `src/styles/app.css`
- `src/rooms/roomsStore.ts`, `src/store/chatStore.ts`,
  `src/components/pages/RoomsPage.tsx`, `src/mocks/db.ts`,
  `src/mocks/handlers.ts`
- `src/components/ProfileDialog.tsx`,
  `src/components/profile/ProfileAccordionSection.tsx`,
  `src/components/profile/TwoFactorCard.tsx`,
  `src/components/BlockedUsersCard.tsx`
- tests: `src/components/Calls.test.tsx`,
  `src/components/pages/RoomsPage.test.tsx`, `src/components/Profile.test.tsx`,
  `src/prefs/devicePreferences.test.ts` (+ updated profile/2FA/blocked suites)
- `scripts/check-security.mjs` (volume preference allowlist)

## Honest limitations

- Output-device selection is browser-picker based; it is not persisted (device
  ids rotate and may be permission-scoped). Volume is persisted.
- The microphone meter depends on Web Audio `AnalyserNode`; the control is
  hidden rather than simulated when unavailable.
- No E2EE, recording, SFU, or server-side media state was added. Room mode is
  metadata only and only changes the `video` flag of the existing mesh signalling.

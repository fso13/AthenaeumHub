# Media previews in messages

**Status:** DONE — 625 frontend tests, Playwright/axe green; live MinIO image preview verified.

> **Цель:** изображения, видео и аудио во вложениях можно просматривать прямо в чате, без скачивания и внешних вкладок. Managed-файлы; E2EE-файлы вне scope.

## Scope

- `AttachmentCard` + `files/format`:
  - image: превью + lightbox (focus trap, Esc, backdrop, download, alt);
  - video: inline `<video controls preload="metadata" playsInline>`;
  - audio: inline `<audio controls preload="metadata">` + name/size;
  - download fallback для PDF/прочих.
- Presigned URL только для `scan_status=CLEAN`; 409/423/410 — понятные состояния.
- SVG/HTML никогда не рендерятся как медиа; allowlist MIME.
- CSP `media-src`/`img-src` уже включает `S3_PUBLIC_ENDPOINT`.
- i18n RU, responsive CSS, dark theme, reduced motion.
- Tests: RTL image/video/audio, no SVG, scan/quarantine, lightbox keyboard/axe; Playwright mock.
- No contract/backend changes; MinIO Range works through presigned URL.

## Acceptance

1. PNG/JPEG/WebP — превью, клик → lightbox, Esc закрывает, download.
2. MP4/WebM — inline player, controls, no autoplay.
3. MP3/OGG/WAV — inline audio controls.
4. SVG/HTML — только файл-карточка, без `<img>`/`<video>`.
5. PENDING/INFECTED — нет URL/плеера, статус и запрет.
6. a11y: alt, labels, focus return, no keyboard trap.

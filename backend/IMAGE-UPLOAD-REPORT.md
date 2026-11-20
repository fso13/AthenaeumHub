# #92 — device image uploads for avatars, channel covers/avatars and workspace logos

**Verdict: DONE (backend + contract + generated types; UI wiring is outside this session's zone).**

This slice adds one narrow, trusted endpoint — `POST /media/images` — that accepts a static
PNG/JPEG/WebP uploaded from the device, validates it by magic bytes and header only, stores
the original bytes in the private object bucket and creates a managed attachment owned by
the caller. Existing avatar/cover/logo APIs accept that attachment without weakening their
gate for arbitrary uploads: the new row is `READY` + `SCAN_STATUS=SKIPPED` with an explicit
`source=DIRECT_IMAGE`, while every regular upload keeps its `PENDING`/AV path and
`source=UPLOAD`. No existing RLS policy, grant or validation rule was relaxed.

## 1. Contract and generated types

`contracts/openapi.yaml` is additive:

| Operation | Semantics |
|---|---|
| `POST /media/images` | `multipart/form-data` part `file` (required) + optional `chat_id`. Auth + `X-Device-Id`. `201` → `UploadedImage` `{file_id,width,height,mime,size}`. `400` malformed/missing file or unsafe filename; `401` unauthenticated; `403` no active workspace; `404` unknown/foreign chat (hidden); `413 FILE_TOO_LARGE` > 5 MiB; `415 UNSUPPORTED_TYPE` (SVG/GIF/unknown magic); `422 IMAGE_INVALID` (truncated/animated/extension mismatch) and `422 E2EE_PLAINTEXT_FORBIDDEN` for an E2EE chat binding. |

`UploadedImage` is a new component schema: `file_id` uuid, `width`/`height` 1..16384,
`mime` enum `image/png|image/jpeg|image/webp`, `size` 1..5242880. It deliberately contains
no filename, object key, SHA-256, EXIF or any other source metadata.

The avatar/cover/chat-avatar/workspace-logo descriptions now point at
`POST /media/images` as the device-upload path while keeping the existing attachment
validation wording. `frontend/src/api/schema.d.ts` was regenerated with
`npm run api:types`; `npm run contract:check` passes (136 operations / 176 contract schemas,
generated types in sync) and `npx tsc -p tsconfig.json --noEmit` passes. The spec currently
exposes **105 paths / 137 operations / 176 schemas** (the contract guard's operation list is
the fixed 136-entry frontend subset; the new operation is intentionally not added to that
list because frontend wiring is out of this zone).

## 2. Upload pipeline

New endpoint/flow:

* `file/api/ImageUploadController` — `POST /api/v1/media/images`, multipart `file` plus
  optional `chat_id`, checks `file.getSize()` before buffering and maps to
  `ImageUploadResponse`.
* `file/application/usecase/DirectImageUploadHandler` — validation, workspace/chat
  authorization, storage write, attachment row, audit.
* `file/domain/service/ImageHeaderParser` — dependency-free magic/header parser (PNG IHDR,
  JPEG SOFn, WebP VP8/VP8L/VP8X).
* `file/domain/service/ImageFileName` — filename traversal/control policy and
  extension-vs-magic check.
* `file/domain/model/{ImageFormat,ImageHeader,AttachmentSource}` and
  `InvalidImageException`.
* `ObjectStoragePort.putObject` implemented by `S3ObjectStorageAdapter` (MinIO/S3
  `PutObject`) and `InMemoryObjectStorageAdapter` (test profile).

Validation order and behavior:

| Gate | Result |
|---|---|
| Missing/empty `file` | `400 VALIDATION_FAILED` |
| Filename contains `/`, `\`, `..`, NUL/control/bidi, or > 255 chars | `400 VALIDATION_FAILED` (object key never derives from the name) |
| Size > 5 MiB (5 242 880 bytes) | `413 FILE_TOO_LARGE`; servlet multipart backstop also maps to `FILE_TOO_LARGE` for this route |
| Magic bytes not PNG/JPEG/WebP (including GIF/SVG) | `415 UNSUPPORTED_TYPE` |
| Truncated header, zero/out-of-range dimensions, > 16384 px, > 40 MP | `422 IMAGE_INVALID` |
| Animated PNG (`acTL`) or animated WebP (`VP8X` ANIM flag) | `422 IMAGE_INVALID` |
| Filename extension present and not matching detected magic | `422 IMAGE_INVALID` |
| `chat_id` present but caller is not an active participant | hidden `404` (chat existence not disclosed) |
| `chat_id` belongs to an E2EE chat | `422 E2EE_PLAINTEXT_FORBIDDEN` |
| No `chat_id`, Keycloak token without workspace claim | first active workspace (same default as `GET /me`); none → `403` |

`Content-Type` is not trusted: a PNG body labelled `text/plain` is accepted as
`image/png`, while a GIF body labelled `image/png` is rejected. The original bytes are stored
verbatim — metadata (EXIF/ICC) is **not** stripped, exactly as required — but is never
returned in the response or copied into the audit metadata.

Object keys are generated as `workspaces/<workspace-uuid>/images/<attachment-uuid>`; the
client filename is only a validated display name. The bucket stays private: uploads use the
normal S3 adapter and downloads remain 5-minute presigned GETs.

## 3. Attachment row, migration, RLS and audit

`backend/src/main/resources/db/migration/V48__direct_image_uploads.sql` (numbered after the
concurrent V46/V47 of #93/#91):

* `file.attachments.chat_id` and `upload_id` become nullable — a direct image has no upload
  session and may be unbound. The `upload_id` UNIQUE constraint stays (many NULLs are legal),
  so the regular upload pipeline is unchanged.
* `source text NOT NULL DEFAULT 'UPLOAD' CHECK (source IN ('UPLOAD','DIRECT_IMAGE'))`.
* `ck_attachments_source_shape`: `UPLOAD` still requires `upload_id` + `chat_id`;
  `DIRECT_IMAGE` requires `upload_id IS NULL`, `scan_status='SKIPPED'`, status
  `READY|BOUND|DELETED`, non-null `media` and `media->>'kind'='IMAGE'`. This is a backstop
  against direct SQL writers and makes it impossible to create a "skipped" generic file.
* Partial index `ix_attachments_direct_image (workspace_id, user_id, created_at DESC)` for the
  caller-owned logo lookup.
* No RLS policy/grant change: `ENABLE`/`FORCE ROW LEVEL SECURITY` and the tenant policy are
  untouched; the caller can only insert in the workspace it activated (chat membership or
  active workspace membership is checked before the insert). No new table, no public table.

The domain `Attachment` now carries `source`, allows null `chatId`/`uploadId` only through
the dedicated `Attachment.directImage(...)` factory, and `belongsToChat` is null-safe.
`ScanStatus.SKIPPED` is now documented as the trusted direct-image outcome.

Audit event: `file.image.uploaded` with target type `attachment` and metadata
`{mime, size_bytes, width, height, chat_bound}` only. No filename, object key, SHA-256, chat
message, EXIF or bytes enter the audit chain or logs.

Maintenance guards added so the new rows cannot be confused with uploads:

* `UploadGcHandler.gcUnboundAttachment` ignores direct images (and any null `uploadId`); the
  unbound-ready query excludes `source <> 'UPLOAD'`. An avatar/cover/logo image is therefore
  not deleted by the 24 h upload TTL.
* `WorkspaceQuotaRepositoryAdapter.committedAttachmentBytes` counts only `source='UPLOAD'`
  rows, so quota reconciliation cannot report permanent drift for direct images (they are
  not quota-reserved — see residual limitations).
* `MessageAttachmentService.bind` rejects a direct image with `422 IMAGE_INVALID`
  (`reason=direct_image_not_bindable`): the trusted image path must never turn into a
  message attachment, and it has no upload/quota row.
* `FileAccessGuard.activateAttachmentScope` lets a direct image with no `message_id`
  through only after an active workspace-membership check; regular unbound uploads remain
  hidden from non-owners. `AttachmentDownloadHandler` then adds the chat-participant check for
  a chat-bound direct image. This is what makes a cover/logo uploaded by one member render
  for the other members (see §4).

## 4. Avatar, cover and logo acceptance

The feature gates were not changed in substance; they simply accept the new row because it is
`READY`/`BOUND` + `SKIPPED` and carries the source marker. Because a direct image has no
message binding, the attachment download resolver now treats it as a channel/workspace asset:
a chat-bound direct image is downloadable by active participants of that chat, and an unbound
one (chat cover or workspace logo) by active workspace members. Regular unbound uploads remain
owner-only. This is required so other members actually see the cover/logo that was set from a
device upload.

| Surface | Authorization | Attachment rule |
|---|---|---|
| `POST /me/avatar` | caller is the owner | image + `READY`/`BOUND` + `CLEAN`/`SKIPPED`; direct image is owner-owned → accepted |
| `POST /chats/{chatId}/cover` and `/avatar` | active chat OWNER/ADMIN; channel only | same workspace **and same chat**; upload with `chat_id` records the chat and requires active participation at upload time |
| `POST /workspaces/{workspaceId}/avatar` / `PATCH /workspaces/{id}` | `manage_workspace` | same workspace **or** a `source=DIRECT_IMAGE` attachment owned by the caller (so a logo uploaded while another workspace was current still works); regular foreign `UPLOAD` attachments remain hidden `404` |
| `GET /attachments/{id}/download-url` (cover/logo read path) | active chat participant for a chat-bound direct image; active workspace member for an unbound direct image | regular unbound `UPLOAD` attachments remain owner-only; bound attachments keep the chat check |

`WorkspaceLogoPort.requireLogo` gained the caller id for that narrow owner check; `POST
/workspaces/{id}/avatar` and `PATCH /workspaces/{id}` pass `principal.userId()`. The
chat-cover/avatar adapter keeps the same-chat filter and now uses the null-safe
`belongsToChat`. Nothing about `PENDING`, `INFECTED`, `FAILED`, foreign, or wrong-chat
attachments was relaxed.

## 5. AV gap and security decisions

* **AV gap (explicit):** direct images are not sent to ClamAV; the attachment is
  `scan_status=SKIPPED`. This is intentional for a trusted image-only pipeline, but it means
  no malware verdict exists for these objects. Mitigations: only static PNG/JPEG/WebP made
  of validated magic/header bytes, no server-side decode, 5 MiB limit, 40 MP bound, private
  bucket, no E2EE chat binding, no message binding, no public URL. A future hardening step is
  to run the existing scanner for `DIRECT_IMAGE` too and only promote to `SKIPPED` after a
  clean verdict; there is no `SUSPICIOUS` status in the current model.
* SVG and GIF are rejected; animated PNG/WebP are rejected. Only static formats are stored.
* `Content-Type` is advisory; magic bytes decide. The stored MIME is derived from magic.
* No EXIF/metadata is returned; the response has only id/dimensions/MIME/size. The original
  bytes are preserved (no stripping) and presigned with an attachment disposition.
* No path traversal: filename is validated and rejected, and the storage key is built from
  server-generated UUIDs only.
* `X-Device-Id` is required for `/api/v1/media/**` (added to the device-binding predicate,
  matching the contract's `DeviceId` parameter).
* A 413 raised by the servlet multipart limit on this route now maps to `FILE_TOO_LARGE`
  rather than the plugin-package code.

## 6. Tests

New test classes (44 tests total):

| Class | Tests | Covers |
|---|---:|---|
| `unit/ImageHeaderParserTest` | 9 | PNG/JPEG/WebP (lossy/lossless/extended) dimensions, EXIF APP segment, APNG/animated WebP rejection, GIF/SVG/unknown magic, truncation, zero/oversized dimensions, 40 MP, trailing bytes |
| `unit/ImageFileNameTest` | 12 | traversal (`../`, `..\`, slash/backslash, `..`, `.`), NUL/control/bidi, 255-char bound, extension-vs-magic, canonical extension |
| `unit/DirectImageUploadHandlerTest` | 4 | Keycloak principal without workspace claim uses first active workspace, chat E2EE rejection, unsupported magic before auth/I/O, oversize before storage |
| `unit/AttachmentDownloadHandlerTest` | 4 | chat-bound direct image readable by active participant; unbound direct image readable by active workspace member; regular unbound upload remains owner-only; non-participant rejected before presign |
| `integration/DirectImageUploadIT` | 15 | PNG/JPEG/WebP success; EXIF never leaks; magic beats spoofed Content-Type; missing extension; GIF/SVG/APNG/animated WebP/extension mismatch; traversal; missing file; 5 MiB boundary (exact accepted, +1 rejected); unauthenticated; chat binding + cover/avatar + owner download; non-member/unknown chat; unbound image not a cover; user avatar + workspace logo; caller-owned direct image as logo of another owned workspace; direct image not bindable as message; GC exclusion; RLS/schema/constraints |

Focused runs (JDK 21, offline Maven repo):

```bash
JAVA_HOME=... mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest=ImageHeaderParserTest,ImageFileNameTest,DirectImageUploadHandlerTest,AttachmentDownloadHandlerTest test
# 29 tests, 0 failures

JAVA_HOME=... mvn -o -Dmaven.repo.local=.m2repo -Dtest=DirectImageUploadIT test
# 15 tests, 0 failures
```

The integration test runs on the complete migration chain (V1–V48), including the
concurrently added `V46__sova_sticker_pack.sql` (#93) and `V47__system_settings_require_2fa.sql`
(#91); V48 applies after both without changes.

Regression checks on the touched surfaces:

```bash
JAVA_HOME=... mvn -o -Dmaven.repo.local=.m2repo \
  -Dtest=ProfileWorkspace82IT,FileSchemaIT,FileUploadIT,ChatAvatarIT,FileDomainTest test
# 51 tests, 0 failures
```

Full backend suite (JDK 21, offline Maven repo, real PostgreSQL/Testcontainers):

```bash
JAVA_HOME=... mvn -o -Dmaven.repo.local=.m2repo test
```

Result: **816 tests, 0 failures, 0 errors, 0 skipped**, including `ArchitectureTest` 10/10
and the new 44 tests. The suite size before this slice was 772; this slice adds 44.

Contract/frontend checks:

* `npm run api:types` — regenerated `frontend/src/api/schema.d.ts`.
* `npm run contract:check` — passed (136 operations, 176 contract schemas, generated types in
  sync).
* `npx tsc -p tsconfig.json --noEmit` — passed.

## 7. Acceptance

| Requirement | Status |
|---|---|
| `POST /media/images` multipart (`file`, optional `chat_id`) → `{file_id,width,height,mime,size}` | ✅ |
| Auth; max 5 MiB; PNG/JPEG/WebP only by magic bytes, not `Content-Type` | ✅ |
| No metadata stripping; original bytes stored | ✅ |
| MinIO/S3 storage, private bucket, presigned downloads | ✅ |
| Attachment owned by caller; optional chat binding | ✅ |
| Scan policy image magic + size + extension; AV gap documented | ✅ (`READY`/`SKIPPED`, explicit gap in §5) |
| User avatar owned by caller | ✅ |
| Chat cover/avatar same chat; active membership when `chat_id` is supplied | ✅ |
| Workspace logo active membership + `manage_workspace` | ✅ (caller-owned direct images also accepted) |
| New uploads accepted as `SKIPPED` + `source=DIRECT_IMAGE`; arbitrary attachments not weakened | ✅ |
| `PENDING`/`INFECTED`/foreign/wrong-chat rules unchanged | ✅ (existing `ProfileWorkspace82IT` 29/29) |
| RLS unchanged; audit metadata only; no public bucket | ✅ |
| Other members can render a cover/logo set from a direct image | ✅ active chat participant / active workspace member (owner-only for regular uploads) |
| Tests: PNG/JPEG/WebP, wrong type/magic/size/traversal, chat binding/membership, avatar/cover/logo, full suite, ArchUnit | ✅ 44 new tests; **816/816**; ArchUnit 10/10 |
| Additive contract + generated schema | ✅ 105/137/176; contract check pass |

## 8. Residual limitations / follow-ups

* **UI wiring is outside this session's zone.** The backend/contract are ready for the
  device picker (`POST /media/images` + optional `chat_id`, response `file_id`/dimensions/
  MIME/size); a separate frontend task should wire the profile/channel/workspace pickers to
  it. Only `frontend/src/api/schema.d.ts` was touched here.
* **Quota:** direct images are bounded to 5 MiB each but are not reserved/committed to
  `file.workspace_usage` (there is no upload session). They are excluded from reconcile so
  the quota invariant does not drift. A per-user/workspace direct-image quota or a normal
  reservation model is a follow-up.
* **Orphan cleanup:** replacing/removing an avatar, cover or logo does not delete the old
  direct-image object (same behavior as the existing attachment-based avatars); unreferenced
  direct images are not GC'd on purpose (the upload TTL must not remove a live avatar). A
  reference-aware retention job is a follow-up.
* **AV:** see §5; `SKIPPED` is not a clean verdict. If image AV is required, run the existing
  scanner for direct images before exposing them.
* **Cross-workspace logo:** only caller-owned `DIRECT_IMAGE` attachments are accepted from
  another workspace; regular foreign attachments remain hidden `404`.
* **No rate limit/burst cap** on the new endpoint beyond auth/device/size; a per-user upload
  rate limit is a follow-up.
* **E2EE:** direct image uploads bound to an E2EE chat are rejected; E2EE media remains
  outside this slice.
* **Download visibility:** a chat-bound direct image is readable by active participants of
  that chat; an unbound direct image (channel cover, workspace logo) is readable by active
  workspace members. Regular unbound `UPLOAD` attachments stay owner-only. The attachment id
  is unguessable, but any active workspace member who learns an unbound direct-image id can
  download that image — the same trust model as a chat/workspace-visible asset.

package ru.krug.backend.file.application.usecase;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.file.application.command.UploadWorkspaceFileCommand;
import ru.krug.backend.file.application.model.FileItemView;
import ru.krug.backend.file.application.model.FileMediaView;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.FileTooLargeException;
import ru.krug.backend.file.domain.exception.UnsupportedFileTypeException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.FileTypePolicy;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.file.domain.service.SafeFileName;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.ContentDlpPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /workspaces/{workspaceId}/files} (#83): a global workspace file.
 *
 * <p>This is the same managed pipeline as a regular chat upload, not a trusted shortcut:
 * workspace membership and the tariff/guest size limit are checked first, the installation
 * {@link FileTypePolicy} (dangerous block + runtime allowlist) rejects the name/MIME, quota
 * is reserved atomically, the bytes are streamed into the private bucket, and the
 * attachment row starts as {@code READY}/{@code PENDING}. The existing scan worker then
 * produces the AV verdict (CLEAN promotes, INFECTED/FAILED quarantines and releases quota).
 * There is no way to mark a workspace file SKIPPED.
 *
 * <p>The filename is untrusted display data: the object key is built from server-side UUIDs
 * only, and the name is validated against traversal/control/bidi characters.
 */
@Service
public class WorkspaceFileUploadHandler {

    static final String ACTION = "file.workspace.uploaded";

    private static final Logger log = LoggerFactory.getLogger(WorkspaceFileUploadHandler.class);

    private final FileAccessGuard accessGuard;
    private final WorkspaceQuotaPort quota;
    private final UploadRepository uploadRepository;
    private final AttachmentRepository attachmentRepository;
    private final ObjectStoragePort storage;
    private final FileSettingsPort settings;
    private final AuditPort audit;
    private final ContentDlpPort dlp;
    private final ClockPort clock;
    private final AudioMetadataExtractor audioMetadataExtractor;

    public WorkspaceFileUploadHandler(FileAccessGuard accessGuard, WorkspaceQuotaPort quota,
                                      UploadRepository uploadRepository,
                                      AttachmentRepository attachmentRepository,
                                      ObjectStoragePort storage, FileSettingsPort settings,
                                      AuditPort audit, ContentDlpPort dlp, ClockPort clock,
                                      AudioMetadataExtractor audioMetadataExtractor) {
        this.accessGuard = accessGuard;
        this.quota = quota;
        this.uploadRepository = uploadRepository;
        this.attachmentRepository = attachmentRepository;
        this.storage = storage;
        this.settings = settings;
        this.audit = audit;
        this.dlp = dlp;
        this.clock = clock;
        this.audioMetadataExtractor = audioMetadataExtractor;
    }

    @Transactional
    public FileItemView upload(Principal principal, UploadWorkspaceFileCommand command) {
        String filename = SafeFileName.require(command.filename());
        if (command.sizeBytes() <= 0) {
            throw DomainException.badRequest("file is required", Map.of("field", "file"));
        }
        if (command.content() == null) {
            throw DomainException.badRequest("file is required", Map.of("field", "file"));
        }

        // Activates RLS and verifies ACTIVE workspace membership; unknown/foreign workspace
        // answers 403 without disclosing existence.
        Principal scoped = accessGuard.requireWorkspaceAccess(principal, command.workspaceId());
        UUID workspaceId = scoped.workspaceId();

        WorkspaceLimits limits = quota.limits(workspaceId);
        boolean guest = accessGuard.isGuest(workspaceId, scoped.userId());
        long maxFileBytes = limits.effectiveMaxFileBytes(guest);
        if (command.sizeBytes() > maxFileBytes) {
            throw new FileTooLargeException(limits.tariff().name(), maxFileBytes,
                    command.sizeBytes());
        }

        String mime = normalizeMime(command.mimeType());
        FileTypePolicy.Verdict verdict =
                FileTypePolicy.check(filename, mime, settings.allowedFileExtensions());
        if (verdict == FileTypePolicy.Verdict.DANGEROUS) {
            throw DomainException.unprocessable(ErrorCode.DANGEROUS_TYPE_BLOCKED,
                    "Dangerous file type is blocked",
                    Map.of("mime", mime == null ? "" : mime, "filename", filename,
                            "policy", "managed-allowlist"));
        }
        if (verdict == FileTypePolicy.Verdict.UNSUPPORTED) {
            throw new UnsupportedFileTypeException(mime,
                    FileTypePolicy.extensionOf(filename), FileTypePolicy.allowedExamples());
        }
        // #101: a workspace-scoped (not yet bound) file is still managed content. Check the
        // DLP attachment rules before the object is written; chat_id is null because the
        // file has no chat yet.
        dlp.enforceAttachment(scoped, null, filename, mime, command.sizeBytes());

        Instant now = clock.now();
        Instant expiresAt = now.plus(settings.uploadTtl());
        Upload upload = Upload.createWorkspaceFile(UUID.randomUUID(), workspaceId,
                scoped.userId(), filename, mime, null, command.sizeBytes(), now, expiresAt);
        uploadRepository.save(upload);
        quota.reserve(workspaceId, upload.id(), upload.sizeBytes(), now, expiresAt);

        Sha256 sha256;
        try {
            sha256 = store(upload, command.content());
        } catch (RuntimeException ex) {
            // The DB transaction rolls back (upload + reservation); remove any object bytes
            // that were already written so a rejected request leaves no orphan.
            try {
                storage.delete(upload.objectKey());
            } catch (RuntimeException cleanup) {
                log.warn("file.workspace.upload.cleanup_failed upload_id={}", upload.id());
            }
            throw ex;
        }

        UUID attachmentId = UUID.randomUUID();
        // #97: a global upload has no client metadata object, so AUDIO is always parsed on
        // the server. Malformed tags leave an AUDIO/SERVER object without fields and never
        // fail the upload.
        MediaMetadata media = null;
        if (audioMetadataExtractor.isAudio(mime, filename)) {
            media = audioMetadataExtractor.extract(workspaceId, attachmentId, mime, filename,
                    upload.objectKey(), upload.sizeBytes()).media();
        }
        Attachment attachment = Attachment.workspaceFile(attachmentId, workspaceId,
                upload.id(), scoped.userId(), filename, mime, media, upload.sizeBytes(), sha256,
                upload.objectKey(), now);
        attachmentRepository.save(attachment);
        uploadRepository.save(upload.markScanning(attachment.id(), now));
        quota.commit(workspaceId, upload.id(), now);

        audit.append(new AuditRecord(workspaceId, scoped.userId(), ACTION, "attachment",
                attachment.id(), scoped.requestId(),
                Map.of("mime", mime == null ? "" : mime, "size_bytes", upload.sizeBytes(),
                        "scan_status", ScanStatus.PENDING.name(), "source", "WORKSPACE"),
                now));
        return new FileItemView(attachment.id(), filename, upload.sizeBytes(), mime,
                ScanStatus.PENDING.name(), FileMediaView.from(media), null, null, null, now);
    }

    /**
     * Streams the multipart body into the private bucket in {@link Upload#partSize()} chunks
     * (never the whole file in memory) and returns the SHA-256 of the stored bytes.
     */
    private Sha256 store(Upload upload, InputStream content) {
        ObjectStoragePort.Multipart multipart =
                storage.createMultipart(upload.objectKey(), upload.mimeType());
        MessageDigest digest = sha256();
        List<ObjectStoragePort.Part> parts = new ArrayList<>();
        byte[] buffer = new byte[upload.partSize()];
        long total = 0;
        int partNo = 1;
        try {
            while (true) {
                int read = content.readNBytes(buffer, 0, buffer.length);
                if (read <= 0) {
                    break;
                }
                if (partNo > upload.totalParts()) {
                    throw DomainException.badRequest("file is larger than reported",
                            Map.of("field", "file"));
                }
                byte[] part = read == buffer.length ? buffer : Arrays.copyOf(buffer, read);
                String etag = storage.uploadPart(upload.objectKey(), multipart.uploadId(),
                        partNo, part);
                digest.update(part, 0, read);
                parts.add(new ObjectStoragePort.Part(partNo, etag));
                total += read;
                partNo++;
                if (read < buffer.length) {
                    break;
                }
            }
            if (total != upload.sizeBytes() || parts.isEmpty()) {
                throw DomainException.unprocessable(ErrorCode.INCOMPLETE_UPLOAD,
                        "Uploaded bytes do not match the reported file size",
                        Map.of("expected", upload.sizeBytes(), "actual", total));
            }
            storage.completeMultipart(upload.objectKey(), multipart.uploadId(), parts);
            return Sha256.of(HexFormat.of().formatHex(digest.digest()));
        } catch (RuntimeException ex) {
            abortQuietly(upload, multipart);
            throw ex;
        } catch (IOException ex) {
            abortQuietly(upload, multipart);
            throw DomainException.badRequest("Uploaded file cannot be read",
                    Map.of("field", "file"));
        }
    }

    private void abortQuietly(Upload upload, ObjectStoragePort.Multipart multipart) {
        try {
            storage.abortMultipart(upload.objectKey(), multipart.uploadId());
        } catch (RuntimeException ex) {
            log.warn("file.workspace.upload.abort_failed upload_id={}", upload.id());
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String normalizeMime(String mime) {
        if (mime == null || mime.isBlank()) {
            return null;
        }
        String value = mime.trim().toLowerCase(java.util.Locale.ROOT);
        int params = value.indexOf(';');
        return params >= 0 ? value.substring(0, params).trim() : value;
    }
}

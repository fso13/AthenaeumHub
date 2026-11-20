package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.file.application.command.UploadImageCommand;
import ru.krug.backend.file.application.model.ImageUploadView;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.ImageHeader;
import ru.krug.backend.file.domain.model.MediaKind;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.MediaMetadataSource;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.service.ImageFileName;
import ru.krug.backend.file.domain.service.ImageHeaderParser;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;

/**
 * {@code POST /media/images} (#92): upload an avatar/cover/logo image from the device.
 *
 * <p>This is a deliberately narrow, trusted pipeline in front of the managed-attachment
 * table, not a second generic file API. Only static PNG/JPEG/WebP bytes detected by magic
 * (never by {@code Content-Type}) and at most 5 MiB are accepted; the header parser extracts
 * the dimensions and rejects malformed/animated content. The original bytes are stored
 * verbatim in the private bucket (metadata is not stripped and never returned), and the
 * attachment row is created as {@code READY}/{@code SKIPPED} with
 * {@code source=DIRECT_IMAGE}. Existing avatar/cover/logo validation therefore keeps its
 * BOUND/READY + CLEAN/SKIPPED gate and is not weakened for arbitrary uploads.
 *
 * <p>Tenant rules: with {@code chat_id} the caller must be an active participant of that chat
 * (the attachment records the chat id, so only that chat's cover/avatar may use it); without
 * it the image belongs to the caller's current or first active workspace. E2EE chats are
 * rejected because their media must not be plaintext.
 */
@Service
public class DirectImageUploadHandler {

    /** Contract maximum: 5 MiB, checked in addition to the servlet multipart backstop. */
    public static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;

    static final String ACTION = "file.image.uploaded";

    private static final Logger log = LoggerFactory.getLogger(DirectImageUploadHandler.class);

    private final AttachmentRepository attachments;
    private final ObjectStoragePort storage;
    private final AuditPort audit;
    private final TenantContext tenantContext;
    private final FileAccessGuard accessGuard;
    private final WorkspaceDirectoryPort workspaceDirectory;
    private final ClockPort clock;

    public DirectImageUploadHandler(AttachmentRepository attachments, ObjectStoragePort storage,
                                    AuditPort audit, TenantContext tenantContext,
                                    FileAccessGuard accessGuard,
                                    WorkspaceDirectoryPort workspaceDirectory, ClockPort clock) {
        this.attachments = attachments;
        this.storage = storage;
        this.audit = audit;
        this.tenantContext = tenantContext;
        this.accessGuard = accessGuard;
        this.workspaceDirectory = workspaceDirectory;
        this.clock = clock;
    }

    @Transactional
    public ImageUploadView upload(Principal principal, UploadImageCommand command) {
        byte[] bytes = command.bytes();
        if (bytes == null || bytes.length == 0) {
            throw DomainException.badRequest("file is required", Map.of("field", "file"));
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw DomainException.payloadTooLarge(ErrorCode.FILE_TOO_LARGE,
                    "Image exceeds the 5 MiB limit",
                    Map.of("limit", MAX_IMAGE_BYTES, "actual", bytes.length));
        }

        // Filename policy first (cheap traversal/control rejection), then the bytes.
        String requestedName = ImageFileName.sanitize(command.filename());
        ImageHeader header = ImageHeaderParser.parse(bytes);
        String filename = ImageFileName.storedName(requestedName, header.format());

        UUID workspaceId = resolveWorkspace(principal, command.chatId());
        tenantContext.activate(principal.withWorkspace(workspaceId));

        UUID attachmentId = UUID.randomUUID();
        String objectKey = "workspaces/" + workspaceId + "/images/" + attachmentId;
        Sha256 sha256 = Sha256.ofBytes(bytes);
        MediaMetadata media = new MediaMetadata(MediaKind.IMAGE, null, header.width(),
                header.height(), null, null, null, null, null, null,
                MediaMetadataSource.SERVER);
        Attachment attachment = Attachment.directImage(attachmentId, workspaceId,
                command.chatId(), principal.userId(), filename, header.format().mime(), media,
                bytes.length, sha256, objectKey, clock.now());

        try {
            storage.putObject(objectKey, bytes, header.format().mime());
            attachments.save(attachment);
            audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "attachment",
                    attachmentId, principal.requestId(),
                    Map.of("mime", header.format().mime(), "size_bytes", bytes.length,
                            "width", header.width(), "height", header.height(),
                            "chat_bound", command.chatId() != null),
                    clock.now()));
        } catch (RuntimeException ex) {
            // The DB transaction rolls back; remove the object so a rejected upload does not
            // leave orphaned bytes behind. Best effort only: the original failure wins.
            try {
                storage.delete(objectKey);
            } catch (RuntimeException cleanup) {
                log.warn("file.image.upload.cleanup_failed attachment_id={}", attachmentId);
            }
            throw ex;
        }
        return new ImageUploadView(attachmentId, header.width(), header.height(),
                header.format().mime(), bytes.length);
    }

    private UUID resolveWorkspace(Principal principal, UUID chatId) {
        if (chatId != null) {
            ChatAccess access = accessGuard.requireChat(principal, chatId);
            if ("E2EE".equals(access.securityMode())) {
                throw DomainException.unprocessable(ErrorCode.E2EE_PLAINTEXT_FORBIDDEN,
                        "A plaintext image cannot be uploaded into an E2EE chat",
                        Map.of("field", "chat_id", "security_mode", "E2EE"));
            }
            return access.workspaceId();
        }
        if (principal.workspaceId() != null) {
            return accessGuard.requireWorkspaceAccess(principal, principal.workspaceId())
                    .workspaceId();
        }
        // Keycloak access tokens carry no workspace claim. Bind the image to the caller's
        // default (first active) workspace, mirroring GET /me; this is only a storage tenant,
        // never an authorization shortcut for the avatar/logo endpoints.
        tenantContext.activate(principal.withWorkspace(null));
        List<WorkspaceMembershipView> memberships =
                workspaceDirectory.listActiveMemberships(principal.userId());
        if (memberships.isEmpty()) {
            throw DomainException.forbidden("No active workspace to store the image");
        }
        return accessGuard.requireWorkspaceAccess(principal, memberships.get(0).id())
                .workspaceId();
    }
}

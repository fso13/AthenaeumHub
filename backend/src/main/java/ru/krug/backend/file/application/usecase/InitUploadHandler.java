package ru.krug.backend.file.application.usecase;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.command.InitUploadCommand;
import ru.krug.backend.file.application.model.UploadView;
import ru.krug.backend.file.application.port.FileSettingsPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.FileTooLargeException;
import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.exception.UploadNotFoundException;
import ru.krug.backend.file.domain.model.FileTypePolicy;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.file.domain.repository.UploadPartRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Creates an upload session, reserves quota and starts the S3 multipart upload.
 * Idempotent by Idempotency-Key: a replay returns the same upload_id and never double
 * reserves quota.
 */
@Service
public class InitUploadHandler {

    private final FileAccessGuard accessGuard;
    private final WorkspaceQuotaPort quota;
    private final UploadRepository uploadRepository;
    private final UploadPartRepository partRepository;
    private final ObjectStoragePort storage;
    private final IdempotencyPort idempotency;
    private final RequestCanonicalizer canonicalizer;
    private final FileSettingsPort settings;
    private final ClockPort clock;

    public InitUploadHandler(FileAccessGuard accessGuard, WorkspaceQuotaPort quota,
                             UploadRepository uploadRepository,
                             UploadPartRepository partRepository, ObjectStoragePort storage,
                             IdempotencyPort idempotency, RequestCanonicalizer canonicalizer,
                             FileSettingsPort settings, ClockPort clock) {
        this.accessGuard = accessGuard;
        this.quota = quota;
        this.uploadRepository = uploadRepository;
        this.partRepository = partRepository;
        this.storage = storage;
        this.idempotency = idempotency;
        this.canonicalizer = canonicalizer;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional
    public UploadView init(InitUploadCommand command) {
        if (command.filename() == null || command.filename().isBlank()
                || command.filename().length() > 255) {
            throw DomainException.badRequest("filename must be 1..255 characters",
                    Map.of("field", "filename"));
        }
        if (command.size() <= 0) {
            throw DomainException.badRequest("size must be > 0", Map.of("field", "size"));
        }
        if (!"MANAGED".equals(command.encryptionMode())) {
            throw DomainException.unprocessable(ErrorCode.MODE_NOT_SUPPORTED,
                    "Only MANAGED file encryption is supported in this slice",
                    Map.of("encryption_mode", command.encryptionMode()));
        }
        Principal scoped = accessGuard.scopeToChat(command.principal(), command.chatId());
        UUID workspaceId = accessGuard.requireChatAccess(scoped, command.chatId());
        scoped = scoped.withWorkspace(workspaceId);

        WorkspaceLimits limits = quota.limits(workspaceId);
        boolean guest = accessGuard.isGuest(workspaceId, scoped.userId());
        long maxFileBytes = limits.effectiveMaxFileBytes(guest);
        if (command.size() > maxFileBytes) {
            throw new FileTooLargeException(limits.tariff().name(), maxFileBytes, command.size());
        }
        FileTypePolicy.Verdict verdict = FileTypePolicy.check(command.filename(), command.mime());
        if (verdict == FileTypePolicy.Verdict.DANGEROUS) {
            throw DomainException.unprocessable(ErrorCode.DANGEROUS_TYPE_BLOCKED,
                    "Dangerous file type is blocked",
                    Map.of("mime", command.mime() == null ? "" : command.mime(),
                            "filename", command.filename(), "policy", "managed-allowlist"));
        }
        if (verdict == FileTypePolicy.Verdict.UNSUPPORTED) {
            throw new ru.krug.backend.file.domain.exception.UnsupportedFileTypeException(
                    command.mime(), FileTypePolicy.allowedExamples());
        }

        Sha256 declaredSha = command.sha256() == null ? null : Sha256.of(command.sha256());
        byte[] requestHash = requestHash(command, scoped);

        IdempotencyReservation reservation = idempotency.reserve(scoped,
                InitUploadCommand.IDEMPOTENCY_SCOPE, command.idempotencyKey().toString(),
                requestHash);
        if (reservation.replay()) {
            return replay(scoped, reservation.resourceId());
        }

        Instant now = clock.now();
        Instant expiresAt = now.plus(settings.uploadTtl());
        Upload upload = Upload.create(UUID.randomUUID(), workspaceId, command.chatId(),
                scoped.userId(), command.filename(), command.mime(), command.size(), declaredSha,
                now, expiresAt);
        uploadRepository.save(upload);

        // The reservation FK points at the upload, so the row must exist first. Both writes
        // are in this transaction; a quota failure rolls the upload row back as well.
        quota.reserve(workspaceId, upload.id(), upload.sizeBytes(), now, expiresAt);

        ObjectStoragePort.Multipart multipart = storage.createMultipart(upload.objectKey(),
                command.mime());
        upload = upload.withStorageUploadId(multipart.uploadId(), clock.now());
        uploadRepository.save(upload);

        idempotency.complete(scoped, InitUploadCommand.IDEMPOTENCY_SCOPE,
                command.idempotencyKey().toString(), requestHash, 201, upload.id());
        return UploadView.from(upload, List.of());
    }

    private UploadView replay(Principal principal, UUID uploadId) {
        Upload upload = uploadRepository.findById(principal.workspaceId(), uploadId)
                .orElseThrow(UploadNotFoundException::new);
        if (upload.status() == UploadStatus.EXPIRED || upload.isExpired(clock.now())) {
            throw new UploadExpiredException(upload.expiresAt());
        }
        List<Integer> received = partRepository.findByUploadId(uploadId).stream()
                .map(part -> part.partNo()).sorted().toList();
        return UploadView.from(upload, received);
    }

    private byte[] requestHash(InitUploadCommand command, Principal principal) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("workspace_id", principal.workspaceId());
        canonical.put("chat_id", command.chatId());
        canonical.put("filename", command.filename());
        canonical.put("size", command.size());
        canonical.put("mime", command.mime());
        canonical.put("sha256", command.sha256());
        canonical.put("encryption_mode", command.encryptionMode());
        return canonicalizer.sha256("POST\n/api/v1/uploads\n"
                + canonicalizer.canonicalize(canonical));
    }
}

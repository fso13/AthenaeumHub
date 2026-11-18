package ru.krug.backend.file.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.command.PreflightCommand;
import ru.krug.backend.file.application.model.FileCandidate;
import ru.krug.backend.file.application.model.PreflightFileView;
import ru.krug.backend.file.application.model.PreflightView;
import ru.krug.backend.file.application.model.QuotaView;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.domain.exception.TooManyFilesException;
import ru.krug.backend.file.domain.model.FileSize;
import ru.krug.backend.file.domain.model.FileTypePolicy;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;
import ru.krug.backend.shared.error.DomainException;

/**
 * Server-authoritative preflight. No quota is reserved here (reservation happens at init);
 * each file still gets an individual ALLOW/DENY so the client can render per-file reasons.
 */
@Service
public class PreflightService {

    private final FileAccessGuard accessGuard;
    private final WorkspaceQuotaPort quota;

    public PreflightService(FileAccessGuard accessGuard, WorkspaceQuotaPort quota) {
        this.accessGuard = accessGuard;
        this.quota = quota;
    }

    @Transactional
    public PreflightView preflight(PreflightCommand command) {
        if (command.files() == null || command.files().isEmpty()) {
            throw DomainException.badRequest("files must not be empty", Map.of("field", "files"));
        }
        UUID workspaceId = accessGuard.requireChatAccess(command.principal(), command.chatId());
        WorkspaceLimits limits = quota.limits(workspaceId);
        QuotaUsage usage = quota.usage(workspaceId);
        boolean guest = accessGuard.isGuest(workspaceId, command.principal().userId());
        long maxFileBytes = limits.effectiveMaxFileBytes(guest);
        if (command.files().size() > limits.maxAttachments()) {
            throw new TooManyFilesException(limits.maxAttachments(), command.files().size());
        }

        long cumulative = 0;
        List<PreflightFileView> decisions = new ArrayList<>();
        for (FileCandidate file : command.files()) {
            PreflightFileView decision = decide(file, limits, usage, maxFileBytes, cumulative);
            decisions.add(decision);
            if (decision.allowed()) {
                cumulative += file.size();
            }
        }
        boolean allAllowed = decisions.stream().allMatch(PreflightFileView::allowed);
        return new PreflightView(allAllowed ? "ALLOW" : "DENY", maxFileBytes,
                limits.maxAttachments(),
                new QuotaView(usage.used(), usage.reserved(), limits.storageBytes()), decisions);
    }

    private PreflightFileView decide(FileCandidate file, WorkspaceLimits limits,
                                     QuotaUsage usage, long maxFileBytes, long cumulative) {
        String name = file.name() == null ? "" : file.name();
        if (name.isBlank() || name.length() > 255) {
            return PreflightFileView.denied(name, "VALIDATION_FAILED",
                    Map.of("field", "name", "reason", "length"));
        }
        if (file.size() <= 0) {
            return PreflightFileView.denied(name, "VALIDATION_FAILED",
                    Map.of("field", "size", "reason", "positive"));
        }
        FileTypePolicy.Verdict verdict = FileTypePolicy.check(file.name(), file.mime());
        if (verdict == FileTypePolicy.Verdict.DANGEROUS) {
            return PreflightFileView.denied(name, "DANGEROUS_TYPE_BLOCKED",
                    Map.of("mime", file.mime() == null ? "" : file.mime(), "policy",
                            "managed-allowlist"));
        }
        if (verdict == FileTypePolicy.Verdict.UNSUPPORTED) {
            return PreflightFileView.denied(name, "UNSUPPORTED_TYPE",
                    Map.of("mime", file.mime() == null ? "" : file.mime(), "allowed",
                            FileTypePolicy.allowedExamples()));
        }
        if (file.size() > maxFileBytes) {
            return PreflightFileView.denied(name, "FILE_TOO_LARGE",
                    Map.of("limit", maxFileBytes, "actual", file.size(),
                            "tariff", limits.tariff().name()));
        }
        if (!usage.canReserve(cumulative + file.size(), limits.storageBytes())) {
            return PreflightFileView.denied(name, "QUOTA_EXCEEDED",
                    Map.of("used", usage.used(), "reserved", usage.reserved(),
                            "limit", limits.storageBytes(),
                            "required", cumulative + file.size()));
        }
        return PreflightFileView.allowed(name, FileSize.DEFAULT_PART_SIZE);
    }
}

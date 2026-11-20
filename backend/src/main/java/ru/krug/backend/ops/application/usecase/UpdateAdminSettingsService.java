package ru.krug.backend.ops.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.cache.annotation.CacheEvict;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.SystemSettingsUpdateCommand;
import ru.krug.backend.ops.application.model.SystemSettingsView;
import ru.krug.backend.ops.application.port.SmtpPasswordCipherPort;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.ops.application.service.SystemSettingsMapper;
import ru.krug.backend.ops.domain.model.SmtpSettings;
import ru.krug.backend.ops.domain.model.SystemSettings;
import ru.krug.backend.ops.domain.repository.SystemSettingsRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code PATCH /admin/settings}: partial update plus first-run completion. Completion is
 * atomic (settings row locked FOR UPDATE): the first successful call sets
 * {@code setup_completed_at}, every later completion attempt is
 * {@code 409 SETUP_ALREADY_COMPLETED} (FR-ADM-4). The SMTP password is encrypted here and is
 * never written to the audit event, logs or the response.
 */
@Service
public class UpdateAdminSettingsService {

    private final PlatformAdminGuard adminGuard;
    private final SystemSettingsRepository repository;
    private final SmtpPasswordCipherPort cipher;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateAdminSettingsService(PlatformAdminGuard adminGuard,
                                      SystemSettingsRepository repository,
                                      SmtpPasswordCipherPort cipher,
                                      AuditPort audit,
                                      ClockPort clock) {
        this.adminGuard = adminGuard;
        this.repository = repository;
        this.cipher = cipher;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    @CacheEvict(cacheNames = SystemSettingsPort.ALLOWED_FILE_EXTENSIONS_CACHE,
            allEntries = true)
    public SystemSettingsView update(Principal principal, SystemSettingsUpdateCommand command) {
        adminGuard.require(principal);
        SystemSettings current = repository.loadForUpdate();
        boolean complete = Boolean.TRUE.equals(command.completeSetup())
                || Boolean.TRUE.equals(command.setupCompleted());
        if (complete && current.setupCompleted()) {
            throw DomainException.conflict(ErrorCode.SETUP_ALREADY_COMPLETED,
                    "Setup is already completed", Map.of());
        }

        Instant now = clock.now();
        SystemSettings next = apply(current, command, now, principal);
        if (complete) {
            next = next.completeSetup(now, principal.userId());
        }
        repository.save(next);

        appendUpdatedAudit(principal, command, now, complete);
        if (complete) {
            audit.append(new AuditRecord(null, principal.userId(), "setup.completed",
                    "system_settings", null, principal.requestId(),
                    Map.of("setup_completed_at", now.toString()), now));
        }
        return SystemSettingsMapper.toView(next);
    }

    private SystemSettings apply(SystemSettings current, SystemSettingsUpdateCommand command,
                                 Instant now, Principal principal) {
        SmtpSettings smtp = current.smtp();
        String host = command.smtpHost() == null ? smtp.host()
                : normalize(command.smtpHost(), 255, "smtp_host");
        Integer port = command.smtpPort() == null ? smtp.port()
                : requirePort(command.smtpPort());
        String username = command.smtpUsername() == null ? smtp.username()
                : normalize(command.smtpUsername(), 255, "smtp_username");
        String from = command.smtpFrom() == null ? smtp.from()
                : normalize(command.smtpFrom(), 254, "smtp_from");
        boolean starttls = command.smtpStarttls() == null ? smtp.starttls()
                : command.smtpStarttls();
        byte[] passwordCiphertext = smtp.passwordCiphertext();
        if (command.smtpPassword() != null && !command.smtpPassword().isBlank()) {
            if (command.smtpPassword().length() > 512) {
                throw badRequest("smtp_password must be at most 512 characters",
                        "smtp_password");
            }
            passwordCiphertext = cipher.encrypt(command.smtpPassword());
        }
        SmtpSettings updatedSmtp = new SmtpSettings(host, port, username, passwordCiphertext,
                from, starttls);

        int maxChatsPerUser = command.maxChatsPerUser() == null ? current.maxChatsPerUser()
                : requireLimit(command.maxChatsPerUser(), "max_chats_per_user");
        int maxChatsPerWorkspace = command.maxChatsPerWorkspace() == null
                ? current.maxChatsPerWorkspace()
                : requireLimit(command.maxChatsPerWorkspace(), "max_chats_per_workspace");
        int maxWorkspaceMembers = command.maxWorkspaceMembers() == null
                ? current.maxWorkspaceMembers()
                : requireLimit(command.maxWorkspaceMembers(), "max_workspace_members");
        boolean registrationOpen = command.registrationOpen() == null
                ? current.registrationOpen() : command.registrationOpen();
        boolean requireTwoFactor = command.requireTwoFactor() == null
                ? current.requireTwoFactor() : command.requireTwoFactor();
        AllowedFileExtensions allowedFileExtensions = current.allowedFileExtensions();
        if (command.allowedFileExtensions() != null) {
            try {
                allowedFileExtensions = AllowedFileExtensions
                        .of(command.allowedFileExtensions());
            } catch (IllegalArgumentException ex) {
                // The message contains the index/reason but never the whole request body.
                throw DomainException.badRequest(ex.getMessage(),
                        Map.of("field", "allowed_file_extensions"));
            }
        }

        return new SystemSettings(current.setupCompletedAt(), updatedSmtp,
                allowedFileExtensions, maxChatsPerUser, maxChatsPerWorkspace,
                maxWorkspaceMembers, registrationOpen, requireTwoFactor, now,
                principal.userId());
    }

    private void appendUpdatedAudit(Principal principal, SystemSettingsUpdateCommand command,
                                    Instant now, boolean complete) {
        List<String> changed = changedFields(command, complete);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("fields", changed);
        metadata.put("complete_setup", complete);
        audit.append(new AuditRecord(null, principal.userId(), "settings.updated",
                "system_settings", null, principal.requestId(), metadata, now));
    }

    private static List<String> changedFields(SystemSettingsUpdateCommand command,
                                              boolean complete) {
        List<String> fields = new ArrayList<>();
        if (command.smtpHost() != null) {
            fields.add("smtp_host");
        }
        if (command.smtpPort() != null) {
            fields.add("smtp_port");
        }
        if (command.smtpUsername() != null) {
            fields.add("smtp_username");
        }
        if (command.smtpPassword() != null && !command.smtpPassword().isBlank()) {
            // Field name only: never the value.
            fields.add("smtp_password");
        }
        if (command.smtpFrom() != null) {
            fields.add("smtp_from");
        }
        if (command.smtpStarttls() != null) {
            fields.add("smtp_starttls");
        }
        if (command.allowedFileExtensions() != null) {
            // Field name only: the allowlist values are not copied into audit metadata.
            fields.add("allowed_file_extensions");
        }
        if (command.maxChatsPerUser() != null) {
            fields.add("max_chats_per_user");
        }
        if (command.maxChatsPerWorkspace() != null) {
            fields.add("max_chats_per_workspace");
        }
        if (command.maxWorkspaceMembers() != null) {
            fields.add("max_workspace_members");
        }
        if (command.registrationOpen() != null) {
            fields.add("registration_open");
        }
        if (command.requireTwoFactor() != null) {
            // Field name only: the boolean value is not copied into audit metadata.
            fields.add("require_2fa");
        }
        if (complete) {
            fields.add("setup_completed_at");
        }
        return List.copyOf(fields);
    }

    private static String normalize(String value, int maxLength, String field) {
        String normalized = value == null ? null : value.strip();
        if (normalized != null && normalized.length() > maxLength) {
            throw badRequest(field + " must be at most " + maxLength + " characters", field);
        }
        return normalized == null || normalized.isEmpty() ? null : normalized;
    }

    private static Integer requirePort(int port) {
        if (port < 1 || port > 65535) {
            throw badRequest("smtp_port must be within 1..65535", "smtp_port");
        }
        return port;
    }

    private static int requireLimit(int value, String field) {
        if (value < 1 || value > 1_000_000) {
            throw badRequest(field + " must be within 1..1000000", field);
        }
        return value;
    }

    private static DomainException badRequest(String message, String field) {
        return DomainException.badRequest(message, Map.of("field", field));
    }
}

package ru.krug.backend.ops.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * PATCH /admin/settings. Every field is optional; {@code complete_setup=true} (alias
 * {@code setup_completed=true}) finishes the first-run wizard and is rejected with 409
 * once setup is complete. SMTP password is write-only and is never echoed by any response.
 *
 * <p>{@code allowed_file_extensions} is normalized (trim/lower-case) and validated by the
 * domain value object: 1..100 entries, {@code [a-z0-9]{1,10}}, no dots, no duplicates and
 * no dangerous extension. An explicit empty list is rejected, not interpreted as defaults.
 */
public record AdminSettingsPatchRequest(
        @Size(max = 255) String smtpHost,
        @Min(1) @Max(65535) Integer smtpPort,
        @Size(max = 255) String smtpUsername,
        @Size(max = 512) String smtpPassword,
        @Size(max = 254) String smtpFrom,
        Boolean smtpStarttls,
        @Size(min = 1, max = 100) List<@Size(max = 10) String> allowedFileExtensions,
        @Min(1) @Max(1000000) Integer maxChatsPerUser,
        @Min(1) @Max(1000000) Integer maxChatsPerWorkspace,
        @Min(1) @Max(1000000) Integer maxWorkspaceMembers,
        Boolean registrationOpen,
        @JsonProperty("require_2fa") Boolean requireTwoFactor,
        Boolean completeSetup,
        Boolean setupCompleted) {
}

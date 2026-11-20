package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One DLP decision event. Deliberately content-free: no message text, ciphertext, file
 * name, email or IP address.
 */
public record DlpEventView(
        UUID id,
        UUID policyId,
        String policyName,
        String action,
        UUID actorId,
        UUID chatId,
        Instant createdAt) {
}

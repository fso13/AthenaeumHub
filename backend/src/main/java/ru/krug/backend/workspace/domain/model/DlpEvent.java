package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One content-free DLP decision event. There is deliberately no message text, ciphertext,
 * file name, email or IP address: only the rule snapshot, action and ids. The table is
 * append-only for the runtime role.
 */
public record DlpEvent(
        UUID id,
        UUID workspaceId,
        UUID policyId,
        String ruleName,
        DlpAction action,
        UUID actorId,
        UUID chatId,
        Instant createdAt) {

    public DlpEvent {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(ruleName, "ruleName");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(createdAt, "createdAt");
    }
}

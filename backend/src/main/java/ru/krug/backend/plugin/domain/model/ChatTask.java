package ru.krug.backend.plugin.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.plugin.domain.service.PluginTextPolicy;

/**
 * Chat-scoped task. Any ACTIVE chat member may create it; only the creator, the assignee
 * or a chat {@code OWNER}/{@code ADMIN} may change its completion state. The assignee is
 * validated by the application against ACTIVE chat membership and is never taken from an
 * arbitrary user-supplied id without that check.
 */
public final class ChatTask {

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID creatorId;
    private final UUID assigneeId;
    private final String title;
    private final Instant dueAt;
    private final boolean done;
    private final UUID completedBy;
    private final Instant completedAt;
    private final Instant createdAt;

    private ChatTask(UUID id, UUID workspaceId, UUID chatId, UUID creatorId, UUID assigneeId,
                     String title, Instant dueAt, boolean done, UUID completedBy,
                     Instant completedAt, Instant createdAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.creatorId = Objects.requireNonNull(creatorId, "creatorId");
        this.assigneeId = assigneeId;
        this.title = Objects.requireNonNull(title, "title");
        this.dueAt = dueAt;
        this.done = done;
        this.completedBy = completedBy;
        this.completedAt = completedAt;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        if (done != (completedAt != null) || done != (completedBy != null)) {
            throw new IllegalArgumentException("done/completedBy/completedAt must agree");
        }
    }

    public static ChatTask create(UUID id, UUID workspaceId, UUID chatId, UUID creatorId,
                                  UUID assigneeId, String rawTitle, Instant dueAt, Instant now) {
        String title = PluginTextPolicy.requireTaskTitle(rawTitle);
        return new ChatTask(id, workspaceId, chatId, creatorId, assigneeId, title, dueAt,
                false, null, null, Objects.requireNonNull(now, "now"));
    }

    public static ChatTask reconstitute(UUID id, UUID workspaceId, UUID chatId, UUID creatorId,
                                        UUID assigneeId, String title, Instant dueAt,
                                        boolean done, UUID completedBy, Instant completedAt,
                                        Instant createdAt) {
        return new ChatTask(id, workspaceId, chatId, creatorId, assigneeId, title, dueAt,
                done, completedBy, completedAt, createdAt);
    }

    /** Pure authorisation rule: creator/assignee wins, managers are a chat-level override. */
    public boolean canChangeDone(UUID userId, String chatRole) {
        return creatorId.equals(userId)
                || (assigneeId != null && assigneeId.equals(userId))
                || "OWNER".equals(chatRole)
                || "ADMIN".equals(chatRole);
    }

    /** Returns this task with a new completion state; no mutation of the original. */
    public ChatTask withDone(boolean newDone, UUID actorId, Instant at) {
        return new ChatTask(id, workspaceId, chatId, creatorId, assigneeId, title, dueAt,
                newDone, newDone ? actorId : null, newDone ? at : null, createdAt);
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID creatorId() {
        return creatorId;
    }

    public UUID assigneeId() {
        return assigneeId;
    }

    public String title() {
        return title;
    }

    public Instant dueAt() {
        return dueAt;
    }

    public boolean done() {
        return done;
    }

    public UUID completedBy() {
        return completedBy;
    }

    public Instant completedAt() {
        return completedAt;
    }

    public Instant createdAt() {
        return createdAt;
    }
}

package ru.krug.backend.chat.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "chats", schema = "chat")
public class ChatEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "type", nullable = false)
    private String type;

    @Column(name = "security_mode", nullable = false)
    private String securityMode;

    @Column(name = "name")
    private String name;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "last_message_at")
    private Instant lastMessageAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    @Column(name = "direct_key")
    private String directKey;

    protected ChatEntity() {
    }

    public UUID getId() {
        return id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public String getType() {
        return type;
    }

    public String getSecurityMode() {
        return securityMode;
    }

    public String getName() {
        return name;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }

    public Instant getLastMessageAt() {
        return lastMessageAt;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    public String getDirectKey() {
        return directKey;
    }
}

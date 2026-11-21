package ru.krug.backend.bot.infrastructure.adapter;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.port.BotAvatarPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Validates a bot avatar against the existing file center: a live, scanned image attachment
 * of the same workspace. There is no upload pipeline for bots. Unknown/foreign files are a
 * hidden 404; a non-image or an unscanned file is {@code 422 BOT_AVATAR_INVALID}.
 */
@Component
public class BotAvatarAdapter implements BotAvatarPort {

    private final EntityManager entityManager;

    public BotAvatarAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    @Transactional(readOnly = true)
    public UUID requireImage(UUID workspaceId, UUID attachmentId) {
        if (workspaceId == null || attachmentId == null) {
            throw DomainException.notFound("Attachment not found");
        }
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT a.status, a.scan_status, lower(coalesce(a.mime_type, ''))
                          FROM file.attachments a
                         WHERE a.id = ?1 AND a.workspace_id = ?2 AND a.deleted_at IS NULL
                        """)
                .setParameter(1, attachmentId)
                .setParameter(2, workspaceId)
                .getResultList();
        if (rows.isEmpty()) {
            throw DomainException.notFound("Attachment not found");
        }
        Object[] row = (Object[]) rows.get(0);
        String status = (String) row[0];
        String scanStatus = (String) row[1];
        String mimeType = (String) row[2];
        boolean ready = "READY".equals(status) || "BOUND".equals(status);
        boolean scanned = "CLEAN".equals(scanStatus) || "SKIPPED".equals(scanStatus);
        if (!ready || !scanned || !mimeType.startsWith("image/")) {
            throw DomainException.unprocessable(ErrorCode.BOT_AVATAR_INVALID,
                    "Bot avatar must be a ready, scanned image",
                    Map.of("file_id", attachmentId.toString(),
                            "status", status == null ? "" : status,
                            "scan_status", scanStatus == null ? "" : scanStatus));
        }
        return attachmentId;
    }
}

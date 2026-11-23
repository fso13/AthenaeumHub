package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.ops.application.model.FileRetentionBatch;
import ru.krug.backend.ops.application.model.MessageRetentionBatch;
import ru.krug.backend.ops.application.port.ContentRetentionPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Bounded retention writes (#101). Every method runs in its own tenant transaction:
 * {@link TenantContext} sets {@code app.workspace_id}, so the standard RLS policies scope
 * the batch. No cross-tenant worker privilege is used for the actual deletion.
 *
 * <p>Message batches clear the managed ciphertext, the content metadata and the mention
 * metadata, and purge E2EE envelopes and reactions for the same messages. Attachment
 * batches flip the row to {@code DELETED} and expire the backing upload; the object bytes
 * are removed by the orchestrator after the transaction commits. A row already in the
 * terminal state is never returned again, which makes a repeated batch a no-op.</p>
 */
@Repository
public class ContentRetentionAdapter implements ContentRetentionPort {

    private static final String REQUEST_ID = "retention";

    private final EntityManager entityManager;
    private final TenantContext tenantContext;

    public ContentRetentionAdapter(EntityManager entityManager, TenantContext tenantContext) {
        this.entityManager = entityManager;
        this.tenantContext = tenantContext;
    }

    @Override
    @Transactional
    public MessageRetentionBatch softDeleteMessages(UUID workspaceId, Instant cutoff, int limit) {
        tenantContext.activate(systemPrincipal(workspaceId));
        @SuppressWarnings("unchecked")
        List<UUID> ids = entityManager.createNativeQuery("""
                        WITH batch AS (
                            SELECT id, created_at
                              FROM message.messages
                             WHERE workspace_id = ?1
                               AND created_at < ?2
                               AND deleted_at IS NULL
                             ORDER BY created_at ASC
                             LIMIT ?3
                             FOR UPDATE SKIP LOCKED
                        ), updated AS (
                            UPDATE message.messages m
                               SET deleted_at = ?4,
                                   deleted_by = NULL,
                                   body_ciphertext = NULL,
                                   content_meta = '{}'::jsonb,
                                   mentions = '[]'::jsonb,
                                   mention_all = false,
                                   version = version + 1
                              FROM batch b
                             WHERE m.id = b.id AND m.created_at = b.created_at
                             RETURNING m.id
                        )
                        SELECT id FROM updated
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, Timestamp.from(cutoff))
                .setParameter(3, limit)
                .setParameter(4, Timestamp.from(cutoff))
                .getResultList();
        if (ids.isEmpty()) {
            return new MessageRetentionBatch(0);
        }
        // Content-adjacent rows: E2EE envelopes and reactions must not outlive the message
        // content they belong to. Both deletes are tenant-scoped by RLS.
        entityManager.createNativeQuery("""
                        DELETE FROM message.message_envelopes
                         WHERE workspace_id = ?1 AND message_id IN (?2)
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, ids)
                .executeUpdate();
        entityManager.createNativeQuery("""
                        DELETE FROM message.message_reactions
                         WHERE workspace_id = ?1 AND message_id IN (?2)
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, ids)
                .executeUpdate();
        return new MessageRetentionBatch(ids.size());
    }

    @Override
    @Transactional
    public FileRetentionBatch softDeleteFiles(UUID workspaceId, Instant cutoff, int limit) {
        tenantContext.activate(systemPrincipal(workspaceId));
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        WITH batch AS (
                            SELECT id
                              FROM file.attachments
                             WHERE workspace_id = ?1
                               AND created_at < ?2
                               AND status <> 'DELETED'
                             ORDER BY created_at ASC, id ASC
                             LIMIT ?3
                             FOR UPDATE SKIP LOCKED
                        ), updated AS (
                            UPDATE file.attachments a
                               SET status = 'DELETED',
                                   deleted_at = ?4,
                                   updated_at = ?4
                              FROM batch b
                             WHERE a.id = b.id
                             RETURNING a.id, a.upload_id, a.object_key
                        )
                        SELECT id, upload_id, object_key FROM updated
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, Timestamp.from(cutoff))
                .setParameter(3, limit)
                .setParameter(4, Timestamp.from(cutoff))
                .getResultList();
        if (rows.isEmpty()) {
            return new FileRetentionBatch(0, List.of(), List.of());
        }
        List<UUID> uploadIds = new ArrayList<>(rows.size());
        List<String> objectKeys = new ArrayList<>(rows.size());
        for (Object[] row : rows) {
            uploadIds.add((UUID) row[1]);
            objectKeys.add((String) row[2]);
        }
        Query expire = entityManager.createNativeQuery("""
                        UPDATE file.uploads
                           SET status = 'EXPIRED', updated_at = ?2
                         WHERE workspace_id = ?1
                           AND id IN (?3)
                           AND status <> 'EXPIRED'
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, Timestamp.from(cutoff))
                .setParameter(3, uploadIds);
        expire.executeUpdate();
        return new FileRetentionBatch(rows.size(), uploadIds, objectKeys);
    }

    private static Principal systemPrincipal(UUID workspaceId) {
        return new Principal(null, null, workspaceId, REQUEST_ID);
    }
}

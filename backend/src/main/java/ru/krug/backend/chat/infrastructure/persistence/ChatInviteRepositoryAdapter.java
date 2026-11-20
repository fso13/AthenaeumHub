package ru.krug.backend.chat.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.chat.domain.model.ChatInvite;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.InviteAcceptance;
import ru.krug.backend.chat.domain.repository.ChatInviteRepository;

/**
 * Native-SQL invite persistence (#79). Every statement runs under the tenant RLS GUC; the
 * accept path calls the narrow {@code chat.accept_invite} SECURITY DEFINER function because
 * the token URL carries no workspace.
 */
@Repository
public class ChatInviteRepositoryAdapter implements ChatInviteRepository {

    private final EntityManager entityManager;

    public ChatInviteRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void save(UUID workspaceId, ChatInvite invite, String tokenHash) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.invites
                            (id, workspace_id, chat_id, token_hash, role, created_by,
                             max_uses, used_count, expires_at, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
                        """)
                .setParameter(1, invite.id())
                .setParameter(2, workspaceId)
                .setParameter(3, invite.chatId())
                .setParameter(4, tokenHash)
                .setParameter(5, invite.role().name())
                .setParameter(6, invite.createdBy())
                .setParameter(7, invite.maxUses())
                .setParameter(8, Timestamp.from(invite.expiresAt()))
                .setParameter(9, Timestamp.from(invite.createdAt()))
                .executeUpdate();
    }

    @Override
    public List<ChatInvite> listByChat(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, chat_id, role, max_uses, used_count, expires_at, revoked_at,
                               created_at, created_by
                          FROM chat.invites
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                         ORDER BY created_at DESC, id DESC
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().map(ChatInviteRepositoryAdapter::toDomain).toList();
    }

    @Override
    public Optional<ChatInvite> findById(UUID workspaceId, UUID chatId, UUID inviteId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, chat_id, role, max_uses, used_count, expires_at, revoked_at,
                               created_at, created_by
                          FROM chat.invites
                         WHERE id = ?1
                           AND chat_id = ?2
                           AND workspace_id = ?3
                        """)
                .setParameter(1, inviteId)
                .setParameter(2, chatId)
                .setParameter(3, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(ChatInviteRepositoryAdapter::toDomain);
    }

    @Override
    public boolean revoke(UUID workspaceId, UUID chatId, UUID inviteId, Instant at) {
        return entityManager.createNativeQuery("""
                        UPDATE chat.invites
                           SET revoked_at = ?4
                         WHERE id = ?1
                           AND chat_id = ?2
                           AND workspace_id = ?3
                           AND revoked_at IS NULL
                        """)
                .setParameter(1, inviteId)
                .setParameter(2, chatId)
                .setParameter(3, workspaceId)
                .setParameter(4, Timestamp.from(at))
                .executeUpdate() > 0;
    }

    @Override
    public InviteAcceptance accept(String tokenHash, UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT outcome, invite_id, workspace_id, chat_id, role, already_member
                          FROM chat.accept_invite(CAST(?1 AS text), CAST(?2 AS uuid))
                        """)
                .setParameter(1, tokenHash)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst()
                .map(row -> new InviteAcceptance(
                        InviteAcceptance.parse((String) row[0]),
                        (UUID) row[1],
                        (UUID) row[2],
                        (UUID) row[3],
                        (String) row[4],
                        Boolean.TRUE.equals(row[5])))
                .orElseGet(() -> InviteAcceptance.failed(InviteAcceptance.Outcome.NOT_FOUND));
    }

    private static ChatInvite toDomain(Object[] row) {
        Integer maxUses = row[3] == null ? null : ((Number) row[3]).intValue();
        return ChatInvite.reconstitute(
                (UUID) row[0],
                (UUID) row[1],
                ChatMember.Role.valueOf((String) row[2]),
                maxUses,
                ((Number) row[4]).intValue(),
                instant(row[5]),
                instant(row[6]),
                instant(row[7]),
                (UUID) row[8]);
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass());
    }
}

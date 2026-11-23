package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspaceInviteAcceptance;
import ru.krug.backend.workspace.domain.model.WorkspaceInvitePreview;
import ru.krug.backend.workspace.domain.repository.WorkspaceInviteRepository;

/**
 * Native-SQL invite persistence. Every statement runs under the tenant RLS GUC except the
 * accept/preview paths, which call narrow SECURITY DEFINER functions because the token URL
 * carries no workspace.
 */
@Repository
public class WorkspaceInviteRepositoryAdapter implements WorkspaceInviteRepository {

    private final EntityManager entityManager;

    public WorkspaceInviteRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void save(UUID workspaceId, WorkspaceInvite invite, String tokenHash) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.invites
                            (id, workspace_id, token_hash, role, email, created_by, max_uses,
                             used_count, expires_at, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
                        """)
                .setParameter(1, invite.id())
                .setParameter(2, workspaceId)
                .setParameter(3, tokenHash)
                .setParameter(4, invite.role().name())
                .setParameter(5, invite.email())
                .setParameter(6, invite.createdBy())
                .setParameter(7, invite.maxUses())
                .setParameter(8, Timestamp.from(invite.expiresAt()))
                .setParameter(9, Timestamp.from(invite.createdAt()))
                .executeUpdate();
    }

    @Override
    public List<WorkspaceInvite> listByWorkspace(UUID workspaceId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, role, email::text, max_uses, used_count, expires_at,
                               revoked_at, created_at, created_by
                          FROM workspace.invites
                         WHERE workspace_id = ?1
                         ORDER BY created_at DESC, id DESC
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().map(WorkspaceInviteRepositoryAdapter::toDomain).toList();
    }

    @Override
    public Optional<WorkspaceInvite> findById(UUID workspaceId, UUID inviteId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, role, email::text, max_uses, used_count, expires_at,
                               revoked_at, created_at, created_by
                          FROM workspace.invites
                         WHERE id = ?1
                           AND workspace_id = ?2
                        """)
                .setParameter(1, inviteId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(WorkspaceInviteRepositoryAdapter::toDomain);
    }

    @Override
    public boolean revoke(UUID workspaceId, UUID inviteId, Instant at) {
        return entityManager.createNativeQuery("""
                        UPDATE workspace.invites
                           SET revoked_at = ?3
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND revoked_at IS NULL
                        """)
                .setParameter(1, inviteId)
                .setParameter(2, workspaceId)
                .setParameter(3, Timestamp.from(at))
                .executeUpdate() > 0;
    }

    @Override
    public WorkspaceInviteAcceptance accept(String tokenHash, UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT outcome, invite_id, workspace_id, role, already_member
                          FROM workspace.accept_invite(CAST(?1 AS text), CAST(?2 AS uuid))
                        """)
                .setParameter(1, tokenHash)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst()
                .map(row -> new WorkspaceInviteAcceptance(
                        WorkspaceInviteAcceptance.Outcome.parse((String) row[0]),
                        (UUID) row[1],
                        (UUID) row[2],
                        (String) row[3],
                        Boolean.TRUE.equals(row[4])))
                .orElseGet(() -> WorkspaceInviteAcceptance.failed(
                        WorkspaceInviteAcceptance.Outcome.NOT_FOUND));
    }

    @Override
    public WorkspaceInvitePreview preview(String tokenHash) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT outcome, workspace_name, workspace_slug, role, email_bound,
                               expires_at
                          FROM workspace.preview_invite(CAST(?1 AS text))
                        """)
                .setParameter(1, tokenHash)
                .getResultList();
        return rows.stream().findFirst()
                .map(row -> new WorkspaceInvitePreview(
                        WorkspaceInvitePreview.Status.parse((String) row[0]),
                        (String) row[1],
                        (String) row[2],
                        (String) row[3],
                        Boolean.TRUE.equals(row[4]),
                        instant(row[5])))
                .orElseGet(WorkspaceInvitePreview::notFound);
    }

    private static WorkspaceInvite toDomain(Object[] row) {
        Integer maxUses = row[4] == null ? null : ((Number) row[4]).intValue();
        return WorkspaceInvite.reconstitute(
                (UUID) row[0],
                (UUID) row[1],
                Membership.Role.valueOf((String) row[2]),
                maxUses,
                ((Number) row[5]).intValue(),
                instant(row[6]),
                instant(row[7]),
                instant(row[8]),
                (UUID) row[9],
                (String) row[3]);
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

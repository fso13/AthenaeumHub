package ru.krug.backend.workspace.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspaceMembership;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

@Repository
public class WorkspaceRepositoryAdapter implements WorkspaceRepository {

    private final WorkspaceJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public WorkspaceRepositoryAdapter(WorkspaceJpaRepository jpaRepository,
                                      EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public boolean isActiveMember(UUID workspaceId, UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM workspace.memberships
                         WHERE workspace_id = ?1
                           AND user_id = ?2
                           AND status = 'ACTIVE'
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getSingleResult();
        return count.longValue() > 0;
    }

    @Override
    public Optional<Workspace> findById(UUID workspaceId) {
        return jpaRepository.findById(workspaceId).map(WorkspacePersistenceMapper::toDomain);
    }

    @Override
    public Optional<Membership> findMembership(UUID workspaceId, UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT role, status
                          FROM workspace.memberships
                         WHERE workspace_id = ?1 AND user_id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst().map(row -> Membership.reconstitute(workspaceId, userId,
                Membership.Role.valueOf((String) row[0]),
                Membership.Status.valueOf((String) row[1])));
    }

    @Override
    public List<WorkspaceMembership> listActiveMemberships(UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT w.id, w.name, w.slug::text, w.description, w.logo_file_id,
                               w.security_mode, w.status, w.created_by, m.role, m.status
                          FROM workspace.workspaces w
                          JOIN workspace.memberships m
                            ON m.workspace_id = w.id
                         WHERE m.user_id = ?1
                           AND m.status = 'ACTIVE'
                           AND w.status = 'ACTIVE'
                         ORDER BY m.joined_at ASC, w.id ASC
                        """)
                .setParameter(1, userId)
                .getResultList();
        return rows.stream().map(row -> {
            Workspace workspace = Workspace.reconstitute((UUID) row[0], (String) row[1],
                    (String) row[2], (String) row[3], (UUID) row[4],
                    Workspace.SecurityMode.valueOf((String) row[5]),
                    Workspace.Status.valueOf((String) row[6]), (UUID) row[7]);
            Membership membership = Membership.reconstitute((UUID) row[0], userId,
                    Membership.Role.valueOf((String) row[8]),
                    Membership.Status.valueOf((String) row[9]));
            return new WorkspaceMembership(workspace, membership);
        }).toList();
    }

    @Override
    public void save(Workspace workspace) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.workspaces
                               (id, name, slug, security_mode, status, created_by)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                        ON CONFLICT (id) DO UPDATE
                           SET name = EXCLUDED.name,
                               status = 'ACTIVE',
                               updated_at = now()
                        -- security_mode is immutable (V16 trigger): never overwrite it on
                        -- onboarding upsert, otherwise an existing E2EE workspace -> 409/500.
                        """)
                .setParameter(1, workspace.id())
                .setParameter(2, workspace.name())
                .setParameter(3, workspace.slug())
                .setParameter(4, workspace.securityMode().name())
                .setParameter(5, workspace.status().name())
                .setParameter(6, workspace.createdBy())
                .executeUpdate();
        // P0-3: every workspace has a security-settings row from creation. The insert is
        // idempotent so an onboarding upsert of an existing workspace leaves the values
        // untouched. The tenant GUC matches the new workspace in both call paths.
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.security_settings (workspace_id)
                        VALUES (?1)
                        ON CONFLICT (workspace_id) DO NOTHING
                        """)
                .setParameter(1, workspace.id())
                .executeUpdate();
        seedRolePermissionDefaults(workspace.id());
    }

    /** P0-4: the effective matrix exists from workspace creation; OWNER rows are true. */
    private void seedRolePermissionDefaults(UUID workspaceId) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.role_permissions
                               (workspace_id, role, permission, allowed)
                        SELECT ?1, d.role, d.permission, d.allowed
                          FROM (VALUES
                                ('OWNER',  'manage_workspace',   true),
                                ('OWNER',  'manage_members',     true),
                                ('OWNER',  'manage_invites',     true),
                                ('OWNER',  'manage_permissions', true),
                                ('OWNER',  'view_audit',         true),
                                ('OWNER',  'manage_security',    true),
                                ('ADMIN',  'manage_workspace',   true),
                                ('ADMIN',  'manage_members',     true),
                                ('ADMIN',  'manage_invites',     true),
                                ('ADMIN',  'manage_permissions', true),
                                ('ADMIN',  'view_audit',         true),
                                ('ADMIN',  'manage_security',    true),
                                ('MEMBER', 'manage_workspace',   false),
                                ('MEMBER', 'manage_members',     false),
                                ('MEMBER', 'manage_invites',     false),
                                ('MEMBER', 'manage_permissions', false),
                                ('MEMBER', 'view_audit',         false),
                                ('MEMBER', 'manage_security',    false)
                          ) AS d(role, permission, allowed)
                        ON CONFLICT (workspace_id, role, permission) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .executeUpdate();
    }

    @Override
    public void updateDetails(UUID workspaceId, String name, String description,
                              UUID logoFileId) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE workspace.workspaces
                           SET name = ?2,
                               description = ?3,
                               logo_file_id = ?4,
                               updated_at = now()
                         WHERE id = ?1
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, name)
                .setParameter(3, description)
                .setParameter(4, logoFileId)
                .executeUpdate();
        if (updated == 0) {
            throw ru.krug.backend.shared.error.DomainException.notFound("Workspace not found");
        }
    }

    @Override
    public void save(Membership membership) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                        VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT (workspace_id, user_id) DO UPDATE
                           SET role = EXCLUDED.role,
                               status = 'ACTIVE',
                               updated_at = now()
                        """)
                .setParameter(1, membership.workspaceId())
                .setParameter(2, membership.userId())
                .setParameter(3, membership.role().name())
                .setParameter(4, membership.status().name())
                .executeUpdate();
    }
}

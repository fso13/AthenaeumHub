package ru.krug.backend.workspace.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.DlpPolicy;

/**
 * Persistence of workspace DLP rules. Every method is tenant-scoped both by RLS
 * ({@code app.workspace_id}) and by an explicit {@code workspace_id} predicate.
 */
public interface DlpPolicyRepository {

    List<DlpPolicy> findAll(UUID workspaceId);

    Optional<DlpPolicy> findById(UUID workspaceId, UUID policyId);

    /**
     * @return true when the name is already used by another rule of this workspace
     *         (case-insensitive); {@code excludeId} is null on create.
     */
    boolean nameTaken(UUID workspaceId, String name, UUID excludeId);

    long count(UUID workspaceId);

    /**
     * @return false when the unique {@code (workspace_id, lower(name))} index won the race
     *         and nothing was inserted.
     */
    boolean insert(DlpPolicy policy);

    /** @return false when the row no longer exists (deleted concurrently). */
    boolean update(DlpPolicy policy);

    boolean delete(UUID workspaceId, UUID policyId);
}

package ru.krug.backend.workspace.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

@Service
public class WorkspaceAccessService implements WorkspaceAccessPort {

    private final WorkspaceRepository workspaceRepository;

    public WorkspaceAccessService(WorkspaceRepository workspaceRepository) {
        this.workspaceRepository = workspaceRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public void requireActiveMember(UUID workspaceId, UUID userId) {
        if (!isActiveMember(workspaceId, userId)) {
            throw DomainException.forbidden("No access to this workspace");
        }
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isActiveMember(UUID workspaceId, UUID userId) {
        return workspaceId != null && userId != null
                && workspaceRepository.isActiveMember(workspaceId, userId);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isGuest(UUID workspaceId, UUID userId) {
        if (workspaceId == null || userId == null) {
            return false;
        }
        return workspaceRepository.findMembership(workspaceId, userId)
                .filter(Membership::isActive)
                .map(membership -> membership.role() == Membership.Role.GUEST)
                .orElse(false);
    }
}

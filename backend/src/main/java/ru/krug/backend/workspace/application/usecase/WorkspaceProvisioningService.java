package ru.krug.backend.workspace.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.workspace.application.command.DevWorkspaceCommand;
import ru.krug.backend.workspace.application.port.WorkspaceProvisioningPort;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

@Service
public class WorkspaceProvisioningService implements WorkspaceProvisioningPort {

    private final WorkspaceRepository workspaceRepository;

    public WorkspaceProvisioningService(WorkspaceRepository workspaceRepository) {
        this.workspaceRepository = workspaceRepository;
    }

    @Override
    @Transactional
    public void ensureDevWorkspace(DevWorkspaceCommand command) {
        Workspace workspace = Workspace.createManagedDev(command.workspaceId(), command.name(),
                command.slug(), command.ownerId());
        workspaceRepository.save(workspace);
        workspaceRepository.save(Membership.owner(command.workspaceId(), command.ownerId()));
    }
}

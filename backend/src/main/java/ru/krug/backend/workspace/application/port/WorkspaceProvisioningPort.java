package ru.krug.backend.workspace.application.port;

import ru.krug.backend.workspace.application.command.DevWorkspaceCommand;

public interface WorkspaceProvisioningPort {

    void ensureDevWorkspace(DevWorkspaceCommand command);
}

package ru.krug.backend.workspace.application.port;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;

/** Published read port for auth's {@code GET /me}; no cross-module SQL. */
public interface WorkspaceDirectoryPort {

    List<WorkspaceMembershipView> listActiveMemberships(UUID userId);
}

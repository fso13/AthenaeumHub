package ru.krug.backend.notification.infrastructure.adapter;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.notification.application.port.WorkspaceLookupPort;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;

/**
 * Resolves a default workspace for workspace-global preferences when the token has no
 * workspace claim. The caller has already activated the user RLS context.
 */
@Component
public class NotificationWorkspaceLookupAdapter implements WorkspaceLookupPort {

    private final WorkspaceDirectoryPort workspaceDirectory;

    public NotificationWorkspaceLookupAdapter(WorkspaceDirectoryPort workspaceDirectory) {
        this.workspaceDirectory = workspaceDirectory;
    }

    @Override
    public Optional<UUID> defaultWorkspace(UUID userId) {
        return workspaceDirectory.listActiveMemberships(userId).stream()
                .map(view -> view.id())
                .findFirst();
    }
}

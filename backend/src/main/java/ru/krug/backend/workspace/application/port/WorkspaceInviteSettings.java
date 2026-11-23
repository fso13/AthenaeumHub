package ru.krug.backend.workspace.application.port;

/**
 * #100 workspace-invite presentation settings. Kept behind a port so application code never
 * depends on Spring configuration.
 */
public interface WorkspaceInviteSettings {

    /**
     * Public SPA origin used to build the clickable invitation link, for example
     * {@code https://chat.example.com}. The token is appended as
     * {@code /workspace-invite/<token>}; the value never contains a secret itself.
     */
    String acceptBaseUrl();
}

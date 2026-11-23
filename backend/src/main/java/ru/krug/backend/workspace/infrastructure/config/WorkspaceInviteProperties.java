package ru.krug.backend.workspace.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import ru.krug.backend.workspace.application.port.WorkspaceInviteSettings;

/**
 * #100 invitation link base. Defaults to the Vite dev origin; deploy sets
 * {@code PUBLIC_URL} so the mail link points at the public SPA.
 */
@ConfigurationProperties(prefix = "krug.workspace-invites")
public record WorkspaceInviteProperties(
        @DefaultValue("http://localhost:5173") String acceptBaseUrl)
        implements WorkspaceInviteSettings {

    @Override
    public String acceptBaseUrl() {
        if (acceptBaseUrl == null || acceptBaseUrl.isBlank()) {
            return "http://localhost:5173";
        }
        return acceptBaseUrl.endsWith("/")
                ? acceptBaseUrl.substring(0, acceptBaseUrl.length() - 1)
                : acceptBaseUrl;
    }
}

package ru.krug.backend.ops.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.command.DevDeviceCommand;
import ru.krug.backend.auth.application.command.DevUserCommand;
import ru.krug.backend.auth.application.port.AuthProvisioningPort;
import ru.krug.backend.chat.application.command.DevChatCommand;
import ru.krug.backend.chat.application.port.ChatProvisioningPort;
import ru.krug.backend.ops.application.command.DevSessionCommand;
import ru.krug.backend.ops.application.model.SessionResult;
import ru.krug.backend.ops.application.port.DevSessionSettings;
import ru.krug.backend.ops.application.service.DevIdentityFactory;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.command.DevWorkspaceCommand;
import ru.krug.backend.workspace.application.port.WorkspaceProvisioningPort;

/**
 * Dev-only bootstrap (SL-01). Orchestrates four contexts through their published ports in
 * one tenant transaction; each context writes only its own tables.
 */
@Service
@Profile({"dev", "test"})
public class DevSessionHandler {

    private static final int MAX_DISPLAY_NAME = 80;

    private final TenantContext tenantContext;
    private final DevIdentityFactory ids;
    private final DevSessionSettings settings;
    private final AuthProvisioningPort authProvisioning;
    private final WorkspaceProvisioningPort workspaceProvisioning;
    private final ChatProvisioningPort chatProvisioning;
    private final TokenIssuer tokenIssuer;

    public DevSessionHandler(TenantContext tenantContext, DevIdentityFactory ids,
                             DevSessionSettings settings, AuthProvisioningPort authProvisioning,
                             WorkspaceProvisioningPort workspaceProvisioning,
                             ChatProvisioningPort chatProvisioning, TokenIssuer tokenIssuer) {
        this.tenantContext = tenantContext;
        this.ids = ids;
        this.settings = settings;
        this.authProvisioning = authProvisioning;
        this.workspaceProvisioning = workspaceProvisioning;
        this.chatProvisioning = chatProvisioning;
        this.tokenIssuer = tokenIssuer;
    }

    @Transactional
    public SessionResult handle(DevSessionCommand command) {
        String displayName = normalizeDisplayName(command.displayName());
        String devKey = ids.devKey(displayName);

        UUID userId = ids.id("user", devKey);
        UUID deviceId = ids.id("device", devKey);
        UUID workspaceId = ids.id("workspace", devKey);
        UUID chatId = ids.id("chat", devKey);

        tenantContext.activate(new Principal(userId, deviceId, workspaceId, command.requestId()));
        authProvisioning.ensureDevUser(new DevUserCommand(userId, ids.emailFor(devKey),
                displayName));
        authProvisioning.ensureDevDevice(new DevDeviceCommand(deviceId, userId));
        workspaceProvisioning.ensureDevWorkspace(new DevWorkspaceCommand(workspaceId, userId,
                settings.workspaceName(), ids.slugFor(devKey)));
        chatProvisioning.ensureDevGroupChat(new DevChatCommand(chatId, workspaceId, userId,
                settings.chatName()));

        IssuedToken token = tokenIssuer.issue(userId, deviceId, workspaceId);
        return new SessionResult(
                token.accessToken(),
                token.expiresAt(),
                new SessionResult.UserView(userId, displayName),
                new SessionResult.DeviceView(deviceId, "WEB"),
                new SessionResult.WorkspaceView(workspaceId, settings.workspaceName(), "MANAGED"),
                new SessionResult.ChatView(chatId, settings.chatName(), "GROUP"));
    }

    private String normalizeDisplayName(String displayName) {
        String name = displayName == null || displayName.isBlank()
                ? settings.defaultDisplayName()
                : displayName.strip();
        if (name.length() > MAX_DISPLAY_NAME) {
            throw DomainException.badRequest("display_name must be at most 80 characters",
                    Map.of("field", "display_name", "max_length", MAX_DISPLAY_NAME));
        }
        return name;
    }
}

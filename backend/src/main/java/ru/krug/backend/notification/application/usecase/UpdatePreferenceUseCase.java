package ru.krug.backend.notification.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.notification.application.model.NotificationPreferenceView;
import ru.krug.backend.notification.application.port.ChatDirectoryPort;
import ru.krug.backend.notification.application.port.WorkspaceLookupPort;
import ru.krug.backend.notification.domain.exception.NotificationAccessDeniedException;
import ru.krug.backend.notification.domain.exception.NotificationPreferenceInvalidException;
import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.NotificationType;
import ru.krug.backend.notification.domain.repository.NotificationPreferenceRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * PATCH /notification-preferences. One row is upserted: the row is always owned by the
 * caller, a chat-scoped row requires ACTIVE membership, and invalid enum/required values
 * map to 422.
 */
@Service
public class UpdatePreferenceUseCase {

    private final TenantContext tenantContext;
    private final NotificationPreferenceRepository preferences;
    private final ChatDirectoryPort chatDirectory;
    private final WorkspaceLookupPort workspaces;
    private final ClockPort clock;

    public UpdatePreferenceUseCase(TenantContext tenantContext,
                                   NotificationPreferenceRepository preferences,
                                   ChatDirectoryPort chatDirectory,
                                   WorkspaceLookupPort workspaces, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.preferences = preferences;
        this.chatDirectory = chatDirectory;
        this.workspaces = workspaces;
        this.clock = clock;
    }

    @Transactional
    public NotificationPreferenceView update(Principal principal, UUID chatId, String type,
                                             String channel, String mode) {
        NotificationType notificationType = parse(NotificationType.class, "type", type);
        Channel parsedChannel = parse(Channel.class, "channel", channel);
        Mode parsedMode = parse(Mode.class, "mode", mode);

        // Activate the user GUC first: chat resolution and the default-workspace lookup
        // both read rows protected by user-scoped RLS policies.
        tenantContext.activate(principal);
        UUID workspaceId = resolveWorkspace(principal, chatId);
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);

        NotificationPreference preference = new NotificationPreference(principal.userId(),
                workspaceId, chatId, notificationType, parsedChannel, parsedMode);
        Instant now = clock.now();
        return NotificationPreferenceView.from(preferences.upsert(preference, now));
    }

    private UUID resolveWorkspace(Principal principal, UUID chatId) {
        if (chatId != null) {
            return chatDirectory.findForMember(chatId, principal.userId())
                    .map(ChatDirectoryPort.ChatDirectory::workspaceId)
                    .orElseThrow(() -> new NotificationAccessDeniedException(
                            "No access to this chat"));
        }
        if (principal.workspaceId() != null) {
            return principal.workspaceId();
        }
        return workspaces.defaultWorkspace(principal.userId())
                .orElseThrow(() -> new NotificationPreferenceInvalidException("workspace_id",
                        null));
    }

    private static <E extends Enum<E>> E parse(Class<E> type, String field, String value) {
        if (value == null || value.isBlank()) {
            throw new NotificationPreferenceInvalidException(field, value);
        }
        try {
            return Enum.valueOf(type, value);
        } catch (IllegalArgumentException ex) {
            throw new NotificationPreferenceInvalidException(field, value);
        }
    }
}

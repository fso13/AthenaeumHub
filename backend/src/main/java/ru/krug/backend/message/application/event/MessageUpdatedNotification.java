package ru.krug.backend.message.application.event;

import java.util.UUID;

import ru.krug.backend.message.application.model.MessageView;

/** After-commit signal for WS {@code message.updated}. Managed-only by construction. */
public record MessageUpdatedNotification(UUID workspaceId, MessageView message) {
}

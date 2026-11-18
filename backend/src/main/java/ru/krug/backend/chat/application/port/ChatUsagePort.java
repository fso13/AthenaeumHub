package ru.krug.backend.chat.application.port;

import java.util.UUID;

import ru.krug.backend.chat.application.model.ChatUsageView;

/** Chat counters consumed by creation limits and {@code GET /workspaces/{id}/limits}. */
public interface ChatUsagePort {

    ChatUsageView usage(UUID workspaceId, UUID userId);
}

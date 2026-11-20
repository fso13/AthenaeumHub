package ru.krug.backend.plugin.application.port;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.plugin.application.model.PluginMessageRef;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Cross-context port for the #95 timeline projection. The plugin application calls it in the
 * same transaction that inserts the poll/task; the implementation delegates to the message
 * context, which allocates the seq, persists the POLL/TASK row, writes the outbox event and
 * schedules the after-commit WS fan-out.
 */
public interface PluginMessagePort {

    UUID createPollMessage(Principal principal, UUID chatId, UUID pollId);

    UUID createTaskMessage(Principal principal, UUID chatId, UUID taskId);

    /** Resolves the message referenced by an idempotency reservation for a replay. */
    Optional<PluginMessageRef> findMessage(Principal principal, UUID messageId);
}

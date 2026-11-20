package ru.krug.backend.plugin.application.model;

import java.util.UUID;

/** Minimal timeline reference returned by the message context for an idempotent replay. */
public record PluginMessageRef(UUID messageId, UUID chatId, UUID pollId, UUID taskId) {
}

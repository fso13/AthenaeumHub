package ru.krug.backend.message.api.dto;

import java.util.List;
import java.util.UUID;

/** OpenAPI {@code ReadMentionsRequest}: mark explicit ids or the whole inbox read. */
public record MarkMentionsReadRequest(List<UUID> ids, Boolean all) {
}

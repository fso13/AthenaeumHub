package ru.krug.backend.file.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /files} query. All optional values arrive as untrusted strings; the list
 * service validates/normalizes them before the repository sees a value.
 */
public record ListFilesQuery(
        Principal principal,
        UUID workspaceId,
        UUID chatId,
        String kind,
        String scanStatus,
        String query,
        String mime,
        String extension,
        String cursor,
        Integer limit) {
}

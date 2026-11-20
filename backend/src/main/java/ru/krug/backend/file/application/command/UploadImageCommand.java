package ru.krug.backend.file.application.command;

import java.util.UUID;

/**
 * Trusted direct-image upload. {@code chatId} is optional: with a chat the caller must be an
 * active participant and the attachment is usable as that chat's cover/avatar; without it the
 * image is owned by the caller in their current/default workspace and is usable as their
 * avatar or as a logo of a workspace they manage.
 */
public record UploadImageCommand(UUID chatId, String filename, String contentType, byte[] bytes) {
}

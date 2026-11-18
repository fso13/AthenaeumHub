package ru.krug.backend.file.application.command;

import java.util.UUID;

import ru.krug.backend.file.application.model.MediaMetadataInput;
import ru.krug.backend.shared.application.model.Principal;

public record InitUploadCommand(
        Principal principal,
        UUID idempotencyKey,
        UUID chatId,
        String filename,
        long size,
        String mime,
        String sha256,
        String encryptionMode,
        MediaMetadataInput media) {

    public static final String IDEMPOTENCY_SCOPE = "POST /uploads";
}

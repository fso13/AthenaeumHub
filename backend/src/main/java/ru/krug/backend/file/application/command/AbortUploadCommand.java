package ru.krug.backend.file.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

public record AbortUploadCommand(
        Principal principal,
        UUID uploadId,
        UUID idempotencyKey) {

    public static final String IDEMPOTENCY_SCOPE = "POST /uploads/{uploadId}/abort";
}

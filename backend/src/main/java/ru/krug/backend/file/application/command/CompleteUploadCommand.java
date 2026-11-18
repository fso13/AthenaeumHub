package ru.krug.backend.file.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

public record CompleteUploadCommand(
        Principal principal,
        UUID uploadId,
        UUID idempotencyKey,
        String sha256,
        int partsCount) {

    public static final String IDEMPOTENCY_SCOPE = "POST /uploads/{uploadId}/complete";
}

package ru.krug.backend.file.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

public record PutPartCommand(
        Principal principal,
        UUID uploadId,
        int partNo,
        String sha256,
        byte[] content) {
}

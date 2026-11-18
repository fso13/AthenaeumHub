package ru.krug.backend.file.application.command;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.file.application.model.FileCandidate;
import ru.krug.backend.shared.application.model.Principal;

public record PreflightCommand(
        Principal principal,
        UUID chatId,
        List<FileCandidate> files) {
}

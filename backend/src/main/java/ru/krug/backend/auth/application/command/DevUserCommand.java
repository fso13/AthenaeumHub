package ru.krug.backend.auth.application.command;

import java.util.UUID;

public record DevUserCommand(UUID userId, String email, String displayName) {
}

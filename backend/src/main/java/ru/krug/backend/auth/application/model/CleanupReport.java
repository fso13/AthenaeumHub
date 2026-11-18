package ru.krug.backend.auth.application.model;

/** Outcome of a cleanup tick; contains counts only (never emails or codes). */
public record CleanupReport(int expiredRows, int deletedKeycloakUsers, int consumedRows) {
}

package ru.krug.backend.workspace.application.command;

/**
 * Transport-independent DLP rule creation input. Literal strings are validated by the
 * application so an invalid action/type/scope produces a 400 instead of an enum parse
 * failure.
 */
public record CreateDlpPolicyCommand(
        String name,
        String action,
        String patternType,
        String pattern,
        String scope,
        Long maxFileSizeBytes,
        Boolean enabled) {
}

package ru.krug.backend.workspace.application.command;

/** Partial DLP rule update; every null field is left unchanged. */
public record UpdateDlpPolicyCommand(
        String name,
        String action,
        String patternType,
        String pattern,
        String scope,
        Long maxFileSizeBytes,
        Boolean enabled) {

    public boolean isEmpty() {
        return name == null && action == null && patternType == null && pattern == null
                && scope == null && maxFileSizeBytes == null && enabled == null;
    }
}

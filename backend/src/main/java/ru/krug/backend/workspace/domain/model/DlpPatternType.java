package ru.krug.backend.workspace.domain.model;

/**
 * DLP pattern semantics. {@code KEYWORD} is a literal case-insensitive substring;
 * {@code PATTERN} adds only the {@code *} wildcard. Neither is a regular expression, so a
 * stored rule cannot cause catastrophic backtracking (P0-3).
 */
public enum DlpPatternType {
    KEYWORD,
    PATTERN
}

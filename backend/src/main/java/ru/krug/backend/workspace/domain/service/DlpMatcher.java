package ru.krug.backend.workspace.domain.service;

import java.util.Locale;

import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;

/**
 * Literal DLP matching. {@code KEYWORD} is a case-insensitive substring; {@code PATTERN}
 * adds only the {@code *} wildcard, matched by a linear two-pointer scan. No regular
 * expression is compiled and no recursive backtracking exists, so a stored rule cannot
 * cause ReDoS even for adversarial patterns such as {@code (a+)+$}.
 */
public final class DlpMatcher {

    private DlpMatcher() {
    }

    public static boolean matches(String text, DlpPolicy policy) {
        if (text == null || text.isEmpty()) {
            return false;
        }
        String haystack = text.toLowerCase(Locale.ROOT);
        String pattern = policy.pattern().toLowerCase(Locale.ROOT);
        return switch (policy.patternType()) {
            case KEYWORD -> haystack.contains(pattern);
            case PATTERN -> wildcardMatches(haystack, pattern);
        };
    }

    /** Wildcard match with {@code *} only; O(text + pattern), iterative, no recursion. */
    static boolean wildcardMatches(String text, String pattern) {
        int textIndex = 0;
        int patternIndex = 0;
        int starIndex = -1;
        int starTextIndex = -1;
        while (textIndex < text.length()) {
            if (patternIndex < pattern.length()
                    && pattern.charAt(patternIndex) == text.charAt(textIndex)) {
                textIndex++;
                patternIndex++;
            } else if (patternIndex < pattern.length()
                    && pattern.charAt(patternIndex) == '*') {
                starIndex = patternIndex;
                starTextIndex = textIndex;
                patternIndex++;
            } else if (starIndex >= 0) {
                patternIndex = starIndex + 1;
                starTextIndex++;
                textIndex = starTextIndex;
            } else {
                return false;
            }
        }
        while (patternIndex < pattern.length() && pattern.charAt(patternIndex) == '*') {
            patternIndex++;
        }
        return patternIndex == pattern.length();
    }
}

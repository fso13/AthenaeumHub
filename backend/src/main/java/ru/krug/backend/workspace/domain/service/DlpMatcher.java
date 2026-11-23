package ru.krug.backend.workspace.domain.service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;

/**
 * Literal DLP matching. {@code KEYWORD} is a case-insensitive substring; {@code PATTERN}
 * adds only the {@code *} wildcard, matched by a linear two-pointer scan. No regular
 * expression is compiled and no recursive backtracking exists, so a stored rule cannot
 * cause ReDoS even for adversarial patterns such as {@code (a+)+$}.
 *
 * <p>Attachment rules are matched against four bounded views of the metadata: the full
 * file name, the base name, the extension (without the dot) and the MIME type. That makes
 * {@code *.exe}, {@code secret} and {@code application/x-msdownload} behave as an
 * administrator expects without ever reading the file bytes.</p>
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

    /** True when any of the supplied values matches the rule; an empty list never matches. */
    public static boolean matchesAny(List<String> values, DlpPolicy policy) {
        if (values == null) {
            return false;
        }
        for (String value : values) {
            if (matches(value, policy)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Bounded, de-duplicated haystacks for an attachment. The values are metadata only;
     * file bytes are never read by a DLP check.
     */
    public static List<String> attachmentHaystacks(String filename, String mimeType) {
        Set<String> values = new LinkedHashSet<>();
        if (filename != null && !filename.isBlank()) {
            String name = filename.strip();
            values.add(name);
            int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
            String base = name.substring(slash + 1);
            values.add(base);
            int dot = base.lastIndexOf('.');
            if (dot > 0 && dot < base.length() - 1) {
                values.add(base.substring(0, dot));
                values.add(base.substring(dot + 1));
            }
        }
        if (mimeType != null && !mimeType.isBlank()) {
            values.add(mimeType.strip());
        }
        return List.copyOf(new ArrayList<>(values));
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

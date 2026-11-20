package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.service.DlpMatcher;

/**
 * Literal DLP matcher: keywords, {@code *} globs and the explicit no-regex property. A
 * catastrophic-backtracking pattern is just text here.
 */
class DlpMatcherTest {

    @Test
    void keywordMatchingIsCaseInsensitiveAndLiteral() {
        DlpPolicy policy = policy("Secret", DlpPatternType.KEYWORD, "TOP-SECRET");
        assertThat(DlpMatcher.matches("here is a top-Secret value", policy)).isTrue();
        assertThat(DlpMatcher.matches("nothing to see", policy)).isFalse();
        // Regex metacharacters are literal, not quantifiers.
        DlpPolicy regexLike = policy("regex", DlpPatternType.KEYWORD, "(a+)+$");
        assertThat(DlpMatcher.matches("literal (a+)+$ text", regexLike)).isTrue();
        assertThat(DlpMatcher.matches("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", regexLike)).isFalse();
    }

    @Test
    void wildcardPatternMatchesAtAnyPosition() {
        DlpPolicy policy = policy("card", DlpPatternType.PATTERN, "*card*");
        assertThat(DlpMatcher.matches("the CARD number", policy)).isTrue();
        assertThat(DlpMatcher.matches("no match", policy)).isFalse();

        assertThat(DlpMatcher.matches("top-secret", policy("p", DlpPatternType.PATTERN,
                "top-*"))).isTrue();
        assertThat(DlpMatcher.matches("prefix-top", policy("p", DlpPatternType.PATTERN,
                "top-*"))).isFalse();
        assertThat(DlpMatcher.matches("anything", policy("p", DlpPatternType.PATTERN, "*")))
                .isTrue();
    }

    @Test
    void adversarialPatternDoesNotBacktrack() {
        DlpPolicy policy = policy("adversarial", DlpPatternType.KEYWORD, "(a+)+$");
        String longText = "a".repeat(200_000);
        long started = System.nanoTime();
        assertThat(DlpMatcher.matches(longText, policy)).isFalse();
        long elapsedMillis = (System.nanoTime() - started) / 1_000_000L;
        assertThat(elapsedMillis).isLessThan(1_000L);
    }

    @Test
    void wildcardScanStaysLinearOnLongText() {
        DlpPolicy policy = policy("glob", DlpPatternType.PATTERN, "*needle*");
        String longText = "a".repeat(200_000) + "needle" + "b".repeat(200_000);
        long started = System.nanoTime();
        assertThat(DlpMatcher.matches(longText, policy)).isTrue();
        long elapsedMillis = (System.nanoTime() - started) / 1_000_000L;
        assertThat(elapsedMillis).isLessThan(1_000L);
    }

    private static DlpPolicy policy(String name, DlpPatternType type, String pattern) {
        return new DlpPolicy(UUID.randomUUID(), UUID.randomUUID(), name, DlpAction.BLOCK,
                type, pattern, true, UUID.randomUUID(), Instant.now(), Instant.now());
    }
}

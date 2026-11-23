package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpPolicy;
import ru.krug.backend.workspace.domain.model.DlpScope;
import ru.krug.backend.workspace.domain.model.DlpSurface;
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

    @Test
    void attachmentHaystacksExposeNameStemExtensionAndMime() {
        assertThat(DlpMatcher.attachmentHaystacks("Quarterly Report.EXE",
                "application/x-msdownload"))
                .containsExactly("Quarterly Report.EXE", "Quarterly Report", "EXE",
                        "application/x-msdownload");
        // A path is reduced to its base name; no directory is ever matched.
        assertThat(DlpMatcher.attachmentHaystacks("/tmp/../../secret.pdf", "application/pdf"))
                .containsExactly("/tmp/../../secret.pdf", "secret.pdf", "secret", "pdf",
                        "application/pdf");
        assertThat(DlpMatcher.attachmentHaystacks("README", null))
                .containsExactly("README");
        assertThat(DlpMatcher.attachmentHaystacks(".env", null))
                .containsExactly(".env");
    }

    @Test
    void attachmentRuleMatchesExtensionAndMimeWithLiteralOrGlob() {
        DlpPolicy executable = policy("exe", DlpPatternType.PATTERN, "*.exe");
        List<String> exe = DlpMatcher.attachmentHaystacks("setup.EXE", null);
        assertThat(DlpMatcher.matchesAny(exe, executable)).isTrue();
        assertThat(DlpMatcher.matchesAny(
                DlpMatcher.attachmentHaystacks("setup.zip", null), executable)).isFalse();

        DlpPolicy mime = policy("mime", DlpPatternType.KEYWORD, "x-msdownload");
        assertThat(DlpMatcher.matchesAny(
                DlpMatcher.attachmentHaystacks("setup.bin", "application/x-msdownload"),
                mime)).isTrue();
    }

    @Test
    void scopeAppliesOnlyToItsOwnSurfaceUnlessAll() {
        assertThat(DlpScope.ALL.appliesTo(DlpSurface.TEXT)).isTrue();
        assertThat(DlpScope.ALL.appliesTo(DlpSurface.ATTACHMENT)).isTrue();
        assertThat(DlpScope.ALL.appliesTo(DlpSurface.PLUGIN)).isTrue();
        assertThat(DlpScope.ATTACHMENT.appliesTo(DlpSurface.ATTACHMENT)).isTrue();
        assertThat(DlpScope.ATTACHMENT.appliesTo(DlpSurface.TEXT)).isFalse();
        assertThat(DlpScope.PLUGIN.appliesTo(DlpSurface.ATTACHMENT)).isFalse();
        assertThat(DlpScope.TEXT.appliesTo(DlpSurface.PLUGIN)).isFalse();
    }

    private static DlpPolicy policy(String name, DlpPatternType type, String pattern) {
        return new DlpPolicy(UUID.randomUUID(), UUID.randomUUID(), name, DlpAction.BLOCK,
                type, pattern, DlpScope.ALL, null, true, UUID.randomUUID(), Instant.now(),
                Instant.now());
    }
}

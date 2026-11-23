package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.service.DlpPolicyRequests;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;
import ru.krug.backend.workspace.domain.model.DlpScope;

/**
 * Bounded literal validation for DLP rules. The critical property is that a regex-looking
 * value is treated as literal text (no Pattern compilation, no ReDoS).
 */
class DlpPolicyRequestsTest {

    @Test
    void acceptsARegularExpressionAsLiteralText() {
        String regex = "(a+)+$";
        assertThat(DlpPolicyRequests.pattern(regex, DlpPatternType.KEYWORD)).isEqualTo(regex);
        assertThat(DlpPolicyRequests.pattern(regex, DlpPatternType.PATTERN)).isEqualTo(regex);
    }

    @Test
    void acceptsAtMostTwentyWildcardsForPatterns() {
        String twenty = "*".repeat(20);
        assertThat(DlpPolicyRequests.pattern(twenty, DlpPatternType.PATTERN))
                .isEqualTo(twenty);

        DomainException tooMany = expectBadRequest(() -> DlpPolicyRequests.pattern(
                "*".repeat(21), DlpPatternType.PATTERN));
        assertThat(tooMany.details()).containsEntry("max_wildcards", 20);
    }

    @Test
    void keywordsMayContainAsterisksLiterally() {
        assertThat(DlpPolicyRequests.pattern("*".repeat(21), DlpPatternType.KEYWORD))
                .isEqualTo("*".repeat(21));
    }

    @Test
    void rejectsBlankControlAndOverlongValues() {
        expectBadRequest(() -> DlpPolicyRequests.name("   "));
        expectBadRequest(() -> DlpPolicyRequests.pattern("line\nbreak",
                DlpPatternType.KEYWORD));
        expectBadRequest(() -> DlpPolicyRequests.name("x".repeat(121)));
        expectBadRequest(() -> DlpPolicyRequests.pattern("x".repeat(201),
                DlpPatternType.KEYWORD));
    }

    @Test
    void parsesActionAndTypeCaseInsensitivelyAndRejectsUnknownLiterals() {
        assertThat(DlpPolicyRequests.action("warn")).isEqualTo(DlpAction.WARN);
        assertThat(DlpPolicyRequests.patternType("pattern"))
                .isEqualTo(DlpPatternType.PATTERN);
        assertThat(DlpPolicyRequests.optionalAction("  ")).isNull();
        assertThat(DlpPolicyRequests.optionalAction("block")).isEqualTo(DlpAction.BLOCK);

        expectBadRequest(() -> DlpPolicyRequests.action("ALERT"));
        expectBadRequest(() -> DlpPolicyRequests.patternType("REGEX"));
        expectBadRequest(() -> DlpPolicyRequests.optionalAction("alert"));
    }

    @Test
    void scopeDefaultsToAllAndRejectsUnknownValues() {
        assertThat(DlpPolicyRequests.scope(null)).isEqualTo(DlpScope.ALL);
        assertThat(DlpPolicyRequests.scope("  ")).isEqualTo(DlpScope.ALL);
        assertThat(DlpPolicyRequests.scope("attachment")).isEqualTo(DlpScope.ATTACHMENT);
        assertThat(DlpPolicyRequests.scope("PLUGIN")).isEqualTo(DlpScope.PLUGIN);
        expectBadRequest(() -> DlpPolicyRequests.scope("MESSAGE"));
    }

    @Test
    void attachmentSizeThresholdIsBoundedAndAttachmentOnly() {
        assertThat(DlpPolicyRequests.maxFileSizeBytes(null)).isNull();
        assertThat(DlpPolicyRequests.maxFileSizeBytes(1_024L)).isEqualTo(1_024L);
        expectBadRequest(() -> DlpPolicyRequests.maxFileSizeBytes(0L));
        expectBadRequest(() -> DlpPolicyRequests.maxFileSizeBytes(
                DlpPolicyRequests.MAX_ATTACHMENT_SIZE_BYTES + 1));

        DlpPolicyRequests.validateMaxFileSizeScope(DlpScope.ATTACHMENT, 10L);
        DlpPolicyRequests.validateMaxFileSizeScope(DlpScope.ALL, 10L);
        expectBadRequest(() -> DlpPolicyRequests.validateMaxFileSizeScope(
                DlpScope.TEXT, 10L));
        expectBadRequest(() -> DlpPolicyRequests.validateMaxFileSizeScope(
                DlpScope.PLUGIN, 10L));
    }

    @Test
    void enabledDefaultsToTrue() {
        assertThat(DlpPolicyRequests.enabled(null)).isTrue();
        assertThat(DlpPolicyRequests.enabled(false)).isFalse();
    }

    private static DomainException expectBadRequest(Runnable action) {
        DomainException exception = org.assertj.core.api.Assertions.catchThrowableOfType(
                action::run, DomainException.class);
        assertThat(exception).isNotNull();
        assertThat(exception.code()).isEqualTo("VALIDATION_FAILED");
        assertThat(exception.details()).isNotEmpty();
        return exception;
    }
}

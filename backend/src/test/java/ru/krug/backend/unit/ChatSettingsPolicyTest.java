package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.domain.service.ChatSettingsPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** D1-BE3 plain-text normalisation/bounds for editable chat settings. */
class ChatSettingsPolicyTest {

    @Test
    void nameIsTrimmedAndInternalWhitespaceIsCollapsed() {
        assertThat(ChatSettingsPolicy.name("  Product   Team \t chat  "))
                .isEqualTo("Product Team chat");
        assertThat(ChatSettingsPolicy.name("Один")).isEqualTo("Один");
    }

    @Test
    void nameRequiresOneTo120CodePoints() {
        assertThat(ChatSettingsPolicy.name("x".repeat(120))).hasSize(120);
        assertThatThrownBy(() -> ChatSettingsPolicy.name("   "))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assert422((DomainException) ex, "name"));
        assertThatThrownBy(() -> ChatSettingsPolicy.name("x".repeat(121)))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assert422((DomainException) ex, "name"));
        // 120 emoji are 240 UTF-16 units but 120 code points -> accepted; PostgreSQL
        // char_length counts code points too.
        assertThat(ChatSettingsPolicy.name("😀".repeat(120)))
                .isEqualTo("😀".repeat(120));
    }

    @Test
    void nameRejectsHtmlAndControlCharacters() {
        for (String bad : new String[]{"<b>chat</b>", "a\u0000b", "a\u202Eb"}) {
            assertThatThrownBy(() -> ChatSettingsPolicy.name(bad))
                    .isInstanceOf(DomainException.class)
                    .satisfies(ex -> assert422((DomainException) ex, "name"));
        }
    }

    @Test
    void descriptionIsNormalisedAndBlankClearsIt() {
        assertThat(ChatSettingsPolicy.description("  first\r\nsecond\rthird  "))
                .isEqualTo("first\nsecond\nthird");
        assertThat(ChatSettingsPolicy.description("   ")).isNull();
        assertThat(ChatSettingsPolicy.description("")).isNull();
        assertThat(ChatSettingsPolicy.description("line\n\ttabbed")).isEqualTo("line\n\ttabbed");
    }

    @Test
    void descriptionIsBoundedTo500CodePoints() {
        assertThat(ChatSettingsPolicy.description("x".repeat(500))).hasSize(500);
        assertThatThrownBy(() -> ChatSettingsPolicy.description("x".repeat(501)))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assert422((DomainException) ex, "description"));
        assertThat(ChatSettingsPolicy.description("😀".repeat(500)))
                .isEqualTo("😀".repeat(500));
    }

    @Test
    void descriptionRejectsHtmlAndControlCharacters() {
        for (String bad : new String[]{"<script>x</script>", "a\u0000b", "a\u202Eb"}) {
            assertThatThrownBy(() -> ChatSettingsPolicy.description(bad))
                    .isInstanceOf(DomainException.class)
                    .satisfies(ex -> assert422((DomainException) ex, "description"));
        }
    }

    @Test
    void e2eeRejectsDescriptionWithDedicatedCode() {
        assertThatThrownBy(() -> ChatSettingsPolicy.requireDescriptionAllowed(true))
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> {
                    DomainException domain = (DomainException) ex;
                    assertThat(domain.category()).isEqualTo(ErrorCategory.UNPROCESSABLE);
                    assertThat(domain.code())
                            .isEqualTo(ErrorCode.CHAT_SETTINGS_E2EE_UNSUPPORTED);
                });
        ChatSettingsPolicy.requireDescriptionAllowed(false);
    }

    private static void assert422(DomainException ex, String field) {
        assertThat(ex.category()).isEqualTo(ErrorCategory.UNPROCESSABLE);
        assertThat(ex.code()).isEqualTo(ErrorCode.VALIDATION_FAILED);
        assertThat(ex.details().get("field")).isEqualTo(field);
    }
}

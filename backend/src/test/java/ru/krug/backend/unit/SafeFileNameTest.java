package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.service.SafeFileName;
import ru.krug.backend.shared.error.DomainException;

/** #83 display-name policy for global files. */
class SafeFileNameTest {

    @Test
    void acceptsOrdinaryNamesAndTrimsSurroundingSpaces() {
        assertThat(SafeFileName.require("  report final.pdf  ")).isEqualTo("report final.pdf");
        assertThat(SafeFileName.require("фото 2026.png")).isEqualTo("фото 2026.png");
    }

    @Test
    void rejectsTraversalSeparatorsControlAndBidiCharacters() {
        for (String name : new String[]{"../escape.txt", "a/b.txt", "a\\b.txt", "..", ".",
                "bad\u0000name.txt", "bad\u0007name.txt", "rlo\u202Etxt"}) {
            assertThatThrownBy(() -> SafeFileName.require(name))
                    .as(name)
                    .isInstanceOf(DomainException.class)
                    .satisfies(error -> assertThat(((DomainException) error).code())
                            .isEqualTo("VALIDATION_FAILED"));
        }
    }

    @Test
    void rejectsEmptyAndOverlongNames() {
        assertThatThrownBy(() -> SafeFileName.require(null)).isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> SafeFileName.require("   ")).isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> SafeFileName.require("a".repeat(SafeFileName.MAX_LENGTH + 1)))
                .isInstanceOf(DomainException.class);
    }
}

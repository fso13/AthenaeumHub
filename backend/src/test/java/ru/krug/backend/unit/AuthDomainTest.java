package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.shared.error.DomainException;

class AuthDomainTest {

    @Test
    void displayNameIsTrimmedAndBounded() {
        assertThat(new DisplayName("  Дмитрий  ").value()).isEqualTo("Дмитрий");
        assertThat(new DisplayName("x".repeat(80)).value()).hasSize(80);
        assertThatThrownBy(() -> new DisplayName(" "))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> new DisplayName("x".repeat(81)))
                .isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> new DisplayName(null))
                .isInstanceOf(DomainException.class);
    }
}

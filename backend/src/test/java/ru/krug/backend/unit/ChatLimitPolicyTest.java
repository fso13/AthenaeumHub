package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.chat.domain.service.ChatLimitPolicy;
import ru.krug.backend.shared.error.DomainException;

class ChatLimitPolicyTest {

    @Test
    void belowTheLimitIsAllowed() {
        ChatLimitPolicy.requireUserCapacity(0, 1);
        ChatLimitPolicy.requireUserCapacity(99, 100);
        ChatLimitPolicy.requireWorkspaceCapacity(999, 1000);
    }

    @Test
    void boundaryIsRejectedWithScopeLimitAndUsed() {
        assertThatThrownBy(() -> ChatLimitPolicy.requireUserCapacity(1, 1))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("CHAT_LIMIT_REACHED");
                    assertThat(ex.details()).containsEntry("scope", "USER")
                            .containsEntry("limit", 1).containsEntry("used", 1L);
                });
        assertThatThrownBy(() -> ChatLimitPolicy.requireWorkspaceCapacity(1000, 1000))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo("CHAT_LIMIT_REACHED");
                    assertThat(ex.details()).containsEntry("scope", "WORKSPACE")
                            .containsEntry("limit", 1000).containsEntry("used", 1000L);
                });
    }
}

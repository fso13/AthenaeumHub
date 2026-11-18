package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;

import org.junit.jupiter.api.Test;

import ru.krug.backend.audit.domain.service.AuditHashChain;

class AuditHashChainTest {

    @Test
    void hashIsDeterministicAndChained() {
        byte[] genesis = new byte[32];
        byte[] first = AuditHashChain.nextHash(genesis, "{\"action\":\"user.provisioned\"}");
        byte[] same = AuditHashChain.nextHash(genesis, "{\"action\":\"user.provisioned\"}");
        byte[] next = AuditHashChain.nextHash(first, "{\"action\":\"workspace.created\"}");

        assertThat(first).hasSize(32).isEqualTo(same);
        assertThat(next).hasSize(32).isNotEqualTo(first);
        assertThat(Arrays.equals(genesis, first)).isFalse();
    }

    @Test
    void rejectsMissingInputs() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> AuditHashChain.nextHash(null, "{}"))
                .isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> AuditHashChain.nextHash(new byte[32], null))
                .isInstanceOf(IllegalArgumentException.class);
    }
}

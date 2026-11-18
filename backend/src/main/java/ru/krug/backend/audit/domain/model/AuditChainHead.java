package ru.krug.backend.audit.domain.model;

import java.util.Arrays;

/**
 * Head of one audit hash chain. The initial hash is 32 zero bytes, matching an empty
 * previous digest.
 */
public record AuditChainHead(String scopeKey, long lastSeq, byte[] lastHash) {

    public static final byte[] GENESIS_HASH = new byte[32];

    public AuditChainHead {
        if (lastSeq < 0) {
            throw new IllegalArgumentException("Audit chain seq must be >= 0");
        }
        lastHash = lastHash == null ? GENESIS_HASH.clone() : lastHash.clone();
    }

    public static AuditChainHead genesis(String scopeKey) {
        return new AuditChainHead(scopeKey, 0, GENESIS_HASH);
    }

    public boolean isGenesis() {
        return lastSeq == 0 && Arrays.equals(lastHash, GENESIS_HASH);
    }
}

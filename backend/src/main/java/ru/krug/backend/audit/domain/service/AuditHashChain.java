package ru.krug.backend.audit.domain.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Pure hash-chain function (SYSTEM-ANALYSIS §6.9). No Spring, no JSON library: the
 * application passes the canonical JSON string.
 */
public final class AuditHashChain {

    private AuditHashChain() {
    }

    public static byte[] nextHash(byte[] previousHash, String canonicalEventJson) {
        if (previousHash == null) {
            throw new IllegalArgumentException("previousHash is required");
        }
        if (canonicalEventJson == null) {
            throw new IllegalArgumentException("canonicalEventJson is required");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(previousHash);
            digest.update(canonicalEventJson.getBytes(StandardCharsets.UTF_8));
            return digest.digest();
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }
}

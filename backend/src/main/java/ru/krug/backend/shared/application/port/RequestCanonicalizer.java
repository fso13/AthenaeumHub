package ru.krug.backend.shared.application.port;

/**
 * Canonical JSON + SHA-256 used for Idempotency-Key request hashing.
 * Implemented in infrastructure so the application layer stays Jackson-free.
 */
public interface RequestCanonicalizer {

    String canonicalize(Object value);

    byte[] sha256(String value);

    String sha256Hex(String value);
}

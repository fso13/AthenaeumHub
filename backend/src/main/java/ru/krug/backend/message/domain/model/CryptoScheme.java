package ru.krug.backend.message.domain.model;

/**
 * Message content scheme (mirrors {@code message.messages.crypto_scheme}). E2EE messages
 * carry no server-readable body: only opaque per-recipient-device envelopes exist.
 */
public enum CryptoScheme {
    MANAGED,
    E2EE_PAIRWISE
}

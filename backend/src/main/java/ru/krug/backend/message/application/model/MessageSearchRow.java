package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One decrypted candidate row from the server-side search query. The adapter only returns
 * live MANAGED plaintext of chats the caller actively belongs to; the service still applies
 * the literal match, snippet and pagination because the body is AES-GCM at rest.
 */
public record MessageSearchRow(
        UUID messageId,
        UUID chatId,
        String chatName,
        long seq,
        UUID senderId,
        String senderDisplayName,
        String text,
        Instant createdAt) {
}

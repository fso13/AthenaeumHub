package ru.krug.backend.chat.application.event;

import java.time.Instant;
import java.util.UUID;

/**
 * In-process notification published inside the read-receipt transaction. Realtime fan-out
 * happens AFTER_COMMIT; receipts are not replayed.
 */
public record ReadReceiptNotification(UUID workspaceId, UUID chatId, UUID userId,
                                      long lastReadSeq, Instant readAt) {
}

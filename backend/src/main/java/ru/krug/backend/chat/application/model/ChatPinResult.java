package ru.krug.backend.chat.application.model;

/**
 * Result of a pin request: {@code created=false} means the message was already pinned (an
 * idempotent repeat that returns 200 and writes no second audit event).
 */
public record ChatPinResult(boolean created, ChatPinView pin) {
}

package ru.krug.backend.message.application.model;

/**
 * PATCH body. {@code version} is optional: when present it is an optimistic lock, when
 * absent the server still increments the version atomically.
 */
public record MessageEditInput(String text, Integer version) {
}

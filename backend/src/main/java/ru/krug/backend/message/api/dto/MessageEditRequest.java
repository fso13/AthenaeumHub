package ru.krug.backend.message.api.dto;

/** OpenAPI {@code MessageEdit}; {@code version} is an optional optimistic lock. */
public record MessageEditRequest(String text, Integer version) {
}

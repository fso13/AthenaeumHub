package ru.krug.backend.message.api.dto;

/** OpenAPI {@code SearchHighlight}: character range in a plain-text search snippet. */
public record SearchHighlightResponse(int start, int end) {
}

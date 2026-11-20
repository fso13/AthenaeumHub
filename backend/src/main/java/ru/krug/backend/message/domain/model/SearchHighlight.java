package ru.krug.backend.message.domain.model;

/** Inclusive-start / exclusive-end range inside a snippet string. */
public record SearchHighlight(int start, int end) {

    public SearchHighlight {
        if (start < 0 || end < start) {
            throw new IllegalArgumentException("invalid highlight range");
        }
    }
}

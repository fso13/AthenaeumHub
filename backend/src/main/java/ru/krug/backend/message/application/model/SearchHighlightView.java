package ru.krug.backend.message.application.model;

/** Caller-facing highlight range inside a search snippet. */
public record SearchHighlightView(int start, int end) {
}

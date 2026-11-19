package ru.krug.backend.plugin.application.model;

import java.util.UUID;

/** Viewer-relative option of a poll. */
public record PollOptionView(UUID id, String text, int position, long votes) {
}

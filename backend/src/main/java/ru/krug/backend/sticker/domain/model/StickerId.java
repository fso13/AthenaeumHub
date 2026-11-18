package ru.krug.backend.sticker.domain.model;

import java.util.Objects;
import java.util.UUID;

/** Sticker identifier value object (E5-B). */
public record StickerId(UUID value) {

    public StickerId {
        Objects.requireNonNull(value, "value");
    }

    public static StickerId of(UUID value) {
        return new StickerId(value);
    }

    public static StickerId of(String value) {
        return new StickerId(UUID.fromString(value));
    }

    @Override
    public String toString() {
        return value.toString();
    }
}

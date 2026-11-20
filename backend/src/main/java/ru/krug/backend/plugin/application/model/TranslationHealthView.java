package ru.krug.backend.plugin.application.model;

/**
 * Health result. {@code status} is {@code OK}, {@code DISABLED} or {@code UNAVAILABLE};
 * {@code latencyMs} is the measured probe duration (0 when no call was made). No provider
 * content is carried.
 */
public record TranslationHealthView(String status, long latencyMs) {

    public static final String OK = "OK";
    public static final String DISABLED = "DISABLED";
    public static final String UNAVAILABLE = "UNAVAILABLE";

    public static TranslationHealthView disabled() {
        return new TranslationHealthView(DISABLED, 0L);
    }
}

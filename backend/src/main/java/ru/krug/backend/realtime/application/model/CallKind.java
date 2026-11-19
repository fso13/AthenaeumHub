package ru.krug.backend.realtime.application.model;

/** Client signalling kinds for a 1:1 call. The wire value is the lowercase name. */
public enum CallKind {
    OFFER("offer"),
    ANSWER("answer"),
    ICE("ice"),
    HANGUP("hangup"),
    BUSY("busy");

    private final String wire;

    CallKind(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** Returns {@code null} for an unknown wire value; callers answer 400 without details. */
    public static CallKind fromWire(String value) {
        if (value == null) {
            return null;
        }
        for (CallKind kind : values()) {
            if (kind.wire.equals(value)) {
                return kind;
            }
        }
        return null;
    }
}

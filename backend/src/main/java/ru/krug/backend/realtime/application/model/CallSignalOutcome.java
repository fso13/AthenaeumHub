package ru.krug.backend.realtime.application.model;

/** Result of a signal after authorisation: delivered to at least one peer session or not. */
public enum CallSignalOutcome {
    RELAYED,
    UNAVAILABLE
}

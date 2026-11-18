package ru.krug.backend.file.domain.model;

/** Quota reservation state machine (SYSTEM-ANALYSIS §6.7). */
public enum ReservationStatus {
    ACTIVE,
    COMMITTED,
    RELEASED,
    EXPIRED;
}

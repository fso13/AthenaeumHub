package ru.krug.backend.notification.domain.model;

/**
 * Notification types from the OpenAPI contract. E6 only produces MESSAGE; MENTION needs a
 * parser (out of scope) and SYSTEM is reserved for later slices.
 */
public enum NotificationType {
    MESSAGE,
    MENTION,
    SYSTEM
}

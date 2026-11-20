package ru.krug.backend.notification.domain.model;

/**
 * Notification types from the OpenAPI contract. E6 produces MESSAGE; #83 produces MENTION
 * (explicit ids and @all); SYSTEM is reserved for later slices.
 */
public enum NotificationType {
    MESSAGE,
    MENTION,
    SYSTEM
}

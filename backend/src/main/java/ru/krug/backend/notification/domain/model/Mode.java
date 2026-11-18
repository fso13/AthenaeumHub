package ru.krug.backend.notification.domain.model;

/**
 * Preference mode. {@code MENTIONS} suppresses ordinary MESSAGE notifications; because E6
 * has no mentions parser it therefore suppresses MESSAGE entirely. MUTE never creates a
 * notification.
 */
public enum Mode {
    ALL,
    MENTIONS,
    MUTE;

    public boolean allows(NotificationType type) {
        return switch (this) {
            case ALL -> true;
            case MENTIONS -> type == NotificationType.MENTION;
            case MUTE -> false;
        };
    }
}

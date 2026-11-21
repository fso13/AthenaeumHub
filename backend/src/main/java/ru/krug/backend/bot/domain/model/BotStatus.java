package ru.krug.backend.bot.domain.model;

/**
 * Bot lifecycle. {@code DISABLED} is the soft delete: the row and its installations stay for
 * history, but the token authenticates nothing. Re-enabling is an explicit OWNER/ADMIN PATCH.
 */
public enum BotStatus {
    ACTIVE, DISABLED
}

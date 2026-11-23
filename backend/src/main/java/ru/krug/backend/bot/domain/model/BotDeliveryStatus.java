package ru.krug.backend.bot.domain.model;

/** Durable delivery lifecycle. Terminal states are {@code DELIVERED} and {@code FAILED}. */
public enum BotDeliveryStatus {
    PENDING, DELIVERED, FAILED
}

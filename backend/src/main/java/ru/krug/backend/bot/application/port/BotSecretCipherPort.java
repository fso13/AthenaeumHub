package ru.krug.backend.bot.application.port;

import java.util.UUID;

/**
 * Reversible encryption for the bot signing secret and the event payload at rest. Both are
 * bound to their owner id with AAD, so a ciphertext cannot be moved between rows.
 */
public interface BotSecretCipherPort {

    byte[] encryptSecret(String rawSecret, UUID botId);

    String decryptSecret(byte[] stored, UUID botId);

    byte[] encryptPayload(String json, UUID deliveryId);

    String decryptPayload(byte[] stored, UUID deliveryId);
}

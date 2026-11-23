package ru.krug.backend.bot.infrastructure.persistence;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * AES-256-GCM for the bot signing secret and the durable event payload at rest.
 *
 * <p>Key material is derived from the content key with distinct domain-separation prefixes,
 * so a payload ciphertext can never be decrypted as a signing secret (and neither can a
 * managed message body). The stored blob is {@code [version][12-byte nonce][ciphertext+tag]};
 * AAD binds it to the bot/delivery id.</p>
 */
@Component
public class BotSecretCipher implements BotSecretCipherPort {

    private static final byte VERSION = 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MIN_KEY_BYTES = 32;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKey secretKey;
    private final SecretKey payloadKey;

    public BotSecretCipher(KrugProperties properties) {
        String material = properties.content().key();
        if (material == null
                || material.getBytes(StandardCharsets.UTF_8).length < MIN_KEY_BYTES) {
            throw new IllegalStateException("krug.content.key must be at least "
                    + MIN_KEY_BYTES + " bytes (set KRUG_CONTENT_KEY)");
        }
        this.secretKey = new SecretKeySpec(
                sha256("bot-signing-secret|" + material), "AES");
        this.payloadKey = new SecretKeySpec(
                sha256("bot-event-payload|" + material), "AES");
    }

    @Override
    public byte[] encryptSecret(String rawSecret, UUID botId) {
        return encrypt(secretKey, rawSecret, "bot.signing_secret|" + botId);
    }

    @Override
    public String decryptSecret(byte[] stored, UUID botId) {
        return decrypt(secretKey, stored, "bot.signing_secret|" + botId);
    }

    @Override
    public byte[] encryptPayload(String json, UUID deliveryId) {
        return encrypt(payloadKey, json, "bot.event_delivery|" + deliveryId);
    }

    @Override
    public String decryptPayload(byte[] stored, UUID deliveryId) {
        return decrypt(payloadKey, stored, "bot.event_delivery|" + deliveryId);
    }

    private static byte[] encrypt(SecretKey key, String plaintext, String aad) {
        if (plaintext == null) {
            return null;
        }
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            RANDOM.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(1 + NONCE_BYTES + ciphertext.length)
                    .put(VERSION)
                    .put(nonce)
                    .put(ciphertext)
                    .array();
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Bot secret encryption failed", ex);
        }
    }

    private static String decrypt(SecretKey key, byte[] stored, String aad) {
        if (stored == null) {
            return null;
        }
        try {
            ByteBuffer buffer = ByteBuffer.wrap(stored);
            if (buffer.get() != VERSION) {
                throw new IllegalStateException("Unsupported bot secret ciphertext version");
            }
            byte[] nonce = new byte[NONCE_BYTES];
            buffer.get(nonce);
            byte[] ciphertext = new byte[buffer.remaining()];
            buffer.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Bot secret decryption failed", ex);
        }
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}

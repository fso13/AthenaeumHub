package ru.krug.backend.message.infrastructure.persistence;

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

import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * Managed-mode body encryption (AES-256-GCM, local key). The DB stores
 * [version][nonce][ciphertext+tag]; AAD binds it to workspace/chat/message.
 * KMS envelope encryption is a later slice.
 */
@Component
public class MessageCipher {

    private static final byte VERSION = 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MIN_KEY_BYTES = 32;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKey key;

    public MessageCipher(KrugProperties properties) {
        String material = properties.content().key();
        if (material == null || material.getBytes(StandardCharsets.UTF_8).length < MIN_KEY_BYTES) {
            throw new IllegalStateException("krug.content.key must be at least "
                    + MIN_KEY_BYTES + " bytes (set KRUG_CONTENT_KEY)");
        }
        this.key = new SecretKeySpec(sha256(material), "AES");
    }

    public byte[] encrypt(String plaintext, String aad) {
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

            ByteBuffer buffer = ByteBuffer.allocate(1 + NONCE_BYTES + ciphertext.length);
            buffer.put(VERSION);
            buffer.put(nonce);
            buffer.put(ciphertext);
            return buffer.array();
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Message encryption failed", ex);
        }
    }

    public String decrypt(byte[] stored, String aad) {
        if (stored == null) {
            return null;
        }
        try {
            ByteBuffer buffer = ByteBuffer.wrap(stored);
            byte version = buffer.get();
            if (version != VERSION) {
                throw new IllegalStateException("Unsupported ciphertext version");
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
            throw new IllegalStateException("Message decryption failed", ex);
        }
    }

    public static String aad(UUID workspaceId, UUID chatId, UUID messageId) {
        return workspaceId + ":" + chatId + ":" + messageId;
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}

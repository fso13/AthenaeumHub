package ru.krug.backend.ops.infrastructure.persistence;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.SmtpPasswordCipherPort;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * AES-256-GCM for the SMTP password at rest, derived from the existing content key. The blob
 * is {@code [version=1][12-byte nonce][ciphertext+tag]} with AAD binding it to the SMTP
 * setting, so a ciphertext copied to another field cannot be decrypted as a valid password.
 * The key is domain-separated from message content and email-code secrets.
 */
@Component
public class SmtpPasswordCipher implements SmtpPasswordCipherPort {

    private static final byte VERSION = 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MIN_KEY_CHARS = 32;
    private static final byte[] AAD =
            "ops.system_settings|smtp_password".getBytes(StandardCharsets.UTF_8);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKey key;

    public SmtpPasswordCipher(KrugProperties properties) {
        String material = properties.content().key();
        if (material == null || material.strip().length() < MIN_KEY_CHARS) {
            throw new IllegalStateException(
                    "krug.content.key must be at least 32 characters for SMTP password encryption");
        }
        this.key = new SecretKeySpec(sha256("ops-system-settings-smtp|" + material.strip()), "AES");
    }

    @Override
    public byte[] encrypt(String plaintext) {
        if (plaintext == null) {
            throw new IllegalArgumentException("SMTP password must not be null");
        }
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            RANDOM.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(AAD);
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(1 + NONCE_BYTES + ciphertext.length)
                    .put(VERSION)
                    .put(nonce)
                    .put(ciphertext)
                    .array();
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("SMTP password encryption failed", ex);
        }
    }

    @Override
    public String decrypt(byte[] stored) {
        if (stored == null || stored.length == 0) {
            return null;
        }
        try {
            ByteBuffer buffer = ByteBuffer.wrap(stored);
            if (buffer.get() != VERSION) {
                throw new IllegalStateException("Unsupported SMTP ciphertext version");
            }
            byte[] nonce = new byte[NONCE_BYTES];
            buffer.get(nonce);
            byte[] ciphertext = new byte[buffer.remaining()];
            buffer.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(AAD);
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("SMTP password decryption failed", ex);
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

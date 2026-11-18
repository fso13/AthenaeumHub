package ru.krug.backend.auth.infrastructure.persistence;

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

import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;

/**
 * AES-256-GCM for the TOTP secret at rest. The stored blob is
 * {@code [version=1][12-byte nonce][ciphertext+tag]}; AAD binds it to the verification row.
 * Key material is domain-separated from the message-content key.
 */
@Component
public class EmailCodeCipher {

    private static final byte VERSION = 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MIN_KEY_CHARS = 32;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final SecretKey key;

    public EmailCodeCipher(AuthBffProperties properties) {
        String material = properties.code().secretKey();
        if (material == null || material.strip().length() < MIN_KEY_CHARS) {
            throw new IllegalStateException(
                    "krug.auth-bff.code.secret-key must be at least 32 characters");
        }
        this.key = new SecretKeySpec(sha256("auth-bff-email-code|" + material.strip()), "AES");
    }

    public byte[] encrypt(String plaintext, UUID verificationId, String email) {
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            RANDOM.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(verificationId, email));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(1 + NONCE_BYTES + ciphertext.length)
                    .put(VERSION)
                    .put(nonce)
                    .put(ciphertext)
                    .array();
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Email-code encryption failed", ex);
        }
    }

    public String decrypt(byte[] stored, UUID verificationId, String email) {
        try {
            ByteBuffer buffer = ByteBuffer.wrap(stored);
            if (buffer.get() != VERSION) {
                throw new IllegalStateException("Unsupported email-code ciphertext version");
            }
            byte[] nonce = new byte[NONCE_BYTES];
            buffer.get(nonce);
            byte[] ciphertext = new byte[buffer.remaining()];
            buffer.get(ciphertext);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(aad(verificationId, email));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Email-code decryption failed", ex);
        }
    }

    private static byte[] aad(UUID verificationId, String email) {
        return ("auth.email_verifications|" + verificationId + "|" + email)
                .getBytes(StandardCharsets.UTF_8);
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

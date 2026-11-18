package ru.krug.backend.auth.domain.service;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;

/**
 * Public, server-side key checks from E2EE-SPEC §3.1/§7.1. The server never derives shared
 * secrets and never decrypts; only Ed25519 verification and SHA-256 are used.
 */
public final class DeviceKeyCrypto {

    public static final String DOMAIN_SPK_SIGNATURE = "Krug/E2EE/v1/spk-signature";
    public static final String DOMAIN_IK_BINDING = "Krug/E2EE/v1/ik-binding";
    public static final String DOMAIN_FINGERPRINT = "Krug/E2EE/v1/fingerprint";

    private static final byte[] ED25519_SPKI_PREFIX = {
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    };

    private DeviceKeyCrypto() {
    }

    /**
     * {@code Ed25519_verify(IK_sig, D_SPKSIG || u8(1) || u16(len(key_id)) || key_id || spk_pub)}.
     */
    public static boolean verifySignedPrekey(byte[] identitySigningKey, String keyId,
                                              byte[] spkPublic, byte[] signature) {
        if (identitySigningKey == null || identitySigningKey.length != 32 || keyId == null
                || spkPublic == null || spkPublic.length != 32 || signature == null
                || signature.length != 64) {
            return false;
        }
        byte[] id = keyId.getBytes(StandardCharsets.UTF_8);
        if (id.length < 1 || id.length > 64) {
            return false;
        }
        byte[] message = new byte[26 + 1 + 2 + id.length + 32];
        int offset = 0;
        byte[] domain = DOMAIN_SPK_SIGNATURE.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(domain, 0, message, offset, domain.length);
        offset += domain.length;
        message[offset++] = 1;
        message[offset++] = (byte) ((id.length >> 8) & 0xFF);
        message[offset++] = (byte) (id.length & 0xFF);
        System.arraycopy(id, 0, message, offset, id.length);
        offset += id.length;
        System.arraycopy(spkPublic, 0, message, offset, 32);
        return verify(identitySigningKey, message, signature);
    }

    /**
     * {@code Ed25519_verify(IK_sig, D_IKBIND || u8(1) || IK_dh || IK_sig)} (88 bytes).
     */
    public static boolean verifyIdentityBinding(byte[] identitySigningKey, byte[] identityDhKey,
                                                 byte[] bindingSignature) {
        if (identitySigningKey == null || identitySigningKey.length != 32
                || identityDhKey == null || identityDhKey.length != 32
                || bindingSignature == null || bindingSignature.length != 64) {
            return false;
        }
        byte[] domain = DOMAIN_IK_BINDING.getBytes(StandardCharsets.US_ASCII);
        byte[] message = new byte[domain.length + 1 + 32 + 32];
        int offset = 0;
        System.arraycopy(domain, 0, message, offset, domain.length);
        offset += domain.length;
        message[offset++] = 1;
        System.arraycopy(identityDhKey, 0, message, offset, 32);
        offset += 32;
        System.arraycopy(identitySigningKey, 0, message, offset, 32);
        return verify(identitySigningKey, message, bindingSignature);
    }

    /** {@code SHA-256(D_FP || IK_sig || IK_dh)} — 32 bytes, base64url for the wire. */
    public static byte[] fingerprint(byte[] identitySigningKey, byte[] identityDhKey) {
        if (identitySigningKey == null || identitySigningKey.length != 32
                || identityDhKey == null || identityDhKey.length != 32) {
            throw new IllegalArgumentException("identity keys must be 32 bytes");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(DOMAIN_FINGERPRINT.getBytes(StandardCharsets.US_ASCII));
            digest.update(identitySigningKey);
            digest.update(identityDhKey);
            return digest.digest();
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }

    /** Key ids accepted by the DDL: 1..64 of {@code [A-Za-z0-9._-]}. */
    public static boolean isValidKeyId(String keyId) {
        if (keyId == null || keyId.isEmpty() || keyId.length() > 64) {
            return false;
        }
        for (int i = 0; i < keyId.length(); i++) {
            char c = keyId.charAt(i);
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == '-')) {
                return false;
            }
        }
        return true;
    }

    private static boolean verify(byte[] rawPublicKey, byte[] message, byte[] signature) {
        try {
            byte[] encoded = new byte[ED25519_SPKI_PREFIX.length + rawPublicKey.length];
            System.arraycopy(ED25519_SPKI_PREFIX, 0, encoded, 0, ED25519_SPKI_PREFIX.length);
            System.arraycopy(rawPublicKey, 0, encoded, ED25519_SPKI_PREFIX.length,
                    rawPublicKey.length);
            PublicKey key = KeyFactory.getInstance("Ed25519")
                    .generatePublic(new X509EncodedKeySpec(encoded));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(message);
            return verifier.verify(signature);
        } catch (GeneralSecurityException | RuntimeException ex) {
            return false;
        }
    }

    public static boolean equals(byte[] left, byte[] right) {
        return Arrays.equals(left, right);
    }
}

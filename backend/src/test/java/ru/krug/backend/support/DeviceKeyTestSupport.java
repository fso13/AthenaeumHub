package ru.krug.backend.support;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.auth.domain.service.DeviceKeyCrypto;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * Test-only key material for E2EE device registration. Uses the JDK Ed25519/X25519
 * providers and the production domain strings/signature messages, so a failure here means
 * the wire/domain contract really changed.
 */
public final class DeviceKeyTestSupport {

    private DeviceKeyTestSupport() {
    }

    public record OneTimeKey(String keyId, byte[] publicKey) {
    }

    public record Material(KeyPair identitySigning, byte[] identitySigningKey,
                           byte[] identityDhKey, byte[] identityBindingSignature,
                           byte[] fingerprint, String spkId, byte[] spkPublicKey,
                           byte[] spkSignature, List<OneTimeKey> oneTimePrekeys) {

        public Material {
            oneTimePrekeys = List.copyOf(oneTimePrekeys);
        }

        public Map<String, Object> registrationBody(String name, String appVersion) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("name", name);
            body.put("platform", "WEB");
            body.put("app_version", appVersion);
            body.put("identity_signing_key", Base64Url.encode(identitySigningKey));
            body.put("identity_dh_key", Base64Url.encode(identityDhKey));
            body.put("identity_binding_signature", Base64Url.encode(identityBindingSignature));
            body.put("identity_key_alg", "Ed25519+X25519");
            body.put("signed_prekey", Map.of(
                    "key_id", spkId,
                    "public_key", Base64Url.encode(spkPublicKey),
                    "signature", Base64Url.encode(spkSignature)));
            body.put("one_time_prekeys", oneTimePrekeys.stream()
                    .map(key -> Map.of("key_id", key.keyId(),
                            "public_key", Base64Url.encode(key.publicKey())))
                    .toList());
            return body;
        }

        /** A fresh SPK (signed by the same IK_sig) plus fresh OPKs for POST /prekeys. */
        public Map<String, Object> prekeyUploadBody(int opkCount, String keyId) {
            byte[] spkPub = rawPublic(x25519());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("signed_prekey", Map.of(
                    "key_id", keyId,
                    "public_key", Base64Url.encode(spkPub),
                    "signature", Base64Url.encode(signSpk(identitySigning, keyId, spkPub))));
            List<Map<String, Object>> opks = new ArrayList<>();
            for (int i = 0; i < opkCount; i++) {
                opks.add(Map.of("key_id", "opk-" + UUID.randomUUID(),
                        "public_key", Base64Url.encode(rawPublic(x25519()))));
            }
            body.put("one_time_prekeys", opks);
            return body;
        }
    }

    public static Material generate() {
        KeyPair identitySigning = ed25519();
        KeyPair identityDh = x25519();
        byte[] ikSig = rawPublic(identitySigning);
        byte[] ikDh = rawPublic(identityDh);
        byte[] spkPub = rawPublic(x25519());
        String spkId = "spk-" + UUID.randomUUID();
        List<OneTimeKey> opks = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            opks.add(new OneTimeKey("opk-" + UUID.randomUUID(), rawPublic(x25519())));
        }
        return new Material(identitySigning, ikSig, ikDh,
                signBinding(identitySigning, ikSig, ikDh),
                DeviceKeyCrypto.fingerprint(ikSig, ikDh), spkId, spkPub,
                signSpk(identitySigning, spkId, spkPub), opks);
    }

    public static Map<String, Object> registrationBody(String name, String appVersion,
                                                       Material material) {
        return material.registrationBody(name, appVersion);
    }

    private static byte[] signSpk(KeyPair identitySigning, String keyId, byte[] spkPublic) {
        byte[] domain = DeviceKeyCrypto.DOMAIN_SPK_SIGNATURE.getBytes(StandardCharsets.US_ASCII);
        byte[] id = keyId.getBytes(StandardCharsets.UTF_8);
        byte[] message = new byte[domain.length + 1 + 2 + id.length + 32];
        int offset = 0;
        System.arraycopy(domain, 0, message, offset, domain.length);
        offset += domain.length;
        message[offset++] = 1;
        message[offset++] = (byte) ((id.length >> 8) & 0xFF);
        message[offset++] = (byte) (id.length & 0xFF);
        System.arraycopy(id, 0, message, offset, id.length);
        offset += id.length;
        System.arraycopy(spkPublic, 0, message, offset, 32);
        return sign(identitySigning, message);
    }

    private static byte[] signBinding(KeyPair identitySigning, byte[] ikSig, byte[] ikDh) {
        byte[] domain = DeviceKeyCrypto.DOMAIN_IK_BINDING.getBytes(StandardCharsets.US_ASCII);
        byte[] message = new byte[domain.length + 1 + 32 + 32];
        int offset = 0;
        System.arraycopy(domain, 0, message, offset, domain.length);
        offset += domain.length;
        message[offset++] = 1;
        System.arraycopy(ikDh, 0, message, offset, 32);
        offset += 32;
        System.arraycopy(ikSig, 0, message, offset, 32);
        return sign(identitySigning, message);
    }

    private static byte[] sign(KeyPair keyPair, byte[] message) {
        try {
            Signature signature = Signature.getInstance("Ed25519");
            signature.initSign(keyPair.getPrivate());
            signature.update(message);
            return signature.sign();
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot sign test key material", ex);
        }
    }

    public static KeyPair ed25519() {
        return generate("Ed25519");
    }

    public static KeyPair x25519() {
        return generate("X25519");
    }

    private static KeyPair generate(String algorithm) {
        try {
            return KeyPairGenerator.getInstance(algorithm).generateKeyPair();
        } catch (Exception ex) {
            throw new IllegalStateException(algorithm + " is unavailable", ex);
        }
    }

    public static byte[] rawPublic(KeyPair keyPair) {
        byte[] encoded = keyPair.getPublic().getEncoded();
        return java.util.Arrays.copyOfRange(encoded, encoded.length - 32, encoded.length);
    }
}

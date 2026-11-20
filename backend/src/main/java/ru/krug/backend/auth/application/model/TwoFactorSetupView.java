package ru.krug.backend.auth.application.model;

/**
 * One-time authenticator setup payload. The secret and otpauth URI are returned exactly
 * once by {@code POST /me/2fa/setup}; neither is ever logged, persisted in plaintext or
 * returned again by any endpoint. {@code qrPayload} is the same otpauth URI encoded into
 * the QR image by the client.
 */
public record TwoFactorSetupView(String secret, String otpauthUri, String qrPayload) {

    @Override
    public String toString() {
        return "TwoFactorSetupView[redacted]";
    }
}

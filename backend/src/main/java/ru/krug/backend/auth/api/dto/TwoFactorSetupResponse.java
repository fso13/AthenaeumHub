package ru.krug.backend.auth.api.dto;

/**
 * One-time authenticator setup payload. {@code qr_payload} is the otpauth URI that the
 * client renders into a QR code; the secret is shown once and never returned again.
 */
public record TwoFactorSetupResponse(String secret, String otpauthUri, String qrPayload) {
}

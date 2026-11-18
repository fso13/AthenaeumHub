package ru.krug.backend.auth.api.dto;

public record SignedPrekeyRequest(String keyId, String publicKey, String signature) {
}

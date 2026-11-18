package ru.krug.backend.auth.application.command;

import java.util.Arrays;

/** Validated (shape) signed prekey upload; cryptographic checks live in the domain. */
public record SignedPrekeyCommand(String keyId, byte[] publicKey, byte[] signature) {

    public SignedPrekeyCommand {
        publicKey = publicKey == null ? null : Arrays.copyOf(publicKey, publicKey.length);
        signature = signature == null ? null : Arrays.copyOf(signature, signature.length);
    }

    @Override
    public byte[] publicKey() {
        return publicKey == null ? null : Arrays.copyOf(publicKey, publicKey.length);
    }

    @Override
    public byte[] signature() {
        return signature == null ? null : Arrays.copyOf(signature, signature.length);
    }
}

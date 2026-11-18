package ru.krug.backend.auth.application.command;

import java.util.Arrays;

public record OneTimePrekeyCommand(String keyId, byte[] publicKey) {

    public OneTimePrekeyCommand {
        publicKey = publicKey == null ? null : Arrays.copyOf(publicKey, publicKey.length);
    }

    @Override
    public byte[] publicKey() {
        return publicKey == null ? null : Arrays.copyOf(publicKey, publicKey.length);
    }
}

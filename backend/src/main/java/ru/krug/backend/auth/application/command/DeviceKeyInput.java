package ru.krug.backend.auth.application.command;

import java.util.Arrays;
import java.util.List;

/**
 * Decoded device key material. {@code anyFieldPresent} is computed from the raw JSON
 * fields, so a partial key set can be rejected as 422 INVALID_KEY_FORMAT.
 */
public record DeviceKeyInput(
        byte[] identitySigningKey,
        byte[] identityDhKey,
        byte[] identityBindingSignature,
        String identityKeyAlg,
        SignedPrekeyCommand signedPrekey,
        List<OneTimePrekeyCommand> oneTimePrekeys,
        boolean anyFieldPresent) {

    public DeviceKeyInput {
        identitySigningKey = identitySigningKey == null ? null
                : Arrays.copyOf(identitySigningKey, identitySigningKey.length);
        identityDhKey = identityDhKey == null ? null
                : Arrays.copyOf(identityDhKey, identityDhKey.length);
        identityBindingSignature = identityBindingSignature == null ? null
                : Arrays.copyOf(identityBindingSignature, identityBindingSignature.length);
        oneTimePrekeys = oneTimePrekeys == null ? List.of() : List.copyOf(oneTimePrekeys);
    }

    public static DeviceKeyInput legacy() {
        return new DeviceKeyInput(null, null, null, null, null, List.of(), false);
    }

    @Override
    public byte[] identitySigningKey() {
        return identitySigningKey == null ? null
                : Arrays.copyOf(identitySigningKey, identitySigningKey.length);
    }

    @Override
    public byte[] identityDhKey() {
        return identityDhKey == null ? null : Arrays.copyOf(identityDhKey, identityDhKey.length);
    }

    @Override
    public byte[] identityBindingSignature() {
        return identityBindingSignature == null ? null
                : Arrays.copyOf(identityBindingSignature, identityBindingSignature.length);
    }
}

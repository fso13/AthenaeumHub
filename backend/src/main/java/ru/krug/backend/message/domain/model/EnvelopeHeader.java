package ru.krug.backend.message.domain.model;

import java.util.Arrays;

/**
 * Double Ratchet header of an opaque envelope ({@code {v:1, dh:b64u32, pn:u32, n:u32}}).
 * Pure value object: the server never interprets the ratchet counters, it only bounds
 * them to the wire format (§4.5).
 */
public record EnvelopeHeader(int v, byte[] dh, long pn, long n) {

    public static final int VERSION = 1;
    public static final int DH_BYTES = 32;
    public static final long MAX_COUNTER = Integer.MAX_VALUE;

    public EnvelopeHeader {
        if (v != VERSION) {
            throw new IllegalArgumentException("header.v must be 1");
        }
        if (dh == null || dh.length != DH_BYTES) {
            throw new IllegalArgumentException("header.dh must be 32 bytes");
        }
        if (pn < 0 || pn > MAX_COUNTER || n < 0 || n > MAX_COUNTER) {
            throw new IllegalArgumentException("header.pn/n must be in 0..2^31-1");
        }
        dh = Arrays.copyOf(dh, dh.length);
    }

    @Override
    public byte[] dh() {
        return Arrays.copyOf(dh, dh.length);
    }
}

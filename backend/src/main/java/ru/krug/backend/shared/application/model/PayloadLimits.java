package ru.krug.backend.shared.application.model;

/**
 * Wire limits shared by transports. The E2EE message body is capped at 512 KiB before
 * JSON parsing (E2EE-SPEC §4.5); the transport enforces it independently of the payload
 * shape so a large body can never reach the parser.
 */
public final class PayloadLimits {

    public static final int MESSAGE_WIRE_BYTES = 524288;

    private PayloadLimits() {
    }
}

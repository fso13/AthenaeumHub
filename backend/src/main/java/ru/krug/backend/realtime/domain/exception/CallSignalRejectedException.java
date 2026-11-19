package ru.krug.backend.realtime.domain.exception;

/**
 * Recoverable rejection of a {@code call.signal} frame. Unlike other WS errors it does not
 * close the connection: a bad call frame must not kill messaging/typing on the same socket.
 * The message is safe to send to the client (never contains SDP or candidate data).
 */
public final class CallSignalRejectedException extends RuntimeException {

    private final String code;
    private final int status;

    private CallSignalRejectedException(String code, String message, int status) {
        super(message, null, false, false);
        this.code = code;
        this.status = status;
    }

    public static CallSignalRejectedException malformed(String message) {
        return new CallSignalRejectedException("WS_FRAME_INVALID", message, 400);
    }

    public static CallSignalRejectedException payloadTooLarge(String message) {
        return new CallSignalRejectedException("CALL_PAYLOAD_TOO_LARGE", message, 413);
    }

    public static CallSignalRejectedException forbidden() {
        return new CallSignalRejectedException("FORBIDDEN",
                "Not an active member of this chat", 403);
    }

    public static CallSignalRejectedException notSupported() {
        return new CallSignalRejectedException("CALL_NOT_SUPPORTED",
                "Calls are not supported for this chat", 422);
    }

    /** A GROUP signalling frame must name its recipients explicitly. */
    public static CallSignalRejectedException recipientsRequired() {
        return new CallSignalRejectedException("CALL_NOT_SUPPORTED",
                "GROUP calls require conference=true and a non-empty recipients list", 422);
    }

    /** Conference metadata is GROUP-only; a DIRECT frame carrying it is malformed. */
    public static CallSignalRejectedException directConference() {
        return new CallSignalRejectedException("WS_FRAME_INVALID",
                "conference/recipients are only valid for GROUP calls", 400);
    }

    public static CallSignalRejectedException rateLimited() {
        return new CallSignalRejectedException("RATE_LIMITED",
                "Too many call signals; retry later", 429);
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }
}

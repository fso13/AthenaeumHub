package ru.krug.backend.bot.application.port;

/**
 * Content-free delivery rejection. {@code reason} is a stable, non-secret token safe to store
 * in {@code last_error} and to log; it never contains the URL, headers or payload.
 */
public final class BotDeliveryException extends RuntimeException {

    private final String reason;
    private final boolean retryable;

    public BotDeliveryException(String reason, boolean retryable) {
        super(reason, null, false, false);
        this.reason = reason;
        this.retryable = retryable;
    }

    public String reason() {
        return reason;
    }

    public boolean retryable() {
        return retryable;
    }
}

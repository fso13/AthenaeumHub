package ru.krug.backend.ops.application.port;

/** SMTP delivery failed for a generic outbound email. The body is never logged. */
public class EmailDeliveryException extends RuntimeException {

    public EmailDeliveryException() {
        super("Email delivery failed", null, false, false);
    }
}

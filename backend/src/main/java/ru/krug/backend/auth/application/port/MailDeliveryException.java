package ru.krug.backend.auth.application.port;

/** SMTP delivery failed. The message (and its code) is never logged. */
public class MailDeliveryException extends RuntimeException {

    public MailDeliveryException() {
        super("Email delivery failed", null, false, false);
    }
}

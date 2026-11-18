package ru.krug.backend.ops.application.port;

/** SMTP test-email delivery failed. The recipient and SMTP secret are never logged here. */
public class TestEmailException extends RuntimeException {

    public TestEmailException() {
        super("Test email delivery failed", null, false, false);
    }
}

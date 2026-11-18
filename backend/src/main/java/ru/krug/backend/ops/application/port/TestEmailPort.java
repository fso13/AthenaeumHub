package ru.krug.backend.ops.application.port;

/** Sends an explicit admin test email through the runtime SMTP adapter. */
public interface TestEmailPort {

    /** @throws TestEmailException when the relay rejects the message */
    void sendTestEmail(String to);
}

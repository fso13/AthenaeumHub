package ru.krug.backend.auth.application.port;

import ru.krug.backend.auth.application.model.EmailCodeMessage;

/** Outbound email port (SMTP in prod, Mailpit in dev, MockMailSender in tests). */
public interface MailPort {

    /** @throws MailDeliveryException when the SMTP relay rejects the message */
    void sendEmailCode(EmailCodeMessage message);
}

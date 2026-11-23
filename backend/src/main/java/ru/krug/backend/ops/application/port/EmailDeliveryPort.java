package ru.krug.backend.ops.application.port;

import ru.krug.backend.ops.application.model.OutboundEmail;

/**
 * Generic SMTP delivery port used outside the auth email-code flow (for example workspace
 * invitations). Implemented by the same SMTP adapter that renders verification codes, so
 * the runtime {@code ops.system_settings} relay / Mailpit configuration is shared.
 *
 * <p>Implementations must never log the recipient, body or any token embedded in it.</p>
 */
public interface EmailDeliveryPort {

    /** @throws EmailDeliveryException when the SMTP relay rejects the message */
    void sendEmail(OutboundEmail email);
}

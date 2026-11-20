package ru.krug.backend.message.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * DLP gate for a MANAGED text message. The workspace implementation evaluates the
 * workspace's enabled rules with literal matching only (never regex), records a
 * content-free event and throws {@code 422 DLP_BLOCKED} for a BLOCK rule. E2EE messages
 * never call this port because the server has no plaintext.
 */
public interface DlpGuardPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException {@code DLP_BLOCKED} when a
     *         BLOCK rule matches; a WARN rule only records an event
     */
    void enforce(Principal principal, UUID chatId, String text);
}

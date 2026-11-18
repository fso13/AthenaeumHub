package ru.krug.backend.ops.application.port;

import java.util.UUID;

import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.shared.application.model.Principal;

public interface IdempotencyPort {

    IdempotencyReservation reserve(Principal principal, String scope, String key,
                                   byte[] requestHash);

    void complete(Principal principal, String scope, String key, byte[] requestHash, int status,
                  UUID resourceId);

    void abandon(Principal principal, String scope, String key);
}

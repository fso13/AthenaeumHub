package ru.krug.backend.auth.infrastructure.session;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.PendingSessionPort;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Single-node in-memory bridge for the registration→verification session. A restart (or a
 * different node) loses the pending token; the account is still verified and the user can
 * sign in with the password, so this is a UX degradation, not a lockout.
 */
@Component
public class InMemoryPendingSessionStore implements PendingSessionPort {

    private record Pending(String refreshToken, Instant expiresAt) {
    }

    private static final int MAX_ENTRIES = 10_000;

    private final ConcurrentHashMap<UUID, Pending> pending = new ConcurrentHashMap<>();
    private final ClockPort clock;

    public InMemoryPendingSessionStore(ClockPort clock) {
        this.clock = clock;
    }

    @Override
    public void store(UUID verificationId, String refreshToken, Instant expiresAt) {
        if (pending.size() > MAX_ENTRIES) {
            Instant now = clock.now();
            pending.entrySet().removeIf(entry -> !now.isBefore(entry.getValue().expiresAt()));
        }
        pending.put(verificationId, new Pending(refreshToken, expiresAt));
    }

    @Override
    public Optional<String> consume(UUID verificationId) {
        Pending value = pending.remove(verificationId);
        if (value == null || !clock.now().isBefore(value.expiresAt())) {
            return Optional.empty();
        }
        return Optional.of(value.refreshToken());
    }

    @Override
    public void discard(UUID verificationId) {
        pending.remove(verificationId);
    }
}

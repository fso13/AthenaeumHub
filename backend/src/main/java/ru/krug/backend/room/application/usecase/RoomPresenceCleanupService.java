package ru.krug.backend.room.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.room.domain.model.RoomPresencePolicy;
import ru.krug.backend.room.domain.repository.RoomRepository;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Physical removal of logically expired presence rows. Reads already ignore stale rows; this
 * bounded cleanup only keeps {@code room.presence} small (there is no durable presence flag
 * to update and no websocket subscription to close).
 */
@Service
public class RoomPresenceCleanupService {

    private final RoomRepository rooms;
    private final ClockPort clock;

    public RoomPresenceCleanupService(RoomRepository rooms, ClockPort clock) {
        this.rooms = rooms;
        this.clock = clock;
    }

    @Transactional
    public int cleanup() {
        return rooms.deleteStalePresence(RoomPresencePolicy.cutoff(clock.now()));
    }
}

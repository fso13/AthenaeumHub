package ru.krug.backend.auth.domain.repository;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.auth.domain.model.UserBlock;
import ru.krug.backend.auth.domain.model.UserBlockMutation;

/**
 * Self-scoped user blocks (#79). Both mutations are idempotent; the SQL function returns
 * {@code UNCHANGED} for a no-op so the application can skip a duplicate audit event.
 */
public interface UserBlockRepository {

    /** Blocked users of the caller, newest first. */
    List<UserBlock> findBlocked(UUID blockerId);

    UserBlockMutation setBlocked(UUID blockerId, UUID blockedId, boolean blocked);
}

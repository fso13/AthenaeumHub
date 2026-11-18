package ru.krug.backend.notification.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.notification.domain.repository.NotificationRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * POST /notifications/read. Only the caller's rows are eligible: the repository filters by
 * user_id and RLS enforces the same rule, so a foreign id is a silent no-op rather than an
 * existence oracle. Marking is idempotent (read_at is only set once).
 */
@Service
public class MarkReadUseCase {

    private static final int MAX_IDS = 100;

    private final TenantContext tenantContext;
    private final NotificationRepository notifications;
    private final ClockPort clock;

    public MarkReadUseCase(TenantContext tenantContext, NotificationRepository notifications,
                           ClockPort clock) {
        this.tenantContext = tenantContext;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Transactional
    public int markRead(Principal principal, List<UUID> ids, boolean all) {
        List<UUID> requested = ids == null ? List.of()
                : ids.stream().filter(java.util.Objects::nonNull).distinct().toList();
        if (!all && requested.isEmpty()) {
            throw DomainException.unprocessable("Either ids or all=true is required",
                    Map.of("field", "ids", "reason", "empty"));
        }
        if (all && !requested.isEmpty()) {
            throw DomainException.unprocessable("ids and all=true are mutually exclusive",
                    Map.of("field", "ids", "reason", "all_conflict"));
        }
        if (requested.size() > MAX_IDS) {
            throw DomainException.unprocessable("At most 100 ids can be marked at once",
                    Map.of("field", "ids", "max", MAX_IDS, "actual", requested.size()));
        }

        tenantContext.activate(principal);
        Instant now = clock.now();
        return all
                ? notifications.markAllRead(principal.userId(), now)
                : notifications.markRead(principal.userId(), requested, now);
    }
}

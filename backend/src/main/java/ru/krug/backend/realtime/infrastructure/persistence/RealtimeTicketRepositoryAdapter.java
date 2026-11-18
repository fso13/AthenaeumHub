package ru.krug.backend.realtime.infrastructure.persistence;

import java.time.Instant;
import java.util.Optional;

import org.springframework.stereotype.Repository;

import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketId;
import ru.krug.backend.realtime.domain.model.TicketTokenHash;
import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;

@Repository
public class RealtimeTicketRepositoryAdapter implements RealtimeTicketRepository {

    private final RealtimeTicketJpaRepository jpaRepository;

    public RealtimeTicketRepositoryAdapter(RealtimeTicketJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    @Override
    public void save(RealtimeTicket ticket) {
        jpaRepository.save(new RealtimeTicketEntity(ticket.id().value(),
                ticket.tokenHash().value(), ticket.userId(), ticket.deviceId(),
                ticket.workspaceId(), ticket.issuedAt(), ticket.expiresAt(),
                ticket.consumedAt()));
    }

    @Override
    public Optional<RealtimeTicket> findByTokenHash(TicketTokenHash tokenHash) {
        return jpaRepository.findByTokenHash(tokenHash.value()).map(RealtimeTicketRepositoryAdapter::toDomain);
    }

    @Override
    public boolean consume(TicketId id, Instant now) {
        return jpaRepository.consume(id.value(), now) > 0;
    }

    @Override
    public int deleteExpired(Instant cutoff, int batchSize) {
        return jpaRepository.deleteExpired(cutoff, batchSize);
    }

    private static RealtimeTicket toDomain(RealtimeTicketEntity entity) {
        return RealtimeTicket.reconstitute(new TicketId(entity.getId()),
                new TicketTokenHash(entity.getTokenHash()), entity.getUserId(),
                entity.getDeviceId(), entity.getWorkspaceId(), entity.getIssuedAt(),
                entity.getExpiresAt(), entity.getConsumedAt());
    }
}

package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.Test;

import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.application.usecase.OpenSessionUseCase;
import ru.krug.backend.realtime.domain.exception.RealtimeTicketInvalidException;
import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketId;
import ru.krug.backend.realtime.domain.model.TicketToken;
import ru.krug.backend.realtime.domain.model.TicketTokenHash;
import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;
import ru.krug.backend.shared.application.port.ClockPort;

class OpenSessionUseCaseTest {

    private static final Instant NOW = Instant.parse("2026-11-16T10:00:00Z");

    private final UUID userId = UUID.randomUUID();
    private final UUID deviceId = UUID.randomUUID();
    private final UUID workspaceId = UUID.randomUUID();
    private final InMemoryTicketRepository repository = new InMemoryTicketRepository();
    private final ClockPort clock = () -> NOW;
    private final OpenSessionUseCase useCase = new OpenSessionUseCase(repository, clock);

    @Test
    void consumesTicketExactlyOnce() {
        TicketToken token = repository.issue(NOW, Duration.ofSeconds(30));

        RealtimeSession first = useCase.open(token.value());
        assertThat(first.userId()).isEqualTo(userId);
        assertThat(first.deviceId()).isEqualTo(deviceId);
        assertThat(first.workspaceId()).isEqualTo(workspaceId);

        assertThatThrownBy(() -> useCase.open(token.value()))
                .isInstanceOf(RealtimeTicketInvalidException.class);
    }

    @Test
    void expiredTicketIsRejected() {
        TicketToken token = repository.issue(NOW.minusSeconds(31), Duration.ofSeconds(30));

        assertThatThrownBy(() -> useCase.open(token.value()))
                .isInstanceOf(RealtimeTicketInvalidException.class);
    }

    @Test
    void unknownAndMalformedTicketsAreRejected() {
        assertThatThrownBy(() -> useCase.open(TicketToken.generate().value()))
                .isInstanceOf(RealtimeTicketInvalidException.class);
        assertThatThrownBy(() -> useCase.open("not-a-ticket"))
                .isInstanceOf(RealtimeTicketInvalidException.class);
        assertThatThrownBy(() -> useCase.open(null))
                .isInstanceOf(RealtimeTicketInvalidException.class);
    }

    @Test
    void concurrentHandshakesHaveExactlyOneWinner() throws Exception {
        TicketToken token = repository.issue(NOW, Duration.ofSeconds(30));
        int attempts = 12;
        ExecutorService executor = Executors.newFixedThreadPool(attempts);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Boolean>> results = new ArrayList<>();
        for (int i = 0; i < attempts; i++) {
            results.add(executor.submit(() -> {
                start.await();
                try {
                    useCase.open(token.value());
                    return true;
                } catch (RealtimeTicketInvalidException ex) {
                    return false;
                }
            }));
        }
        start.countDown();
        int winners = 0;
        for (Future<Boolean> result : results) {
            if (result.get()) {
                winners++;
            }
        }
        executor.shutdownNow();

        assertThat(winners).isEqualTo(1);
    }

    private final class InMemoryTicketRepository implements RealtimeTicketRepository {

        private final Map<TicketTokenHash, RealtimeTicket> byHash = new ConcurrentHashMap<>();
        private final Set<TicketId> consumed = ConcurrentHashMap.newKeySet();

        TicketToken issue(Instant issuedAt, Duration ttl) {
            TicketToken token = TicketToken.generate();
            RealtimeTicket ticket = RealtimeTicket.issue(TicketId.newId(), token.hash(),
                    userId, deviceId, workspaceId, issuedAt, ttl);
            byHash.put(ticket.tokenHash(), ticket);
            return token;
        }

        @Override
        public void save(RealtimeTicket ticket) {
            byHash.put(ticket.tokenHash(), ticket);
        }

        @Override
        public Optional<RealtimeTicket> findByTokenHash(TicketTokenHash tokenHash) {
            return Optional.ofNullable(byHash.get(tokenHash));
        }

        @Override
        public boolean consume(TicketId id, Instant now) {
            return consumed.add(id);
        }

        @Override
        public int deleteExpired(Instant cutoff, int batchSize) {
            return 0;
        }
    }
}

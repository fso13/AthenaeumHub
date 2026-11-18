package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.application.port.EventPublisher;
import ru.krug.backend.ops.application.port.OutboxRelaySettings;
import ru.krug.backend.ops.application.usecase.OutboxRelayService;
import ru.krug.backend.ops.domain.model.OutboxRecord;
import ru.krug.backend.ops.domain.repository.OutboxRepository;
import ru.krug.backend.shared.application.port.WorkerContext;

class OutboxRelayServiceTest {

    private final OutboxRepository repository = mock(OutboxRepository.class);
    private final EventPublisher publisher = mock(EventPublisher.class);
    private final OutboxRelaySettings settings = mock(OutboxRelaySettings.class);
    private final WorkerContext workerContext = mock(WorkerContext.class);

    @Test
    void publishesLockedRowsAndMarksThemPublished() {
        Instant now = Instant.parse("2026-11-16T09:00:00Z");
        UUID workspaceId = UUID.randomUUID();
        UUID aggregateId = UUID.randomUUID();
        OutboxRecord row = new OutboxRecord(11L, workspaceId, "message.created", aggregateId,
                "chat-1");
        when(settings.batchSize()).thenReturn(500);
        when(repository.lockUnpublished(500)).thenReturn(List.of(row));

        OutboxRelayService service = new OutboxRelayService(repository, publisher, settings,
                workerContext, () -> now);

        assertThat(service.publishPending()).isEqualTo(1);
        verify(workerContext).activate(WorkerContext.WorkerRole.OUTBOX_RELAY);
        verify(publisher).publish(11L, "message.created", aggregateId, workspaceId, "chat-1");
        verify(repository).markPublished(11L, now);
    }
}

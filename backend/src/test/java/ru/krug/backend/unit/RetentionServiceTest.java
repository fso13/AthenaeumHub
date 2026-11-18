package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;

import ru.krug.backend.ops.application.model.RetentionReport;
import ru.krug.backend.ops.application.usecase.IdempotencyOutboxRetentionBatch;
import ru.krug.backend.ops.application.usecase.RetentionService;
import ru.krug.backend.realtime.application.usecase.RealtimeTicketRetentionBatch;
import ru.krug.backend.realtime.application.usecase.RealtimeTicketRetentionService;
import ru.krug.backend.shared.application.port.RetentionMetrics;
import ru.krug.backend.shared.application.port.RetentionSettings;

class RetentionServiceTest {

    private final RetentionSettings settings = mock(RetentionSettings.class);
    private final RetentionMetrics metrics = mock(RetentionMetrics.class);

    @Test
    void drainsIdempotencyAndOutboxInBatches() {
        IdempotencyOutboxRetentionBatch batch = mock(IdempotencyOutboxRetentionBatch.class);
        when(settings.batchSize()).thenReturn(2);
        when(batch.deleteIdempotencyBatch()).thenReturn(2, 2, 1);
        when(batch.deleteOutboxBatch()).thenReturn(2, 0);

        RetentionReport report = new RetentionService(batch, settings, metrics).run();

        assertThat(report.idempotencyKeys()).isEqualTo(5);
        assertThat(report.outbox()).isEqualTo(2);
        verify(batch, times(3)).deleteIdempotencyBatch();
        verify(batch, times(2)).deleteOutboxBatch();
        verify(metrics, times(2)).deleted(RetentionService.IDEMPOTENCY_TARGET, 2);
        verify(metrics).deleted(RetentionService.IDEMPOTENCY_TARGET, 1);
        verify(metrics).deleted(RetentionService.OUTBOX_TARGET, 2);
    }

    @Test
    void stopsWhenABatchIsSmallerThanTheBatchSize() {
        IdempotencyOutboxRetentionBatch batch = mock(IdempotencyOutboxRetentionBatch.class);
        when(settings.batchSize()).thenReturn(500);
        when(batch.deleteIdempotencyBatch()).thenReturn(3);
        when(batch.deleteOutboxBatch()).thenReturn(0);

        RetentionReport report = new RetentionService(batch, settings, metrics).run();

        assertThat(report.idempotencyKeys()).isEqualTo(3);
        assertThat(report.outbox()).isZero();
        verify(batch).deleteIdempotencyBatch();
        verify(batch).deleteOutboxBatch();
    }

    @Test
    void ticketRetentionDrainsInBatchesAndRecordsMetrics() {
        RealtimeTicketRetentionBatch batch = mock(RealtimeTicketRetentionBatch.class);
        when(settings.batchSize()).thenReturn(10);
        when(batch.deleteBatch()).thenReturn(10, 4);

        int deleted = new RealtimeTicketRetentionService(batch, settings, metrics).run();

        assertThat(deleted).isEqualTo(14);
        verify(batch, times(2)).deleteBatch();
        verify(metrics).deleted(RealtimeTicketRetentionService.TARGET, 10);
        verify(metrics).deleted(RealtimeTicketRetentionService.TARGET, 4);
    }
}

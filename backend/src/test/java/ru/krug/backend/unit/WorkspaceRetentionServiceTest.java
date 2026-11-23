package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.ops.application.model.FileRetentionBatch;
import ru.krug.backend.ops.application.model.MessageRetentionBatch;
import ru.krug.backend.ops.application.model.RetentionTarget;
import ru.krug.backend.ops.application.model.WorkspaceRetentionReport;
import ru.krug.backend.ops.application.port.ContentRetentionPort;
import ru.krug.backend.ops.application.port.RetentionRunsPort;
import ru.krug.backend.ops.application.port.RetentionTargetDirectory;
import ru.krug.backend.ops.application.usecase.WorkspaceRetentionService;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RetentionMetrics;
import ru.krug.backend.shared.application.port.RetentionSettings;

/** #101 retention batching, idempotence, counters and failure isolation. */
class WorkspaceRetentionServiceTest {

    private static final UUID WS1 = UUID.randomUUID();
    private static final UUID WS2 = UUID.randomUUID();
    private static final Instant NOW = Instant.parse("2026-11-23T03:30:00Z");

    private final RetentionTargetDirectory directory = mock(RetentionTargetDirectory.class);
    private final ContentRetentionPort content = mock(ContentRetentionPort.class);
    private final RetentionRunsPort runs = mock(RetentionRunsPort.class);
    private final RetentionSettings settings = mock(RetentionSettings.class);
    private final RetentionMetrics metrics = mock(RetentionMetrics.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final ClockPort clock = mock(ClockPort.class);

    private WorkspaceRetentionService service;

    @BeforeEach
    void setUp() {
        service = new WorkspaceRetentionService(directory, content, runs, settings, metrics,
                storage, clock);
        when(settings.batchSize()).thenReturn(2);
        when(clock.now()).thenReturn(NOW);
    }

    @Test
    void noTargetsIsANoOp() {
        when(directory.targets(anyInt())).thenReturn(List.of());

        WorkspaceRetentionReport report = service.run();

        assertThat(report).isEqualTo(new WorkspaceRetentionReport(0, 0, 0, 0, 0));
        verify(content, never()).softDeleteMessages(any(), any(), anyInt());
        verify(runs, never()).record(any(), any(), any(), anyInt(), anyInt(), anyInt(),
                anyInt(), anyString(), any());
    }

    @Test
    void drainsMessagesAndFilesInBoundedBatchesAndDeletesObjects() {
        when(directory.targets(anyInt())).thenReturn(List.of(new RetentionTarget(WS1, 30)));
        when(content.softDeleteMessages(eq(WS1), any(), eq(2)))
                .thenReturn(new MessageRetentionBatch(2))
                .thenReturn(new MessageRetentionBatch(1));
        when(content.softDeleteFiles(eq(WS1), any(), eq(2)))
                .thenReturn(new FileRetentionBatch(2, List.of(UUID.randomUUID(),
                        UUID.randomUUID()), List.of("workspaces/w/f1", "workspaces/w/f2")))
                .thenReturn(new FileRetentionBatch(0, List.of(), List.of()));

        WorkspaceRetentionReport report = service.run();

        assertThat(report.workspaces()).isEqualTo(1);
        assertThat(report.messages()).isEqualTo(3);
        assertThat(report.files()).isEqualTo(2);
        assertThat(report.batches()).isEqualTo(4);
        assertThat(report.failedWorkspaces()).isZero();
        verify(storage).delete("workspaces/w/f1");
        verify(storage).delete("workspaces/w/f2");
        verify(metrics).deleted("workspace_messages", 3);
        verify(metrics).deleted("workspace_files", 2);
        verify(runs).record(eq(WS1), eq(NOW), eq(NOW), eq(30), eq(3), eq(2), eq(4),
                eq("COMPLETED"), eq(null));
    }

    @Test
    void cutoffIsDerivedFromPerWorkspaceRetentionDays() {
        when(directory.targets(anyInt())).thenReturn(List.of(new RetentionTarget(WS1, 1)));
        when(content.softDeleteMessages(any(), any(), anyInt()))
                .thenReturn(new MessageRetentionBatch(0));
        when(content.softDeleteFiles(any(), any(), anyInt()))
                .thenReturn(new FileRetentionBatch(0, List.of(), List.of()));

        service.run();

        verify(content).softDeleteMessages(WS1, NOW.minus(Duration.ofDays(1)), 2);
        verify(content).softDeleteFiles(WS1, NOW.minus(Duration.ofDays(1)), 2);
    }

    @Test
    void capsTheBatchesPerWorkspacePerRun() {
        when(directory.targets(anyInt())).thenReturn(List.of(new RetentionTarget(WS1, 30)));
        when(content.softDeleteMessages(eq(WS1), any(), eq(2)))
                .thenReturn(new MessageRetentionBatch(2));

        WorkspaceRetentionReport report = service.run();

        assertThat(report.batches())
                .isEqualTo(WorkspaceRetentionService.MAX_BATCHES_PER_RUN);
        verify(content, times(WorkspaceRetentionService.MAX_BATCHES_PER_RUN))
                .softDeleteMessages(eq(WS1), any(), eq(2));
        // The cap was reached on messages, so no file batch ran in this pass.
        verify(content, never()).softDeleteFiles(any(), any(), anyInt());
    }

    @Test
    void oneFailingWorkspaceDoesNotStopTheOthers() {
        when(directory.targets(anyInt())).thenReturn(List.of(
                new RetentionTarget(WS1, 30), new RetentionTarget(WS2, 30)));
        when(content.softDeleteMessages(eq(WS1), any(), anyInt()))
                .thenThrow(new IllegalStateException("boom"));
        when(content.softDeleteMessages(eq(WS2), any(), anyInt()))
                .thenReturn(new MessageRetentionBatch(1));
        when(content.softDeleteFiles(eq(WS2), any(), anyInt()))
                .thenReturn(new FileRetentionBatch(0, List.of(), List.of()));

        WorkspaceRetentionReport report = service.run();

        assertThat(report.failedWorkspaces()).isEqualTo(1);
        assertThat(report.messages()).isEqualTo(1);
        verify(runs).record(eq(WS1), eq(NOW), eq(NOW), eq(30), eq(0), eq(0), eq(0),
                eq("FAILED"), eq("IllegalStateException"));
        // One message batch + one (empty) file batch.
        verify(runs).record(eq(WS2), eq(NOW), eq(NOW), eq(30), eq(1), eq(0), eq(2),
                eq("COMPLETED"), eq(null));
    }
}

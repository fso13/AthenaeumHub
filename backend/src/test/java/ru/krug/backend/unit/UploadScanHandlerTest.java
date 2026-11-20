package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.file.application.port.MalwareScanPort;
import ru.krug.backend.file.application.port.ObjectStoragePort;
import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.file.application.usecase.UploadScanHandler;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.repository.AttachmentRepository;
import ru.krug.backend.file.domain.repository.UploadRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * #83: the AV verdict is a targeted column update, not a whole-row save. A rename that
 * commits during the scan must survive, and a DELETED row must never be resurrected.
 */
class UploadScanHandlerTest {

    private static final Instant NOW = Instant.parse("2026-01-01T10:00:00Z");
    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID UPLOAD = UUID.randomUUID();
    private static final UUID ATTACHMENT = UUID.randomUUID();

    private WorkerContext workerContext;
    private UploadRepository uploadRepository;
    private AttachmentRepository attachmentRepository;
    private MalwareScanPort scanner;
    private ObjectStoragePort storage;
    private WorkspaceQuotaPort quota;
    private ClockPort clock;
    private UploadScanHandler handler;

    @BeforeEach
    void setUp() {
        workerContext = mock(WorkerContext.class);
        uploadRepository = mock(UploadRepository.class);
        attachmentRepository = mock(AttachmentRepository.class);
        scanner = mock(MalwareScanPort.class);
        storage = mock(ObjectStoragePort.class);
        quota = mock(WorkspaceQuotaPort.class);
        clock = mock(ClockPort.class);
        when(clock.now()).thenReturn(NOW);
        handler = new UploadScanHandler(workerContext, uploadRepository, attachmentRepository,
                scanner, storage, quota, clock);

        Upload upload = Upload.createWorkspaceFile(UPLOAD, WORKSPACE, UUID.randomUUID(),
                "report.pdf", "application/pdf", null, 100, NOW, NOW.plusSeconds(86_400))
                .markScanning(ATTACHMENT, NOW);
        when(uploadRepository.findForUpdateById(UPLOAD)).thenReturn(Optional.of(upload));
        Attachment attachment = Attachment.workspaceFile(ATTACHMENT, WORKSPACE, UPLOAD,
                upload.userId(), "report.pdf", "application/pdf", null, 100,
                Sha256.of("0".repeat(64)), upload.objectKey(), NOW);
        when(attachmentRepository.findByUploadId(UPLOAD)).thenReturn(Optional.of(attachment));
        when(attachmentRepository.updateScanVerdict(eq(ATTACHMENT), any(), any(), any()))
                .thenReturn(1);
    }

    @Test
    void aCleanVerdictUpdatesOnlyTheVerdictColumns() {
        when(scanner.scan(any())).thenReturn(MalwareScanPort.ScanResult.clean("test"));

        handler.scanOne(UPLOAD);

        verify(attachmentRepository).updateScanVerdict(ATTACHMENT, AttachmentStatus.READY,
                ScanStatus.CLEAN, NOW);
        verify(attachmentRepository, never()).save(any());
        ArgumentCaptor<Upload> saved = ArgumentCaptor.forClass(Upload.class);
        verify(uploadRepository).save(saved.capture());
        assertThat(saved.getValue().status().name()).isEqualTo("READY");
    }

    @Test
    void aFileDeletedDuringTheScanIsNotResurrected() {
        when(scanner.scan(any())).thenReturn(MalwareScanPort.ScanResult.clean("test"));
        when(attachmentRepository.updateScanVerdict(eq(ATTACHMENT), any(), any(), any()))
                .thenReturn(0);

        handler.scanOne(UPLOAD);

        ArgumentCaptor<Upload> saved = ArgumentCaptor.forClass(Upload.class);
        verify(uploadRepository).save(saved.capture());
        assertThat(saved.getValue().status().name()).isEqualTo("FAILED");
        verify(quota, never()).releaseCommitted(any(), any(), any());
        verify(storage, never()).delete(any());
    }

    @Test
    void anInfectedVerdictQuarantinesAndReleasesTheCommittedQuota() {
        when(scanner.scan(any())).thenReturn(MalwareScanPort.ScanResult.infected("test",
                "EICAR"));

        handler.scanOne(UPLOAD);

        verify(attachmentRepository).updateScanVerdict(ATTACHMENT,
                AttachmentStatus.QUARANTINED, ScanStatus.INFECTED, NOW);
        verify(quota).releaseCommitted(WORKSPACE, UPLOAD, NOW);
        verify(storage).delete(any());
        verify(uploadRepository, org.mockito.Mockito.atLeastOnce()).save(any());
    }
}

package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.exception.AttachmentNotReadyException;
import ru.krug.backend.file.domain.exception.AttachmentQuarantinedException;
import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.QuotaReservation;
import ru.krug.backend.file.domain.model.ReservationStatus;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;

class FileDomainTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
    private static final Sha256 SHA = Sha256.of("a".repeat(64));

    private static Upload upload(long size, Instant expiresAt) {
        return Upload.create(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), "file.bin", "application/octet-stream", size, SHA, NOW,
                expiresAt);
    }

    @Test
    void uploadLifecycleHonoursTtlAndTerminalStates() {
        Upload upload = upload(10, NOW.plusSeconds(60));
        assertThat(upload.status()).isEqualTo(UploadStatus.INIT);
        assertThat(upload.totalParts()).isEqualTo(1);
        assertThat(upload.expectedPartLength(1)).isEqualTo(10);

        Upload expired = upload(10, NOW.minusSeconds(1));
        assertThatThrownBy(() -> expired.assertAcceptingParts(NOW))
                .isInstanceOf(UploadExpiredException.class);

        Upload uploading = upload.markUploading(NOW.plusSeconds(1));
        assertThat(uploading.status()).isEqualTo(UploadStatus.UPLOADING);
        Upload aborted = uploading.abort(NOW.plusSeconds(2));
        assertThat(aborted.status()).isEqualTo(UploadStatus.ABORTED);
        assertThat(aborted.abort(NOW.plusSeconds(3))).isSameAs(aborted);
        assertThatThrownBy(() -> aborted.assertAcceptingParts(NOW))
                .isInstanceOfAny(UploadExpiredException.class,
                        ru.krug.backend.file.domain.exception.UploadStateException.class);
        assertThat(aborted.expire(NOW.plusSeconds(4)).status())
                .isEqualTo(UploadStatus.ABORTED);
    }

    @Test
    void attachmentRequiresCleanScanBeforeBindAndDownload() {
        Attachment attachment = Attachment.uploaded(UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "file.bin",
                "application/octet-stream", 10, SHA, "key", NOW);

        assertThat(attachment.scanStatus()).isEqualTo(ScanStatus.PENDING);
        assertThatThrownBy(attachment::assertDownloadable)
                .isInstanceOf(AttachmentNotReadyException.class);
        assertThatThrownBy(() -> attachment.bindTo(UUID.randomUUID(), NOW))
                .isInstanceOf(AttachmentNotReadyException.class);

        Attachment clean = attachment.markClean(NOW.plusSeconds(1));
        assertThat(clean.scanStatus()).isEqualTo(ScanStatus.CLEAN);
        clean.assertDownloadable();
        Attachment bound = clean.bindTo(UUID.randomUUID(), NOW.plusSeconds(2));
        assertThat(bound.status()).isEqualTo(AttachmentStatus.BOUND);
        assertThatThrownBy(() -> bound.bindTo(UUID.randomUUID(), NOW))
                .isInstanceOf(AttachmentNotReadyException.class);
    }

    @Test
    void infectedAttachmentIsQuarantinedAndFailClosed() {
        Attachment attachment = Attachment.uploaded(UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), "bad.bin",
                "application/octet-stream", 10, SHA, "key", NOW);
        Attachment infected = attachment.markInfected(NOW.plusSeconds(1));
        assertThat(infected.status()).isEqualTo(AttachmentStatus.QUARANTINED);
        assertThat(infected.scanStatus()).isEqualTo(ScanStatus.INFECTED);
        assertThatThrownBy(infected::assertDownloadable)
                .isInstanceOf(AttachmentQuarantinedException.class);
        assertThatThrownBy(() -> infected.bindTo(UUID.randomUUID(), NOW))
                .isInstanceOf(AttachmentQuarantinedException.class);

        Attachment failed = attachment.markScanFailed(NOW);
        assertThat(failed.status()).isEqualTo(AttachmentStatus.QUARANTINED);
        assertThat(failed.scanStatus()).isEqualTo(ScanStatus.FAILED);
    }

    @Test
    void reservationTransitionsAreGuarded() {
        QuotaReservation active = QuotaReservation.active(UUID.randomUUID(), UUID.randomUUID(),
                UUID.randomUUID(), 10, NOW, NOW.plusSeconds(60));
        assertThat(active.status()).isEqualTo(ReservationStatus.ACTIVE);
        QuotaReservation committed = active.commit(NOW.plusSeconds(1));
        assertThat(committed.status()).isEqualTo(ReservationStatus.COMMITTED);
        QuotaReservation released = committed.release(NOW.plusSeconds(2));
        assertThat(released.status()).isEqualTo(ReservationStatus.RELEASED);
        assertThatThrownBy(() -> committed.commit(NOW))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> committed.expire(NOW))
                .isInstanceOf(IllegalStateException.class);
    }
}

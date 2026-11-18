package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.model.FileSize;
import ru.krug.backend.file.domain.model.FileTypePolicy;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Tariff;
import ru.krug.backend.shared.error.DomainException;

class FileValueObjectsTest {

    @Test
    void fileSizeComputesPartsAndLastChunkLength() {
        int partSize = FileSize.DEFAULT_PART_SIZE;
        assertThat(FileSize.of(10).totalParts(partSize)).isEqualTo(1);
        assertThat(FileSize.of(partSize).totalParts(partSize)).isEqualTo(1);
        assertThat(FileSize.of(partSize + 1L).totalParts(partSize)).isEqualTo(2);
        assertThat(FileSize.of(partSize + 10L).partLength(2, partSize, 2)).isEqualTo(10);
        assertThat(FileSize.of(partSize + 10L).partLength(1, partSize, 2)).isEqualTo(partSize);
        assertThatThrownBy(() -> FileSize.of(0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sha256ValidatesHexAndHashesBytes() {
        assertThat(Sha256.ofBytes(new byte[0]).value())
                .isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assertThat(Sha256.isValid("a".repeat(64))).isTrue();
        assertThat(Sha256.isValid("A".repeat(64))).isFalse();
        assertThatThrownBy(() -> Sha256.of("not-a-hash")).isInstanceOf(DomainException.class);
        assertThat(Sha256.of("A".repeat(64)).value()).isEqualTo("a".repeat(64));
    }

    @Test
    void quotaUsageMovesBetweenReservedAndUsedExactlyOnce() {
        QuotaUsage empty = QuotaUsage.empty();
        assertThat(empty.canReserve(100, 100)).isTrue();
        assertThat(empty.canReserve(101, 100)).isFalse();

        QuotaUsage reserved = empty.reserve(100);
        assertThat(reserved.reserved()).isEqualTo(100);
        assertThat(reserved.canReserve(1, 100)).isFalse();

        QuotaUsage committed = reserved.commit(100);
        assertThat(committed.used()).isEqualTo(100);
        assertThat(committed.reserved()).isZero();

        QuotaUsage released = committed.releaseCommitted(100);
        assertThat(released.used()).isZero();
        assertThatThrownBy(() -> released.releaseCommitted(100))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> empty.releaseReserved(1))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void tariffDefaultsMatchSystemAnalysis() {
        assertThat(Tariff.TEAM.maxFileBytes()).isEqualTo(2L * 1024 * 1024 * 1024);
        assertThat(Tariff.TEAM.storageBytes()).isEqualTo(1024L * 1024 * 1024 * 1024);
        assertThat(Tariff.TEAM.maxAttachments()).isEqualTo(10);
        assertThat(Tariff.TEAM.guestFileBytes()).isEqualTo(500L * 1024 * 1024);
        assertThat(Tariff.from("unknown")).isEqualTo(Tariff.TEAM);
    }

    @Test
    void managedFileTypePolicyIsAnAllowlist() {
        assertThat(FileTypePolicy.check("a.pdf", "application/pdf"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("a.png", "image/png"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("a.zip", "application/zip"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("a.bin", null))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("run.exe", "application/octet-stream"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("page.svg", "image/svg+xml"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("script.sh", "text/plain"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("a.bin", "application/x-unknown"))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
    }
}

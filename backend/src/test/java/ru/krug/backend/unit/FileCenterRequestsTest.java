package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.application.service.FileCenterRequests;
import ru.krug.backend.file.domain.exception.InvalidFileCursorException;
import ru.krug.backend.shared.error.DomainException;

/** #73 file-center request validation/normalization (no database). */
class FileCenterRequestsTest {

    @Test
    void limitDefaultsToFiftyAndStaysInOneToHundred() {
        assertThat(FileCenterRequests.limit(null)).isEqualTo(50);
        assertThat(FileCenterRequests.limit(1)).isEqualTo(1);
        assertThat(FileCenterRequests.limit(100)).isEqualTo(100);
        assertBadRequest(() -> FileCenterRequests.limit(0), "limit");
        assertBadRequest(() -> FileCenterRequests.limit(101), "limit");
        assertBadRequest(() -> FileCenterRequests.limit(-5), "limit");
    }

    @Test
    void queryIsATrimmedLiteralWithABoundedLength() {
        assertThat(FileCenterRequests.query(null)).isNull();
        assertThat(FileCenterRequests.query("   ")).isNull();
        assertThat(FileCenterRequests.query("  Report 2026  ")).isEqualTo("Report 2026");
        assertThat(FileCenterRequests.query("%_")).isEqualTo("%_");
        assertThat(FileCenterRequests.query("x".repeat(200))).hasSize(200);
        assertBadRequest(() -> FileCenterRequests.query("x".repeat(201)), "query");
    }

    @Test
    void parsesClosedKindAndScanStatusEnumsCaseInsensitively() {
        assertThat(FileCenterRequests.kind(null)).isNull();
        assertThat(FileCenterRequests.kind(" ")).isNull();
        assertThat(FileCenterRequests.kind("image")).isEqualTo("IMAGE");
        assertThat(FileCenterRequests.kind("FILE")).isEqualTo("FILE");
        assertBadRequest(() -> FileCenterRequests.kind("ARCHIVE"), "kind");

        assertThat(FileCenterRequests.scanStatus(null)).isNull();
        assertThat(FileCenterRequests.scanStatus("clean")).isEqualTo("CLEAN");
        assertThat(FileCenterRequests.scanStatus("SKIPPED")).isEqualTo("SKIPPED");
        assertBadRequest(() -> FileCenterRequests.scanStatus("MAYBE"), "scan_status");
    }

    @Test
    void validatesExactMimeAndExtensionFilters() {
        assertThat(FileCenterRequests.mime(null)).isNull();
        assertThat(FileCenterRequests.mime("  ")).isNull();
        assertThat(FileCenterRequests.mime(" Application/PDF ")).isEqualTo("application/pdf");
        assertThat(FileCenterRequests.mime("application/vnd.openxmlformats-officedocument"
                + ".wordprocessingml.document"))
                .isEqualTo("application/vnd.openxmlformats-officedocument"
                        + ".wordprocessingml.document");
        assertBadRequest(() -> FileCenterRequests.mime("not a mime"), "mime");
        assertBadRequest(() -> FileCenterRequests.mime("image/"), "mime");

        assertThat(FileCenterRequests.extension(null)).isNull();
        assertThat(FileCenterRequests.extension("  ")).isNull();
        assertThat(FileCenterRequests.extension(" PDF ")).isEqualTo("pdf");
        assertThat(FileCenterRequests.extension(".JPG")).isEqualTo("jpg");
        assertThat(FileCenterRequests.extension("..tar")).isEqualTo("tar");
        assertBadRequest(() -> FileCenterRequests.extension("p df"), "extension");
        assertBadRequest(() -> FileCenterRequests.extension("x".repeat(11)), "extension");
    }

    @Test
    void blankCursorMeansFirstPageAndTamperedCursorIsRejected() {
        UUID workspaceId = UUID.randomUUID();
        assertThat(FileCenterRequests.cursor(null, workspaceId)).isNull();
        assertThat(FileCenterRequests.cursor("   ", workspaceId)).isNull();
        assertThatThrownBy(() -> FileCenterRequests.cursor("nope", workspaceId))
                .isInstanceOf(InvalidFileCursorException.class);
    }

    private void assertBadRequest(Runnable action, String field) {
        assertThatThrownBy(action::run)
                .isInstanceOf(DomainException.class)
                .satisfies(ex -> assertThat(((DomainException) ex).details())
                        .containsEntry("field", field));
    }
}

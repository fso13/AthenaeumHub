package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.file.domain.model.FileTypePolicy;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/** Runtime extension allowlist, M4A and the non-weakenable dangerous block. */
class FileTypePolicySettingsTest {

    @Test
    void defaultsAreSafeBoundedAndContainM4a() {
        AllowedFileExtensions defaults = AllowedFileExtensions.defaults();
        assertThat(defaults.values()).hasSizeBetween(1, AllowedFileExtensions.MAX_ENTRIES);
        assertThat(defaults.values()).contains("m4a", "txt", "pdf", "bin", "webm");
        assertThat(defaults.values()).doesNotContain("exe", "bat", "sh", "html", "svg");
        assertThat(defaults.values()).allMatch(v -> v.matches("[a-z0-9]{1,10}"));
        assertThat(defaults.values()).doesNotHaveDuplicates();
    }

    @Test
    void inputIsNormalizedAndStrictlyValidated() {
        AllowedFileExtensions normalized = new AllowedFileExtensions(
                List.of(" TXT ", "M4A", "Pdf"));
        assertThat(normalized.values()).containsExactly("txt", "m4a", "pdf");

        assertThatThrownBy(() -> new AllowedFileExtensions(List.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 1 and 100");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("jpg", "JPG")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("duplicates");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of(".jpg")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("j png")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("abcdefghijk")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("exe")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("dangerous");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("bat")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("dangerous");
        assertThatThrownBy(() -> new AllowedFileExtensions(List.of("html")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("dangerous");

        List<String> tooMany = new ArrayList<>();
        for (int i = 0; i < AllowedFileExtensions.MAX_ENTRIES + 1; i++) {
            tooMany.add("x" + i);
        }
        assertThatThrownBy(() -> new AllowedFileExtensions(tooMany))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 1 and 100");
    }

    @Test
    void m4aIsAllowedThroughBothMimeSpellings() {
        assertThat(FileTypePolicy.check("interview.m4a", "audio/mp4"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("interview.m4a", "audio/x-m4a"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("interview.m4a", "audio/mp4; codecs=mp4a.40.2"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("interview.m4a", null))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("interview.M4A", "application/octet-stream"))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(MediaMetadata.AUDIO_ALLOWED).contains("audio/mp4", "audio/x-m4a");
    }

    @Test
    void runtimeAllowlistNarrowsAndExtendsTheExtensionGate() {
        AllowedFileExtensions onlyText = new AllowedFileExtensions(List.of("txt"));
        assertThat(FileTypePolicy.check("note.txt", "text/plain", onlyText))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("song.m4a", "audio/mp4", onlyText))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
        assertThat(FileTypePolicy.check("photo.png", "image/png", onlyText))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);

        AllowedFileExtensions withM4a = new AllowedFileExtensions(List.of("txt", "m4a"));
        assertThat(FileTypePolicy.check("song.m4a", "audio/x-m4a", withM4a))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("song.m4a", "audio/mpeg", withM4a))
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
    }

    @Test
    void unknownOrMissingExtensionIsRejectedButMimeStillGates() {
        assertThat(FileTypePolicy.check("payload.xyz", "application/octet-stream"))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
        assertThat(FileTypePolicy.check("payload.xyz", "text/plain"))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
        assertThat(FileTypePolicy.check("README", "text/plain"))
                .as("extensionless files fall back to the MIME allowlist")
                .isEqualTo(FileTypePolicy.Verdict.ALLOWED);
        assertThat(FileTypePolicy.check("README", null))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
        assertThat(FileTypePolicy.check("note.txt", "application/x-unknown"))
                .isEqualTo(FileTypePolicy.Verdict.UNSUPPORTED);
    }

    @Test
    void dangerousBlockCannotBeWeakenedByConfigurationOrMime() {
        assertThat(FileTypePolicy.check("run.exe", "application/octet-stream"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("run.exe", "text/plain"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("page.svg", "image/svg+xml"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("page.svg", "application/octet-stream"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("page.html", "text/plain"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("archive.jar", "application/java-archive"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
        assertThat(FileTypePolicy.check("script.sh", "text/plain"))
                .isEqualTo(FileTypePolicy.Verdict.DANGEROUS);
    }
}

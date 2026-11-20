package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import ru.krug.backend.file.domain.exception.InvalidImageException;
import ru.krug.backend.file.domain.model.ImageFormat;
import ru.krug.backend.file.domain.service.ImageFileName;
import ru.krug.backend.shared.error.DomainException;

/** #92: filename traversal/control rejection and extension-vs-magic policy. */
class ImageFileNameTest {

    @Test
    void acceptsPlainNamesAndCanonicalizesMissingExtension() {
        assertThat(ImageFileName.sanitize("avatar.png")).isEqualTo("avatar.png");
        assertThat(ImageFileName.storedName("photo", ImageFormat.JPEG))
                .isEqualTo("image.jpg");
        assertThat(ImageFileName.storedName("photo.JPEG", ImageFormat.JPEG))
                .isEqualTo("photo.JPEG");
        assertThat(ImageFileName.storedName("", ImageFormat.WEBP)).isEqualTo("image.webp");
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "../secret.png",
            "..\\secret.png",
            "a/b.png",
            "a\\b.png",
            "..",
            ".",
            "bad\u0000name.png",
            "bad\u202Ename.png",
            "line\nbreak.png"
    })
    void rejectsUnsafeNames(String name) {
        assertThatThrownBy(() -> ImageFileName.sanitize(name))
                .isInstanceOf(DomainException.class)
                .satisfies(error -> assertThat(((DomainException) error).category().name())
                        .isEqualTo("BAD_REQUEST"));
    }

    @Test
    void rejectsNameOver255Characters() {
        assertThatThrownBy(() -> ImageFileName.sanitize("a".repeat(252) + ".png"))
                .isInstanceOf(DomainException.class);
    }

    @Test
    void extensionMustMatchDetectedMagic() {
        assertThatThrownBy(() -> ImageFileName.storedName("avatar.jpg", ImageFormat.PNG))
                .isInstanceOf(InvalidImageException.class);
        assertThatThrownBy(() -> ImageFileName.storedName("avatar.txt", ImageFormat.WEBP))
                .isInstanceOf(InvalidImageException.class);
        assertThat(ImageFileName.storedName("avatar.webp", ImageFormat.WEBP))
                .isEqualTo("avatar.webp");
    }
}

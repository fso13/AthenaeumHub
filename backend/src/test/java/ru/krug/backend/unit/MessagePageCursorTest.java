package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import ru.krug.backend.message.application.model.MessagePageCursor;

class MessagePageCursorTest {

    @Test
    void roundTripsAsOpaqueBase64Url() {
        MessagePageCursor cursor = new MessagePageCursor(18422);
        String encoded = cursor.encode();
        assertThat(encoded).doesNotContain("=").doesNotContain("+").doesNotContain("/");
        assertThat(MessagePageCursor.decode(encoded).seq()).isEqualTo(18422);
    }

    @Test
    void rejectsMalformedCursor() {
        assertThatThrownBy(() -> MessagePageCursor.decode("not-base64!!"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MessagePageCursor.decode("e30"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MessagePageCursor.decode(""))
                .isInstanceOf(IllegalArgumentException.class);
    }
}

package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.infrastructure.persistence.MessageEnvelopeRepositoryAdapter;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * E7-B3F3 P2-12: the tolerant read path must skip an unreadable stored envelope instead of
 * failing the page, and its warning must never contain ciphertext bytes.
 */
class MessageEnvelopeRepositoryAdapterTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final UUID MESSAGE = UUID.randomUUID();
    private static final UUID CHAT = UUID.randomUUID();
    private static final UUID RECIPIENT = UUID.randomUUID();
    private static final UUID SENDER = UUID.randomUUID();

    private EntityManager entityManager;
    private Query query;
    private MessageEnvelopeRepositoryAdapter adapter;
    private Logger logger;
    private ListAppender<ILoggingEvent> appender;

    @BeforeEach
    void setUp() {
        entityManager = mock(EntityManager.class);
        query = mock(Query.class);
        when(entityManager.createNativeQuery(anyString())).thenReturn(query);
        when(query.setParameter(anyInt(), any())).thenReturn(query);
        adapter = new MessageEnvelopeRepositoryAdapter(entityManager, new ObjectMapper());
        logger = (Logger) LoggerFactory.getLogger(MessageEnvelopeRepositoryAdapter.class);
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(appender);
        appender.stop();
    }

    @Test
    void findByMessageSkipsCorruptRowsAndNeverLogsCiphertext() {
        byte[] ciphertext = fill(0x42, 272);
        Object[] corruptHeader = row(ciphertext, "{\"v\":1,\"dh\":\"%%%not-base64%%%\"}");
        Object[] corruptShape = row(fill(0x24, 272), validHeader());
        corruptShape[6] = null; // NullPointerException inside the mapper
        Object[] valid = row(ciphertext, validHeader());

        stubRows(List.of(corruptHeader, corruptShape, valid));

        List<MessageEnvelope> result = adapter.findByMessage(WORKSPACE, MESSAGE);

        assertThat(result).hasSize(1);
        assertThat(result.get(0).messageId()).isEqualTo(MESSAGE);
        assertThat(result.get(0).envelope().ciphertext()).isEqualTo(ciphertext);

        assertThat(appender.list).hasSize(2);
        String logs = appender.list.stream().map(ILoggingEvent::getFormattedMessage)
                .reduce("", (left, right) -> left + "\n" + right);
        assertThat(logs).contains("Skipping unreadable envelope")
                .contains(MESSAGE.toString())
                .contains(RECIPIENT.toString())
                .contains("Stored envelope header is invalid");
        // The stored ciphertext must never reach the log, neither b64u nor hex.
        assertThat(logs).doesNotContain(Base64Url.encode(ciphertext));
        assertThat(logs).doesNotContain(java.util.HexFormat.of().formatHex(ciphertext));
        assertThat(logs).doesNotContain("QkJCQkJC");
    }

    @Test
    void findForDeviceSkipsUnreadableRowAndKeepsTheValidOne() {
        Object[] corrupt = row(fill(0x24, 272), "{\"v\":1,\"dh\":\"short\"}");
        Object[] valid = row(fill(0x11, 272), validHeader());
        stubRows(List.of(corrupt, valid));

        Map<UUID, MessageEnvelope> result = adapter.findForDevice(WORKSPACE,
                List.of(MESSAGE), RECIPIENT);

        assertThat(result).containsOnlyKeys(MESSAGE);
        assertThat(result.get(MESSAGE).envelope().recipientDeviceId()).isEqualTo(RECIPIENT);
        assertThat(appender.list).hasSize(1);
        assertThat(appender.list.get(0).getFormattedMessage())
                .contains("Skipping unreadable envelope");
    }

    private void stubRows(List<Object[]> rows) {
        @SuppressWarnings("unchecked")
        List<Object[]> typed = new ArrayList<>(rows);
        when(query.getResultList()).thenReturn(typed);
    }

    private static Object[] row(byte[] ciphertext, String header) {
        return new Object[] {
                MESSAGE, WORKSPACE, CHAT, RECIPIENT, SENDER, "PAIRWISE_X3DH_DR",
                1, 1, fill(0x07, 16), header, ciphertext, null,
                Timestamp.from(Instant.now())
        };
    }

    private static String validHeader() {
        return "{\"v\":1,\"dh\":\"" + Base64Url.encode(fill(0x33, 32))
                + "\",\"pn\":0,\"n\":0}";
    }

    private static byte[] fill(int value, int length) {
        byte[] bytes = new byte[length];
        java.util.Arrays.fill(bytes, (byte) value);
        return bytes;
    }
}

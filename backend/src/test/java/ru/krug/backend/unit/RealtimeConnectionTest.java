package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.infrastructure.ws.OutboundFrame;
import ru.krug.backend.realtime.infrastructure.ws.RealtimeConnection;

class RealtimeConnectionTest {

    @Test
    void slowConsumerIsClosedWith1013WithoutBlockingOtherWork() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        WebSocketSession session = org.mockito.Mockito.mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        CountDownLatch sendStarted = new CountDownLatch(1);
        CountDownLatch releaseSend = new CountDownLatch(1);
        doAnswer(invocation -> {
            sendStarted.countDown();
            releaseSend.await(3, TimeUnit.SECONDS);
            return null;
        }).when(session).sendMessage(any(WebSocketMessage.class));

        RealtimeConnection connection = new RealtimeConnection(
                RealtimeSession.open(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                        Instant.now()), session, 256, executor);
        UUID chatId = UUID.randomUUID();
        connection.enqueue(durable(chatId, 1));
        assertThat(sendStarted.await(2, TimeUnit.SECONDS)).isTrue();

        for (long seq = 2; seq <= 257; seq++) {
            connection.enqueue(durable(chatId, seq));
        }
        connection.enqueue(durable(chatId, 258));
        releaseSend.countDown();

        ArgumentCaptor<CloseStatus> close = ArgumentCaptor.forClass(CloseStatus.class);
        verify(session, timeout(3000)).close(close.capture());
        assertThat(close.getValue().getCode()).isEqualTo(1013);
        assertThat(close.getValue().getReason()).contains("SLOW_CONSUMER");
        executor.shutdownNow();
    }

    private static OutboundFrame durable(UUID chatId, long seq) {
        return OutboundFrame.text("{\"seq\":" + seq + "}", false, chatId, seq);
    }
}

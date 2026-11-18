package ru.krug.backend.realtime.infrastructure.ws;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Virtual threads keep a blocking send for one slow client from starving fan-out to other
 * connections; the queue itself enforces the 256-frame bound.
 */
@Configuration
public class RealtimeExecutorConfig {

    @Bean(name = "realtimeWriterExecutor", destroyMethod = "close")
    public ExecutorService realtimeWriterExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }
}

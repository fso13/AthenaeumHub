package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;

/** Two concurrent inits cannot both pass used+reserved+new <= limit. */
@ActiveProfiles("test")
class FileQuotaRaceIT extends FileUploadTestSupport {

    @Test
    void concurrentInitReservesQuotaExactlyOnce() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID workspaceId = session.workspace().id();
        setLimits(workspaceId, 2000, 1000, 10);
        byte[] data = randomBytes(600);

        int attempts = 2;
        ExecutorService pool = Executors.newFixedThreadPool(attempts);
        CountDownLatch ready = new CountDownLatch(attempts);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<MvcResult>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < attempts; i++) {
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    start.await(5, TimeUnit.SECONDS);
                    return init(session, chatId, "race.bin", data, "application/octet-stream");
                }));
            }
            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();

            List<Integer> statuses = new ArrayList<>();
            for (Future<MvcResult> future : futures) {
                MvcResult result = future.get(20, TimeUnit.SECONDS);
                statuses.add(result.getResponse().getStatus());
                if (result.getResponse().getStatus() == 409) {
                    assertThat(json(result).get("code").asText()).isEqualTo("QUOTA_EXCEEDED");
                }
            }
            assertThat(statuses).containsExactlyInAnyOrder(201, 409);
        } finally {
            pool.shutdownNow();
        }

        Map<String, Object> usage = usage(workspaceId);
        assertThat(((Number) usage.get("reserved_bytes")).longValue()).isEqualTo(600);
        assertThat(((Number) usage.get("used_bytes")).longValue()).isZero();
        Integer reservations = migrator().queryForObject(
                "SELECT count(*) FROM file.quota_reservations WHERE workspace_id = ?"
                        + " AND status = 'ACTIVE'", Integer.class, workspaceId);
        assertThat(reservations).isEqualTo(1);
    }
}

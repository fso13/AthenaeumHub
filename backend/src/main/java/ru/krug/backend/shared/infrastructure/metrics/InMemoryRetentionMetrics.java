package ru.krug.backend.shared.infrastructure.metrics;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.LongAdder;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import ru.krug.backend.shared.application.port.RetentionMetrics;

/**
 * In-process retention counters plus structured logs. No HTTP surface and no new runtime
 * dependency; the port can be backed by Micrometer when observability is added.
 */
@Component
public class InMemoryRetentionMetrics implements RetentionMetrics {

    private static final Logger log = LoggerFactory.getLogger(InMemoryRetentionMetrics.class);

    private final ConcurrentMap<String, LongAdder> totals = new ConcurrentHashMap<>();

    @Override
    public void deleted(String target, int count) {
        if (count <= 0) {
            return;
        }
        LongAdder adder = totals.computeIfAbsent(target, ignored -> new LongAdder());
        adder.add(count);
        log.info("retention.deleted target={} count={} total={}", target, count, adder.sum());
    }

    @Override
    public long totalDeleted(String target) {
        LongAdder adder = totals.get(target);
        return adder == null ? 0 : adder.sum();
    }
}

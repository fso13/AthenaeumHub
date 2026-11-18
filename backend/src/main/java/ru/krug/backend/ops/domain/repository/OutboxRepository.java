package ru.krug.backend.ops.domain.repository;

import java.time.Instant;
import java.util.List;

import ru.krug.backend.ops.domain.model.OutboxMessage;
import ru.krug.backend.ops.domain.model.OutboxRecord;

public interface OutboxRepository {

    void save(OutboxMessage message);

    List<OutboxRecord> lockUnpublished(int batchSize);

    void markPublished(long id, Instant at);

    /**
     * Deletes one batch of already-published rows older than the retention cutoff. Runs
     * under the explicit retention worker role so it can span tenants.
     */
    int deletePublishedBefore(Instant cutoff, int batchSize);
}

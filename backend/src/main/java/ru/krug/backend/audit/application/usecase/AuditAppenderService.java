package ru.krug.backend.audit.application.usecase;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.audit.domain.model.AuditChainHead;
import ru.krug.backend.audit.domain.model.AuditEvent;
import ru.krug.backend.audit.domain.repository.AuditRepository;
import ru.krug.backend.audit.domain.service.AuditHashChain;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;

/**
 * Appends one audit event in the caller's transaction. The chain head is locked per scope,
 * so seq is monotonic and the hash chain is never forked.
 */
@Service
public class AuditAppenderService implements AuditPort {

    private final AuditRepository repository;
    private final RequestCanonicalizer canonicalizer;
    private final ClockPort clock;

    public AuditAppenderService(AuditRepository repository,
                                RequestCanonicalizer canonicalizer,
                                ClockPort clock) {
        this.repository = repository;
        this.canonicalizer = canonicalizer;
        this.clock = clock;
    }

    @Override
    @Transactional
    public void append(AuditRecord record) {
        String scopeKey = record.workspaceId() != null
                ? "workspace:" + record.workspaceId()
                : "user:" + record.actorId();
        AuditChainHead head = repository.lockOrCreate(scopeKey);
        long seq = head.lastSeq() + 1;
        Instant now = record.occurredAt() == null ? clock.now() : record.occurredAt();
        UUID eventId = UUID.randomUUID();

        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("id", eventId.toString());
        canonical.put("scope_key", scopeKey);
        canonical.put("workspace_id", record.workspaceId() == null
                ? null : record.workspaceId().toString());
        canonical.put("seq", seq);
        canonical.put("actor_type", "USER");
        canonical.put("actor_id", record.actorId().toString());
        canonical.put("action", record.action());
        canonical.put("target_type", record.targetType());
        canonical.put("target_id", record.targetId() == null
                ? null : record.targetId().toString());
        canonical.put("request_id", record.requestId());
        canonical.put("metadata", record.metadata());
        canonical.put("created_at", now.toString());

        byte[] hash = AuditHashChain.nextHash(head.lastHash(),
                canonicalizer.canonicalize(canonical));
        repository.append(new AuditEvent(eventId, scopeKey, record.workspaceId(), seq, "USER",
                record.actorId(), record.action(), record.targetType(), record.targetId(),
                record.requestId(), record.metadata(), head.lastHash(), hash, now));
        repository.updateHead(scopeKey, seq, hash);
    }
}

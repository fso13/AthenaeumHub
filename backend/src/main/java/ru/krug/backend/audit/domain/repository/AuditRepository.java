package ru.krug.backend.audit.domain.repository;

import ru.krug.backend.audit.domain.model.AuditChainHead;
import ru.krug.backend.audit.domain.model.AuditEvent;

public interface AuditRepository {

    /**
     * Creates the chain row on first use and locks it FOR UPDATE for the caller's
     * transaction (one writer per scope).
     */
    AuditChainHead lockOrCreate(String scopeKey);

    void append(AuditEvent event);

    void updateHead(String scopeKey, long lastSeq, byte[] lastHash);
}

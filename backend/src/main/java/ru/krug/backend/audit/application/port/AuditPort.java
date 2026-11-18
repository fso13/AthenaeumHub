package ru.krug.backend.audit.application.port;

import ru.krug.backend.audit.application.model.AuditRecord;

/**
 * Published append port. Joins the caller's transaction so the audit row and the domain
 * change commit or roll back together.
 */
public interface AuditPort {

    void append(AuditRecord record);
}

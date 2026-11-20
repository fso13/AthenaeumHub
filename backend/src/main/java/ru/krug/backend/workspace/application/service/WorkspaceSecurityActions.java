package ru.krug.backend.workspace.application.service;

/** Audit action names owned by the P0-3 workspace security surface. */
public final class WorkspaceSecurityActions {

    public static final String SECURITY_UPDATED = "workspace.security.updated";
    public static final String DLP_POLICY_CREATED = "workspace.dlp.policy.created";
    public static final String DLP_POLICY_UPDATED = "workspace.dlp.policy.updated";
    public static final String DLP_POLICY_DELETED = "workspace.dlp.policy.deleted";
    public static final String AUDIT_EXPORTED = "workspace.audit.exported";
    public static final String SESSION_REVOKED = "workspace.session.revoked";
    public static final String SESSIONS_REVOKED_ALL = "workspace.sessions.revoked_all";

    private WorkspaceSecurityActions() {
    }
}

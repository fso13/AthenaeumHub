package ru.krug.backend.shared.application.port;

import ru.krug.backend.shared.application.model.Principal;

/**
 * Activates the transaction-local RLS context (app.user_id/app.workspace_id/app.request_id).
 * Must be called at the beginning of an application transaction, before any repository call.
 */
public interface TenantContext {

    void activate(Principal principal);
}

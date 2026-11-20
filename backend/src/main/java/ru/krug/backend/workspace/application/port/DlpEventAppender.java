package ru.krug.backend.workspace.application.port;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.domain.model.DlpEvent;

/**
 * Append port for the content-free DLP event log.
 *
 * <p>{@link #append} joins the message transaction (a WARN event commits only if the
 * message commits). {@link #appendIndependently} commits in a new transaction so a BLOCK
 * event survives the caller's rollback. The implementation sets the tenant GUCs itself
 * because the application transaction context is suspended.</p>
 */
public interface DlpEventAppender {

    void append(DlpEvent event);

    void appendIndependently(Principal principal, DlpEvent event);
}

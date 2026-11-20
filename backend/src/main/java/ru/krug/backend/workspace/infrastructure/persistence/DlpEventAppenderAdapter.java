package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.application.port.DlpEventAppender;
import ru.krug.backend.workspace.domain.model.DlpEvent;

/**
 * Append-only DLP event writer. The runtime role has SELECT/INSERT only on
 * {@code workspace.dlp_events}; there is no update or delete path.
 *
 * <p>A WARN event joins the caller's message transaction. A BLOCK event must survive the
 * caller's rollback, so it is written in a {@code REQUIRES_NEW} transaction with the
 * tenant GUCs re-applied (the outer transaction context is suspended). Only ids, the rule
 * name snapshot and the action are written — never message content.</p>
 */
@Repository
public class DlpEventAppenderAdapter implements DlpEventAppender {

    private final EntityManager entityManager;
    private final PlatformTransactionManager transactionManager;

    public DlpEventAppenderAdapter(EntityManager entityManager,
                                   PlatformTransactionManager transactionManager) {
        this.entityManager = entityManager;
        this.transactionManager = transactionManager;
    }

    @Override
    public void append(DlpEvent event) {
        insert(event);
    }

    @Override
    public void appendIndependently(Principal principal, DlpEvent event) {
        TransactionTemplate template = new TransactionTemplate(transactionManager);
        template.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        template.executeWithoutResult(status -> {
            entityManager.createNativeQuery("""
                            SELECT set_config('app.user_id', ?1, true),
                                   set_config('app.workspace_id', ?2, true),
                                   set_config('app.request_id', ?3, true)
                            """)
                    .setParameter(1, principal.userId() == null ? ""
                            : principal.userId().toString())
                    .setParameter(2, event.workspaceId().toString())
                    .setParameter(3, principal.requestId() == null ? ""
                            : principal.requestId())
                    .getSingleResult();
            insert(event);
        });
    }

    private void insert(DlpEvent event) {
        entityManager.createNativeQuery("""
                        INSERT INTO workspace.dlp_events
                               (id, workspace_id, policy_id, rule_name, action, actor_id,
                                chat_id, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        """)
                .setParameter(1, event.id())
                .setParameter(2, event.workspaceId())
                .setParameter(3, event.policyId())
                .setParameter(4, event.ruleName())
                .setParameter(5, event.action().name())
                .setParameter(6, event.actorId())
                .setParameter(7, event.chatId())
                .setParameter(8, Timestamp.from(event.createdAt()))
                .executeUpdate();
    }
}

package ru.krug.backend.file.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.file.application.port.WorkspaceQuotaPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/** Runs the daily quota reconciliation under the transaction-local file-reconcile role. */
@Service
public class QuotaReconciliationHandler {

    private final WorkerContext workerContext;
    private final WorkspaceQuotaPort quota;

    public QuotaReconciliationHandler(WorkerContext workerContext, WorkspaceQuotaPort quota) {
        this.workerContext = workerContext;
        this.quota = quota;
    }

    @Transactional
    public int reconcile(int batchSize) {
        workerContext.activate(WorkerContext.WorkerRole.FILE_RECONCILE);
        return quota.reconcileStorage(batchSize);
    }
}

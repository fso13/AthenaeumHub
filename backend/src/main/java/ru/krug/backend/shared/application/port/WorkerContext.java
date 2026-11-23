package ru.krug.backend.shared.application.port;

/**
 * Activates an explicit transaction-local worker role for cross-tenant background jobs.
 * Only two roles exist; keeping them as an enum makes the privilege grant auditable.
 */
public interface WorkerContext {

    void activate(WorkerRole role);

    enum WorkerRole {
        /** Reads/updates the unpublished outbox across tenants (relay). */
        OUTBOX_RELAY("outbox-relay"),
        /** Purges expired idempotency rows and published outbox rows across tenants. */
        RETENTION("retention"),
        /** E4-B: scans managed objects across tenants. */
        FILE_SCAN("file-scan"),
        /** E4-B: expires uploads and unbound attachments across tenants. */
        FILE_GC("file-gc"),
        /** E4-B: daily storage usage reconciliation across tenants. */
        FILE_RECONCILE("file-reconcile"),
        /** E4-B: tenant binding for upload/attachment ids without a workspace path. */
        FILE_RESOLVE("file-resolve"),
        /** E6-B: purges 90-day-old notification rows across users. */
        NOTIFICATION_RETENTION("notification-retention"),
        /** #98: sends the bot webhook outbox across tenants. */
        BOT_EVENT_RELAY("bot-event-relay");

        private final String setting;

        WorkerRole(String setting) {
            this.setting = setting;
        }

        public String setting() {
            return setting;
        }
    }
}

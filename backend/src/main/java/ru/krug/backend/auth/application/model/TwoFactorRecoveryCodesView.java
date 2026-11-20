package ru.krug.backend.auth.application.model;

import java.util.List;

/**
 * Fresh one-time recovery codes, returned exactly once. Only hashes are persisted; this
 * view is never audited or logged.
 */
public record TwoFactorRecoveryCodesView(List<String> codes, long remaining) {

    @Override
    public String toString() {
        return "TwoFactorRecoveryCodesView[redacted, remaining=" + remaining + "]";
    }
}

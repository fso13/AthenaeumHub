package ru.krug.backend.ops.application.model;

/**
 * Generic outbound email (workspace invitations, operational notices). The body may contain
 * a single-use bearer link, so {@link #toString()} never renders it.
 */
public record OutboundEmail(String to, String subject, String body) {

    @Override
    public String toString() {
        return "OutboundEmail[to=" + to + ", subject=" + subject + ", body=redacted]";
    }
}

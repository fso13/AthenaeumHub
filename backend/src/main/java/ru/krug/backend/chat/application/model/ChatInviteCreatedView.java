package ru.krug.backend.chat.application.model;

/**
 * Invite creation result: metadata plus the raw token, which is returned exactly once and
 * never persisted or re-readable.
 */
public record ChatInviteCreatedView(ChatInviteView invite, String token) {
}

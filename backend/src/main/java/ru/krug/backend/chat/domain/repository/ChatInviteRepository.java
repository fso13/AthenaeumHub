package ru.krug.backend.chat.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.domain.model.ChatInvite;
import ru.krug.backend.chat.domain.model.InviteAcceptance;

/**
 * Invite-link persistence (#79). The repository only ever accepts the SHA-256 token hash:
 * no method in this port can read a raw token back.
 */
public interface ChatInviteRepository {

    /** Persists one invite together with the hash of its one-time token. */
    void save(UUID workspaceId, ChatInvite invite, String tokenHash);

    /** All invites of the channel, newest first (tenant RLS applies). */
    List<ChatInvite> listByChat(UUID workspaceId, UUID chatId);

    Optional<ChatInvite> findById(UUID workspaceId, UUID chatId, UUID inviteId);

    /**
     * Soft-revokes one invite. {@code false} when it does not belong to the chat or was
     * already revoked (idempotent DELETE: the caller still answers 204).
     */
    boolean revoke(UUID workspaceId, UUID chatId, UUID inviteId, Instant at);

    /**
     * Runs {@code chat.accept_invite} for the authenticated caller. The token hash is the
     * only link material; the SQL function owns workspace/expiry/max-uses checks and the
     * idempotent ACTIVE-member answer.
     */
    InviteAcceptance accept(String tokenHash, UUID userId);
}

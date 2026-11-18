package ru.krug.backend.chat.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatSummary;

public interface ChatRepository {

    Optional<Chat> findById(UUID workspaceId, UUID chatId);

    Optional<ChatMember> findMember(UUID chatId, UUID userId);

    /** ACTIVE members only; used by notification fan-out (E6-B). */
    List<UUID> findActiveMemberIds(UUID workspaceId, UUID chatId);

    long lastSeq(UUID chatId);

    List<ChatSummary> listActiveSummaries(UUID workspaceId, UUID userId);

    Optional<ChatCounter> lockCounter(UUID chatId);

    void saveCounter(ChatCounter counter);

    void touchLastMessageAt(UUID workspaceId, UUID chatId, Instant at);

    void markRead(UUID workspaceId, UUID chatId, UUID userId, long lastSeq, Instant at);

    /** Idempotent upsert used by dev bootstrap and workspace onboarding. */
    void saveChat(Chat chat, ChatMember owner, ChatCounter counter);

    /**
     * Creates a DIRECT chat with both participant rows and its counter.
     *
     * @return {@code false} when a live DIRECT chat for the same pair already exists
     *         (concurrent create); the caller then returns the winner with 200
     */
    boolean saveDirectChat(Chat chat, UUID firstUserId, UUID secondUserId, ChatCounter counter);

    /** Live (not deleted) DIRECT chat for the ordered pair key in the workspace. */
    Optional<Chat> findLiveDirectByKey(UUID workspaceId, String directKey);

    /** Immutable workspace security mode (MANAGED/E2EE). */
    String findWorkspaceSecurityMode(UUID workspaceId);

    /** Derived capability flag for a peer in a DIRECT chat (J3 wire criterion). */
    boolean peerHasE2eeCapableDevices(UUID workspaceId, UUID chatId, UUID viewerId);

    /**
     * Derived capability flag for an ACTIVE workspace member (E2EE DIRECT creation gate).
     * Uses the SECURITY DEFINER capability lookup because a chat does not exist yet, so
     * {@code p_devices_chat_peer} cannot expose the future peer's devices.
     */
    boolean userHasE2eeCapableDevice(UUID workspaceId, UUID userId);

    /**
     * Resolves the workspace of a chat only when the user is an active chat member. Used
     * for Keycloak principals, whose access token does not contain workspace_id.
     */
    Optional<UUID> findWorkspaceIdForActiveMember(UUID chatId, UUID userId);

    /**
     * Serializes chat creation inside a workspace for the caller's transaction. The limit
     * check and the insert must observe the same snapshot, so concurrent boundary requests
     * cannot both pass the counter check (FR-CHAT-15).
     */
    void lockChatCreation(UUID workspaceId);

    /** ACTIVE, non-deleted chat memberships of the user in the workspace. */
    long countActiveChatsForUser(UUID workspaceId, UUID userId);

    /** Non-deleted chats of the workspace (all users). */
    long countActiveChatsInWorkspace(UUID workspaceId);
}

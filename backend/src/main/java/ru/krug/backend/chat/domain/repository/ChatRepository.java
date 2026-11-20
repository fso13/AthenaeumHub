package ru.krug.backend.chat.domain.repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatSettingsScope;
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

    /**
     * D1-BE3: resolves the workspace of a live chat for an ACTIVE workspace member via
     * {@code chat.settings_scope}. Chat membership is intentionally not required.
     */
    Optional<ChatSettingsScope> findSettingsScope(UUID chatId, UUID userId);

    /**
     * Persists name/description (D1-BE3). {@code false} when the live chat disappeared
     * concurrently or belongs to another workspace.
     */
    boolean updateDetails(Chat chat);

    void markRead(UUID workspaceId, UUID chatId, UUID userId, long lastSeq, Instant at);

    /** Idempotent upsert used by dev bootstrap and workspace onboarding. */
    void saveChat(Chat chat, ChatMember owner, ChatCounter counter);

    /**
     * GROUP-only visibility row for a chat (V39). Empty for DIRECT chats and for legacy
     * rows without channel settings.
     */
    Optional<ChannelVisibility> findChannelVisibility(UUID workspaceId, UUID chatId);

    /** Idempotent settings upsert for a freshly created GROUP channel. */
    void saveChannelSettings(UUID workspaceId, UUID chatId, ChannelVisibility visibility);

    /**
     * Adds every ACTIVE workspace member to a new PUBLIC GROUP channel (idempotent).
     *
     * @return number of participant rows inserted
     */
    int addActiveWorkspaceMembers(UUID workspaceId, UUID chatId);

    /**
     * Adds the selected users as ACTIVE MEMBER to a PRIVATE GROUP channel. Each insert is
     * guarded by an ACTIVE workspace membership, so a concurrent removal cannot create a
     * foreign participant.
     *
     * @return number of participant rows inserted
     */
    int addChatMembers(UUID workspaceId, UUID chatId, Collection<UUID> userIds);

    /**
     * Adds a newly joined ACTIVE workspace member to every live PUBLIC GROUP channel.
     * PRIVATE channels are never touched.
     *
     * @return number of participant rows inserted
     */
    int addMemberToPublicChannels(UUID workspaceId, UUID userId);

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

    /**
     * Serializes public-channel membership changes with chat creation in the same workspace.
     * A member added concurrently with a PUBLIC channel create must end up in that channel:
     * one transaction holds this lock while it writes the channel and its participants.
     */
    void lockChannelMembership(UUID workspaceId);

    /** ACTIVE, non-deleted chat memberships of the user in the workspace. */
    long countActiveChatsForUser(UUID workspaceId, UUID userId);

    /** Non-deleted chats of the workspace (all users). */
    long countActiveChatsInWorkspace(UUID workspaceId);
}

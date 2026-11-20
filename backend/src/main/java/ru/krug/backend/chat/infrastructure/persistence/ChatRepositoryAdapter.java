package ru.krug.backend.chat.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.chat.domain.model.ChannelJoinPolicy;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatMemberRow;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.model.ChatPin;
import ru.krug.backend.chat.domain.model.ChatSettingsScope;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatPermissionPolicy;
import ru.krug.backend.chat.domain.service.DirectPairKey;

@Repository
public class ChatRepositoryAdapter implements ChatRepository {

    private final ChatJpaRepository chatJpaRepository;
    private final ChatCounterJpaRepository counterJpaRepository;
    private final EntityManager entityManager;

    public ChatRepositoryAdapter(ChatJpaRepository chatJpaRepository,
                                 ChatCounterJpaRepository counterJpaRepository,
                                 EntityManager entityManager) {
        this.chatJpaRepository = chatJpaRepository;
        this.counterJpaRepository = counterJpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public Optional<Chat> findById(UUID workspaceId, UUID chatId) {
        return chatJpaRepository.findById(chatId)
                .filter(entity -> workspaceId.equals(entity.getWorkspaceId()))
                .filter(entity -> entity.getDeletedAt() == null)
                .map(ChatPersistenceMapper::toDomain);
    }

    @Override
    public Optional<ChatMember> findMember(UUID chatId, UUID userId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT role, status
                          FROM chat.chat_members
                         WHERE chat_id = ?1 AND user_id = ?2
                        """)
                .setParameter(1, chatId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst().map(row -> {
            Object[] values = (Object[]) row;
            return ChatMember.reconstitute(chatId, userId,
                    ChatMember.Role.valueOf((String) values[0]),
                    ChatMember.Status.valueOf((String) values[1]));
        });
    }

    @Override
    public List<UUID> findActiveMemberIds(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<UUID> rows = entityManager.createNativeQuery("""
                        SELECT cm.user_id
                          FROM chat.chat_members cm
                          JOIN chat.chats c ON c.id = cm.chat_id
                         WHERE cm.chat_id = ?1
                           AND cm.workspace_id = ?2
                           AND cm.status = 'ACTIVE'
                           AND c.deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows;
    }

    @Override
    public List<ChatMemberRow> findMemberDirectory(UUID chatId, UUID viewerId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT user_id, display_name, role, status, joined_at
                          FROM chat.member_directory(CAST(?1 AS uuid), CAST(?2 AS uuid))
                        """)
                .setParameter(1, chatId)
                .setParameter(2, viewerId)
                .getResultList();
        return rows.stream().map(row -> new ChatMemberRow(
                (UUID) row[0],
                (String) row[1],
                (String) row[2],
                (String) row[3],
                instant(row[4]))).toList();
    }

    @Override
    public void lockChatMemberManagement(UUID chatId) {
        entityManager.createNativeQuery("""
                        SELECT pg_advisory_xact_lock(
                                   hashtextextended('chat.members|' || ?1, 0))
                        """)
                .setParameter(1, chatId.toString())
                .getSingleResult();
    }

    @Override
    public int insertActiveChatMember(UUID workspaceId, UUID chatId, UUID userId, String role) {
        return entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_members
                            (chat_id, workspace_id, user_id, role, status, joined_at,
                             updated_at)
                        SELECT ?2, ?1, wm.user_id, ?4, 'ACTIVE', now(), now()
                          FROM workspace.memberships wm
                         WHERE wm.workspace_id = ?1
                           AND wm.user_id = ?3
                           AND wm.status = 'ACTIVE'
                        ON CONFLICT (chat_id, user_id) DO UPDATE
                           SET role = EXCLUDED.role,
                               status = 'ACTIVE',
                               joined_at = CASE
                                   WHEN chat.chat_members.status = 'ACTIVE'
                                       THEN chat.chat_members.joined_at
                                   ELSE EXCLUDED.joined_at
                               END,
                               updated_at = now()
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, userId)
                .setParameter(4, role)
                .executeUpdate();
    }

    @Override
    public boolean updateChatMemberRole(UUID workspaceId, UUID chatId, UUID userId, String role) {
        return entityManager.createNativeQuery("""
                        UPDATE chat.chat_members
                           SET role = ?4,
                               updated_at = now()
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                           AND user_id = ?3
                           AND status = 'ACTIVE'
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, userId)
                .setParameter(4, role)
                .executeUpdate() > 0;
    }

    @Override
    public boolean updateChatMemberStatus(UUID workspaceId, UUID chatId, UUID userId,
                                          String status) {
        return entityManager.createNativeQuery("""
                        UPDATE chat.chat_members
                           SET status = ?4,
                               updated_at = now()
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                           AND user_id = ?3
                           AND status <> ?4
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, userId)
                .setParameter(4, status)
                .executeUpdate() > 0;
    }

    @Override
    public long countActiveChatOwners(UUID workspaceId, UUID chatId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM chat.chat_members
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                           AND role = 'OWNER'
                           AND status = 'ACTIVE'
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public long lastSeq(UUID chatId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT COALESCE(next_seq - 1, 0)
                          FROM chat.chat_counters
                         WHERE chat_id = ?1
                        """)
                .setParameter(1, chatId)
                .getResultList();
        return rows.stream().findFirst()
                .map(value -> ((Number) value).longValue())
                .orElse(0L);
    }

    @Override
    public List<ChatSummary> listActiveSummaries(UUID workspaceId, UUID userId) {
        return listActiveSummaries(workspaceId, userId, 0);
    }

    @Override
    public List<ChatSummary> listActiveSummaries(UUID workspaceId, UUID userId,
                                                 Boolean archivedFilter) {
        int archiveMode = archivedFilter == null ? 0 : (archivedFilter ? 1 : 2);
        return listActiveSummaries(workspaceId, userId, archiveMode);
    }

    /**
     * @param archiveMode 0 = every membership, 1 = only archived, 2 = only the main list
     */
    private List<ChatSummary> listActiveSummaries(UUID workspaceId, UUID userId,
                                                  int archiveMode) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT c.id,
                               c.name,
                               c.description,
                               c.type,
                               c.security_mode,
                               c.last_message_at,
                               COALESCE(cc.next_seq - 1, 0) AS last_seq,
                               GREATEST(COALESCE(cc.next_seq - 1, 0)
                                        - COALESCE(rr.last_read_seq, 0), 0) AS unread_count,
                               CASE WHEN c.type = 'DIRECT' THEN (
                                   SELECT pm.user_id
                                     FROM chat.chat_members pm
                                    WHERE pm.chat_id = c.id
                                      AND pm.user_id <> ?2
                                    ORDER BY pm.user_id
                                    LIMIT 1
                               ) END AS peer_id,
                               CASE WHEN c.type = 'DIRECT' THEN EXISTS (
                                   SELECT 1
                                     FROM chat.chat_members pm
                                     JOIN auth.devices d ON d.user_id = pm.user_id
                                    WHERE pm.chat_id = c.id
                                      AND pm.user_id <> ?2
                                      AND pm.status = 'ACTIVE'
                                      AND auth.device_is_e2ee_capable(d.status,
                                              d.identity_key_alg, d.identity_signing_key,
                                              d.identity_dh_key,
                                              d.identity_binding_signature, d.fingerprint)
                               ) ELSE false END AS peer_capable,
                               c.created_at,
                               CASE WHEN c.type = 'GROUP' THEN cs.visibility END AS visibility,
                               c.cover_file_id,
                               c.read_only,
                               c.join_policy,
                               (ua.chat_id IS NOT NULL) AS archived
                          FROM chat.chats c
                          JOIN chat.chat_members cm
                            ON cm.chat_id = c.id
                           AND cm.user_id = ?2
                           AND cm.status = 'ACTIVE'
                          LEFT JOIN chat.chat_counters cc ON cc.chat_id = c.id
                          LEFT JOIN chat.channel_settings cs ON cs.chat_id = c.id
                          LEFT JOIN chat.read_receipts rr
                            ON rr.chat_id = c.id AND rr.user_id = ?2
                          LEFT JOIN chat.user_chat_archive ua
                            ON ua.chat_id = c.id AND ua.user_id = ?2
                         WHERE c.workspace_id = ?1
                           AND c.deleted_at IS NULL
                           AND (?3 = 0
                                OR (?3 = 1 AND ua.chat_id IS NOT NULL)
                                OR (?3 = 2 AND ua.chat_id IS NULL))
                         ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .setParameter(3, archiveMode)
                .getResultList();
        return rows.stream().map(row -> {
            Chat.Type type = Chat.Type.valueOf((String) row[3]);
            return new ChatSummary(
                    (UUID) row[0],
                    (String) row[1],
                    (String) row[2],
                    type,
                    Chat.SecurityMode.valueOf((String) row[4]),
                    row[11] == null ? null : ChannelVisibility.valueOf((String) row[11]),
                    instant(row[5]),
                    ((Number) row[7]).longValue(),
                    ((Number) row[6]).longValue(),
                    (UUID) row[8],
                    Boolean.TRUE.equals(row[9]),
                    instant(row[10]),
                    (UUID) row[12],
                    Boolean.TRUE.equals(row[13]),
                    type == Chat.Type.GROUP && row[14] != null
                            ? ChannelJoinPolicy.valueOf((String) row[14]) : null,
                    Boolean.TRUE.equals(row[15]));
        }).toList();
    }

    @Override
    public Optional<ChatCounter> lockCounter(UUID chatId) {
        return counterJpaRepository.findForUpdate(chatId)
                .map(entity -> ChatCounter.reconstitute(entity.getChatId(),
                        entity.getNextSeq(), entity.getLastMessageAt()));
    }

    @Override
    public void saveCounter(ChatCounter counter) {
        entityManager.createNativeQuery("""
                        UPDATE chat.chat_counters
                           SET next_seq = ?2,
                               last_message_at = ?3,
                               updated_at = now()
                         WHERE chat_id = ?1
                        """)
                .setParameter(1, counter.chatId())
                .setParameter(2, counter.nextSeq())
                .setParameter(3, counter.lastMessageAt() == null ? null
                        : Timestamp.from(counter.lastMessageAt()))
                .executeUpdate();
    }

    @Override
    public void touchLastMessageAt(UUID workspaceId, UUID chatId, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET last_message_at = ?3,
                               updated_at = now()
                         WHERE id = ?1 AND workspace_id = ?2
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public Optional<ChatSettingsScope> findSettingsScope(UUID chatId, UUID userId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT workspace_id, workspace_role
                          FROM chat.settings_scope(CAST(?1 AS uuid), CAST(?2 AS uuid))
                        """)
                .setParameter(1, chatId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst()
                .map(row -> new ChatSettingsScope((UUID) row[0], (String) row[1]));
    }

    @Override
    public boolean updateDetails(Chat chat) {
        int updated = entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET name = ?3,
                               description = ?4,
                               updated_at = now()
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, chat.id())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, chat.name())
                .setParameter(4, chat.description())
                .executeUpdate();
        return updated > 0;
    }

    @Override
    public void markRead(UUID workspaceId, UUID chatId, UUID userId, long lastSeq, Instant at) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.read_receipts
                               (chat_id, workspace_id, user_id, last_read_seq, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (chat_id, user_id) DO UPDATE
                           SET last_read_seq = GREATEST(
                                   chat.read_receipts.last_read_seq, EXCLUDED.last_read_seq),
                               updated_at = EXCLUDED.updated_at
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, userId)
                .setParameter(4, lastSeq)
                .setParameter(5, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public void saveChat(Chat chat, ChatMember owner, ChatCounter counter) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.chats
                               (id, workspace_id, type, security_mode, name, created_by)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                        ON CONFLICT (id) DO UPDATE
                           SET name = EXCLUDED.name,
                               deleted_at = NULL,
                               updated_at = now()
                        """)
                .setParameter(1, chat.id())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, chat.type().name())
                .setParameter(4, chat.securityMode().name())
                .setParameter(5, chat.name())
                .setParameter(6, chat.createdBy())
                .executeUpdate();

        entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_members
                               (chat_id, workspace_id, user_id, role, status)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (chat_id, user_id) DO UPDATE
                           SET role = EXCLUDED.role,
                               status = 'ACTIVE',
                               updated_at = now()
                        """)
                .setParameter(1, owner.chatId())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, owner.userId())
                .setParameter(4, owner.role().name())
                .setParameter(5, owner.status().name())
                .executeUpdate();

        entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_counters (chat_id, workspace_id, next_seq)
                        VALUES (?1, ?2, ?3)
                        ON CONFLICT (chat_id) DO NOTHING
                        """)
                .setParameter(1, counter.chatId())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, counter.nextSeq())
                .executeUpdate();
    }

    @Override
    public boolean saveDirectChat(Chat chat, UUID firstUserId, UUID secondUserId,
                                  ChatCounter counter) {
        // ON CONFLICT DO NOTHING without a target also covers the partial unique index
        // ux_chats_direct_pair. A plain duplicate would abort the PostgreSQL transaction
        // (P2-06); the conflict-safe form lets the caller read the winner and return 200.
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO chat.chats
                               (id, workspace_id, type, security_mode, name, created_by, direct_key)
                        VALUES (?1, ?2, 'DIRECT', ?3, NULL, ?4, ?5)
                        ON CONFLICT DO NOTHING
                        """)
                .setParameter(1, chat.id())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, chat.securityMode().name())
                .setParameter(4, chat.createdBy())
                .setParameter(5, DirectPairKey.of(firstUserId, secondUserId))
                .executeUpdate();
        if (inserted == 0) {
            return false;
        }

        insertMember(chat, firstUserId, "OWNER");
        insertMember(chat, secondUserId, "MEMBER");

        entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_counters (chat_id, workspace_id, next_seq)
                        VALUES (?1, ?2, ?3)
                        ON CONFLICT (chat_id) DO NOTHING
                        """)
                .setParameter(1, counter.chatId())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, counter.nextSeq())
                .executeUpdate();
        return true;
    }

    private void insertMember(Chat chat, UUID userId, String role) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                        VALUES (?1, ?2, ?3, ?4, 'ACTIVE')
                        ON CONFLICT (chat_id, user_id) DO NOTHING
                        """)
                .setParameter(1, chat.id())
                .setParameter(2, chat.workspaceId())
                .setParameter(3, userId)
                .setParameter(4, role)
                .executeUpdate();
    }

    @Override
    public Optional<Chat> findLiveDirectByKey(UUID workspaceId, String directKey) {
        return entityManager.createQuery("""
                        SELECT c FROM ChatEntity c
                         WHERE c.workspaceId = ?1
                           AND c.type = 'DIRECT'
                           AND c.directKey = ?2
                           AND c.deletedAt IS NULL
                        """, ChatEntity.class)
                .setParameter(1, workspaceId)
                .setParameter(2, directKey)
                .setMaxResults(1)
                .getResultList().stream().findFirst()
                .map(ChatPersistenceMapper::toDomain);
    }

    @Override
    public String findWorkspaceSecurityMode(UUID workspaceId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT security_mode FROM workspace.workspaces WHERE id = ?1
                        """)
                .setParameter(1, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(value -> (String) value).orElse(null);
    }

    @Override
    public boolean peerHasE2eeCapableDevices(UUID workspaceId, UUID chatId, UUID viewerId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM chat.chat_members pm
                          JOIN auth.devices d ON d.user_id = pm.user_id
                         WHERE pm.chat_id = ?1
                           AND pm.status = 'ACTIVE'
                           AND pm.user_id <> ?2
                           AND auth.device_is_e2ee_capable(d.status, d.identity_key_alg,
                                   d.identity_signing_key, d.identity_dh_key,
                                   d.identity_binding_signature, d.fingerprint)
                        """)
                .setParameter(1, chatId)
                .setParameter(2, viewerId)
                .getSingleResult();
        return count.longValue() > 0;
    }

    @Override
    public boolean userHasE2eeCapableDevice(UUID workspaceId, UUID userId) {
        Boolean capable = (Boolean) entityManager.createNativeQuery("""
                        SELECT auth.user_has_e2ee_capable_device(?1, ?2)
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getSingleResult();
        return Boolean.TRUE.equals(capable);
    }

    @Override
    public Optional<UUID> findWorkspaceIdForActiveMember(UUID chatId, UUID userId) {
        @SuppressWarnings("unchecked")
        List<UUID> rows = entityManager.createNativeQuery("""
                        SELECT c.workspace_id
                          FROM chat.chats c
                         WHERE c.id = ?1
                           AND c.deleted_at IS NULL
                           AND EXISTS (
                               SELECT 1
                                 FROM chat.chat_members cm
                                WHERE cm.chat_id = c.id
                                  AND cm.user_id = ?2
                                  AND cm.status = 'ACTIVE'
                           )
                        """)
                .setParameter(1, chatId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().findFirst();
    }

    @Override
    public void lockChatCreation(UUID workspaceId) {
        entityManager.createNativeQuery("""
                        SELECT pg_advisory_xact_lock(
                                   hashtextextended('chat.create|' || ?1, 0))
                        """)
                .setParameter(1, workspaceId.toString())
                .getSingleResult();
    }

    @Override
    public void lockChannelMembership(UUID workspaceId) {
        // Same advisory key as lockChatCreation: public-channel joins and channel creation
        // must not interleave, otherwise a member committing between addActiveWorkspaceMembers
        // and the creator's commit could miss the new PUBLIC channel.
        lockChatCreation(workspaceId);
    }

    @Override
    public long countActiveChatsForUser(UUID workspaceId, UUID userId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM chat.chats c
                          JOIN chat.chat_members cm
                            ON cm.chat_id = c.id
                           AND cm.user_id = ?2
                           AND cm.status = 'ACTIVE'
                         WHERE c.workspace_id = ?1
                           AND c.deleted_at IS NULL
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public long countActiveChatsInWorkspace(UUID workspaceId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM chat.chats
                         WHERE workspace_id = ?1
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, workspaceId)
                .getSingleResult();
        return count.longValue();
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass());
    }

    @Override
    public int addActiveWorkspaceMembers(UUID workspaceId, UUID chatId) {
        return entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_members
                            (chat_id, workspace_id, user_id, role, status, joined_at, updated_at)
                        SELECT ?2, ?1, wm.user_id, 'MEMBER', 'ACTIVE', now(), now()
                          FROM workspace.memberships wm
                         WHERE wm.workspace_id = ?1
                           AND wm.status = 'ACTIVE'
                        ON CONFLICT (chat_id, user_id) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .executeUpdate();
    }

    @Override
    public Optional<ChannelVisibility> findChannelVisibility(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<String> rows = entityManager.createNativeQuery("""
                        SELECT cs.visibility
                          FROM chat.channel_settings cs
                          JOIN chat.chats c ON c.id = cs.chat_id
                         WHERE cs.chat_id = ?1
                           AND c.workspace_id = ?2
                           AND c.deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(ChannelVisibility::valueOf);
    }

    @Override
    public void saveChannelSettings(UUID workspaceId, UUID chatId, ChannelVisibility visibility) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.channel_settings (chat_id, visibility, created_at)
                        SELECT c.id, ?2, now()
                          FROM chat.chats c
                         WHERE c.id = ?1
                           AND c.workspace_id = ?3
                        ON CONFLICT (chat_id) DO NOTHING
                        """)
                .setParameter(1, chatId)
                .setParameter(2, visibility.name())
                .setParameter(3, workspaceId)
                .executeUpdate();
        // P0-2: a newly created channel gets the coherent join policy and its default
        // per-role matrix; both statements are idempotent for a replayed provisioning call.
        entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET join_policy = ?3,
                               updated_at = now()
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND type = 'GROUP'
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, ChannelJoinPolicy.forVisibility(visibility).name())
                .executeUpdate();
        seedDefaultPermissions(workspaceId, chatId);
    }

    @Override
    public Optional<ChannelSettings> findChannelSettings(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT c.read_only, c.join_policy, c.cover_file_id
                          FROM chat.chats c
                         WHERE c.id = ?1
                           AND c.workspace_id = ?2
                           AND c.deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().findFirst().map(row -> new ChannelSettings(
                Boolean.TRUE.equals(row[0]),
                ChannelJoinPolicy.valueOf((String) row[1]),
                (UUID) row[2]));
    }

    @Override
    public boolean updateChannelSettings(UUID workspaceId, UUID chatId, UUID coverFileId,
                                         boolean readOnly, String joinPolicy) {
        return entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET cover_file_id = ?3,
                               read_only = ?4,
                               join_policy = ?5,
                               updated_at = now()
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, coverFileId)
                .setParameter(4, readOnly)
                .setParameter(5, joinPolicy)
                .executeUpdate() > 0;
    }

    @Override
    public boolean updateChannelVisibility(UUID workspaceId, UUID chatId,
                                           ChannelVisibility visibility) {
        return entityManager.createNativeQuery("""
                        INSERT INTO chat.channel_settings (chat_id, visibility, created_at)
                        SELECT c.id, ?3, now()
                          FROM chat.chats c
                         WHERE c.id = ?1
                           AND c.workspace_id = ?2
                           AND c.deleted_at IS NULL
                        ON CONFLICT (chat_id) DO UPDATE
                           SET visibility = EXCLUDED.visibility
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, visibility.name())
                .executeUpdate() > 0;
    }

    @Override
    public boolean updateCover(UUID workspaceId, UUID chatId, UUID coverFileId) {
        return entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET cover_file_id = ?3,
                               updated_at = now()
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, coverFileId)
                .executeUpdate() > 0;
    }

    @Override
    public boolean softDeleteChat(UUID workspaceId, UUID chatId) {
        // The cover reference is cleared with the delete; the attachment itself is left to
        // the normal file retention/GC path and may still be used by a message.
        return entityManager.createNativeQuery("""
                        UPDATE chat.chats
                           SET deleted_at = now(),
                               cover_file_id = NULL,
                               updated_at = now()
                         WHERE id = ?1
                           AND workspace_id = ?2
                           AND deleted_at IS NULL
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .executeUpdate() > 0;
    }

    @Override
    public Map<ChatPermission, Boolean> findPermissions(UUID workspaceId, UUID chatId,
                                                        String role) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT p.permission, p.allowed
                          FROM chat.chat_permissions p
                          JOIN chat.chats c ON c.id = p.chat_id
                         WHERE p.chat_id = ?1
                           AND p.role = ?2
                           AND c.workspace_id = ?3
                        """)
                .setParameter(1, chatId)
                .setParameter(2, role)
                .setParameter(3, workspaceId)
                .getResultList();
        Map<ChatPermission, Boolean> rights = new java.util.EnumMap<>(ChatPermission.class);
        for (Object[] row : rows) {
            rightPut(rights, (String) row[0], Boolean.TRUE.equals(row[1]));
        }
        return rights;
    }

    @Override
    public void upsertPermissions(UUID workspaceId, UUID chatId, String role,
                                  Map<ChatPermission, Boolean> rights) {
        for (Map.Entry<ChatPermission, Boolean> entry : rights.entrySet()) {
            entityManager.createNativeQuery("""
                            INSERT INTO chat.chat_permissions
                                (chat_id, role, permission, allowed, updated_at)
                            SELECT c.id, ?3, ?4, ?5, now()
                              FROM chat.chats c
                             WHERE c.id = ?1
                               AND c.workspace_id = ?2
                               AND c.deleted_at IS NULL
                            ON CONFLICT (chat_id, role, permission) DO UPDATE
                               SET allowed = EXCLUDED.allowed,
                                   updated_at = now()
                            """)
                    .setParameter(1, chatId)
                    .setParameter(2, workspaceId)
                    .setParameter(3, role)
                    .setParameter(4, entry.getKey().wire())
                    .setParameter(5, entry.getValue())
                    .executeUpdate();
        }
    }

    @Override
    public void seedDefaultPermissions(UUID workspaceId, UUID chatId) {
        for (ChatMember.Role role : ChatMember.Role.values()) {
            for (Map.Entry<ChatPermission, Boolean> entry
                    : ChatPermissionPolicy.defaults(role).entrySet()) {
                entityManager.createNativeQuery("""
                                INSERT INTO chat.chat_permissions
                                    (chat_id, role, permission, allowed, updated_at)
                                SELECT c.id, ?3, ?4, ?5, now()
                                  FROM chat.chats c
                                 WHERE c.id = ?1
                                   AND c.workspace_id = ?2
                                   AND c.type = 'GROUP'
                                ON CONFLICT (chat_id, role, permission) DO NOTHING
                                """)
                        .setParameter(1, chatId)
                        .setParameter(2, workspaceId)
                        .setParameter(3, role.name())
                        .setParameter(4, entry.getKey().wire())
                        .setParameter(5, entry.getValue())
                        .executeUpdate();
            }
        }
    }

    @Override
    public void archiveChat(UUID workspaceId, UUID chatId, UUID userId, Instant at) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.user_chat_archive
                            (user_id, chat_id, workspace_id, archived_at)
                        SELECT ?3, c.id, c.workspace_id, ?4
                          FROM chat.chats c
                         WHERE c.id = ?1
                           AND c.workspace_id = ?2
                           AND c.deleted_at IS NULL
                           AND EXISTS (
                               SELECT 1
                                 FROM chat.chat_members cm
                                WHERE cm.chat_id = c.id
                                  AND cm.user_id = ?3
                                  AND cm.status = 'ACTIVE'
                           )
                        ON CONFLICT (user_id, chat_id) DO NOTHING
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, userId)
                .setParameter(4, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public void unarchiveChat(UUID workspaceId, UUID chatId, UUID userId) {
        entityManager.createNativeQuery("""
                        DELETE FROM chat.user_chat_archive
                         WHERE user_id = ?3
                           AND chat_id = ?1
                           AND workspace_id = ?2
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, userId)
                .executeUpdate();
    }

    @Override
    public Optional<ChatPin> findPin(UUID workspaceId, UUID chatId, UUID messageId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT chat_id, message_id, pinned_by, pinned_at
                          FROM chat.chat_pins
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                           AND message_id = ?3
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, messageId)
                .getResultList();
        return rows.stream().findFirst().map(row -> new ChatPin(
                (UUID) row[0], (UUID) row[1], (UUID) row[2], instant(row[3])));
    }

    @Override
    public long countPins(UUID workspaceId, UUID chatId) {
        Number count = (Number) entityManager.createNativeQuery("""
                        SELECT count(*)
                          FROM chat.chat_pins
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getSingleResult();
        return count.longValue();
    }

    @Override
    public void pinMessage(UUID workspaceId, UUID chatId, UUID messageId, UUID pinnedBy,
                           Instant at) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_pins
                            (chat_id, message_id, workspace_id, pinned_by, pinned_at)
                        VALUES (?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (chat_id, message_id) DO NOTHING
                        """)
                .setParameter(1, chatId)
                .setParameter(2, messageId)
                .setParameter(3, workspaceId)
                .setParameter(4, pinnedBy)
                .setParameter(5, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public boolean unpinMessage(UUID workspaceId, UUID chatId, UUID messageId) {
        return entityManager.createNativeQuery("""
                        DELETE FROM chat.chat_pins
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                           AND message_id = ?3
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .setParameter(3, messageId)
                .executeUpdate() > 0;
    }

    @Override
    public List<ChatPin> findPins(UUID workspaceId, UUID chatId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT chat_id, message_id, pinned_by, pinned_at
                          FROM chat.chat_pins
                         WHERE chat_id = ?1
                           AND workspace_id = ?2
                         ORDER BY pinned_at DESC, message_id ASC
                        """)
                .setParameter(1, chatId)
                .setParameter(2, workspaceId)
                .getResultList();
        return rows.stream().map(row -> new ChatPin(
                (UUID) row[0],
                (UUID) row[1],
                (UUID) row[2],
                instant(row[3]))).toList();
    }

    private static void rightPut(Map<ChatPermission, Boolean> rights, String permission,
                                 boolean allowed) {
        ChatPermission parsed = ChatPermission.fromWire(permission);
        if (parsed != null) {
            rights.put(parsed, allowed);
        }
    }

    @Override
    public int addChatMembers(UUID workspaceId, UUID chatId, java.util.Collection<UUID> userIds) {
        int inserted = 0;
        for (UUID userId : userIds) {
            inserted += entityManager.createNativeQuery("""
                            INSERT INTO chat.chat_members
                                (chat_id, workspace_id, user_id, role, status, joined_at,
                                 updated_at)
                            SELECT ?2, ?1, wm.user_id, 'MEMBER', 'ACTIVE', now(), now()
                              FROM workspace.memberships wm
                             WHERE wm.workspace_id = ?1
                               AND wm.user_id = ?3
                               AND wm.status = 'ACTIVE'
                            ON CONFLICT (chat_id, user_id) DO NOTHING
                            """)
                    .setParameter(1, workspaceId)
                    .setParameter(2, chatId)
                    .setParameter(3, userId)
                    .executeUpdate();
        }
        return inserted;
    }

    @Override
    public int addMemberToPublicChannels(UUID workspaceId, UUID userId) {
        return entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_members
                            (chat_id, workspace_id, user_id, role, status, joined_at, updated_at)
                        SELECT c.id, c.workspace_id, wm.user_id, 'MEMBER', 'ACTIVE', now(), now()
                          FROM workspace.memberships wm
                          JOIN chat.chats c ON c.workspace_id = wm.workspace_id
                          JOIN chat.channel_settings cs
                            ON cs.chat_id = c.id
                           AND cs.visibility = 'PUBLIC'
                         WHERE wm.workspace_id = ?1
                           AND wm.user_id = ?2
                           AND wm.status = 'ACTIVE'
                           AND c.type = 'GROUP'
                           AND c.deleted_at IS NULL
                           AND c.join_policy = 'OPEN'
                        ON CONFLICT (chat_id, user_id) DO NOTHING
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .executeUpdate();
    }
}

package ru.krug.backend.chat.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;
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
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT c.id,
                               c.name,
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
                               c.created_at
                          FROM chat.chats c
                          JOIN chat.chat_members cm
                            ON cm.chat_id = c.id
                           AND cm.user_id = ?2
                           AND cm.status = 'ACTIVE'
                          LEFT JOIN chat.chat_counters cc ON cc.chat_id = c.id
                          LEFT JOIN chat.read_receipts rr
                            ON rr.chat_id = c.id AND rr.user_id = ?2
                         WHERE c.workspace_id = ?1
                           AND c.deleted_at IS NULL
                         ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, userId)
                .getResultList();
        return rows.stream().map(row -> new ChatSummary(
                (UUID) row[0],
                (String) row[1],
                Chat.Type.valueOf((String) row[2]),
                Chat.SecurityMode.valueOf((String) row[3]),
                instant(row[4]),
                ((Number) row[6]).longValue(),
                ((Number) row[5]).longValue(),
                (UUID) row[7],
                Boolean.TRUE.equals(row[8]),
                instant(row[9]))).toList();
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
}

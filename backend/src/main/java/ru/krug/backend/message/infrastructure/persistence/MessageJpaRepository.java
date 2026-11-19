package ru.krug.backend.message.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Timeline queries always exclude messages the caller hid for themselves. The subquery is
 * correlated on the message id and the caller's user id; RLS additionally scopes both
 * tables to the active workspace. The same predicate is used for forward/backward cursors
 * so pagination never leaks a "hole" that a hidden message would otherwise occupy.
 */
public interface MessageJpaRepository extends JpaRepository<MessageEntity, UUID> {

    Optional<MessageEntity> findByIdAndWorkspaceId(UUID id, UUID workspaceId);

    Optional<MessageEntity> findByWorkspaceIdAndChatIdAndClientMessageId(UUID workspaceId,
                                                                         UUID chatId,
                                                                         UUID clientMessageId);

    Optional<MessageEntity> findByWorkspaceIdAndChatIdAndSenderIdAndClientMessageId(
            UUID workspaceId, UUID chatId, UUID senderId, UUID clientMessageId);

    @Query("""
            select m.senderId from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.clientMessageId = :clientMessageId
            """)
    Optional<UUID> findSenderIdByClientMessageId(@Param("workspaceId") UUID workspaceId,
                                                 @Param("chatId") UUID chatId,
                                                 @Param("clientMessageId") UUID clientMessageId);

    @Query("""
            select m.chatId from MessageEntity m
             where m.id = :messageId and m.workspaceId = :workspaceId
               and m.chatId = :chatId and m.deletedAt is null
            """)
    Optional<UUID> findChatId(@Param("workspaceId") UUID workspaceId,
                              @Param("chatId") UUID chatId,
                              @Param("messageId") UUID messageId);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> pageDesc(@Param("workspaceId") UUID workspaceId,
                                 @Param("chatId") UUID chatId,
                                 @Param("viewerId") UUID viewerId,
                                 Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> pageDescBefore(@Param("workspaceId") UUID workspaceId,
                                       @Param("chatId") UUID chatId,
                                       @Param("beforeSeq") long beforeSeq,
                                       @Param("viewerId") UUID viewerId,
                                       Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq > :afterSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> pageAscAfter(@Param("workspaceId") UUID workspaceId,
                                     @Param("chatId") UUID chatId,
                                     @Param("afterSeq") long afterSeq,
                                     @Param("viewerId") UUID viewerId,
                                     Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq > :afterSeq and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> pageAscRange(@Param("workspaceId") UUID workspaceId,
                                     @Param("chatId") UUID chatId,
                                     @Param("afterSeq") long afterSeq,
                                     @Param("beforeSeq") long beforeSeq,
                                     @Param("viewerId") UUID viewerId,
                                     Pageable pageable);

    // ------------------------------------------------------------------
    // D1-BE1: main feed excludes replies; a thread page filters by root.
    // ------------------------------------------------------------------

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId is null
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> mainPageDesc(@Param("workspaceId") UUID workspaceId,
                                     @Param("chatId") UUID chatId,
                                     @Param("viewerId") UUID viewerId,
                                     Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId is null and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> mainPageDescBefore(@Param("workspaceId") UUID workspaceId,
                                           @Param("chatId") UUID chatId,
                                           @Param("beforeSeq") long beforeSeq,
                                           @Param("viewerId") UUID viewerId,
                                           Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId is null and m.seq > :afterSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> mainPageAscAfter(@Param("workspaceId") UUID workspaceId,
                                         @Param("chatId") UUID chatId,
                                         @Param("afterSeq") long afterSeq,
                                         @Param("viewerId") UUID viewerId,
                                         Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId is null and m.seq > :afterSeq and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> mainPageAscRange(@Param("workspaceId") UUID workspaceId,
                                         @Param("chatId") UUID chatId,
                                         @Param("afterSeq") long afterSeq,
                                         @Param("beforeSeq") long beforeSeq,
                                         @Param("viewerId") UUID viewerId,
                                         Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId = :threadRootId
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> threadPageDesc(@Param("workspaceId") UUID workspaceId,
                                       @Param("chatId") UUID chatId,
                                       @Param("threadRootId") UUID threadRootId,
                                       @Param("viewerId") UUID viewerId,
                                       Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId = :threadRootId and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq desc
            """)
    List<MessageEntity> threadPageDescBefore(@Param("workspaceId") UUID workspaceId,
                                             @Param("chatId") UUID chatId,
                                             @Param("threadRootId") UUID threadRootId,
                                             @Param("beforeSeq") long beforeSeq,
                                             @Param("viewerId") UUID viewerId,
                                             Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId = :threadRootId and m.seq > :afterSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> threadPageAscAfter(@Param("workspaceId") UUID workspaceId,
                                           @Param("chatId") UUID chatId,
                                           @Param("threadRootId") UUID threadRootId,
                                           @Param("afterSeq") long afterSeq,
                                           @Param("viewerId") UUID viewerId,
                                           Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.threadRootId = :threadRootId
               and m.seq > :afterSeq and m.seq < :beforeSeq
               and not exists (select d.messageId from MessageDeletionEntity d
                                where d.messageId = m.id and d.userId = :viewerId)
             order by m.seq asc
            """)
    List<MessageEntity> threadPageAscRange(@Param("workspaceId") UUID workspaceId,
                                           @Param("chatId") UUID chatId,
                                           @Param("threadRootId") UUID threadRootId,
                                           @Param("afterSeq") long afterSeq,
                                           @Param("beforeSeq") long beforeSeq,
                                           @Param("viewerId") UUID viewerId,
                                           Pageable pageable);
}

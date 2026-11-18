package ru.krug.backend.message.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

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
             order by m.seq desc
            """)
    List<MessageEntity> pageDesc(@Param("workspaceId") UUID workspaceId,
                                 @Param("chatId") UUID chatId,
                                 Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq < :beforeSeq
             order by m.seq desc
            """)
    List<MessageEntity> pageDescBefore(@Param("workspaceId") UUID workspaceId,
                                       @Param("chatId") UUID chatId,
                                       @Param("beforeSeq") long beforeSeq,
                                       Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq > :afterSeq
             order by m.seq asc
            """)
    List<MessageEntity> pageAscAfter(@Param("workspaceId") UUID workspaceId,
                                     @Param("chatId") UUID chatId,
                                     @Param("afterSeq") long afterSeq,
                                     Pageable pageable);

    @Query("""
            select m from MessageEntity m
             where m.workspaceId = :workspaceId and m.chatId = :chatId
               and m.seq > :afterSeq and m.seq < :beforeSeq
             order by m.seq asc
            """)
    List<MessageEntity> pageAscRange(@Param("workspaceId") UUID workspaceId,
                                     @Param("chatId") UUID chatId,
                                     @Param("afterSeq") long afterSeq,
                                     @Param("beforeSeq") long beforeSeq,
                                     Pageable pageable);
}

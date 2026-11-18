package ru.krug.backend.message.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.repository.MessageRepository;

@Repository
public class MessageRepositoryAdapter implements MessageRepository {

    private final MessageJpaRepository jpaRepository;
    private final MessagePersistenceMapper mapper;
    private final EntityManager entityManager;

    public MessageRepositoryAdapter(MessageJpaRepository jpaRepository,
                                    MessagePersistenceMapper mapper,
                                    EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.mapper = mapper;
        this.entityManager = entityManager;
    }

    @Override
    public void save(Message message) {
        entityManager.persist(mapper.toEntity(message));
    }

    @Override
    public Optional<Message> findById(UUID workspaceId, UUID messageId) {
        return jpaRepository.findByIdAndWorkspaceId(messageId, workspaceId)
                .map(mapper::toDomain);
    }

    @Override
    public Optional<Message> findByClientMessageId(UUID workspaceId, UUID chatId,
                                                   UUID clientMessageId, UUID senderId) {
        return jpaRepository.findByWorkspaceIdAndChatIdAndSenderIdAndClientMessageId(
                        workspaceId, chatId, senderId, clientMessageId)
                .map(mapper::toDomain);
    }

    @Override
    public Optional<UUID> findSenderIdByClientMessageId(UUID workspaceId, UUID chatId,
                                                        UUID clientMessageId) {
        return jpaRepository.findSenderIdByClientMessageId(workspaceId, chatId, clientMessageId);
    }

    @Override
    public Optional<UUID> findChatIdByMessageId(UUID workspaceId, UUID chatId, UUID messageId) {
        return jpaRepository.findChatId(workspaceId, chatId, messageId);
    }

    @Override
    public List<Message> findPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                                  int limitPlusOne) {
        PageRequest page = PageRequest.of(0, limitPlusOne);
        List<MessageEntity> entities;
        if (afterSeq != null && beforeSeq != null) {
            entities = jpaRepository.pageAscRange(workspaceId, chatId, afterSeq, beforeSeq, page);
        } else if (afterSeq != null) {
            entities = jpaRepository.pageAscAfter(workspaceId, chatId, afterSeq, page);
        } else if (beforeSeq != null) {
            entities = jpaRepository.pageDescBefore(workspaceId, chatId, beforeSeq, page);
        } else {
            entities = jpaRepository.pageDesc(workspaceId, chatId, page);
        }
        return entities.stream().map(mapper::toDomain).toList();
    }
}

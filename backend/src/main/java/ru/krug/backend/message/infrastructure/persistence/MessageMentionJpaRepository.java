package ru.krug.backend.message.infrastructure.persistence;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface MessageMentionJpaRepository extends JpaRepository<MessageMentionEntity, UUID> {

    List<MessageMentionEntity> findByWorkspaceIdAndMessageIdIn(UUID workspaceId,
                                                               Collection<UUID> messageIds);
}

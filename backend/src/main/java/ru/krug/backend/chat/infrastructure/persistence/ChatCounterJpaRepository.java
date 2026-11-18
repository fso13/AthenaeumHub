package ru.krug.backend.chat.infrastructure.persistence;

import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ChatCounterJpaRepository extends JpaRepository<ChatCounterEntity, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from ChatCounterEntity c where c.chatId = :chatId")
    Optional<ChatCounterEntity> findForUpdate(@Param("chatId") UUID chatId);
}

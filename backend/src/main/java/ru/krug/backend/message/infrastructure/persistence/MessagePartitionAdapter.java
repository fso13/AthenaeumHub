package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Date;
import java.time.YearMonth;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.message.application.port.MessagePartitionPort;

@Repository
public class MessagePartitionAdapter implements MessagePartitionPort {

    private final EntityManager entityManager;

    public MessagePartitionAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void ensureMonth(YearMonth month) {
        entityManager.createNativeQuery("SELECT message.ensure_partition(?1)")
                .setParameter(1, Date.valueOf(month.atDay(1)))
                .getResultList();
    }
}

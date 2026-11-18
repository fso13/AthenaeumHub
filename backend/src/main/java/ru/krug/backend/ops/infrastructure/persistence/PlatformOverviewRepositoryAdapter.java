package ru.krug.backend.ops.infrastructure.persistence;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.PlatformOverview;
import ru.krug.backend.ops.domain.repository.PlatformOverviewRepository;

@Repository
public class PlatformOverviewRepositoryAdapter implements PlatformOverviewRepository {

    private final EntityManager entityManager;

    public PlatformOverviewRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public PlatformOverview overview() {
        Object[] row = (Object[]) entityManager.createNativeQuery("""
                        SELECT total_users, total_workspaces, total_chats
                          FROM ops.platform_overview()
                        """)
                .getSingleResult();
        return new PlatformOverview(((Number) row[0]).longValue(),
                ((Number) row[1]).longValue(), ((Number) row[2]).longValue());
    }
}

package ru.krug.backend.sticker.infrastructure.persistence;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Repository;

import ru.krug.backend.sticker.domain.repository.StickerFavoriteRepository;

@Repository
public class StickerFavoriteRepositoryAdapter implements StickerFavoriteRepository {

    private final StickerFavoriteJpaRepository jpaRepository;

    public StickerFavoriteRepositoryAdapter(StickerFavoriteJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    @Override
    public Set<UUID> findStickerIds(UUID userId, Collection<UUID> stickerIds) {
        if (stickerIds == null || stickerIds.isEmpty()) {
            return Set.of();
        }
        return jpaRepository.findStickerIds(userId, stickerIds);
    }

    @Override
    public void add(UUID userId, UUID stickerId) {
        jpaRepository.insertIfAbsent(userId, stickerId);
    }

    @Override
    public void remove(UUID userId, UUID stickerId) {
        jpaRepository.deleteFavorite(userId, stickerId);
    }
}

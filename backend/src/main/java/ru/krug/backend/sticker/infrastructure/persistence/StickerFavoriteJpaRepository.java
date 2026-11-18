package ru.krug.backend.sticker.infrastructure.persistence;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface StickerFavoriteJpaRepository
        extends JpaRepository<StickerFavoriteEntity, StickerFavoriteId> {

    @Query("""
            select favorite.stickerId from StickerFavoriteEntity favorite
             where favorite.userId = :userId and favorite.stickerId in :stickerIds
            """)
    Set<UUID> findStickerIds(@Param("userId") UUID userId,
                             @Param("stickerIds") Collection<UUID> stickerIds);

    @Modifying
    @Query(value = """
            INSERT INTO sticker.sticker_favorites (user_id, sticker_id)
            VALUES (:userId, :stickerId)
            ON CONFLICT DO NOTHING
            """, nativeQuery = true)
    int insertIfAbsent(@Param("userId") UUID userId, @Param("stickerId") UUID stickerId);

    @Modifying
    @Query("""
            delete from StickerFavoriteEntity favorite
             where favorite.userId = :userId and favorite.stickerId = :stickerId
            """)
    int deleteFavorite(@Param("userId") UUID userId, @Param("stickerId") UUID stickerId);
}

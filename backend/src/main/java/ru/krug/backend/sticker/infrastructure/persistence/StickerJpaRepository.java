package ru.krug.backend.sticker.infrastructure.persistence;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface StickerJpaRepository extends JpaRepository<StickerEntity, UUID> {

    List<StickerEntity> findByPackIdInOrderByPackIdAscPositionAsc(Collection<UUID> packIds);
}

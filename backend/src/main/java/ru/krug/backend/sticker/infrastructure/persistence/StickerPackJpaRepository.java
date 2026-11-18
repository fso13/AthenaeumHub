package ru.krug.backend.sticker.infrastructure.persistence;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface StickerPackJpaRepository extends JpaRepository<StickerPackEntity, UUID> {

    List<StickerPackEntity> findByStatusOrderByNameAsc(String status);
}

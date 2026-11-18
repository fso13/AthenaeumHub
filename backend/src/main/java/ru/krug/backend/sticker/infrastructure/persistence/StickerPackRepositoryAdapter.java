package ru.krug.backend.sticker.infrastructure.persistence;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Repository;

import ru.krug.backend.sticker.domain.model.PackStatus;
import ru.krug.backend.sticker.domain.model.Sticker;
import ru.krug.backend.sticker.domain.model.StickerPack;
import ru.krug.backend.sticker.domain.model.StickerRecord;
import ru.krug.backend.sticker.domain.repository.StickerPackRepository;

@Repository
public class StickerPackRepositoryAdapter implements StickerPackRepository {

    private final StickerPackJpaRepository packJpa;
    private final StickerJpaRepository stickerJpa;
    private final StickerPersistenceMapper mapper;

    public StickerPackRepositoryAdapter(StickerPackJpaRepository packJpa,
                                        StickerJpaRepository stickerJpa,
                                        StickerPersistenceMapper mapper) {
        this.packJpa = packJpa;
        this.stickerJpa = stickerJpa;
        this.mapper = mapper;
    }

    @Override
    public List<StickerPack> findActiveWithStickers() {
        List<StickerPackEntity> packEntities =
                packJpa.findByStatusOrderByNameAsc(PackStatus.ACTIVE.name());
        if (packEntities.isEmpty()) {
            return List.of();
        }
        Map<UUID, List<Sticker>> byPack = stickersByPack(
                packEntities.stream().map(StickerPackEntity::getId).toList());
        return packEntities.stream()
                .map(pack -> StickerPack.reconstitute(pack.getId(), pack.getSlug(),
                        pack.getName(), pack.getCoverUrl(), PackStatus.valueOf(pack.getStatus()),
                        pack.isBuiltin(), byPack.getOrDefault(pack.getId(), List.of())))
                .toList();
    }

    @Override
    public Optional<StickerRecord> findSticker(UUID stickerId) {
        return stickerJpa.findById(stickerId)
                .flatMap(sticker -> packJpa.findById(sticker.getPackId())
                        .map(pack -> record(sticker, pack)));
    }

    @Override
    public List<StickerRecord> findStickers(Collection<UUID> stickerIds) {
        if (stickerIds == null || stickerIds.isEmpty()) {
            return List.of();
        }
        List<StickerEntity> stickers = stickerJpa.findAllById(stickerIds);
        if (stickers.isEmpty()) {
            return List.of();
        }
        Map<UUID, StickerPackEntity> packs = new LinkedHashMap<>();
        packJpa.findAllById(stickers.stream().map(StickerEntity::getPackId).distinct().toList())
                .forEach(pack -> packs.put(pack.getId(), pack));
        return stickers.stream()
                .filter(sticker -> packs.containsKey(sticker.getPackId()))
                .map(sticker -> record(sticker, packs.get(sticker.getPackId())))
                .toList();
    }

    private Map<UUID, List<Sticker>> stickersByPack(Collection<UUID> packIds) {
        Map<UUID, List<Sticker>> result = new LinkedHashMap<>();
        for (StickerEntity entity : stickerJpa
                .findByPackIdInOrderByPackIdAscPositionAsc(packIds)) {
            result.computeIfAbsent(entity.getPackId(), key -> new java.util.ArrayList<>())
                    .add(mapper.toDomain(entity));
        }
        return result;
    }

    private StickerRecord record(StickerEntity sticker, StickerPackEntity pack) {
        return new StickerRecord(mapper.toDomain(sticker),
                PackStatus.valueOf(pack.getStatus()), pack.isBuiltin());
    }
}

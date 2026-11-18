package ru.krug.backend.sticker.infrastructure.adapter;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.sticker.application.model.StickerRefView;
import ru.krug.backend.sticker.application.port.StickerCatalogPort;
import ru.krug.backend.sticker.application.service.StickerViewMapper;
import ru.krug.backend.sticker.domain.exception.StickerGoneException;
import ru.krug.backend.sticker.domain.exception.StickerNotFoundException;
import ru.krug.backend.sticker.domain.exception.StickerPackDisabledException;
import ru.krug.backend.sticker.domain.model.StickerRecord;
import ru.krug.backend.sticker.domain.repository.StickerFavoriteRepository;
import ru.krug.backend.sticker.domain.repository.StickerPackRepository;

/**
 * Message-side catalog: resolves a sendable sticker and enriches stored messages.
 * Runs inside the caller's transaction (the caller already activated the tenant GUCs,
 * including app.user_id needed by the favorites RLS policy).
 */
@Component
public class StickerCatalogAdapter implements StickerCatalogPort {

    private final StickerPackRepository packs;
    private final StickerFavoriteRepository favorites;
    private final StickerViewMapper mapper;

    public StickerCatalogAdapter(StickerPackRepository packs,
                                 StickerFavoriteRepository favorites,
                                 StickerViewMapper mapper) {
        this.packs = packs;
        this.favorites = favorites;
        this.mapper = mapper;
    }

    @Override
    @Transactional
    public StickerRefView resolveForMessage(UUID viewerId, UUID stickerId) {
        StickerRecord record = packs.findSticker(stickerId)
                .orElseThrow(() -> new StickerNotFoundException(stickerId));
        if (!record.sticker().isActive()) {
            throw new StickerGoneException(stickerId, record.sticker().status().name());
        }
        if (!record.packStatus().isUsable()) {
            throw new StickerPackDisabledException(record.sticker().packId(),
                    record.packStatus().name());
        }
        boolean favorite = favorites.findStickerIds(viewerId, List.of(stickerId))
                .contains(stickerId);
        return mapper.toRef(record.sticker(), favorite);
    }

    @Override
    @Transactional(readOnly = true)
    public Map<UUID, StickerRefView> findForMessage(UUID viewerId,
                                                    Collection<UUID> stickerIds) {
        if (stickerIds == null || stickerIds.isEmpty()) {
            return Map.of();
        }
        List<StickerRecord> records = packs.findStickers(stickerIds);
        Set<UUID> favoriteIds = favorites.findStickerIds(viewerId,
                records.stream().map(record -> record.sticker().id().value()).toList());
        Map<UUID, StickerRefView> result = new LinkedHashMap<>();
        for (StickerRecord record : records) {
            UUID id = record.sticker().id().value();
            result.put(id, mapper.toRef(record.sticker(), favoriteIds.contains(id)));
        }
        return result;
    }
}

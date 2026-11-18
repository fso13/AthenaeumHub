package ru.krug.backend.sticker.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.sticker.application.model.StickerPackView;
import ru.krug.backend.sticker.application.port.StickerAccessPort;
import ru.krug.backend.sticker.application.service.StickerViewMapper;
import ru.krug.backend.sticker.domain.model.StickerPack;
import ru.krug.backend.sticker.domain.repository.StickerFavoriteRepository;
import ru.krug.backend.sticker.domain.repository.StickerPackRepository;

/**
 * GET /sticker-packs?chat_id= — ACTIVE built-in packs for a chat the caller can read.
 * Favorites are always the caller's own (server-side, cross-device; E5-D-03).
 */
@Service
public class ListPacksUseCase {

    private final StickerAccessPort access;
    private final StickerPackRepository packs;
    private final StickerFavoriteRepository favorites;
    private final StickerViewMapper mapper;

    public ListPacksUseCase(StickerAccessPort access, StickerPackRepository packs,
                            StickerFavoriteRepository favorites, StickerViewMapper mapper) {
        this.access = access;
        this.packs = packs;
        this.favorites = favorites;
        this.mapper = mapper;
    }

    @Transactional(readOnly = true)
    public List<StickerPackView> list(Principal principal, UUID chatId) {
        if (chatId == null) {
            throw DomainException.badRequest("chat_id is required", Map.of("field", "chat_id"));
        }
        access.requireChatAccess(principal, chatId);

        List<StickerPack> activePacks = packs.findActiveWithStickers();
        List<UUID> stickerIds = activePacks.stream()
                .flatMap(pack -> pack.activeStickers().stream())
                .map(sticker -> sticker.id().value())
                .toList();
        Set<UUID> favoriteIds = stickerIds.isEmpty() ? Set.of()
                : favorites.findStickerIds(principal.userId(), stickerIds);
        return activePacks.stream().map(pack -> mapper.toPack(pack, favoriteIds)).toList();
    }
}

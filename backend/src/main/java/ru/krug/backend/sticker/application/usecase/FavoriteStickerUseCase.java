package ru.krug.backend.sticker.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.sticker.domain.exception.StickerNotFoundException;
import ru.krug.backend.sticker.domain.model.StickerRecord;
import ru.krug.backend.sticker.domain.repository.StickerFavoriteRepository;
import ru.krug.backend.sticker.domain.repository.StickerPackRepository;

/**
 * PUT/DELETE /stickers/{id}/favorite. Both directions are idempotent (204); unknown or
 * inactive sticker/pack is hidden as 404 STICKER_NOT_FOUND.
 */
@Service
public class FavoriteStickerUseCase {

    private final TenantContext tenantContext;
    private final StickerPackRepository packs;
    private final StickerFavoriteRepository favorites;

    public FavoriteStickerUseCase(TenantContext tenantContext, StickerPackRepository packs,
                                  StickerFavoriteRepository favorites) {
        this.tenantContext = tenantContext;
        this.packs = packs;
        this.favorites = favorites;
    }

    @Transactional
    public void favorite(Principal principal, UUID stickerId) {
        requireUsable(principal, stickerId);
        favorites.add(principal.userId(), stickerId);
    }

    @Transactional
    public void unfavorite(Principal principal, UUID stickerId) {
        requireUsable(principal, stickerId);
        favorites.remove(principal.userId(), stickerId);
    }

    private void requireUsable(Principal principal, UUID stickerId) {
        tenantContext.activate(principal);
        StickerRecord record = packs.findSticker(stickerId)
                .orElseThrow(() -> new StickerNotFoundException(stickerId));
        if (!record.isUsable()) {
            throw new StickerNotFoundException(stickerId);
        }
    }
}

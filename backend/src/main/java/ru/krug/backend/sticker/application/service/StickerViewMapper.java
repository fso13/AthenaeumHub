package ru.krug.backend.sticker.application.service;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.sticker.application.model.StickerPackView;
import ru.krug.backend.sticker.application.model.StickerRefView;
import ru.krug.backend.sticker.application.port.StickerAssetUrlResolver;
import ru.krug.backend.sticker.domain.model.Sticker;
import ru.krug.backend.sticker.domain.model.StickerPack;

/** Maps domain stickers to the published API read models, resolving asset URLs. */
@Component
public class StickerViewMapper {

    private final StickerAssetUrlResolver urlResolver;

    public StickerViewMapper(StickerAssetUrlResolver urlResolver) {
        this.urlResolver = urlResolver;
    }

    public StickerRefView toRef(Sticker sticker, boolean favorite) {
        return new StickerRefView(sticker.id().value(), sticker.packId(), sticker.alt(),
                urlResolver.resolve(sticker.asset().url()), favorite);
    }

    public StickerPackView toPack(StickerPack pack, Set<UUID> favoriteIds) {
        List<StickerRefView> stickers = pack.activeStickers().stream()
                .map(sticker -> toRef(sticker, favoriteIds.contains(sticker.id().value())))
                .toList();
        return new StickerPackView(pack.id(), pack.name(),
                urlResolver.resolve(pack.coverUrl()), stickers);
    }
}

package ru.krug.backend.sticker.api.mapper;

import java.util.List;

import ru.krug.backend.sticker.api.dto.StickerPackListResponse;
import ru.krug.backend.sticker.api.dto.StickerPackResponse;
import ru.krug.backend.sticker.api.dto.StickerRefResponse;
import ru.krug.backend.sticker.application.model.StickerPackView;
import ru.krug.backend.sticker.application.model.StickerRefView;

/** Application read models -> API DTOs. No domain or persistence imports. */
public final class StickerApiMapper {

    private StickerApiMapper() {
    }

    public static StickerPackListResponse toResponse(List<StickerPackView> packs) {
        List<StickerPackResponse> items = packs.stream()
                .map(StickerApiMapper::toResponse)
                .toList();
        return new StickerPackListResponse(items);
    }

    public static StickerPackResponse toResponse(StickerPackView pack) {
        return new StickerPackResponse(pack.id(), pack.name(), pack.coverUrl(),
                pack.stickers().stream().map(StickerApiMapper::toResponse).toList());
    }

    public static StickerRefResponse toResponse(StickerRefView sticker) {
        return new StickerRefResponse(sticker.id(), sticker.packId(), sticker.alt(),
                sticker.url(), sticker.favorite());
    }
}

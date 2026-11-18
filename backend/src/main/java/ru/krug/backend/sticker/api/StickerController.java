package ru.krug.backend.sticker.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.sticker.api.dto.StickerPackListResponse;
import ru.krug.backend.sticker.api.mapper.StickerApiMapper;
import ru.krug.backend.sticker.application.usecase.FavoriteStickerUseCase;
import ru.krug.backend.sticker.application.usecase.ListPacksUseCase;

/**
 * E5-B sticker endpoints. {@code X-Device-Id} is enforced by DeviceBindingFilter (the
 * contract declares it); chat access is checked in the use cases.
 */
@RestController
@RequestMapping("/api/v1")
public class StickerController {

    private final ListPacksUseCase listPacks;
    private final FavoriteStickerUseCase favorites;

    public StickerController(ListPacksUseCase listPacks, FavoriteStickerUseCase favorites) {
        this.listPacks = listPacks;
        this.favorites = favorites;
    }

    @GetMapping("/sticker-packs")
    public StickerPackListResponse list(@RequestParam("chat_id") UUID chatId,
                                        Principal principal) {
        return StickerApiMapper.toResponse(listPacks.list(principal, chatId));
    }

    @PutMapping("/stickers/{stickerId}/favorite")
    public ResponseEntity<Void> favorite(@PathVariable UUID stickerId, Principal principal) {
        favorites.favorite(principal, stickerId);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/stickers/{stickerId}/favorite")
    public ResponseEntity<Void> unfavorite(@PathVariable UUID stickerId, Principal principal) {
        favorites.unfavorite(principal, stickerId);
        return ResponseEntity.noContent().build();
    }
}

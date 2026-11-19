package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.sticker.domain.exception.StickerGoneException;
import ru.krug.backend.sticker.domain.exception.StickerNotFoundException;
import ru.krug.backend.sticker.domain.exception.StickerPackDisabledException;
import ru.krug.backend.sticker.domain.model.PackStatus;
import ru.krug.backend.sticker.domain.model.Sticker;
import ru.krug.backend.sticker.domain.model.StickerAsset;
import ru.krug.backend.sticker.domain.model.StickerFormat;
import ru.krug.backend.sticker.domain.model.StickerId;
import ru.krug.backend.sticker.domain.model.StickerPack;
import ru.krug.backend.sticker.domain.model.StickerRecord;
import ru.krug.backend.sticker.domain.model.StickerStatus;

class StickerDomainTest {

    private final UUID packId = UUID.randomUUID();
    private final StickerAsset asset = new StickerAsset("/stickers/krug/01.png",
            StickerFormat.PNG, 512, 512, 1024);

    @Test
    void assetEnforcesFormatDimensionsAndSize() {
        assertThatCode(() -> new StickerAsset("/x.webp", StickerFormat.WEBP, 512, 512, 524288))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> new StickerAsset(" ", StickerFormat.PNG, 512, 512, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new StickerAsset("/x.png", null, 512, 512, 1))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new StickerAsset("/x.png", StickerFormat.PNG, 511, 512, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new StickerAsset("/x.png", StickerFormat.PNG, 512, 512, 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new StickerAsset("/x.png", StickerFormat.PNG, 512, 512,
                524289)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void activePackRequiresEightStickersAndFiltersDisabledOnes() {
        List<Sticker> stickers = stickers(8);
        StickerPack pack = StickerPack.reconstitute(packId, "krug", "Сова",
                "/stickers/krug/cover.png", PackStatus.ACTIVE, true, stickers);
        assertThat(pack.activeStickers()).hasSize(8);
        assertThat(pack.findSticker(stickers.get(0).id().value())).contains(stickers.get(0));

        assertThatThrownBy(() -> StickerPack.reconstitute(packId, "krug", "Сова",
                "/cover.png", PackStatus.ACTIVE, true, stickers(7)))
                .isInstanceOf(IllegalArgumentException.class);

        // DISABLED packs keep history but may have fewer/zero stickers.
        assertThatCode(() -> StickerPack.reconstitute(packId, "krug", "Сова",
                "/cover.png", PackStatus.DISABLED, true, List.of()))
                .doesNotThrowAnyException();

        Sticker disabled = Sticker.create(new StickerId(UUID.randomUUID()), packId, "off",
                asset, 9, StickerStatus.DISABLED);
        List<Sticker> mixed = new ArrayList<>(stickers);
        mixed.add(disabled);
        StickerPack withDisabled = StickerPack.reconstitute(packId, "krug", "Сова",
                "/cover.png", PackStatus.ACTIVE, true, mixed);
        assertThat(withDisabled.activeStickers()).hasSize(8);
    }

    @Test
    void packRejectsForeignStickerAndInvalidMetadata() {
        Sticker foreign = Sticker.create(new StickerId(UUID.randomUUID()), UUID.randomUUID(),
                "foreign", asset, 1, StickerStatus.ACTIVE);
        List<Sticker> stickers = stickers(8);
        stickers.add(foreign);
        assertThatThrownBy(() -> StickerPack.reconstitute(packId, "krug", "Сова",
                "/cover.png", PackStatus.ACTIVE, true, stickers))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> StickerPack.reconstitute(packId, " ", "Сова",
                "/cover.png", PackStatus.DISABLED, true, List.of()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> StickerPack.reconstitute(packId, "krug", "Сова",
                " ", PackStatus.DISABLED, true, List.of()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void stickerValidatesAltAndPosition() {
        assertThatThrownBy(() -> Sticker.create(new StickerId(UUID.randomUUID()), packId,
                "", asset, 1, StickerStatus.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Sticker.create(new StickerId(UUID.randomUUID()), packId,
                "x".repeat(121), asset, 1, StickerStatus.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Sticker.create(new StickerId(UUID.randomUUID()), packId,
                "alt", asset, 0, StickerStatus.ACTIVE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(StickerId.of(UUID.randomUUID()).value()).isNotNull();
        assertThat(StickerId.of(UUID.randomUUID().toString()).toString()).isNotBlank();
    }

    @Test
    void statusesAndExceptionsFollowTheContract() {
        assertThat(PackStatus.ACTIVE.isUsable()).isTrue();
        assertThat(PackStatus.DISABLED.isUsable()).isFalse();
        assertThat(StickerStatus.ACTIVE.isUsable()).isTrue();
        assertThat(StickerStatus.REMOVED.isUsable()).isFalse();

        Sticker active = Sticker.create(new StickerId(UUID.randomUUID()), packId, "alt",
                asset, 1, StickerStatus.ACTIVE);
        assertThat(new StickerRecord(active, PackStatus.ACTIVE, true).isUsable()).isTrue();
        assertThat(new StickerRecord(active, PackStatus.DISABLED, true).isUsable()).isFalse();

        UUID stickerId = UUID.randomUUID();
        assertThatThrownBy(() -> {
            throw new StickerNotFoundException(stickerId);
        }).isInstanceOfSatisfying(DomainException.class, ex -> {
            assertThat(ex.category().name()).isEqualTo("NOT_FOUND");
            assertThat(ex.code()).isEqualTo("STICKER_NOT_FOUND");
        });
        assertThatThrownBy(() -> {
            throw new StickerGoneException(stickerId, "DISABLED");
        }).isInstanceOfSatisfying(DomainException.class, ex -> {
            assertThat(ex.category().name()).isEqualTo("GONE");
            assertThat(ex.code()).isEqualTo("STICKER_NOT_FOUND");
        });
        assertThatThrownBy(() -> {
            throw new StickerPackDisabledException(packId, "DISABLED");
        }).isInstanceOfSatisfying(DomainException.class, ex -> {
            assertThat(ex.category().name()).isEqualTo("CONFLICT");
            assertThat(ex.code()).isEqualTo("STICKER_PACK_DISABLED");
        });
    }

    private List<Sticker> stickers(int count) {
        List<Sticker> stickers = new ArrayList<>();
        for (int i = 1; i <= count; i++) {
            stickers.add(Sticker.create(new StickerId(UUID.randomUUID()), packId, "alt-" + i,
                    asset, i, StickerStatus.ACTIVE));
        }
        return stickers;
    }
}

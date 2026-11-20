package ru.krug.backend.support;

import java.util.UUID;

/** Deterministic ids from V14 so tests can reference built-in packs without a lookup. */
public final class StickerTestSupport {

    public static final UUID KRUG_PACK_ID = UUID.fromString("3a7f2fdc-306b-53c8-926d-77d90bcea67e");
    public static final UUID KRUG_01 = UUID.fromString("a275046b-3f4d-55ca-aabe-2abb589afc93");
    public static final UUID KRUG_02 = UUID.fromString("2fdff577-4816-5a8e-bb77-a3efef1681e6");
    /** V46 deleted the cats pack; the regression tests use a surviving owl sticker. */
    public static final UUID SOVA_PACK_ID = KRUG_PACK_ID;
    public static final UUID SOVA_02 = KRUG_02;

    private StickerTestSupport() {
    }
}

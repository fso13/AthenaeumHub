package ru.krug.backend.support;

import java.util.UUID;

/** Deterministic ids from V14 so tests can reference built-in packs without a lookup. */
public final class StickerTestSupport {

    public static final UUID KRUG_PACK_ID = UUID.fromString("3a7f2fdc-306b-53c8-926d-77d90bcea67e");
    public static final UUID CATS_PACK_ID = UUID.fromString("80c42b6e-6530-5a31-b47e-eaf857ebaf0e");
    public static final UUID KRUG_01 = UUID.fromString("a275046b-3f4d-55ca-aabe-2abb589afc93");
    public static final UUID KRUG_02 = UUID.fromString("2fdff577-4816-5a8e-bb77-a3efef1681e6");
    public static final UUID CATS_01 = UUID.fromString("e23ed071-3a99-53a6-a507-e9f4a1c7a451");

    private StickerTestSupport() {
    }
}

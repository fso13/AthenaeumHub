package ru.krug.backend.plugin.domain.model;

/**
 * Constants of the built-in {@code music-room} plugin (#94).
 *
 * <p>The room is an ordinary managed GROUP channel tagged in {@code chat.plugin_rooms}; the
 * server stores no audio, no playback state and no SFU session. The client lists the
 * channel's AUDIO attachments and mixes them locally into the call. Built-in catalog rows
 * carry no package version by design, so {@link #VERSION} is the plugin slice version
 * exposed by the API and documented in {@code backend/MUSIC-ROOM-REPORT.md}.</p>
 */
public final class MusicRoom {

    /** Catalog id (slug) of the built-in plugin. */
    public static final String PLUGIN_ID = "music-room";

    /** Slice version of the built-in plugin exposed in the music-room state payload. */
    public static final String VERSION = "1.0.0";

    /** Stable name of the workspace-wide room created by the open endpoint. */
    public static final String CHANNEL_NAME = "Музыкальная комната";

    /** Hard cap of the audio listing in this slice (no cursor); documented in OpenAPI. */
    public static final int MAX_TRACKS = 100;

    private MusicRoom() {
    }
}

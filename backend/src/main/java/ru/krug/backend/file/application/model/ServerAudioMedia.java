package ru.krug.backend.file.application.model;

import ru.krug.backend.file.domain.model.MediaMetadata;

/**
 * Result of server-side audio extraction (#97): the sanitized server metadata plus the private
 * object key of the extracted cover, when one was stored. The key is application-internal and
 * never serialized into an API response.
 */
public record ServerAudioMedia(MediaMetadata media, String artworkKey) {
}

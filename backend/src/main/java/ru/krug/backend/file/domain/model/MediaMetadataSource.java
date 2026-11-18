package ru.krug.backend.file.domain.model;

/**
 * Where the metadata came from. The MVP accepts client parsed ID3 (or a client fallback);
 * server extraction is D1.1. {@code NONE} means the client explicitly had no metadata.
 */
public enum MediaMetadataSource {
    ID3,
    SERVER,
    CLIENT,
    NONE
}

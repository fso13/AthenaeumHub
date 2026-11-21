package ru.krug.backend.file.domain.model;

/**
 * Where the metadata came from. {@code ID3}/{@code CLIENT} are client supplied;
 * {@code SERVER} is the bounded server extraction added in #97; {@code NONE} means the client
 * explicitly had no metadata (the server may still replace it on complete).
 */
public enum MediaMetadataSource {
    ID3,
    SERVER,
    CLIENT,
    NONE
}

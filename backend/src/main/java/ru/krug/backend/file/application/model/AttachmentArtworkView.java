package ru.krug.backend.file.application.model;

/**
 * Bytes of a server-extracted audio cover (#97). {@code mimeType} is sniffed from the stored
 * magic bytes, never from client input, and is limited to static raster formats.
 */
public record AttachmentArtworkView(byte[] content, String mimeType) {
}

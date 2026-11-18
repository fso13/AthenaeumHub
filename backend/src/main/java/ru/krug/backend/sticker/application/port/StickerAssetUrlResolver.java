package ru.krug.backend.sticker.application.port;

/** Expands a stored sticker asset path into the URL returned by the API. */
public interface StickerAssetUrlResolver {

    String resolve(String storedUrl);
}

package ru.krug.backend.plugin.api.dto;

/**
 * Partial PATCH of the translation provider. At least one field is required; {@code url}
 * must be an absolute https URL (or an internal http host) without credentials/query/fragment
 * when supplied. {@code provider} is {@code AUTO}, {@code CUSTOM} or {@code LIBRETRANSLATE};
 * {@code null} keeps the stored value and a blank value resets it to {@code AUTO}.
 */
public record UpdateTranslationProviderRequest(Boolean enabled, String url, String provider) {
}

package ru.krug.backend.plugin.api.dto;

/**
 * Partial PATCH of the translation provider. At least one field is required; {@code url}
 * must be an absolute https URL without credentials/query/fragment when supplied.
 */
public record UpdateTranslationProviderRequest(Boolean enabled, String url) {
}

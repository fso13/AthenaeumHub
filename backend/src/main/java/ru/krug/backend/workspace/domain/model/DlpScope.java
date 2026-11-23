package ru.krug.backend.workspace.domain.model;

/**
 * Surface a DLP rule applies to (#101).
 *
 * <p>{@code ALL} is the default for a rule created without an explicit scope and for the
 * rules that existed before #101. It keeps a single workspace rule effective on every
 * managed payload, which is the conservative (blocking) choice. A rule can be narrowed to
 * {@code TEXT}, {@code ATTACHMENT} or {@code PLUGIN}; the enforcement service never treats
 * a narrowed rule as applicable to another surface.</p>
 *
 * <p>Only managed content is evaluated. E2EE payloads are opaque to the server and the
 * workspace cannot enable DLP in E2EE mode, so no rule is ever applied to ciphertext.</p>
 */
public enum DlpScope {
    ALL,
    TEXT,
    ATTACHMENT,
    PLUGIN;

    /** True when this rule scope applies to the given enforcement surface. */
    public boolean appliesTo(DlpSurface surface) {
        return this == ALL || surface == DlpSurface.valueOf(name());
    }
}

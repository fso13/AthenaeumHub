package ru.krug.backend.workspace.domain.model;

/**
 * Enforcement point that asks the DLP matcher a question (#101). Unlike {@link DlpScope},
 * this enum never contains {@code ALL}: a concrete payload is always one of the three
 * managed surfaces.
 */
public enum DlpSurface {
    TEXT,
    ATTACHMENT,
    PLUGIN
}

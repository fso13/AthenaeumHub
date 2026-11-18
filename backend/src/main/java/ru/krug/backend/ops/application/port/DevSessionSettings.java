package ru.krug.backend.ops.application.port;

/**
 * Infrastructure-provided defaults for the dev bootstrap, so application code does not
 * depend on Spring configuration classes.
 */
public interface DevSessionSettings {

    String defaultDisplayName();

    String workspaceName();

    String chatName();
}

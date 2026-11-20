package ru.krug.backend.plugin.application.port;

/** A uploaded package is not a valid, safe manifest v1 package. */
public class PluginPackageInvalidException extends RuntimeException {

    public PluginPackageInvalidException(String message) {
        super(message);
    }

    public PluginPackageInvalidException(String message, Throwable cause) {
        super(message, cause);
    }
}

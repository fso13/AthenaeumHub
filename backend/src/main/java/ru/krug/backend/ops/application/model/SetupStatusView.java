package ru.krug.backend.ops.application.model;

/** Public, secret-free setup status used by the first-run wizard. */
public record SetupStatusView(boolean setupRequired, boolean registrationOpen) {
}

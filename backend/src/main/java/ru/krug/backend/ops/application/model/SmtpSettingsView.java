package ru.krug.backend.ops.application.model;

/** SMTP settings safe to return through the admin API: never includes the password. */
public record SmtpSettingsView(
        String host,
        Integer port,
        String username,
        String from,
        boolean starttls,
        boolean configured) {
}

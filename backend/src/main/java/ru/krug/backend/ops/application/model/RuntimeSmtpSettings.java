package ru.krug.backend.ops.application.model;

/**
 * Decrypted SMTP transport settings for the mail adapter only. This type deliberately has a
 * redacted {@link #toString()}; it must never be serialized into an API response or a log.
 */
public record RuntimeSmtpSettings(
        String host,
        Integer port,
        String username,
        String password,
        String from,
        boolean starttls) {

    public boolean usable() {
        return host != null && !host.isBlank() && from != null && !from.isBlank();
    }

    @Override
    public String toString() {
        return "RuntimeSmtpSettings[host=" + host + ", port=" + port + ", username=" + username
                + ", password=" + (password == null ? "null" : "<redacted>")
                + ", from=" + from + ", starttls=" + starttls + "]";
    }
}

package ru.krug.backend.ops.domain.model;

import java.util.Arrays;
import java.util.Objects;

/**
 * SMTP transport configuration of the installation. The password is stored only as AES-GCM
 * ciphertext; no accessor returns plaintext and {@link #toString()} never contains it.
 */
public record SmtpSettings(
        String host,
        Integer port,
        String username,
        byte[] passwordCiphertext,
        String from,
        boolean starttls) {

    public SmtpSettings {
        if (host != null && host.strip().length() > 255) {
            throw new IllegalArgumentException("SMTP host must be at most 255 characters");
        }
        if (port != null && (port < 1 || port > 65535)) {
            throw new IllegalArgumentException("SMTP port must be within 1..65535");
        }
        if (username != null && username.strip().length() > 255) {
            throw new IllegalArgumentException("SMTP username must be at most 255 characters");
        }
        if (from != null && (from.isBlank() || from.strip().length() > 254)) {
            throw new IllegalArgumentException("SMTP from must be 1..254 characters");
        }
        passwordCiphertext = passwordCiphertext == null ? null
                : Arrays.copyOf(passwordCiphertext, passwordCiphertext.length);
    }

    public static SmtpSettings empty() {
        return new SmtpSettings(null, null, null, null, null, true);
    }

    @Override
    public byte[] passwordCiphertext() {
        return passwordCiphertext == null ? null
                : Arrays.copyOf(passwordCiphertext, passwordCiphertext.length);
    }

    public boolean hasPassword() {
        return passwordCiphertext != null && passwordCiphertext.length > 0;
    }

    /** A relay is usable when the host and envelope sender are configured. */
    public boolean configured() {
        return host != null && !host.isBlank() && from != null && !from.isBlank();
    }

    @Override
    public String toString() {
        return "SmtpSettings[host=" + host + ", port=" + port + ", username=" + username
                + ", password=" + (hasPassword() ? "<redacted>" : "null")
                + ", from=" + from + ", starttls=" + starttls + "]";
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof SmtpSettings that)) {
            return false;
        }
        return starttls == that.starttls
                && Objects.equals(host, that.host)
                && Objects.equals(port, that.port)
                && Objects.equals(username, that.username)
                && Arrays.equals(passwordCiphertext, that.passwordCiphertext)
                && Objects.equals(from, that.from);
    }

    @Override
    public int hashCode() {
        int result = Objects.hash(host, port, username, from, starttls);
        return 31 * result + Arrays.hashCode(passwordCiphertext);
    }
}

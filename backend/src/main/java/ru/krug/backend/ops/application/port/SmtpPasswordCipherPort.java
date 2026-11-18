package ru.krug.backend.ops.application.port;

/** AES-256-GCM at-rest encryption for the SMTP password. */
public interface SmtpPasswordCipherPort {

    byte[] encrypt(String plaintext);

    String decrypt(byte[] ciphertext);
}

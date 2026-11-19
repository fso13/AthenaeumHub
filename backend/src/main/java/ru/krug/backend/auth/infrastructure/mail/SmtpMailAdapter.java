package ru.krug.backend.auth.infrastructure.mail;

import java.util.Properties;

import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.model.EmailCodeMessage;
import ru.krug.backend.auth.application.port.MailDeliveryException;
import ru.krug.backend.auth.application.port.MailPort;
import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.ops.application.port.TestEmailException;
import ru.krug.backend.ops.application.port.TestEmailPort;

/**
 * SMTP delivery for verification codes and admin test emails. Runtime settings from
 * {@code ops.system_settings} override the environment ({@code spring.mail.*}); when the
 * installer has not configured SMTP yet, the environment-configured sender is the fallback.
 * The SMTP password is decrypted in memory only and is never logged or returned.
 */
@Component
public class SmtpMailAdapter implements MailPort, TestEmailPort {

    private final JavaMailSender envSender;
    private final AuthBffProperties properties;
    private final SystemSettingsPort settings;

    public SmtpMailAdapter(JavaMailSender envSender, AuthBffProperties properties,
                           SystemSettingsPort settings) {
        this.envSender = envSender;
        this.properties = properties;
        this.settings = settings;
    }

    @Override
    public void sendEmailCode(EmailCodeMessage message) {
        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setTo(message.email());
        mail.setSubject("Сова — подтверждение email");
        mail.setText("""
                Здравствуйте!

                Ваш код подтверждения: %s

                Код действует %d мин. Если вы не регистрировались в Сове, проигнорируйте письмо.
                """.formatted(message.code(), message.expiresInMinutes()));
        send(mail, MailDeliveryException::new);
    }

    @Override
    public void sendTestEmail(String to) {
        SimpleMailMessage mail = new SimpleMailMessage();
        mail.setTo(to);
        mail.setSubject("Сова — тестовое письмо");
        mail.setText("""
                Это тестовое письмо из административной панели Совы.

                Если вы его получили, SMTP настроен корректно.
                """);
        send(mail, TestEmailException::new);
    }

    private void send(SimpleMailMessage mail, RuntimeExceptionFactory failure) {
        RuntimeSmtpSettings runtime = settings.smtp();
        mail.setFrom(runtime.usable() ? runtime.from() : properties.mail().from());
        try {
            if (runtime.usable()) {
                runtimeSender(runtime).send(mail);
            } else {
                envSender.send(mail);
            }
        } catch (MailException ex) {
            throw failure.create();
        }
    }

    private static JavaMailSenderImpl runtimeSender(RuntimeSmtpSettings runtime) {
        JavaMailSenderImpl sender = new JavaMailSenderImpl();
        sender.setHost(runtime.host());
        if (runtime.port() != null) {
            sender.setPort(runtime.port());
        }
        sender.setDefaultEncoding("UTF-8");
        if (runtime.username() != null && !runtime.username().isBlank()) {
            sender.setUsername(runtime.username());
            if (runtime.password() != null) {
                sender.setPassword(runtime.password());
            }
        }
        Properties mailProperties = sender.getJavaMailProperties();
        mailProperties.put("mail.smtp.auth",
                runtime.username() != null && !runtime.username().isBlank());
        mailProperties.put("mail.smtp.starttls.enable", runtime.starttls());
        mailProperties.put("mail.smtp.connectiontimeout", "5000");
        mailProperties.put("mail.smtp.timeout", "5000");
        mailProperties.put("mail.smtp.writetimeout", "5000");
        return sender;
    }

    @FunctionalInterface
    private interface RuntimeExceptionFactory {
        RuntimeException create();
    }
}

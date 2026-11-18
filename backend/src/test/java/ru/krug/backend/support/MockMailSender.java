package ru.krug.backend.support;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import ru.krug.backend.auth.application.model.EmailCodeMessage;
import ru.krug.backend.auth.application.port.MailPort;
import ru.krug.backend.ops.application.port.TestEmailPort;

/** Captures Auth BFF emails and admin SMTP probes instead of talking to SMTP. */
public class MockMailSender implements MailPort, TestEmailPort {

    private final List<EmailCodeMessage> sent = new CopyOnWriteArrayList<>();
    private final List<String> testEmails = new CopyOnWriteArrayList<>();

    @Override
    public void sendEmailCode(EmailCodeMessage message) {
        sent.add(message);
    }

    @Override
    public void sendTestEmail(String to) {
        testEmails.add(to);
    }

    public String lastTestEmail() {
        if (testEmails.isEmpty()) {
            throw new IllegalStateException("No test email was sent");
        }
        return testEmails.get(testEmails.size() - 1);
    }

    public EmailCodeMessage last() {
        if (sent.isEmpty()) {
            throw new IllegalStateException("No verification email was sent");
        }
        return sent.get(sent.size() - 1);
    }

    public String lastCode() {
        return last().code();
    }

    public EmailCodeMessage lastFor(String email) {
        return sent.stream()
                .filter(message -> message.email().equalsIgnoreCase(email))
                .reduce((first, second) -> second)
                .orElseThrow(() -> new IllegalStateException("No email for the requested user"));
    }

    public int count() {
        return sent.size();
    }

    public void clear() {
        sent.clear();
        testEmails.clear();
    }
}

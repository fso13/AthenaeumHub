package ru.krug.backend.support;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import ru.krug.backend.auth.application.model.EmailCodeMessage;
import ru.krug.backend.auth.application.port.MailPort;
import ru.krug.backend.ops.application.model.OutboundEmail;
import ru.krug.backend.ops.application.port.EmailDeliveryPort;
import ru.krug.backend.ops.application.port.TestEmailPort;

/** Captures Auth BFF emails and generic outbound emails instead of talking to SMTP. */
public class MockMailSender implements MailPort, TestEmailPort, EmailDeliveryPort {

    private final List<EmailCodeMessage> sent = new CopyOnWriteArrayList<>();
    private final List<OutboundEmail> outbound = new CopyOnWriteArrayList<>();
    private final List<String> testEmails = new CopyOnWriteArrayList<>();

    @Override
    public void sendEmailCode(EmailCodeMessage message) {
        sent.add(message);
    }

    @Override
    public void sendEmail(OutboundEmail email) {
        outbound.add(email);
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

    public OutboundEmail lastOutbound() {
        if (outbound.isEmpty()) {
            throw new IllegalStateException("No outbound email was sent");
        }
        return outbound.get(outbound.size() - 1);
    }

    public List<OutboundEmail> outbound() {
        return List.copyOf(outbound);
    }

    public int outboundCount() {
        return outbound.size();
    }

    public int count() {
        return sent.size();
    }

    public void clear() {
        sent.clear();
        outbound.clear();
        testEmails.clear();
    }
}

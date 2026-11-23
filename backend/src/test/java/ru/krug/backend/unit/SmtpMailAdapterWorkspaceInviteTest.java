package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

import ru.krug.backend.auth.infrastructure.mail.SmtpMailAdapter;
import ru.krug.backend.ops.application.model.OutboundEmail;
import ru.krug.backend.ops.application.model.RuntimeSmtpSettings;
import ru.krug.backend.ops.application.port.SystemSettingsPort;
import ru.krug.backend.support.AuthBffTestData;

/**
 * #100: a workspace invitation follows the same SMTP adapter path as verification codes
 * (Mailpit in dev); the token-bearing body is forwarded verbatim and never rendered by
 * {@code toString}.
 */
class SmtpMailAdapterWorkspaceInviteTest {

    @Test
    void outboundEmailUsesTheConfiguredSenderAndRedactsItsBody() {
        JavaMailSender envSender = mock(JavaMailSender.class);
        SystemSettingsPort settings = mock(SystemSettingsPort.class);
        when(settings.smtp()).thenReturn(
                new RuntimeSmtpSettings(null, null, null, null, null, false));
        SmtpMailAdapter adapter = new SmtpMailAdapter(envSender,
                AuthBffTestData.properties(), settings);

        OutboundEmail message = new OutboundEmail("invitee@krug.test",
                "Сова — приглашение", "Принять: http://localhost:5173/workspace-invite/token");
        adapter.sendEmail(message);

        ArgumentCaptor<SimpleMailMessage> captor =
                ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(envSender).send(captor.capture());
        SimpleMailMessage sent = captor.getValue();
        assertThat(sent.getTo()).containsExactly("invitee@krug.test");
        assertThat(sent.getFrom()).isEqualTo(AuthBffTestData.MAIL_FROM);
        assertThat(sent.getSubject()).isEqualTo("Сова — приглашение");
        assertThat(sent.getText()).contains("http://localhost:5173/workspace-invite/token");
        assertThat(message.toString()).contains("body=redacted")
                .doesNotContain("workspace-invite/token");
        verify(envSender, org.mockito.Mockito.times(1)).send(any(SimpleMailMessage.class));
    }
}

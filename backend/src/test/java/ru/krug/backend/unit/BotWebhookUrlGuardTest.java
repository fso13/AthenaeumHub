package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;

import org.junit.jupiter.api.Test;

import ru.krug.backend.bot.application.port.BotDeliveryException;
import ru.krug.backend.bot.application.service.BotWebhookUrlGuard;

class BotWebhookUrlGuardTest {

    private static final InetAddress PUBLIC = address("93.184.216.34");

    @Test
    void acceptsPublicHttpsOnly() {
        BotWebhookUrlGuard guard = new BotWebhookUrlGuard(host -> List.of(PUBLIC));
        assertThat(guard.validate("https://events.example.test/hooks/sova").toString())
                .isEqualTo("https://events.example.test/hooks/sova");
        assertThatThrownBy(() -> guard.validate("http://events.example.test/hook"))
                .isInstanceOfSatisfying(BotDeliveryException.class,
                        ex -> assertThat(ex.reason()).isEqualTo("url_invalid"));
        assertThatThrownBy(() -> guard.validate("https://user:pass@events.example.test/hook"))
                .isInstanceOfSatisfying(BotDeliveryException.class,
                        ex -> assertThat(ex.reason()).isEqualTo("url_invalid"));
    }

    @Test
    void rejectsLoopbackPrivateLinkLocalAndMetadataAddresses() {
        for (String address : List.of("127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
                "169.254.169.254", "100.64.0.1", "198.18.0.1", "0.0.0.0", "224.0.0.1",
                "192.0.2.10", "198.51.100.10", "203.0.113.10", "255.255.255.255")) {
            InetAddress resolved = address(address);
            BotWebhookUrlGuard guard = new BotWebhookUrlGuard(host -> List.of(resolved));
            assertThatThrownBy(() -> guard.validate("https://events.example.test/hook"))
                    .as(address)
                    .isInstanceOfSatisfying(BotDeliveryException.class,
                            ex -> assertThat(ex.reason()).isEqualTo("private_address"));
        }
    }

    @Test
    void rejectsIPv6LoopbackUniqueLocalAndMappedPrivate() {
        for (String address : List.of("::1", "fc00::1", "fd12:3456::1", "fe80::1",
                "::ffff:127.0.0.1", "::ffff:10.0.0.5", "2001:db8::1")) {
            InetAddress resolved = address(address);
            BotWebhookUrlGuard guard = new BotWebhookUrlGuard(host -> List.of(resolved));
            assertThatThrownBy(() -> guard.validate("https://events.example.test/hook"))
                    .as(address)
                    .isInstanceOfSatisfying(BotDeliveryException.class,
                            ex -> assertThat(ex.reason()).isEqualTo("private_address"));
        }
    }

    @Test
    void rejectsLocalhostAndUnresolvedHosts() {
        BotWebhookUrlGuard guard = new BotWebhookUrlGuard(host -> List.of(PUBLIC));
        assertThatThrownBy(() -> guard.validate("https://localhost/hook"))
                .isInstanceOfSatisfying(BotDeliveryException.class,
                        ex -> assertThat(ex.reason()).isEqualTo("loopback_address"));

        BotWebhookUrlGuard unresolved = new BotWebhookUrlGuard(host -> {
            throw new UnknownHostException(host);
        });
        assertThatThrownBy(() -> unresolved.validate("https://missing.example.test/hook"))
                .isInstanceOfSatisfying(BotDeliveryException.class, ex -> {
                    assertThat(ex.reason()).isEqualTo("dns_unresolved");
                    assertThat(ex.retryable()).isTrue();
                });
    }

    @Test
    void onePrivateAnswerAmongManyRejectsTheWholeHost() {
        BotWebhookUrlGuard guard = new BotWebhookUrlGuard(
                host -> List.of(PUBLIC, address("192.168.0.5")));
        assertThatThrownBy(() -> guard.validate("https://events.example.test/hook"))
                .isInstanceOfSatisfying(BotDeliveryException.class,
                        ex -> assertThat(ex.reason()).isEqualTo("private_address"));
    }

    private static InetAddress address(String value) {
        try {
            return InetAddress.getByName(value);
        } catch (UnknownHostException ex) {
            throw new IllegalStateException(ex);
        }
    }
}

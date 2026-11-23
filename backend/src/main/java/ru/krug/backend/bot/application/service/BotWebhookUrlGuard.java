package ru.krug.backend.bot.application.service;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Locale;

import org.springframework.stereotype.Service;

import ru.krug.backend.bot.application.port.BotDeliveryException;
import ru.krug.backend.bot.application.port.BotHostResolver;

/**
 * SSRF guard executed immediately before every outbound delivery.
 *
 * <p>The stored URL is already https-only and credential/query/fragment-free. At send time
 * the host is resolved and every address is checked: loopback, private, link-local,
 * multicast, unspecified, CGNAT, benchmark/documentation ranges and IPv6 unique-local are
 * rejected. No redirect is ever followed by the transport, so a public endpoint cannot
 * bounce the request to an internal address. DNS is resolved at send time on purpose; a
 * literal {@code 127.0.0.1}/{@code localhost} therefore fails even when the URL was accepted
 * at configuration time.</p>
 */
@Service
public class BotWebhookUrlGuard {

    private final BotHostResolver hostResolver;

    public BotWebhookUrlGuard(BotHostResolver hostResolver) {
        this.hostResolver = hostResolver;
    }

    public URI validate(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) {
            throw new BotDeliveryException("url_not_configured", false);
        }
        URI uri;
        try {
            uri = URI.create(BotEventsUrl.normalize(rawUrl));
        } catch (IllegalArgumentException | ru.krug.backend.shared.error.DomainException ex) {
            throw new BotDeliveryException("url_invalid", false);
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new BotDeliveryException("url_invalid", false);
        }
        String normalizedHost = host.toLowerCase(Locale.ROOT);
        if (normalizedHost.equals("localhost") || normalizedHost.endsWith(".localhost")) {
            throw new BotDeliveryException("loopback_address", false);
        }
        String resolveHost = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1) : host;
        List<InetAddress> addresses;
        try {
            addresses = hostResolver.resolve(resolveHost);
        } catch (UnknownHostException ex) {
            throw new BotDeliveryException("dns_unresolved", true);
        }
        if (addresses == null || addresses.isEmpty()) {
            throw new BotDeliveryException("dns_unresolved", true);
        }
        boolean blocked = false;
        for (InetAddress address : addresses) {
            if (isBlocked(address)) {
                blocked = true;
                break;
            }
        }
        if (blocked) {
            throw new BotDeliveryException("private_address", false);
        }
        return uri;
    }

    static boolean isBlocked(InetAddress address) {
        if (address == null) {
            return true;
        }
        if (address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            return ipv4Blocked(bytes);
        }
        if (bytes.length == 16) {
            // IPv4-mapped ::ffff:a.b.c.d — re-check the embedded address.
            boolean mapped = true;
            for (int index = 0; index < 10; index++) {
                if (bytes[index] != 0) {
                    mapped = false;
                    break;
                }
            }
            if (mapped && (bytes[10] & 0xFF) == 0xFF && (bytes[11] & 0xFF) == 0xFF) {
                return ipv4Blocked(new byte[] {bytes[12], bytes[13], bytes[14], bytes[15]});
            }
            // fc00::/7 unique-local.
            if ((bytes[0] & 0xFE) == 0xFC) {
                return true;
            }
            // 2001:db8::/32 documentation.
            if ((bytes[0] & 0xFF) == 0x20 && (bytes[1] & 0xFF) == 0x01
                    && (bytes[2] & 0xFF) == 0x0D && (bytes[3] & 0xFF) == 0xB8) {
                return true;
            }
            // 64:ff9b::/96 NAT64 can map private IPv4; reject the well-known prefix.
            if ((bytes[0] & 0xFF) == 0x00 && (bytes[1] & 0xFF) == 0x64
                    && (bytes[2] & 0xFF) == 0xFF && (bytes[3] & 0xFF) == 0x9B) {
                return true;
            }
        }
        return false;
    }

    private static boolean ipv4Blocked(byte[] b) {
        int first = b[0] & 0xFF;
        int second = b[1] & 0xFF;
        if (first == 0 || first == 10 || first == 127) {
            return true;
        }
        if (first == 100 && second >= 64 && second <= 127) {
            return true; // 100.64.0.0/10 CGNAT
        }
        if (first == 169 && second == 254) {
            return true;
        }
        if (first == 172 && second >= 16 && second <= 31) {
            return true;
        }
        if (first == 192 && second == 168) {
            return true;
        }
        if (first == 192 && second == 0 && (b[2] & 0xFF) == 0) {
            return true; // 192.0.0.0/24
        }
        if (first == 192 && second == 0 && (b[2] & 0xFF) == 2) {
            return true; // 192.0.2.0/24 TEST-NET-1
        }
        if (first == 198 && (second == 18 || second == 19)) {
            return true; // 198.18.0.0/15 benchmark
        }
        if (first == 198 && second == 51 && (b[2] & 0xFF) == 100) {
            return true; // 198.51.100.0/24 TEST-NET-2
        }
        if (first == 203 && second == 0 && (b[2] & 0xFF) == 113) {
            return true; // 203.0.113.0/24 TEST-NET-3
        }
        return first >= 224; // multicast, reserved, broadcast
    }
}

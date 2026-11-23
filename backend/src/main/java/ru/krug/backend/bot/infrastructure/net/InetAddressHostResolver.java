package ru.krug.backend.bot.infrastructure.net;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.List;

import org.springframework.stereotype.Component;

import ru.krug.backend.bot.application.port.BotHostResolver;

/** Production DNS seam: resolves the host at send time for the SSRF guard. */
@Component
public class InetAddressHostResolver implements BotHostResolver {

    @Override
    public List<InetAddress> resolve(String host) throws UnknownHostException {
        InetAddress[] addresses = InetAddress.getAllByName(host);
        return addresses == null ? List.of() : List.copyOf(Arrays.asList(addresses));
    }
}

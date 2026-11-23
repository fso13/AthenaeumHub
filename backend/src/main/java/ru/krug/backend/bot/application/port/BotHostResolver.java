package ru.krug.backend.bot.application.port;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;

/**
 * DNS seam for the SSRF guard. Production resolves with {@link InetAddress}; tests inject a
 * deterministic resolver so the suite never depends on external DNS.
 */
public interface BotHostResolver {

    List<InetAddress> resolve(String host) throws UnknownHostException;
}

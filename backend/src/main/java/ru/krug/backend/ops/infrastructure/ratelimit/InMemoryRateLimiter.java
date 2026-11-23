package ru.krug.backend.ops.infrastructure.ratelimit;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * In-memory fixed-window limiter for message sends and E2EE prekey claims (single-node
 * MVP). Redis token bucket is the production implementation (SYSTEM-ANALYSIS §7.3).
 *
 * <p>Claim windows (P1-01) are independent from the message windows: a claim never
 * consumes message quota and vice versa. A claim counts once per (user), (chat) and
 * (target device) bucket so a single chat cannot be used to drain a victim's OPK pool.
 */
@Component
public class InMemoryRateLimiter implements RateLimitPort {

    private record Window(long startNanos, int count) {
    }

    private final boolean enabled;
    private final int sendPerUser;
    private final long sendUserWindowNanos;
    private final int sendPerChat;
    private final long sendChatWindowNanos;
    private final int claimPerUser;
    private final long claimUserWindowNanos;
    private final int claimPerChat;
    private final long claimChatWindowNanos;
    private final int inviteAcceptPerUser;
    private final long inviteAcceptUserWindowNanos;
    private final int inviteCreatePerChat;
    private final long inviteCreateChatWindowNanos;
    private final int botSendPerBot;
    private final long botSendBotWindowNanos;
    private final int botSendPerChat;
    private final long botSendChatWindowNanos;
    private final int botCommandPerUser;
    private final long botCommandUserWindowNanos;
    private final int botResponsePerToken;
    private final long botResponseTokenWindowNanos;
    private final int inviteEmailPerWorkspace;
    private final long inviteEmailWorkspaceWindowNanos;
    private final int inviteEmailPerAddress;
    private final long inviteEmailAddressWindowNanos;
    private final int invitePreviewPerIp;
    private final long invitePreviewIpWindowNanos;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public InMemoryRateLimiter(KrugProperties properties) {
        KrugProperties.RateLimit config = properties.rateLimit();
        this.enabled = config.enabled();
        this.sendPerUser = config.sendPerUser();
        this.sendUserWindowNanos = config.sendUserWindow().toNanos();
        this.sendPerChat = config.sendPerChat();
        this.sendChatWindowNanos = config.sendChatWindow().toNanos();
        this.claimPerUser = config.claimPerUser();
        this.claimUserWindowNanos = config.claimUserWindow().toNanos();
        this.claimPerChat = config.claimPerChat();
        this.claimChatWindowNanos = config.claimChatWindow().toNanos();
        this.inviteAcceptPerUser = config.inviteAcceptPerUser();
        this.inviteAcceptUserWindowNanos = config.inviteAcceptWindow().toNanos();
        this.inviteCreatePerChat = config.inviteCreatePerChat();
        this.inviteCreateChatWindowNanos = config.inviteCreateWindow().toNanos();
        this.botSendPerBot = config.botSendPerBot();
        this.botSendBotWindowNanos = config.botSendWindow().toNanos();
        this.botSendPerChat = config.botSendPerChat();
        this.botSendChatWindowNanos = config.botSendChatWindow().toNanos();
        this.botCommandPerUser = config.botCommandPerUser();
        this.botCommandUserWindowNanos = config.botCommandWindow().toNanos();
        this.botResponsePerToken = config.botResponsePerToken();
        this.botResponseTokenWindowNanos = config.botResponseWindow().toNanos();
        this.inviteEmailPerWorkspace = config.inviteEmailPerWorkspace();
        this.inviteEmailWorkspaceWindowNanos = config.inviteEmailWorkspaceWindow().toNanos();
        this.inviteEmailPerAddress = config.inviteEmailPerAddress();
        this.inviteEmailAddressWindowNanos = config.inviteEmailAddressWindow().toNanos();
        this.invitePreviewPerIp = config.invitePreviewPerIp();
        this.invitePreviewIpWindowNanos = config.invitePreviewIpWindow().toNanos();
    }

    @Override
    public void checkMessageSend(Principal principal, UUID chatId) {
        if (!enabled) {
            return;
        }
        enforce("send:user:" + principal.userId(), sendPerUser, sendUserWindowNanos, "user");
        enforce("send:chat:" + chatId, sendPerChat, sendChatWindowNanos, "chat");
    }

    @Override
    public void checkKeyClaim(Principal principal, UUID chatId, UUID targetDeviceId) {
        if (!enabled) {
            return;
        }
        enforce("claim:user:" + principal.userId(), claimPerUser, claimUserWindowNanos, "user");
        if (chatId != null) {
            enforce("claim:chat:" + chatId, claimPerChat, claimChatWindowNanos, "chat");
        }
        if (targetDeviceId != null) {
            enforce("claim:device:" + targetDeviceId, claimPerChat, claimChatWindowNanos,
                    "device");
        }
    }

    @Override
    public void checkInviteAccept(Principal principal) {
        if (!enabled) {
            return;
        }
        enforce("invite-accept:user:" + principal.userId(), inviteAcceptPerUser,
                inviteAcceptUserWindowNanos, "user");
    }

    @Override
    public void checkInviteCreate(Principal principal, UUID chatId) {
        if (!enabled) {
            return;
        }
        enforce("invite-create:chat:" + chatId, inviteCreatePerChat,
                inviteCreateChatWindowNanos, "chat");
    }

    @Override
    public void checkBotSend(UUID botId, UUID chatId) {
        if (!enabled) {
            return;
        }
        enforce("bot-send:bot:" + botId, botSendPerBot, botSendBotWindowNanos, "bot");
        enforce("bot-send:chat:" + chatId, botSendPerChat, botSendChatWindowNanos, "chat");
    }

    @Override
    public void checkBotCommand(Principal principal, UUID chatId) {
        if (!enabled) {
            return;
        }
        enforce("bot-command:user:" + principal.userId(), botCommandPerUser,
                botCommandUserWindowNanos, "user");
        enforce("bot-command:chat:" + chatId, botCommandPerUser,
                botCommandUserWindowNanos, "chat");
    }

    @Override
    public void checkBotResponse(UUID tokenId, UUID botId) {
        if (!enabled) {
            return;
        }
        enforce("bot-response:token:" + tokenId, botResponsePerToken,
                botResponseTokenWindowNanos, "token");
        enforce("bot-response:bot:" + botId, botResponsePerToken,
                botResponseTokenWindowNanos, "bot");
    }

    @Override
    public void checkInviteEmailSend(Principal principal, UUID workspaceId, String email) {
        if (!enabled) {
            return;
        }
        enforce("invite-email:workspace:" + workspaceId, inviteEmailPerWorkspace,
                inviteEmailWorkspaceWindowNanos, "workspace");
        enforce("invite-email:address:" + normalize(email), inviteEmailPerAddress,
                inviteEmailAddressWindowNanos, "email");
    }

    @Override
    public void checkInvitePreview(String clientIp) {
        if (!enabled) {
            return;
        }
        enforce("invite-preview:ip:" + normalize(clientIp), invitePreviewPerIp,
                invitePreviewIpWindowNanos, "ip");
    }

    private static String normalize(String value) {
        return value == null || value.isBlank()
                ? "unknown" : value.strip().toLowerCase(java.util.Locale.ROOT);
    }

    private void enforce(String key, int limit, long windowNanos, String scope) {
        long now = System.nanoTime();
        Window window = windows.compute(key, (ignored, current) -> {
            if (current == null || now - current.startNanos() >= windowNanos) {
                return new Window(now, 1);
            }
            return new Window(current.startNanos(), current.count() + 1);
        });
        if (window.count() > limit) {
            long elapsed = now - window.startNanos();
            long retryAfterSeconds = Math.max(1,
                    (windowNanos - elapsed + 999_999_999L) / 1_000_000_000L);
            throw DomainException.rateLimited(retryAfterSeconds, Map.of(
                    "scope", scope,
                    "limit", limit,
                    "window_seconds", Math.max(1, Duration.ofNanos(windowNanos).toSeconds())));
        }
        if (windows.size() > 50_000) {
            windows.entrySet().removeIf(entry -> now - entry.getValue().startNanos() > 60_000_000_000L);
        }
    }
}

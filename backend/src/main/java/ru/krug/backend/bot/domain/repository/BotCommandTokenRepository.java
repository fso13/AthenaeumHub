package ru.krug.backend.bot.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.BotCommandToken;

/** One-time slash-command response capabilities. RLS scoped by the caller's tenant GUC. */
public interface BotCommandTokenRepository {

    void save(BotCommandToken token);

    Optional<BotCommandToken> findById(UUID workspaceId, UUID tokenId);

    /**
     * Atomically consumes an unexpired token.
     *
     * @return {@code true} when this call won the one-time race
     */
    boolean consume(UUID workspaceId, UUID tokenId, Instant now);

    void attachResponseMessage(UUID workspaceId, UUID tokenId, UUID messageId);
}

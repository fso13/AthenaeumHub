package ru.krug.backend.bot.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.Bot;

/**
 * Persistence port for the bot registry. Every method runs under the caller's tenant GUC
 * (RLS enforced); a foreign workspace id is simply not found.
 */
public interface BotRepository {

    Optional<Bot> findById(UUID workspaceId, UUID botId);

    /** Row lock for token rotation; the caller owns the transaction. */
    Optional<Bot> findByIdForUpdate(UUID workspaceId, UUID botId);

    List<Bot> findByWorkspace(UUID workspaceId);

    /** Insert or update all mutable fields. RLS rejects a cross-tenant write at commit. */
    void save(Bot bot);
}

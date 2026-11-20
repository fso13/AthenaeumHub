package ru.krug.backend.plugin.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.Poll;
import ru.krug.backend.plugin.domain.model.PollOption;
import ru.krug.backend.plugin.domain.repository.PollRepository;

/**
 * Native adapter for {@code plugin.polls/poll_options/poll_votes}. Forced RLS scopes every
 * statement to the tenant GUCs; workspace/chat filters are repeated explicitly. Vote counts
 * and {@code myOptionId} are computed in one grouped query per call (no N+1).
 */
@Repository
public class PollRepositoryAdapter implements PollRepository {

    private static final String SELECT_POLLS = """
            WITH selected AS (
                SELECT p.id, p.workspace_id, p.chat_id, p.creator_id, p.question,
                       p.closed_at, p.created_at
                  FROM plugin.polls p
                 WHERE p.workspace_id = ?1 AND p.chat_id = ?2
                 ORDER BY p.created_at DESC, p.id DESC
                 LIMIT ?4
            )
            SELECT s.id, s.workspace_id, s.chat_id, s.creator_id, s.question,
                   s.closed_at, s.created_at,
                   o.id AS option_id, o.text, o.position,
                   count(v.user_id) AS votes,
                   bool_or(v.user_id = ?3) AS mine
              FROM selected s
              JOIN plugin.poll_options o
                ON o.poll_id = s.id AND o.workspace_id = s.workspace_id
              LEFT JOIN plugin.poll_votes v
                ON v.poll_id = s.id AND v.option_id = o.id
             GROUP BY s.id, s.workspace_id, s.chat_id, s.creator_id, s.question,
                      s.closed_at, s.created_at, o.id, o.text, o.position
             ORDER BY s.created_at DESC, s.id DESC, o.position
            """;

    private static final String SELECT_POLLS_BY_IDS = """
            SELECT p.id, p.workspace_id, p.chat_id, p.creator_id, p.question,
                   p.closed_at, p.created_at,
                   o.id AS option_id, o.text, o.position,
                   count(v.user_id) AS votes,
                   bool_or(v.user_id = :viewerId) AS mine
              FROM plugin.polls p
              JOIN plugin.poll_options o
                ON o.poll_id = p.id AND o.workspace_id = p.workspace_id
              LEFT JOIN plugin.poll_votes v
                ON v.poll_id = p.id AND v.option_id = o.id
             WHERE p.workspace_id = :workspaceId AND p.chat_id = :chatId
               AND p.id IN (:pollIds)
             GROUP BY p.id, p.workspace_id, p.chat_id, p.creator_id, p.question,
                      p.closed_at, p.created_at, o.id, o.text, o.position
             ORDER BY p.created_at DESC, p.id DESC, o.position
            """;

    private static final String SELECT_POLL = """
            SELECT p.id, p.workspace_id, p.chat_id, p.creator_id, p.question,
                   p.closed_at, p.created_at,
                   o.id AS option_id, o.text, o.position,
                   count(v.user_id) AS votes,
                   bool_or(v.user_id = ?4) AS mine
              FROM plugin.polls p
              JOIN plugin.poll_options o
                ON o.poll_id = p.id AND o.workspace_id = p.workspace_id
              LEFT JOIN plugin.poll_votes v
                ON v.poll_id = p.id AND v.option_id = o.id
             WHERE p.workspace_id = ?1 AND p.chat_id = ?2 AND p.id = ?3
             GROUP BY p.id, p.workspace_id, p.chat_id, p.creator_id, p.question,
                      p.closed_at, p.created_at, o.id, o.text, o.position
             ORDER BY o.position
            """;

    private final EntityManager entityManager;

    public PollRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Poll create(Poll poll) {
        entityManager.createNativeQuery("""
                        INSERT INTO plugin.polls
                               (id, workspace_id, chat_id, creator_id, question, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                        """)
                .setParameter(1, poll.id())
                .setParameter(2, poll.workspaceId())
                .setParameter(3, poll.chatId())
                .setParameter(4, poll.creatorId())
                .setParameter(5, poll.question())
                .setParameter(6, Timestamp.from(poll.createdAt()))
                .executeUpdate();
        for (PollOption option : poll.options()) {
            entityManager.createNativeQuery("""
                            INSERT INTO plugin.poll_options
                                   (id, workspace_id, chat_id, poll_id, position, text)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                            """)
                    .setParameter(1, option.id())
                    .setParameter(2, poll.workspaceId())
                    .setParameter(3, poll.chatId())
                    .setParameter(4, poll.id())
                    .setParameter(5, option.position())
                    .setParameter(6, option.text())
                    .executeUpdate();
        }
        return poll;
    }

    @Override
    public Optional<Poll> findById(UUID workspaceId, UUID chatId, UUID pollId,
                                   UUID viewerId) {
        List<?> rows = entityManager.createNativeQuery(SELECT_POLL)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, pollId)
                .setParameter(4, viewerId)
                .getResultList();
        return toPolls(rows).stream().findFirst();
    }

    @Override
    public List<Poll> findByIds(UUID workspaceId, UUID chatId, Collection<UUID> pollIds,
                                UUID viewerId) {
        if (pollIds == null || pollIds.isEmpty()) {
            return List.of();
        }
        List<?> rows = entityManager.createNativeQuery(SELECT_POLLS_BY_IDS)
                .setParameter("workspaceId", workspaceId)
                .setParameter("chatId", chatId)
                .setParameter("viewerId", viewerId)
                .setParameter("pollIds", pollIds)
                .getResultList();
        return toPolls(rows);
    }

    @Override
    public List<Poll> findByChat(UUID workspaceId, UUID chatId, UUID viewerId, int limit) {
        List<?> rows = entityManager.createNativeQuery(SELECT_POLLS)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, viewerId)
                .setParameter(4, limit)
                .getResultList();
        return toPolls(rows);
    }

    @Override
    public boolean vote(UUID workspaceId, UUID chatId, UUID pollId, UUID optionId,
                        UUID userId, Instant at) {
        List<?> changed = entityManager.createNativeQuery("""
                        INSERT INTO plugin.poll_votes
                               (poll_id, option_id, workspace_id, chat_id, user_id,
                                created_at, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                        ON CONFLICT (poll_id, user_id) DO UPDATE
                           SET option_id = EXCLUDED.option_id,
                               updated_at = EXCLUDED.updated_at
                         WHERE plugin.poll_votes.option_id
                               IS DISTINCT FROM EXCLUDED.option_id
                        RETURNING option_id
                        """)
                .setParameter(1, pollId)
                .setParameter(2, optionId)
                .setParameter(3, workspaceId)
                .setParameter(4, chatId)
                .setParameter(5, userId)
                .setParameter(6, Timestamp.from(at))
                .getResultList();
        return !changed.isEmpty();
    }

    @Override
    public boolean close(UUID workspaceId, UUID chatId, UUID pollId, Instant closedAt) {
        List<?> changed = entityManager.createNativeQuery("""
                        UPDATE plugin.polls
                           SET closed_at = ?1
                         WHERE workspace_id = ?2 AND chat_id = ?3 AND id = ?4
                           AND closed_at IS NULL
                        RETURNING id
                        """)
                .setParameter(1, Timestamp.from(closedAt))
                .setParameter(2, workspaceId)
                .setParameter(3, chatId)
                .setParameter(4, pollId)
                .getResultList();
        return !changed.isEmpty();
    }

    private List<Poll> toPolls(List<?> rows) {
        Map<UUID, PollAccumulator> byId = new LinkedHashMap<>();
        for (Object row : rows) {
            Object[] values = (Object[]) row;
            UUID pollId = (UUID) values[0];
            PollAccumulator accumulator = byId.computeIfAbsent(pollId, ignored ->
                    new PollAccumulator((UUID) values[1], (UUID) values[2], (UUID) values[3],
                            (String) values[4], instant(values[5]), instant(values[6])));
            long votes = values[10] instanceof Number number ? number.longValue() : 0L;
            boolean mine = Boolean.TRUE.equals(values[11]);
            UUID optionId = (UUID) values[7];
            accumulator.options.add(new PollOption(optionId, (String) values[8],
                    ((Number) values[9]).intValue(), votes));
            accumulator.totalVotes += votes;
            if (mine) {
                accumulator.myOptionId = optionId;
            }
        }
        List<Poll> polls = new ArrayList<>(byId.size());
        byId.forEach((pollId, accumulator) -> polls.add(Poll.reconstitute(pollId,
                accumulator.workspaceId, accumulator.chatId, accumulator.creatorId,
                accumulator.question, accumulator.options, accumulator.myOptionId,
                accumulator.closedAt != null, accumulator.closedAt, accumulator.createdAt,
                accumulator.totalVotes)));
        return polls;
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        return (Instant) value;
    }

    private static final class PollAccumulator {
        private final UUID workspaceId;
        private final UUID chatId;
        private final UUID creatorId;
        private final String question;
        private final Instant closedAt;
        private final Instant createdAt;
        private final List<PollOption> options = new ArrayList<>();
        private UUID myOptionId;
        private long totalVotes;

        private PollAccumulator(UUID workspaceId, UUID chatId, UUID creatorId, String question,
                                Instant closedAt, Instant createdAt) {
            this.workspaceId = workspaceId;
            this.chatId = chatId;
            this.creatorId = creatorId;
            this.question = question;
            this.closedAt = closedAt;
            this.createdAt = createdAt;
        }
    }
}

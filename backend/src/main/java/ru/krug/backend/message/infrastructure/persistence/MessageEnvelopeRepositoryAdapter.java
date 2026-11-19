package ru.krug.backend.message.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Repository;

import ru.krug.backend.message.domain.model.CryptoEnvelope;
import ru.krug.backend.message.domain.model.EnvelopeHeader;
import ru.krug.backend.message.domain.model.EnvelopePrekey;
import ru.krug.backend.message.domain.model.MessageEnvelope;
import ru.krug.backend.message.domain.repository.MessageEnvelopeRepository;
import ru.krug.backend.shared.application.model.Base64Url;

/**
 * Opaque envelope storage. Rows are written/read with native SQL because the table is
 * range-partitioned and has a composite key; JSONB columns are cast to text on read and
 * passed as JSON text on write, so no Hibernate JSON mapping guesses the wire shape. The
 * server never interprets the ciphertext.
 */
@Repository
public class MessageEnvelopeRepositoryAdapter implements MessageEnvelopeRepository {

    private static final Logger log =
            LoggerFactory.getLogger(MessageEnvelopeRepositoryAdapter.class);

    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;

    public MessageEnvelopeRepositoryAdapter(EntityManager entityManager,
                                            ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
    }

    @Override
    public void saveAll(List<MessageEnvelope> envelopes) {
        for (MessageEnvelope row : envelopes) {
            CryptoEnvelope envelope = row.envelope();
            entityManager.createNativeQuery("""
                            INSERT INTO message.message_envelopes
                                   (message_id, recipient_device_id, sender_device_id,
                                    workspace_id, chat_id, scheme, sender_key_generation,
                                    recipient_key_generation, session_id, header, ciphertext,
                                    prekey, created_at)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                                    CAST(?9 AS bytea), CAST(?10 AS jsonb), CAST(?11 AS bytea),
                                    CAST(?12 AS jsonb), CAST(?13 AS timestamptz))
                            """)
                    .setParameter(1, row.messageId())
                    .setParameter(2, envelope.recipientDeviceId())
                    .setParameter(3, envelope.senderDeviceId())
                    .setParameter(4, row.workspaceId())
                    .setParameter(5, row.chatId())
                    .setParameter(6, envelope.scheme())
                    .setParameter(7, envelope.senderKeyGeneration())
                    .setParameter(8, envelope.recipientKeyGeneration())
                    .setParameter(9, envelope.sessionId())
                    .setParameter(10, writeJson(headerToJson(envelope.header())))
                    .setParameter(11, envelope.ciphertext())
                    .setParameter(12, envelope.prekey() == null ? null
                            : writeJson(prekeyToJson(envelope.prekey())))
                    .setParameter(13, Timestamp.from(row.createdAt()))
                    .executeUpdate();
        }
    }

    @Override
    public Map<UUID, MessageEnvelope> findForDevice(UUID workspaceId, Collection<UUID> messageIds,
                                                    UUID recipientDeviceId) {
        if (messageIds == null || messageIds.isEmpty() || recipientDeviceId == null) {
            return Map.of();
        }
        List<UUID> ids = List.copyOf(new LinkedHashSet<>(messageIds));
        StringBuilder sql = new StringBuilder("""
                SELECT message_id, workspace_id, chat_id, recipient_device_id,
                       sender_device_id, scheme, sender_key_generation,
                       recipient_key_generation, session_id, header::text,
                       ciphertext, prekey::text, created_at
                  FROM message.message_envelopes
                 WHERE workspace_id = ?1
                   AND recipient_device_id = ?2
                   AND octet_length(ciphertext) BETWEEN ?3 AND ?4
                   AND EXISTS (
                         SELECT 1 FROM auth.devices d
                          WHERE d.id = ?2
                            AND d.user_id = ops.current_user_id()
                            AND d.status = 'ACTIVE')
                   AND EXISTS (
                         SELECT 1 FROM chat.chat_members m
                          WHERE m.chat_id = message_envelopes.chat_id
                            AND m.user_id = ops.current_user_id()
                            AND m.status = 'ACTIVE')
                   AND message_id IN (""");
        for (int i = 0; i < ids.size(); i++) {
            sql.append(i == 0 ? "" : ", ").append('?').append(i + 5);
        }
        sql.append(')');
        Query query = entityManager.createNativeQuery(sql.toString())
                .setParameter(1, workspaceId)
                .setParameter(2, recipientDeviceId)
                .setParameter(3, CryptoEnvelope.MIN_CIPHERTEXT_BYTES)
                .setParameter(4, CryptoEnvelope.MAX_CIPHERTEXT_BYTES);
        for (int i = 0; i < ids.size(); i++) {
            query.setParameter(i + 5, ids.get(i));
        }
        @SuppressWarnings("unchecked")
        List<Object[]> rows = query.getResultList();
        Map<UUID, MessageEnvelope> result = new LinkedHashMap<>();
        for (Object[] row : rows) {
            MessageEnvelope envelope = toDomainOrNull(row);
            if (envelope != null) {
                result.putIfAbsent(envelope.messageId(), envelope);
            }
        }
        return result;
    }

    @Override
    public List<MessageEnvelope> findByMessage(UUID workspaceId, UUID messageId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT message_id, workspace_id, chat_id, recipient_device_id,
                               sender_device_id, scheme, sender_key_generation,
                               recipient_key_generation, session_id, header::text,
                               ciphertext, prekey::text, created_at
                          FROM message.message_envelopes
                         WHERE workspace_id = ?1
                           AND message_id = ?2
                           AND octet_length(ciphertext) BETWEEN ?3 AND ?4
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .setParameter(3, CryptoEnvelope.MIN_CIPHERTEXT_BYTES)
                .setParameter(4, CryptoEnvelope.MAX_CIPHERTEXT_BYTES)
                .getResultList();
        return rows.stream().map(this::toDomainOrNull).filter(java.util.Objects::nonNull)
                .toList();
    }

    @Override
    public int deleteByMessage(UUID workspaceId, UUID messageId) {
        return entityManager.createNativeQuery("""
                        DELETE FROM message.message_envelopes
                         WHERE workspace_id = ?1 AND message_id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, messageId)
                .executeUpdate();
    }

    /**
     * P1-03: a row can predate the V18 ciphertext floor (V18 is {@code NOT VALID}) or be
     * otherwise unreadable. Such a row must never reach the {@link CryptoEnvelope}
     * constructor: mapping it would turn one legacy envelope into a 500 for the whole page.
     * The SQL above already excludes the known length range; this guard is the
     * defense-in-depth layer for any other corrupt row and skips it as {@code crypto:null}.
     * Any runtime mapping failure is skipped, not only the two expected validation
     * exceptions: a {@code NullPointerException}/{@code ClassCastException} from an
     * unexpected row shape must not turn one row into a 500 for the whole page either.
     * Never log the ciphertext itself (only ids and the reason text).
     */
    private MessageEnvelope toDomainOrNull(Object[] row) {
        try {
            return toDomain(row);
        } catch (RuntimeException ex) {
            log.warn("Skipping unreadable envelope message_id={} recipient_device_id={} "
                            + "reason={}", row[0], row[3], ex.getMessage());
            return null;
        }
    }

    private MessageEnvelope toDomain(Object[] row) {
        EnvelopeHeader header = readHeader((String) row[9]);
        EnvelopePrekey prekey = row[11] == null ? null : readPrekey((String) row[11]);
        CryptoEnvelope envelope = new CryptoEnvelope(1, (String) row[5], (UUID) row[2],
                (UUID) row[4], ((Number) row[6]).intValue(), (UUID) row[3],
                ((Number) row[7]).intValue(), (byte[]) row[8], header, (byte[]) row[10],
                prekey);
        return new MessageEnvelope((UUID) row[0], (UUID) row[1], (UUID) row[2],
                instant(row[12]), envelope);
    }

    private EnvelopeHeader readHeader(String json) {
        try {
            var node = objectMapper.readTree(json);
            return new EnvelopeHeader(node.path("v").asInt(), Base64Url.decode(
                    node.path("dh").asText(), EnvelopeHeader.DH_BYTES).orElseThrow(),
                    node.path("pn").asLong(), node.path("n").asLong());
        } catch (Exception ex) {
            throw new IllegalStateException("Stored envelope header is invalid", ex);
        }
    }

    private EnvelopePrekey readPrekey(String json) {
        try {
            var node = objectMapper.readTree(json);
            return new EnvelopePrekey(
                    key(node, "sender_identity_signing_key"),
                    key(node, "sender_identity_dh_key"),
                    key(node, "sender_ephemeral_key"),
                    key(node, "recipient_identity_dh_key"),
                    node.path("spk_id").asText(),
                    key(node, "spk_public"),
                    node.hasNonNull("opk_id") ? node.path("opk_id").asText() : null,
                    node.hasNonNull("opk_public") ? key(node, "opk_public") : null,
                    key(node, "signature"));
        } catch (Exception ex) {
            throw new IllegalStateException("Stored envelope prekey is invalid", ex);
        }
    }

    private static byte[] key(com.fasterxml.jackson.databind.JsonNode node, String field) {
        return Base64Url.decode(node.path(field).asText()).orElseThrow();
    }

    private static Map<String, Object> headerToJson(EnvelopeHeader header) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("v", header.v());
        json.put("dh", Base64Url.encode(header.dh()));
        json.put("pn", header.pn());
        json.put("n", header.n());
        return json;
    }

    private static Map<String, Object> prekeyToJson(EnvelopePrekey prekey) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("sender_identity_signing_key",
                Base64Url.encode(prekey.senderIdentitySigningKey()));
        json.put("sender_identity_dh_key", Base64Url.encode(prekey.senderIdentityDhKey()));
        json.put("sender_ephemeral_key", Base64Url.encode(prekey.senderEphemeralKey()));
        json.put("recipient_identity_dh_key",
                Base64Url.encode(prekey.recipientIdentityDhKey()));
        json.put("spk_id", prekey.spkId());
        json.put("spk_public", Base64Url.encode(prekey.spkPublic()));
        json.put("opk_id", prekey.opkId());
        json.put("opk_public", prekey.opkPublic() == null ? null
                : Base64Url.encode(prekey.opkPublic()));
        json.put("signature", Base64Url.encode(prekey.signature()));
        return json;
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot serialize an envelope field", ex);
        }
    }

    private static Instant instant(Object value) {
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offset) {
            return offset.toInstant();
        }
        return (Instant) value;
    }
}

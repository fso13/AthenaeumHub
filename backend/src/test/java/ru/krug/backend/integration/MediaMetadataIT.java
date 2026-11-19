package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.FileSize;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * D1-BE2: managed media metadata roundtrip, strict validation, voice MIME/duration rules,
 * E2EE refusal and the V29 database backstop. Existing scan/quota pipeline is reused
 * unchanged (complete -> SCANNING -> CLEAN -> send).
 */
@ActiveProfiles("test")
class MediaMetadataIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void mediaRoundtripsFromUploadToMessageAndMessagePage() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        Map<String, Object> media = songMedia();
        UUID attachmentId = uploadWithMedia(session, chatId, "song.mp3",
                randomBytes(2048), "audio/mpeg", media);

        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        assertThat(send.getResponse().getStatus())
                .as(send.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(send);
        CONTRACT.assertValid("Message", message);

        JsonNode attachment = message.get("attachments").get(0);
        JsonNode mediaNode = attachment.get("media");
        assertThat(mediaNode.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(mediaNode.get("duration_ms").asLong()).isEqualTo(245_000);
        assertThat(mediaNode.get("width").asInt()).isEqualTo(640);
        assertThat(mediaNode.get("height").asInt()).isEqualTo(480);
        assertThat(mediaNode.get("title").asText()).isEqualTo("Song title");
        assertThat(mediaNode.get("artist").asText()).isEqualTo("Artist");
        assertThat(mediaNode.get("album").asText()).isEqualTo("Album");
        assertThat(mediaNode.get("year").asText()).isEqualTo("2024");
        assertThat(mediaNode.get("genre").asText()).isEqualTo("Rock");
        assertThat(mediaNode.get("artwork_url").asText())
                .isEqualTo("https://cdn.example.com/art/cover.jpg");
        assertThat(mediaNode.get("metadata_source").asText()).isEqualTo("ID3");

        // GET /chats/{id}/messages returns the same sanitized media.
        JsonNode page = messages(session, chatId);
        CONTRACT.assertValid("MessagePage", page);
        JsonNode fromPage = page.get("items").get(0).get("attachments").get(0).get("media");
        assertThat(fromPage).isEqualTo(mediaNode);

        // jsonb is the source of truth after the upload/complete copy.
        Map<String, Object> row = migrator().queryForMap("""
                SELECT media->>'kind' AS kind, media->>'title' AS title,
                       media->>'artwork_url' AS artwork_url,
                       media->>'metadata_source' AS source,
                       (media->>'duration_ms')::bigint AS duration_ms
                  FROM file.attachments WHERE id = ?
                """, attachmentId);
        assertThat(row.get("kind")).isEqualTo("AUDIO");
        assertThat(row.get("title")).isEqualTo("Song title");
        assertThat(row.get("source")).isEqualTo("ID3");
        assertThat(((Number) row.get("duration_ms")).longValue()).isEqualTo(245_000);
        assertThat(row.get("artwork_url")).isEqualTo("https://cdn.example.com/art/cover.jpg");
    }

    @Test
    void plainAttachmentWithoutMediaKeepsNullAndStaysContractValid() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode uploaded = uploadFile(session, chatId, "plain.bin", randomBytes(512),
                "application/octet-stream");
        UUID attachmentId = UUID.fromString(uploaded.get("attachment_id").asText());

        MvcResult send = sendWithAttachments(session, chatId, "plain", List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        JsonNode message = json(send);
        CONTRACT.assertValid("Message", message);
        assertThat(message.get("attachments").get(0).get("media").isNull()).isTrue();

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.attachments WHERE id = ? AND media IS NULL
                """, Integer.class, attachmentId)).isEqualTo(1);
    }

    @Test
    void rejectsInvalidMediaBeforeAnyUploadRowIsCreated() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        List<Map<String, Object>> invalid = List.of(
                with(media("AUDIO", "ID3"), Map.of("kind", "BOGUS")),
                with(media("AUDIO", "ID3"), Map.of("metadata_source", "TRUST_ME")),
                withoutSource(media("AUDIO", "ID3")),
                with(media("AUDIO", "ID3"), Map.of("title", "<script>alert(1)</script>")),
                with(media("AUDIO", "ID3"),
                        Map.of("title", "x".repeat(256))),
                with(media("AUDIO", "ID3"), Map.of("duration_ms", -1)),
                with(media("AUDIO", "ID3"), Map.of("width", 0)),
                with(media("AUDIO", "ID3"), Map.of("height", 20_000)),
                with(media("AUDIO", "ID3"), Map.of("year", "24")),
                with(media("AUDIO", "ID3"),
                        Map.of("artwork_url", "http://127.0.0.1/cover.png")),
                with(media("AUDIO", "ID3"),
                        Map.of("artwork_url", "javascript:alert(1)")),
                with(media("AUDIO", "ID3"),
                        Map.of("artwork_url", "https://localhost/cover.png")),
                with(media("AUDIO", "ID3"),
                        Map.of("artwork_url", "https://169.254.169.254/latest/meta-data/")));

        int index = 0;
        for (Map<String, Object> media : invalid) {
            String filename = "invalid-" + index++ + ".mp3";
            MvcResult result = init(session, chatId, filename, randomBytes(128),
                    "audio/mpeg", media);
            assertThat(result.getResponse().getStatus())
                    .as("case %s: %s", filename, result.getResponse().getContentAsString())
                    .isEqualTo(422);
            JsonNode error = json(result);
            assertThat(error.get("code").asText()).isEqualTo("MEDIA_METADATA_INVALID");
            assertThat(migrator().queryForObject("""
                    SELECT count(*) FROM file.uploads WHERE filename = ?
                    """, Integer.class, filename)).isZero();
        }
    }

    @Test
    void m4aIsAcceptedWithBothMimeSpellingsAndRoundtripsAsAudio() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        Map<String, Object> m4aMedia = with(media("AUDIO", "ID3"),
                Map.of("duration_ms", 18_000, "title", "Interview"));

        UUID attachmentId = uploadWithMedia(session, chatId, "interview-team.m4a",
                randomBytes(1024), "audio/mp4", m4aMedia);
        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        assertThat(send.getResponse().getStatus())
                .as(send.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode mediaNode = json(send).get("attachments").get(0).get("media");
        CONTRACT.assertValid("Message", json(send));
        assertThat(mediaNode.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(mediaNode.get("title").asText()).isEqualTo("Interview");
        assertThat(mediaNode.get("duration_ms").asLong()).isEqualTo(18_000);

        // Some browsers report audio/x-m4a; it is a first-class M4A MIME as well.
        MvcResult xM4a = init(session, chatId, "voice-note.m4a", randomBytes(128),
                "audio/x-m4a");
        assertThat(xM4a.getResponse().getStatus())
                .as(xM4a.getResponse().getContentAsString()).isEqualTo(201);
    }

    @Test
    void audioKindOutsideTheMimeAllowlistIs415() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        MvcResult result = init(session, chatId, "song.wma", randomBytes(128),
                "audio/x-ms-wma", media("AUDIO", "ID3"));
        assertThat(result.getResponse().getStatus()).isEqualTo(415);
        assertThat(json(result).get("code").asText()).isEqualTo("UNSUPPORTED_TYPE");
    }

    @Test
    void voiceMimeRequiresAudioKindAndBoundedDuration() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] voice = randomBytes(4096);

        // audio/webm without media is ambiguous: a voice note must carry its duration.
        MvcResult missing = init(session, chatId, "voice.webm", voice, "audio/webm");
        assertThat(missing.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(missing).get("details").get("reason").asText())
                .isEqualTo("required_for_voice");

        MvcResult wrongKind = init(session, chatId, "voice.webm", voice, "audio/webm",
                with(media("FILE", "CLIENT"), Map.of("duration_ms", 12_000)));
        assertThat(wrongKind.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(wrongKind).get("details").get("field").asText()).isEqualTo("media.kind");

        MvcResult noDuration = init(session, chatId, "voice.webm", voice, "audio/webm",
                media("AUDIO", "CLIENT"));
        assertThat(noDuration.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(noDuration).get("details").get("reason").asText())
                .isEqualTo("required_for_voice");

        MvcResult tooLong = init(session, chatId, "voice.webm", voice, "audio/webm",
                with(media("AUDIO", "CLIENT"), Map.of("duration_ms", 600_001)));
        assertThat(tooLong.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(tooLong).get("details").get("reason").asText())
                .isEqualTo("voice_too_long");

        // Ogg voice is accepted with a bounded duration and roundtrips as AUDIO.
        UUID attachmentId = uploadWithMedia(session, chatId, "voice.ogg", voice, "audio/ogg",
                with(media("AUDIO", "CLIENT"), Map.of("duration_ms", 12_000)));
        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        assertThat(send.getResponse().getStatus()).isEqualTo(201);
        JsonNode mediaNode = json(send).get("attachments").get(0).get("media");
        assertThat(mediaNode.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(mediaNode.get("duration_ms").asLong()).isEqualTo(12_000);
        assertThat(mediaNode.get("metadata_source").asText()).isEqualTo("CLIENT");
    }

    @Test
    void idempotentReplayWithDifferentMediaConflicts() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = randomBytes(256);
        String key = UUID.randomUUID().toString();
        MvcResult first = init(session, chatId, "song.mp3", data, "audio/mpeg",
                media("AUDIO", "ID3"), "MANAGED", key);
        assertThat(first.getResponse().getStatus()).isEqualTo(201);

        MvcResult replay = init(session, chatId, "song.mp3", data, "audio/mpeg",
                with(media("AUDIO", "ID3"), Map.of("title", "Other title")), "MANAGED", key);
        assertThat(replay.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(replay).get("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REUSED");

        MvcResult same = init(session, chatId, "song.mp3", data, "audio/mpeg",
                media("AUDIO", "ID3"), "MANAGED", key);
        assertThat(same.getResponse().getStatus()).isEqualTo(201);
        assertThat(json(same).get("upload_id").asText())
                .isEqualTo(json(first).get("upload_id").asText());
    }

    @Test
    void e2eeEncryptionModeIsRejectedBeforeMediaIsParsed() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        // Malformed media would be 422 MEDIA_METADATA_INVALID if it were parsed. The mode
        // check runs first, proving the server does not parse E2EE payloads.
        Map<String, Object> malformed = with(media("AUDIO", "ID3"),
                Map.of("kind", "BOGUS", "title", "<x>"));
        MvcResult result = init(session, chatId, "e2ee.webm", randomBytes(128), "audio/webm",
                malformed, "E2EE", UUID.randomUUID().toString());
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        assertThat(json(result).get("code").asText()).isEqualTo("MODE_NOT_SUPPORTED");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.uploads WHERE filename = ?
                """, Integer.class, "e2ee.webm")).isZero();
    }

    @Test
    void managedUploadIntoAnE2eeChatRejectsMediaBeforeParsing() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'e2ee-media', ?)
                """, chatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chatId, workspaceId);

        // Malformed media would be MEDIA_METADATA_INVALID if it were parsed; the chat-mode
        // guard fires first, so no plaintext metadata is parsed or stored for an E2EE chat.
        MvcResult result = init(session, chatId, "e2ee-song.mp3", randomBytes(128),
                "audio/mpeg", with(media("AUDIO", "ID3"),
                        Map.of("kind", "BOGUS", "title", "<x>")));
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo("MEDIA_METADATA_INVALID");
        assertThat(error.get("details").get("reason").asText())
                .isEqualTo("e2ee_plaintext_forbidden");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.uploads WHERE chat_id = ? AND media IS NOT NULL
                """, Integer.class, chatId)).isZero();

        // A media-less (opaque) upload is still accepted: the existing E4 pipeline is
        // unchanged; only plaintext media metadata is forbidden.
        MvcResult opaque = init(session, chatId, "opaque.bin", randomBytes(128),
                "application/octet-stream");
        assertThat(opaque.getResponse().getStatus()).isEqualTo(201);
    }

    @Test
    void v29AddsMediaColumnsBackstopFunctionAndIndex() {
        for (String table : List.of("uploads", "attachments")) {
            assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM information_schema.columns
                     WHERE table_schema = 'file' AND table_name = ? AND column_name = 'media'
                       AND udt_name = 'jsonb'
                    """, Integer.class, table)).as(table).isEqualTo(1);
        }
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'file' AND p.proname = 'media_metadata_valid'
                """, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conname IN ('ck_uploads_media_valid', 'ck_attachments_media_valid')
                """, Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'file' AND indexname = 'ix_attachments_media_kind'
                """, Integer.class)).isEqualTo(1);

        assertThat(jdbc.queryForObject("""
                SELECT file.media_metadata_valid(?::jsonb)
                """, Boolean.class, """
                {"kind":"AUDIO","metadata_source":"ID3","duration_ms":1000,
                 "title":"ok","artwork_url":"https://example.com/a.png"}
                """)).isTrue();
        for (String bad : List.of(
                "{\"kind\":\"BOGUS\",\"metadata_source\":\"ID3\"}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"TRUST_ME\"}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"ID3\",\"title\":\"<b>x</b>\"}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"ID3\",\"duration_ms\":-5}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"ID3\",\"width\":0}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"ID3\",\"year\":\"24\"}",
                "{\"kind\":\"AUDIO\",\"metadata_source\":\"ID3\","
                        + "\"artwork_url\":\"javascript:alert(1)\"}",
                "[]")) {
            assertThat(jdbc.queryForObject("""
                    SELECT file.media_metadata_valid(?::jsonb)
                    """, Boolean.class, bad)).as(bad).isFalse();
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private UUID uploadWithMedia(SessionResponse session, UUID chatId, String filename,
                                 byte[] data, String mime, Map<String, Object> media)
            throws Exception {
        MvcResult initResult = init(session, chatId, filename, data, mime, media);
        assertThat(initResult.getResponse().getStatus())
                .as(initResult.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode init = json(initResult);
        UUID uploadId = UUID.fromString(init.get("upload_id").asText());
        int partSize = init.get("part_size").asInt();
        int totalParts = init.get("total_parts").asInt();
        assertThat(partSize).isEqualTo(FileSize.DEFAULT_PART_SIZE);
        for (int partNo = 1; partNo <= totalParts; partNo++) {
            int from = (partNo - 1) * partSize;
            int to = Math.min(data.length, from + partSize);
            byte[] part = java.util.Arrays.copyOfRange(data, from, to);
            MvcResult put = putPart(session, uploadId, partNo, part);
            assertThat(put.getResponse().getStatus()).isEqualTo(200);
        }
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(),
                totalParts);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());
        assertThat(awaitScan(session, attachmentId, 200)).isEqualTo(200);
        return attachmentId;
    }

    private static Map<String, Object> songMedia() {
        Map<String, Object> media = media("AUDIO", "ID3");
        media.put("duration_ms", 245_000);
        media.put("width", 640);
        media.put("height", 480);
        media.put("title", "Song title");
        media.put("artist", "Artist");
        media.put("album", "Album");
        media.put("year", "2024");
        media.put("genre", "Rock");
        media.put("artwork_url", "https://cdn.example.com/art/cover.jpg");
        return media;
    }

    private static Map<String, Object> media(String kind, String source) {
        Map<String, Object> media = new LinkedHashMap<>();
        media.put("kind", kind);
        media.put("metadata_source", source);
        return media;
    }

    private static Map<String, Object> with(Map<String, Object> media,
                                            Map<String, Object> overrides) {
        Map<String, Object> copy = new LinkedHashMap<>(media);
        copy.putAll(overrides);
        return copy;
    }

    private static Map<String, Object> withoutSource(Map<String, Object> media) {
        Map<String, Object> copy = new LinkedHashMap<>(media);
        copy.remove("metadata_source");
        return copy;
    }
}

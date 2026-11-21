package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.file.domain.model.FileSize;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.AudioTestData;
import ru.krug.backend.support.FileUploadTestSupport;
import ru.krug.backend.support.OpenApiContract;

/**
 * #97: server-side audio metadata end to end.
 *
 * <p>Global workspace uploads always extract; the resumable {@code /uploads} flow falls back
 * only when the client media is absent/empty. Cover bytes are private and served exclusively
 * through the authenticated artwork endpoint after the AV verdict.
 */
@ActiveProfiles("test")
class AudioMetadataIT extends FileUploadTestSupport {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void workspaceAudioUploadExtractsTagsArtworkAndServesTheCover() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] artwork = AudioTestData.jpegArtwork();
        byte[] data = AudioTestData.mp3Id3v23("Song title", "Artist", "Album", "2024", "Rock",
                artwork);

        MvcResult result = workspaceUpload(session, workspaceId, "song.mp3", data,
                "audio/mpeg");
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode item = json(result);
        CONTRACT.assertValid("FileItem", item);
        UUID fileId = UUID.fromString(item.get("id").asText());

        JsonNode media = item.get("media");
        assertThat(media).isNotNull();
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(media.get("title").asText()).isEqualTo("Song title");
        assertThat(media.get("artist").asText()).isEqualTo("Artist");
        assertThat(media.get("album").asText()).isEqualTo("Album");
        assertThat(media.get("year").asText()).isEqualTo("2024");
        assertThat(media.get("genre").asText()).isEqualTo("Rock");
        assertThat(media.get("duration_ms").asLong()).isPositive();
        assertThat(media.get("artwork_url").asText())
                .isEqualTo("http://artwork.krug.test/api/v1/attachments/" + fileId
                        + "/artwork");

        // The cover is served only after the AV verdict: PENDING -> 409, CLEAN -> 200.
        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);
        MvcResult cover = artwork(session, fileId);
        assertThat(cover.getResponse().getStatus()).isEqualTo(200);
        assertThat(cover.getResponse().getContentType()).isEqualTo("image/jpeg");
        assertThat(cover.getResponse().getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(cover.getResponse().getContentAsByteArray()).isEqualTo(artwork);

        // No token -> 401; another workspace/unknown user -> hidden (403/404, never 200).
        assertThat(mockMvc.perform(get("/api/v1/attachments/{id}/artwork", fileId))
                .andReturn().getResponse().getStatus()).isEqualTo(401);
        SessionResponse stranger = devSession();
        assertThat(artwork(stranger, fileId).getResponse().getStatus()).isIn(403, 404);

        // The file-center row carries the same server metadata.
        JsonNode listed = files(session, workspaceId).get("items").get(0);
        CONTRACT.assertValid("FileItem", listed);
        assertThat(listed.get("media").get("title").asText()).isEqualTo("Song title");
        assertThat(listed.get("media").get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(listed.get("media").get("artwork_url").asText())
                .contains("/attachments/" + fileId + "/artwork");
    }

    @Test
    void uploadsInitFillsMissingClientMetadataForAudio() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = AudioTestData.mp3Id3v23("Server title", "Server artist", "Server album",
                "2022", "Jazz", AudioTestData.jpegArtwork());

        // No media object at all: the resumable flow must fill it on complete.
        JsonNode completed = uploadFile(session, chatId, "fallback.mp3", data, "audio/mpeg");
        UUID attachmentId = UUID.fromString(completed.get("attachment_id").asText());

        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        assertThat(send.getResponse().getStatus())
                .as(send.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode message = json(send);
        CONTRACT.assertValid("Message", message);
        JsonNode media = message.at("/attachments/0/media");
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(media.get("title").asText()).isEqualTo("Server title");
        assertThat(media.get("artist").asText()).isEqualTo("Server artist");
        assertThat(media.get("album").asText()).isEqualTo("Server album");
        assertThat(media.get("year").asText()).isEqualTo("2022");
        assertThat(media.get("genre").asText()).isEqualTo("Jazz");
        assertThat(media.get("duration_ms").asLong()).isPositive();

        // The upload row keeps the same sanitized copy for a later upload read.
        Map<String, Object> row = migrator().queryForMap("""
                SELECT media->>'kind' AS kind, media->>'title' AS title,
                       media->>'metadata_source' AS source
                  FROM file.uploads WHERE id = ?
                """, UUID.fromString(completed.get("upload_id").asText()));
        assertThat(row.get("kind")).isEqualTo("AUDIO");
        assertThat(row.get("title")).isEqualTo("Server title");
        assertThat(row.get("source")).isEqualTo("SERVER");
    }

    @Test
    void uploadsKeepsCompleteClientMedia() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = AudioTestData.mp3Id3v23("Server title", "Server artist", null, null,
                null, null);
        Map<String, Object> media = new LinkedHashMap<>();
        media.put("kind", "AUDIO");
        media.put("metadata_source", "ID3");
        media.put("title", "Client title");
        media.put("duration_ms", 1_000);

        UUID attachmentId = uploadWithMedia(session, chatId, "client.mp3", data, "audio/mpeg",
                media);
        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        JsonNode mediaNode = json(send).at("/attachments/0/media");

        assertThat(mediaNode.get("title").asText()).isEqualTo("Client title");
        assertThat(mediaNode.get("duration_ms").asLong()).isEqualTo(1_000);
        assertThat(mediaNode.get("artist").isNull()).isTrue();
        assertThat(mediaNode.get("metadata_source").asText()).isEqualTo("ID3");
    }

    @Test
    void workspaceAudioWithoutTagsStillBecomesAnAudioServerObject() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] data = AudioTestData.mp3WithoutTags(90);

        MvcResult result = workspaceUpload(session, workspaceId, "untagged.mp3", data,
                "audio/mpeg");
        JsonNode item = json(result);
        assertThat(result.getResponse().getStatus()).isEqualTo(201);
        UUID fileId = UUID.fromString(item.get("id").asText());
        JsonNode media = item.get("media");
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(media.get("title").isNull()).isTrue();
        assertThat(media.get("artwork_url").isNull()).isTrue();
        assertThat(media.get("duration_ms").asLong()).isPositive();

        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);
        assertThat(artwork(session, fileId).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void workspaceM4aExtractsAtomsAndMvhdDuration() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] artwork = AudioTestData.pngArtwork();
        byte[] data = AudioTestData.m4a("Interview", "Reporter", "Series", "2023", "Speech",
                artwork, 65_000);

        MvcResult result = workspaceUpload(session, workspaceId, "interview.m4a", data,
                "audio/mp4");
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode item = json(result);
        CONTRACT.assertValid("FileItem", item);
        UUID fileId = UUID.fromString(item.get("id").asText());
        JsonNode media = item.get("media");
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(media.get("title").asText()).isEqualTo("Interview");
        assertThat(media.get("artist").asText()).isEqualTo("Reporter");
        assertThat(media.get("album").asText()).isEqualTo("Series");
        assertThat(media.get("year").asText()).isEqualTo("2023");
        assertThat(media.get("genre").asText()).isEqualTo("Speech");
        assertThat(media.get("duration_ms").asLong()).isEqualTo(65_000);

        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);
        MvcResult cover = artwork(session, fileId);
        assertThat(cover.getResponse().getStatus()).isEqualTo(200);
        assertThat(cover.getResponse().getContentType()).isEqualTo("image/png");
        assertThat(cover.getResponse().getContentAsByteArray()).isEqualTo(artwork);
    }

    @Test
    void malformedAudioDoesNotFailTheUpload() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] junk = new byte[256];
        junk[0] = 0x00;
        junk[1] = 0x01;

        MvcResult result = workspaceUpload(session, workspaceId, "broken.mp3", junk,
                "audio/mpeg");
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(201);
        JsonNode media = json(result).get("media");
        assertThat(media.get("kind").asText()).isEqualTo("AUDIO");
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(media.get("title").isNull()).isTrue();
        assertThat(media.get("artwork_url").isNull()).isTrue();
    }

    @Test
    void oversizedArtworkIsIgnoredButTheUploadSucceeds() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] huge = new byte[AudioMetadataParserLimits.artworkCap() + 4096];
        huge[0] = (byte) 0xff;
        huge[1] = (byte) 0xd8;
        huge[2] = (byte) 0xff;
        byte[] data = AudioTestData.mp3Id3v23("Big cover", null, null, null, null, huge);

        MvcResult result = workspaceUpload(session, workspaceId, "big-cover.mp3", data,
                "audio/mpeg");
        assertThat(result.getResponse().getStatus()).isEqualTo(201);
        JsonNode media = json(result).get("media");
        assertThat(media.get("title").asText()).isEqualTo("Big cover");
        assertThat(media.get("artwork_url").isNull()).isTrue();
        assertThat(media.get("metadata_source").asText()).isEqualTo("SERVER");
    }

    @Test
    void artworkEndpointRequiresAnAudioAttachmentWithACover() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        byte[] pdf = randomBytes(256);

        MvcResult result = workspaceUpload(session, workspaceId, "document.pdf", pdf,
                "application/pdf");
        assertThat(result.getResponse().getStatus()).isEqualTo(201);
        UUID fileId = UUID.fromString(json(result).get("id").asText());
        assertThat(awaitScan(session, fileId, 200)).isEqualTo(200);

        assertThat(artwork(session, fileId).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void uploadsFillsEmptyNoneMediaForAudio() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        byte[] data = AudioTestData.mp3Id3v23("Fallback title", "Fallback artist", null, null,
                null, null);
        Map<String, Object> media = new LinkedHashMap<>();
        media.put("kind", "AUDIO");
        media.put("metadata_source", "NONE");

        UUID attachmentId = uploadWithMedia(session, chatId, "none.mp3", data, "audio/mpeg",
                media);
        MvcResult send = sendWithAttachments(session, chatId, null, List.of(attachmentId));
        JsonNode mediaNode = json(send).at("/attachments/0/media");

        assertThat(mediaNode.get("metadata_source").asText()).isEqualTo("SERVER");
        assertThat(mediaNode.get("title").asText()).isEqualTo("Fallback title");
        assertThat(mediaNode.get("artist").asText()).isEqualTo("Fallback artist");
    }

    @Test
    void e2eeChatUploadsAreNeverInspected() throws Exception {
        SessionResponse session = devSession();
        UUID workspaceId = session.workspace().id();
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'E2EE', 'e2ee-audio', ?)
                """, chatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, workspaceId, session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, chatId, workspaceId);

        byte[] data = AudioTestData.mp3Id3v23("Secret title", "Secret artist", null, null,
                null, AudioTestData.jpegArtwork());
        MvcResult initResult = init(session, chatId, "e2ee.mp3", data, "audio/mpeg");
        assertThat(initResult.getResponse().getStatus()).isEqualTo(201);
        UUID uploadId = UUID.fromString(json(initResult).get("upload_id").asText());
        assertThat(putPart(session, uploadId, 1, data).getResponse().getStatus()).isEqualTo(200);
        MvcResult complete = complete(session, uploadId, Sha256.ofBytes(data).value(), 1);
        assertThat(complete.getResponse().getStatus()).isEqualTo(202);
        UUID attachmentId = UUID.fromString(json(complete).get("attachment_id").asText());

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.attachments WHERE id = ? AND media IS NULL
                """, Integer.class, attachmentId)).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM file.uploads WHERE id = ? AND media IS NULL
                """, Integer.class, uploadId)).isEqualTo(1);
        // No server artwork object exists for the E2EE attachment either.
        assertThat(objectStorage.exists(
                "workspaces/" + workspaceId + "/artwork/" + attachmentId)).isFalse();
    }

    // ------------------------------------------------------------------

    private MvcResult workspaceUpload(SessionResponse session, UUID workspaceId, String filename,
                                      byte[] data, String mime) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", filename, mime, data);
        return mockMvc.perform(authed(multipart("/api/v1/workspaces/{workspaceId}/files",
                workspaceId).file(file), session)).andReturn();
    }

    private MvcResult artwork(SessionResponse session, UUID attachmentId) throws Exception {
        return mockMvc.perform(authed(get("/api/v1/attachments/{attachmentId}/artwork",
                attachmentId), session)).andReturn();
    }

    private JsonNode files(SessionResponse session, UUID workspaceId) throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/files"), session)
                .param("workspace_id", workspaceId.toString())).andReturn();
        assertThat(result.getResponse().getStatus())
                .as(result.getResponse().getContentAsString()).isEqualTo(200);
        return json(result);
    }

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

    /** Keeps the parser cap out of the test body without exposing internals. */
    private static final class AudioMetadataParserLimits {
        private static int artworkCap() {
            return ru.krug.backend.file.domain.service.AudioMetadataParser.MAX_ARTWORK_BYTES;
        }
    }
}

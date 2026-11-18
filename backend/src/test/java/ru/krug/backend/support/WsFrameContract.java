package ru.krug.backend.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

/**
 * Test-only WS frame schema derived from contracts/ws-protocol.md. The contract file itself
 * is read-only and is not parsed here; this schema is a local executable copy for tests.
 */
public final class WsFrameContract {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonSchemaFactory FACTORY =
            JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
    private static final JsonNode ROOT = load();

    private WsFrameContract() {
    }

    public static void assertValid(String definition, String frame) throws Exception {
        JsonNode node = MAPPER.readTree(frame);
        JsonNode schemaNode = ROOT.at("/$defs/" + definition);
        assertThat(schemaNode.isMissingNode()).as("unknown WS schema %s", definition).isFalse();
        JsonSchema schema = FACTORY.getSchema(schemaNode, new SchemaValidatorsConfig());
        Set<ValidationMessage> errors = schema.validate(node);
        assertThat(errors).as("frame %s does not match %s: %s", frame, definition, errors)
                .isEmpty();
    }

    private static JsonNode load() {
        try (InputStream input = WsFrameContract.class.getResourceAsStream(
                "/contracts/ws-frames.schema.json")) {
            if (input == null) {
                throw new IllegalStateException("ws-frames.schema.json is missing");
            }
            return MAPPER.readTree(input);
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot load WS frame schema", ex);
        }
    }
}

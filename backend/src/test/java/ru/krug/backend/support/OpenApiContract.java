package ru.krug.backend.support;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.yaml.snakeyaml.Yaml;

/**
 * Loads contracts/openapi.yaml (read-only) and validates JSON responses against its
 * component schemas. Local $refs are inlined; the contract file is never modified.
 */
public final class OpenApiContract {

    private final JsonNode root;
    private final JsonSchemaFactory factory =
            JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);

    private OpenApiContract(JsonNode root) {
        this.root = root;
    }

    public static OpenApiContract load() {
        try {
            Path path = locate();
            try (InputStream input = Files.newInputStream(path)) {
                Object yaml = new Yaml().load(input);
                return new OpenApiContract(new ObjectMapper().valueToTree(yaml));
            }
        } catch (Exception ex) {
            throw new IllegalStateException("Cannot load contracts/openapi.yaml", ex);
        }
    }

    public void assertValid(String component, JsonNode payload) {
        JsonNode schemaNode = root.at("/components/schemas/" + component);
        assertThat(schemaNode.isMissingNode()).as("schema %s is missing", component).isFalse();
        JsonSchema schema = factory.getSchema(resolve(schemaNode, new HashSet<>()),
                new SchemaValidatorsConfig());
        Set<ValidationMessage> errors = schema.validate(payload);
        assertThat(errors).as("payload does not match %s: %s", component, errors).isEmpty();
    }

    private JsonNode resolve(JsonNode node, Set<String> seenRefs) {
        if (node.isObject() && node.has("$ref")) {
            String ref = node.get("$ref").asText();
            if (!ref.startsWith("#/")) {
                throw new IllegalStateException("Only local $refs are supported: " + ref);
            }
            if (!seenRefs.add(ref)) {
                throw new IllegalStateException("Cyclic $ref: " + ref);
            }
            JsonNode target = root.at(ref.substring(1));
            if (target.isMissingNode()) {
                throw new IllegalStateException("Unresolved $ref: " + ref);
            }
            JsonNode resolved = resolve(target, seenRefs);
            seenRefs.remove(ref);
            return resolved;
        }
        if (node.isObject()) {
            ObjectNode copy = JsonNodeFactory.instance.objectNode();
            Iterator<String> names = node.fieldNames();
            while (names.hasNext()) {
                String name = names.next();
                copy.set(name, resolve(node.get(name), seenRefs));
            }
            return copy;
        }
        if (node.isArray()) {
            ArrayNode copy = JsonNodeFactory.instance.arrayNode();
            node.forEach(child -> copy.add(resolve(child, seenRefs)));
            return copy;
        }
        return node;
    }

    private static Path locate() {
        Path fromBackend = Path.of("..", "contracts", "openapi.yaml");
        if (Files.exists(fromBackend)) {
            return fromBackend;
        }
        Path fromRoot = Path.of("contracts", "openapi.yaml");
        if (Files.exists(fromRoot)) {
            return fromRoot;
        }
        throw new IllegalStateException("contracts/openapi.yaml not found relative to "
                + Path.of("").toAbsolutePath());
    }
}

package ru.krug.backend.chat.application.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Effective channel rights matrix (P0-2 / #80) for every role, including the immutable OWNER
 * row. Keys are the wire role names ({@code OWNER..GUEST}) and permission names
 * ({@code post_messages..change_info}) so the API layer never depends on domain enums. Not a
 * domain entity and not an API DTO: the mapper turns it into the contract shape.
 */
public record ChatPermissionsView(Map<String, Map<String, Boolean>> rights) {

    public ChatPermissionsView {
        Map<String, Map<String, Boolean>> copy = new LinkedHashMap<>();
        rights.forEach((role, values) ->
                copy.put(role, Collections.unmodifiableMap(new LinkedHashMap<>(values))));
        rights = Collections.unmodifiableMap(copy);
    }

    public Map<String, Boolean> of(String role) {
        return rights.getOrDefault(role, Map.of());
    }
}

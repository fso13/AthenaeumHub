package ru.krug.backend.chat.domain.service;

import java.util.UUID;

/**
 * Canonical DIRECT pair key: {@code least(a,b) || ':' || greatest(a,b)} (UUID byte order;
 * for the canonical lowercase UUID text form this equals lexicographic order). The order
 * makes (A,B) and (B,A) the same key, so the partial unique index cannot be bypassed.
 */
public final class DirectPairKey {

    private DirectPairKey() {
    }

    public static String of(UUID first, UUID second) {
        if (first == null || second == null) {
            throw new IllegalArgumentException("Both DIRECT participants are required");
        }
        String a = first.toString();
        if (first.equals(second)) {
            // #199: the personal "Избранное" chat is a self-pair; a stable
            // a:a key keeps it unique per user without a second member row.
            return a + ":" + a;
        }
        String b = second.toString();
        return a.compareTo(b) < 0 ? a + ":" + b : b + ":" + a;
    }
}

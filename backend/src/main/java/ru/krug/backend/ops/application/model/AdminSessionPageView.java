package ru.krug.backend.ops.application.model;

import java.util.List;

/** Cursor page of platform-admin session rows. */
public record AdminSessionPageView(
        List<AdminSessionView> items,
        String nextCursor,
        boolean hasMore) {
}

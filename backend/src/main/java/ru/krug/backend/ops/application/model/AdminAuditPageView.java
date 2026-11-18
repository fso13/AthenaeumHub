package ru.krug.backend.ops.application.model;

import java.util.List;

/** One cursor page of the platform-admin audit view plus the opaque next-page cursor. */
public record AdminAuditPageView(List<AdminAuditView> items, String nextCursor,
                                 boolean hasMore) {
}

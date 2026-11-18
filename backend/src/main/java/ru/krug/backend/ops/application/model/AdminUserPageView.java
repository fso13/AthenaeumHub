package ru.krug.backend.ops.application.model;

import java.util.List;

/** One cursor page of admin users plus the opaque cursor of the next page. */
public record AdminUserPageView(List<AdminUserView> items, String nextCursor, boolean hasMore) {
}

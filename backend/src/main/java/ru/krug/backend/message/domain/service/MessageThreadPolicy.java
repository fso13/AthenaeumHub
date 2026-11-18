package ru.krug.backend.message.domain.service;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * D1-BE1: flat threads (depth one). A reply is a normal message carrying
 * {@code thread_root_id}; the root itself must be a main-feed message in the same chat.
 * Threads are managed-only: an E2EE chat cannot build a plaintext thread excerpt and the
 * server refuses the operation instead of silently degrading it.
 */
public final class MessageThreadPolicy {

    private MessageThreadPolicy() {
    }

    /**
     * Validates the requested root. A root from another chat is reported exactly like a
     * missing one so the caller cannot probe foreign messages; the chat is already
     * access-checked before this method runs.
     */
    public static void ensureThreadRoot(UUID chatId, UUID threadRootId, Message root) {
        if (threadRootId == null) {
            return;
        }
        Map<String, Object> details = Map.of("field", "thread_root_id");
        if (root == null || !chatId.equals(root.chatId())) {
            throw DomainException.unprocessable(ErrorCode.THREAD_ROOT_NOT_FOUND,
                    "thread_root_id must reference a message in the same chat", details);
        }
        if (root.threadRootId() != null) {
            throw DomainException.unprocessable(ErrorCode.THREAD_NESTING_UNSUPPORTED,
                    "Replies to replies are not supported (thread depth is one)",
                    Map.of("field", "thread_root_id", "reason", "nested_thread"));
        }
        if (root.deletedAt() != null) {
            throw DomainException.unprocessable(ErrorCode.THREAD_ROOT_DELETED,
                    "The thread root has been deleted", details);
        }
        if (root.isE2ee()) {
            throw DomainException.unprocessable(ErrorCode.THREADS_E2EE_UNSUPPORTED,
                    "Threads are not supported in E2EE chats", details);
        }
    }

    /** E2EE chats have no server-visible thread metadata (D1 is managed-only). */
    public static void ensureThreadsSupported(boolean e2eeChat) {
        if (e2eeChat) {
            throw DomainException.unprocessable(ErrorCode.THREADS_E2EE_UNSUPPORTED,
                    "Threads are not supported in E2EE chats",
                    Map.of("field", "thread_root_id"));
        }
    }
}

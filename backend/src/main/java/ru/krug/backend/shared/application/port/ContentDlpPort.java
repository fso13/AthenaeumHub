package ru.krug.backend.shared.application.port;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * DLP gate for every MANAGED content surface (#101).
 *
 * <p>The workspace implementation evaluates the workspace's enabled literal rules (never
 * regex), records a content-free decision event and throws {@code 422 DLP_BLOCKED} for a
 * BLOCK match. A WARN match records the event and lets the caller continue. E2EE payloads
 * never reach this port because the server has no plaintext and DLP cannot be enabled in
 * an E2EE workspace.</p>
 *
 * <p>Implementations must never copy the evaluated value into the event log, a metric tag
 * or a log line: only ids, the rule snapshot, the action and the surface are allowed.</p>
 */
public interface ContentDlpPort {

    /**
     * Managed message text and message-edit text.
     *
     * @throws ru.krug.backend.shared.error.DomainException {@code DLP_BLOCKED} on a BLOCK
     *         match
     */
    void enforceText(Principal principal, UUID chatId, String text);

    /**
     * Attachment metadata on upload, bind and rename. Matching uses the file name, base
     * name, extension, MIME type and the optional per-rule size threshold; bytes are never
     * read.
     *
     * @param chatId nullable for a workspace-scoped (unbound) file
     * @throws ru.krug.backend.shared.error.DomainException {@code DLP_BLOCKED} on a BLOCK
     *         match
     */
    void enforceAttachment(Principal principal, UUID chatId, String filename, String mimeType,
                           long sizeBytes);

    /**
     * Plugin payload fields (poll question/options, task title, translation input/output).
     * Each field is evaluated independently so a keyword cannot match across a field
     * boundary; blank fields are skipped.
     *
     * @throws ru.krug.backend.shared.error.DomainException {@code DLP_BLOCKED} on a BLOCK
     *         match
     */
    void enforcePluginPayload(Principal principal, UUID chatId, List<String> fields);
}

package ru.krug.backend.workspace.api;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.api.dto.WorkspaceAuditPageResponse;
import ru.krug.backend.workspace.api.mapper.WorkspaceSecurityApiMapper;
import ru.krug.backend.workspace.application.model.AuditExportFormat;
import ru.krug.backend.workspace.application.model.WorkspaceAuditExportView;
import ru.krug.backend.workspace.application.usecase.WorkspaceAuditService;

/**
 * Workspace audit page and bounded export (P0-3 / #81). OWNER/ADMIN only.
 *
 * <pre>
 * GET /workspaces/{id}/audit?action=&amp;actor_id=&amp;from=&amp;to=&amp;cursor=&amp;limit=
 * GET /workspaces/{id}/audit/export?format=csv|json&amp;action=&amp;actor_id=&amp;from=&amp;to=
 * </pre>
 *
 * <p>Rows contain action/actor/target/time only: metadata JSONB, hash-chain bytes, request
 * id and actor email never leave the database. CSV is RFC 4180 quoted; JSON is a bounded
 * {@code WorkspaceAuditExport} object. The export is at most 10 000 rows and reports
 * truncation through {@code X-Export-Truncated}. Exporting is itself audited.</p>
 */
@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/audit")
public class WorkspaceAuditController {

    private static final DateTimeFormatter FILE_TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);

    private final WorkspaceAuditService audit;

    public WorkspaceAuditController(WorkspaceAuditService audit) {
        this.audit = audit;
    }

    @GetMapping
    public WorkspaceAuditPageResponse list(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "actor_id", required = false) UUID actorId,
            @RequestParam(value = "from", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(value = "to", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return WorkspaceSecurityApiMapper.toPage(audit.list(principal, workspaceId, action,
                actorId, from, to, cursor, limit));
    }

    @GetMapping("/export")
    public ResponseEntity<?> export(
            @PathVariable UUID workspaceId,
            @RequestParam(value = "format", required = false) String format,
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "actor_id", required = false) UUID actorId,
            @RequestParam(value = "from", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(value = "to", required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            Principal principal) {
        AuditExportFormat exportFormat = AuditExportFormat.parse(format);
        WorkspaceAuditExportView view = audit.export(principal, workspaceId, action, actorId,
                from, to, format);
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Export-Rows", Integer.toString(view.exportedRows()));
        headers.set("X-Export-Truncated", Boolean.toString(view.truncated()));
        headers.set(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"workspace-audit-" + workspaceId + "-"
                        + FILE_TIMESTAMP.format(Instant.now()) + "."
                        + (exportFormat == AuditExportFormat.CSV ? "csv" : "json") + "\"");
        if (exportFormat == AuditExportFormat.CSV) {
            headers.setContentType(new MediaType("text", "csv", StandardCharsets.UTF_8));
            return ResponseEntity.ok().headers(headers)
                    .body(WorkspaceSecurityApiMapper.toCsv(view)
                            .getBytes(StandardCharsets.UTF_8));
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        return ResponseEntity.ok().headers(headers)
                .body(WorkspaceSecurityApiMapper.toResponse(view));
    }
}

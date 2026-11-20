package ru.krug.backend.ops.api;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminAuditPageResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.api.mapper.AdminAuditExportMapper;
import ru.krug.backend.ops.application.model.AdminAuditExportView;
import ru.krug.backend.ops.application.model.AdminExportFormat;
import ru.krug.backend.ops.application.usecase.ExportAdminAuditService;
import ru.krug.backend.ops.application.usecase.ListAdminAuditService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /admin/audit} and {@code GET /admin/audit/export} (#84). Cursor pagination
 * plus an optional exact action filter; the service enforces the platform-admin guard and
 * audits the read itself. The export is bounded to 10 000 rows, uses RFC 4180 CSV or the
 * bounded JSON object and never exposes metadata/hashes/request ids.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminAuditController {

    private static final DateTimeFormatter FILE_TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC);

    private final ListAdminAuditService auditService;
    private final ExportAdminAuditService exportService;

    public AdminAuditController(ListAdminAuditService auditService,
                                ExportAdminAuditService exportService) {
        this.auditService = auditService;
        this.exportService = exportService;
    }

    @GetMapping("/audit")
    public AdminAuditPageResponse list(
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return AdminApiMapper.toPage(auditService.list(principal, action, cursor, limit));
    }

    @GetMapping("/audit/export")
    public ResponseEntity<?> export(
            @RequestParam(value = "format", required = false) String format,
            @RequestParam(value = "action", required = false) String action,
            Principal principal) {
        AdminAuditExportView view = exportService.export(principal, action, format);
        AdminExportFormat exportFormat = AdminExportFormat.parse(format);
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Export-Rows", Integer.toString(view.exportedRows()));
        headers.set("X-Export-Truncated", Boolean.toString(view.truncated()));
        headers.set(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"admin-audit-"
                        + FILE_TIMESTAMP.format(Instant.now()) + "."
                        + (exportFormat == AdminExportFormat.CSV ? "csv" : "json") + "\"");
        if (exportFormat == AdminExportFormat.CSV) {
            headers.setContentType(new MediaType("text", "csv", StandardCharsets.UTF_8));
            return ResponseEntity.ok().headers(headers)
                    .body(AdminAuditExportMapper.toCsv(view)
                            .getBytes(StandardCharsets.UTF_8));
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        return ResponseEntity.ok().headers(headers)
                .body(AdminAuditExportMapper.toResponse(view));
    }
}

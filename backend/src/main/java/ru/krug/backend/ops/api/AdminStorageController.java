package ru.krug.backend.ops.api;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminStorageResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.GetAdminStorageService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /admin/storage} (FR-ADM-12): aggregate storage dashboard, no file bytes,
 * names or object keys. The service applies the platform-admin guard and audit.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminStorageController {

    private final GetAdminStorageService storageService;

    public AdminStorageController(GetAdminStorageService storageService) {
        this.storageService = storageService;
    }

    @GetMapping("/storage")
    public AdminStorageResponse get(
            @RequestParam(value = "workspace_id", required = false) UUID workspaceId,
            Principal principal) {
        return AdminApiMapper.toResponse(storageService.storage(principal, workspaceId));
    }
}

package ru.krug.backend.ops.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminOverviewResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.GetAdminOverviewService;
import ru.krug.backend.shared.application.model.Principal;

/** Platform-admin aggregate overview (users/workspaces/chats counts only). */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminOverviewController {

    private final GetAdminOverviewService overviewService;

    public AdminOverviewController(GetAdminOverviewService overviewService) {
        this.overviewService = overviewService;
    }

    @GetMapping("/overview")
    public AdminOverviewResponse overview(Principal principal) {
        return AdminApiMapper.toResponse(overviewService.overview(principal));
    }
}

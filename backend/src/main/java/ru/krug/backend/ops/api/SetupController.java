package ru.krug.backend.ops.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.SetupStatusResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.GetSetupStatusService;

/** Public first-run probe; no authentication and no secret material. */
@RestController
@RequestMapping("/api/v1/setup")
public class SetupController {

    private final GetSetupStatusService setupStatusService;

    public SetupController(GetSetupStatusService setupStatusService) {
        this.setupStatusService = setupStatusService;
    }

    @GetMapping("/status")
    public SetupStatusResponse status() {
        return AdminApiMapper.toResponse(setupStatusService.status());
    }
}

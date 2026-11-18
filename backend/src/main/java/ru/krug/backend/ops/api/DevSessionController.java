package ru.krug.backend.ops.api;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.DevSessionRequest;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.api.mapper.SessionApiMapper;
import ru.krug.backend.ops.application.command.DevSessionCommand;
import ru.krug.backend.ops.application.usecase.DevSessionHandler;
import ru.krug.backend.shared.api.RequestIdFilter;

/**
 * Dev-only bootstrap. The bean does not exist in prod, so the route is unmapped and the
 * global handler returns 404 NOT_FOUND.
 */
@RestController
@RequestMapping("/api/v1/dev")
@Profile({"dev", "test"})
public class DevSessionController {

    private final DevSessionHandler devSessionHandler;

    public DevSessionController(DevSessionHandler devSessionHandler) {
        this.devSessionHandler = devSessionHandler;
    }

    @PostMapping("/session")
    public SessionResponse session(@RequestBody(required = false) DevSessionRequest request,
                                   HttpServletRequest httpRequest) {
        String displayName = request == null ? null : request.displayName();
        return SessionApiMapper.toResponse(devSessionHandler.handle(
                new DevSessionCommand(displayName, RequestIdFilter.requestId(httpRequest))));
    }
}

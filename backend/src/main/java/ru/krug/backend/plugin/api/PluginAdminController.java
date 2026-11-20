package ru.krug.backend.plugin.api;

import java.io.IOException;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import ru.krug.backend.plugin.api.dto.AdminPluginPackageListResponse;
import ru.krug.backend.plugin.api.dto.AdminPluginPackageResponse;
import ru.krug.backend.plugin.api.mapper.PluginApiMapper;
import ru.krug.backend.plugin.application.usecase.InstallPluginPackageService;
import ru.krug.backend.plugin.application.usecase.ListAdminPluginPackagesService;
import ru.krug.backend.plugin.application.usecase.UninstallPluginPackageService;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Admin-only lifecycle of external plugin packages. The platform-admin guard lives in the
 * use cases, so a direct call from a non-admin is always 403. The upload is a plain ZIP
 * part named {@code file}; no server-side plugin code is executed.
 */
@RestController
@RequestMapping("/api/v1/admin/plugins")
public class PluginAdminController {

    private final InstallPluginPackageService install;
    private final ListAdminPluginPackagesService list;
    private final UninstallPluginPackageService uninstall;

    public PluginAdminController(InstallPluginPackageService install,
                                 ListAdminPluginPackagesService list,
                                 UninstallPluginPackageService uninstall) {
        this.install = install;
        this.list = list;
        this.uninstall = uninstall;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public AdminPluginPackageResponse install(@RequestPart("file") MultipartFile file,
                                              Principal principal) {
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException ex) {
            throw new DomainException(ErrorCategory.BAD_REQUEST,
                    ErrorCode.PLUGIN_PACKAGE_INVALID,
                    "Uploaded package cannot be read", java.util.Map.of(), null);
        }
        return PluginApiMapper.toResponse(install.install(principal, bytes));
    }

    @GetMapping
    public AdminPluginPackageListResponse list(Principal principal) {
        return PluginApiMapper.toPackageResponse(list.list(principal));
    }

    @DeleteMapping("/{pluginId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public ResponseEntity<Void> uninstall(@PathVariable String pluginId, Principal principal) {
        uninstall.uninstall(principal, pluginId);
        return ResponseEntity.noContent().build();
    }
}

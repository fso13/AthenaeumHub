package ru.krug.backend.auth.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.ProfileAvatarView;
import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.UserAvatarPort;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code POST/DELETE/GET /me/avatar} (P0-4 / #82).
 *
 * <p>There is no new upload endpoint: the body references an existing managed attachment
 * that must be owned by the caller, be an image and be CLEAN ({@link UserAvatarPort}).
 * DELETE is idempotent and writes no audit when nothing changed. The profile payload only
 * exposes a stable relative URL; {@code GET /me/avatar} redirects to a short-lived
 * presigned object URL.</p>
 */
@Service
public class ProfileAvatarService {

    static final String ACTION = "profile.avatar.updated";

    private final TenantContext tenantContext;
    private final UserRepository users;
    private final UserAvatarPort avatars;
    private final AuditPort audit;
    private final ClockPort clock;

    public ProfileAvatarService(TenantContext tenantContext, UserRepository users,
                                UserAvatarPort avatars, AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.users = users;
        this.avatars = avatars;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public UserProfileView setAvatar(Principal principal, UUID fileId) {
        if (fileId == null) {
            throw DomainException.badRequest("file_id is required",
                    Map.of("field", "file_id"));
        }
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        UUID validated = avatars.requireAvatar(principal.userId(), fileId);
        // The port activates the narrow file-resolve role; restore the self RLS context
        // before writing auth.users and the audit chain.
        tenantContext.activate(principal.withWorkspace(null));
        if (!validated.equals(user.avatarFileId())) {
            users.updateAvatar(principal.userId(), validated);
            audit.append(new AuditRecord(null, principal.userId(), ACTION, "user",
                    principal.userId(), principal.requestId(), Map.of("changed", "avatar"),
                    clock.now()));
        }
        return UserProfileService.toView(user.withAvatar(validated));
    }

    @Transactional
    public void removeAvatar(Principal principal) {
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        if (user.avatarFileId() == null) {
            return;
        }
        users.updateAvatar(principal.userId(), null);
        audit.append(new AuditRecord(null, principal.userId(), ACTION, "user",
                principal.userId(), principal.requestId(), Map.of("changed", "avatar"),
                clock.now()));
    }

    @Transactional(readOnly = true)
    public ProfileAvatarView download(Principal principal) {
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        if (user.avatarFileId() == null) {
            throw DomainException.notFound("Avatar not found");
        }
        return avatars.download(user.avatarFileId())
                .map(value -> new ProfileAvatarView(value.url(), value.expiresAt()))
                .orElseThrow(() -> DomainException.notFound("Avatar not found"));
    }
}

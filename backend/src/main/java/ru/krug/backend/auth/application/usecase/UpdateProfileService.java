package ru.krug.backend.auth.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.command.UpdateProfileCommand;
import ru.krug.backend.auth.application.model.ProfileAvatars;
import ru.krug.backend.auth.application.model.UserProfileView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.domain.model.Bio;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.Phone;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code PATCH /me}: update the caller's own profile fields.
 *
 * <p>Email and password are identity-provider owned and are intentionally not writable
 * here. E2EE keys live on {@code auth.devices}/{@code auth.device_prekeys}, so this service
 * never touches key material or device rows.</p>
 *
 * <p>The audit event contains only the changed field <em>names</em>; display name, bio and
 * phone values are never copied into audit metadata or logs. The Keycloak display-name
 * sync is best effort: the local profile is already committed and an unreachable IdP does
 * not turn a successful PATCH into a 503.</p>
 */
@Service
public class UpdateProfileService {

    static final String ACTION = "profile.updated";
    private static final Logger log = LoggerFactory.getLogger(UpdateProfileService.class);

    private final TenantContext tenantContext;
    private final UserRepository users;
    private final UserIdentityRepository identities;
    private final KeycloakAdminPort keycloak;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateProfileService(TenantContext tenantContext, UserRepository users,
                                UserIdentityRepository identities, KeycloakAdminPort keycloak,
                                AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.users = users;
        this.identities = identities;
        this.keycloak = keycloak;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public UserProfileView update(Principal principal, UpdateProfileCommand command) {
        if (command.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "At least one profile field is required",
                    Map.of("reason", "empty_patch"));
        }
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));

        DisplayName displayName = command.displayNamePresent()
                ? new DisplayName(command.displayName()) : user.displayName();
        Bio bio = command.bioPresent() ? new Bio(command.bio()) : user.bio();
        Phone phone = command.phonePresent() ? new Phone(command.phone()) : user.phone();

        List<String> changedFields = new ArrayList<>(3);
        if (command.displayNamePresent()) {
            changedFields.add("display_name");
        }
        if (command.bioPresent()) {
            changedFields.add("bio");
        }
        if (command.phonePresent()) {
            changedFields.add("phone");
        }

        users.updateProfile(user.id(), displayName, bio, phone);

        // Fields only: values (especially bio/phone) never enter the audit chain.
        audit.append(new AuditRecord(null, principal.userId(), ACTION, "user", user.id(),
                principal.requestId(), Map.of("fields", List.copyOf(changedFields)),
                clock.now()));

        if (command.displayNamePresent()) {
            syncDisplayNameBestEffort(principal, displayName.value());
        }

        return new UserProfileView(user.id().toString(), displayName.value(), user.email(),
                user.isPlatformAdmin(), bio.value(), phone.value(),
                ProfileAvatars.url(user.avatarFileId()));
    }

    /**
     * JIT-provisioned users are linked to Keycloak by subject. A dev user has no link, so
     * the sync is skipped. Any provider failure is logged without the display-name value or
     * exception message and never propagated.
     */
    private void syncDisplayNameBestEffort(Principal principal, String displayName) {
        Optional<UserIdentity> identity = identities.findByUserIdAndProvider(
                principal.userId(), UserIdentity.PROVIDER_KEYCLOAK);
        if (identity.isEmpty()) {
            return;
        }
        UUID keycloakUserId = parseUuid(identity.get().subject());
        if (keycloakUserId == null) {
            return;
        }
        if (displayName == null || displayName.isBlank()) {
            return;
        }
        try {
            keycloak.updateDisplayName(keycloakUserId, displayName);
        } catch (ProviderUnavailableException ex) {
            log.warn("Keycloak display-name sync failed (best effort) request_id={} type={}",
                    principal.requestId(), ex.getClass().getSimpleName());
        }
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}

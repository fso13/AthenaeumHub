package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * P0-4 / #82: profile avatar, workspace settings/logo, role permissions and invite links.
 * Runs the real REST/DB/audit stack on the dev profile; TOTP is covered by
 * {@link TwoFactorIT} because it needs the Keycloak password grant.
 */
@ActiveProfiles("test")
class ProfileWorkspace82IT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    // ---------------------------------------------------------------- avatar

    @Test
    void avatarLifecycleUsesCleanImageAndAuditsOnlyMetadata() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-avatar-owner"));
        UUID fileId = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/png", "CLEAN", "READY");

        MvcResult set = mockMvc.perform(authed(post("/api/v1/me/avatar"), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode user = json(set);
        CONTRACT.assertValid("AuthUser", user);
        assertThat(user.get("avatar_url").asText()).isEqualTo("/api/v1/me/avatar");
        assertThat(migrator().queryForObject(
                "SELECT avatar_file_id FROM auth.users WHERE id = ?", UUID.class,
                owner.user().id())).isEqualTo(fileId);

        MvcResult me = mockMvc.perform(authed(get("/api/v1/me"), owner))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("MeResponse", json(me));
        assertThat(json(me).at("/user/avatar_url").asText()).isEqualTo("/api/v1/me/avatar");

        MvcResult download = mockMvc.perform(authed(get("/api/v1/me/avatar"), owner))
                .andExpect(status().isFound())
                .andExpect(header().exists("Location"))
                .andReturn();
        assertThat(download.getResponse().getHeader("Location")).isNotBlank();

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'profile.avatar.updated' AND actor_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, owner.user().id());
        assertThat(metadata).contains("avatar").doesNotContain(fileId.toString());
    }

    @Test
    void avatarDeleteIsIdempotentAndClearsTheProfile() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-avatar-delete"));
        UUID fileId = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/jpeg", "CLEAN", "READY");
        setAvatar(owner, fileId).andExpect(status().isOk());

        mockMvc.perform(authed(delete("/api/v1/me/avatar"), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(delete("/api/v1/me/avatar"), owner))
                .andExpect(status().isNoContent());
        assertThat(migrator().queryForObject(
                "SELECT avatar_file_id FROM auth.users WHERE id = ?", UUID.class,
                owner.user().id())).isNull();
        assertThat(json(mockMvc.perform(authed(get("/api/v1/me"), owner))
                .andExpect(status().isOk()).andReturn()).at("/user/avatar_url").isNull());
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'profile.avatar.updated' AND actor_id = ?
                """, Long.class, owner.user().id())).isEqualTo(2L);
    }

    @Test
    void avatarRejectsForeignAndNonImageAndNotReadyAttachments() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-avatar-owner2"));
        SessionResponse other = devSession(uniqueDisplayName("p82-avatar-other"));
        UUID foreign = imageAttachment(other.user().id(), other.workspace().id(),
                other.chat().id(), "image/png", "CLEAN", "READY");
        MvcResult foreignResult = setAvatar(owner, foreign)
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(foreignResult));

        UUID notImage = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "text/plain", "CLEAN", "READY");
        MvcResult invalid = setAvatar(owner, notImage)
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(invalid).get("code").asText()).isEqualTo("AVATAR_INVALID");

        UUID pending = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/png", "PENDING", "READY");
        MvcResult notReady = setAvatar(owner, pending)
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(notReady).get("code").asText()).isEqualTo("ATTACHMENT_NOT_READY");

        mockMvc.perform(authed(post("/api/v1/me/avatar"), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(post("/api/v1/me/avatar")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", foreign))))
                .andExpect(status().isUnauthorized());
    }

    // ----------------------------------------------------- workspace settings

    @Test
    void ownerUpdatesNameDescriptionAndLogoWithFieldNameAudit() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-owner"));
        UUID logo = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/webp", "CLEAN", "READY");

        MvcResult updated = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Новое имя",
                                "description", "Описание воркспейса",
                                "logo_file_id", logo))))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(updated);
        CONTRACT.assertValid("WorkspaceSummary", body);
        assertThat(body.get("name").asText()).isEqualTo("Новое имя");
        assertThat(body.get("description").asText()).isEqualTo("Описание воркспейса");
        assertThat(body.get("logo_file_id").asText()).isEqualTo(logo.toString());
        assertThat(body.get("role").asText()).isEqualTo("OWNER");

        Map<String, Object> row = migrator().queryForMap("""
                SELECT name, description, logo_file_id FROM workspace.workspaces WHERE id = ?
                """, owner.workspace().id());
        assertThat(row.get("name")).isEqualTo("Новое имя");
        assertThat(row.get("description")).isEqualTo("Описание воркспейса");
        assertThat(row.get("logo_file_id")).isEqualTo(logo);

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.updated' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, owner.workspace().id());
        assertThat(metadata).contains("name", "description", "logo_file_id")
                .doesNotContain("Новое имя", "Описание воркспейса", logo.toString());
    }

    @Test
    void workspaceLogoCanBeReplacedAndClearedViaBothSurfaces() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-logo"));
        UUID first = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/png", "CLEAN", "READY");
        UUID second = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "image/png", "SKIPPED", "READY");
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/avatar",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", first))))
                .andExpect(status().isOk());
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/avatar",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("file_id", second))))
                .andExpect(status().isOk());
        assertThat(logoOf(owner.workspace().id())).isEqualTo(second);

        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(nullable("logo_file_id", null))))
                .andExpect(status().isOk());
        assertThat(logoOf(owner.workspace().id())).isNull();

        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/avatar",
                        owner.workspace().id()), owner))
                .andExpect(status().isNoContent());
    }

    @Test
    void workspaceSettingsRejectForeignLogoAndEmptyPatch() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-bad"));
        SessionResponse other = devSession(uniqueDisplayName("p82-ws-other"));
        UUID foreign = imageAttachment(other.user().id(), other.workspace().id(),
                other.chat().id(), "image/png", "CLEAN", "READY");
        MvcResult hidden = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("logo_file_id", foreign))))
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(hidden));

        UUID notImage = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), "application/pdf", "CLEAN", "READY");
        MvcResult invalid = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("logo_file_id", notImage))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(invalid).get("code").asText()).isEqualTo("WORKSPACE_LOGO_INVALID");

        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " "})
    void workspaceNameValidationRejectsBadValues(String name) throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-name"));
        MvcResult result = mockMvc.perform(authed(
                        patch("/api/v1/workspaces/{workspaceId}", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", name))))
                .andExpect(status().isBadRequest()).andReturn();
        CONTRACT.assertValid("Error", json(result));
    }

    @Test
    void workspaceDescriptionBoundsAndControlCharactersAreRejected() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-desc"));
        for (String description : List.of("x".repeat(501), "bad\u0000value")) {
            MvcResult result = mockMvc.perform(authed(
                            patch("/api/v1/workspaces/{workspaceId}",
                                    owner.workspace().id()), owner)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(
                                    Map.of("description", description))))
                    .andExpect(status().isBadRequest()).andReturn();
            assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        }
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(nullable("description", null))))
                .andExpect(status().isOk());
        assertThat(migrator().queryForObject(
                "SELECT description FROM workspace.workspaces WHERE id = ?", String.class,
                owner.workspace().id())).isNull();
    }

    @Test
    void workspaceSettingsAndAvatarRequireAuthentication() throws Exception {
        UUID workspaceId = UUID.randomUUID();
        mockMvc.perform(patch("/api/v1/workspaces/{workspaceId}", workspaceId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"x\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/workspaces/{workspaceId}/avatar", workspaceId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"file_id\":\"" + UUID.randomUUID() + "\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/workspaces/{workspaceId}/permissions", workspaceId))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/workspaces/{workspaceId}/invites", workspaceId))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/workspace-invites/{token}/accept", "a".repeat(32)))
                .andExpect(status().isUnauthorized());
    }

    // ----------------------------------------------------------- permissions

    @Test
    void permissionMatrixDefaultsAndAdministrationScope() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-perm-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("p82-perm-admin"));
        SessionResponse member = devSession(uniqueDisplayName("p82-perm-member"));
        admin = addMember(owner, admin, "ADMIN");
        member = addMember(owner, member, "MEMBER");

        JsonNode matrix = permissions(owner);
        CONTRACT.assertValid("WorkspacePermissionMatrix", matrix);
        assertThat(matrix.get("roles")).hasSize(3);
        assertThat(matrix.at("/roles/0/role").asText()).isEqualTo("OWNER");
        for (JsonNode role : matrix.get("roles")) {
            boolean ownerRole = role.get("role").asText().equals("OWNER");
            boolean adminRole = role.get("role").asText().equals("ADMIN");
            assertThat(role.get("manage_workspace").asBoolean()).isEqualTo(ownerRole || adminRole);
            assertThat(role.get("manage_invites").asBoolean()).isEqualTo(ownerRole || adminRole);
            assertThat(role.get("manage_permissions").asBoolean()).isEqualTo(ownerRole || adminRole);
        }
        assertThat(matrix.at("/roles/2/manage_workspace").asBoolean()).isFalse();

        // A regular member can read the matrix (their own effective rights).
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/permissions",
                        owner.workspace().id()), member))
                .andExpect(status().isOk());

        updatePermissions(admin, entry("MEMBER", "manage_invites", true))
                .andExpect(status().isOk());
        assertThat(permissions(owner).at("/roles/2/manage_invites").asBoolean()).isTrue();

        // ADMIN may not change ADMIN cells; only the OWNER may.
        MvcResult adminSelf = updatePermissions(admin, entry("ADMIN", "manage_workspace", false))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(adminSelf).get("code").asText()).isEqualTo("PERMISSION_CHANGE_FORBIDDEN");
        updatePermissions(owner, entry("ADMIN", "manage_workspace", false))
                .andExpect(status().isOk());
        assertThat(permissions(owner).at("/roles/1/manage_workspace").asBoolean()).isFalse();
        // The matrix is enforced for the ADMIN workspace-update path.
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}",
                        owner.workspace().id()), admin)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Denied\"}"))
                .andExpect(status().isForbidden());
        updatePermissions(owner, entry("ADMIN", "manage_workspace", true))
                .andExpect(status().isOk());

        MvcResult ownerRow = updatePermissions(owner, entry("OWNER", "manage_workspace", false))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(ownerRow).get("code").asText()).isEqualTo("OWNER_PERMISSIONS_IMMUTABLE");
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}/permissions",
                        owner.workspace().id()), member)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("entries",
                                List.of(entry("MEMBER", "manage_invites", true))))))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}/permissions",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"entries\":[]}"))
                .andExpect(status().isBadRequest());
        MvcResult unknown = updatePermissions(owner, entry("MEMBER", "unknown", true))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(unknown).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        updatePermissions(owner, entry("MEMBER", "unknown", true),
                entry("MEMBER", "unknown", false))
                .andExpect(status().isBadRequest());
        MvcResult duplicate = updatePermissions(owner, entry("MEMBER", "manage_invites", true),
                entry("MEMBER", "manage_invites", false))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(duplicate).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.permissions.updated' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, owner.workspace().id());
        assertThat(metadata).contains("role", "permission", "allowed");
    }

    // --------------------------------------------------------------- invites

    @Test
    void inviteLifecycleIsHashedIdempotentAndAuditedWithoutSecrets() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-inv-owner"));
        SessionResponse joiner = devSession(uniqueDisplayName("p82-inv-join"));

        MvcResult created = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{workspaceId}/invites", owner.workspace().id()),
                        owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"MEMBER\",\"max_uses\":5,\"expires_in_seconds\":600}"))
                .andExpect(status().isCreated()).andReturn();
        JsonNode body = json(created);
        CONTRACT.assertValid("WorkspaceInviteCreated", body);
        String token = body.get("token").asText();
        UUID inviteId = UUID.fromString(body.at("/invite/id").asText());
        assertThat(token).hasSizeGreaterThanOrEqualTo(20);
        assertThat(body.get("accept_url").asText()).endsWith(token + "/accept");
        assertThat(body.at("/invite/status").asText()).isEqualTo("ACTIVE");

        Map<String, Object> stored = migrator().queryForMap("""
                SELECT token_hash, used_count FROM workspace.invites WHERE id = ?
                """, inviteId);
        assertThat(stored.get("token_hash")).isNotEqualTo(token);
        assertThat(String.valueOf(stored.get("token_hash"))).hasSize(64)
                .doesNotContain(token);

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/invites", owner.workspace().id()),
                        owner))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("WorkspaceInviteList", json(list));
        assertThat(list.getResponse().getContentAsString()).doesNotContain(token);
        assertThat(json(list).get("invites")).hasSize(1);

        MvcResult accepted = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept", token), joiner))
                .andExpect(status().isOk()).andReturn();
        JsonNode acceptance = json(accepted);
        CONTRACT.assertValid("WorkspaceInviteAcceptance", acceptance);
        assertThat(acceptance.get("workspace_id").asText())
                .isEqualTo(owner.workspace().id().toString());
        assertThat(acceptance.get("role").asText()).isEqualTo("MEMBER");
        assertThat(acceptance.get("already_member").asBoolean()).isFalse();

        MvcResult repeated = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept", token), joiner))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(repeated).get("already_member").asBoolean()).isTrue();
        assertThat(migrator().queryForObject(
                "SELECT used_count FROM workspace.invites WHERE id = ?", Integer.class,
                inviteId)).isEqualTo(1);

        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.invite.accepted' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, owner.workspace().id());
        assertThat(metadata).contains("MEMBER").doesNotContain(token);

        // A revoked *unused* link is a 410; the joined user above is idempotent by design.
        SessionResponse newcomer = devSession(uniqueDisplayName("p82-inv-newcomer"));
        JsonNode secondInvite = json(createInvite(owner, null, 600)
                .andExpect(status().isCreated()).andReturn());
        String secondToken = secondInvite.get("token").asText();
        UUID secondId = UUID.fromString(secondInvite.at("/invite/id").asText());
        mockMvc.perform(authed(delete(
                        "/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        owner.workspace().id(), secondId), owner))
                .andExpect(status().isNoContent());
        MvcResult gone = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept", secondToken), newcomer))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(gone).get("code").asText()).isEqualTo("WORKSPACE_INVITE_REVOKED");

        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        owner.workspace().id(), inviteId), owner))
                .andExpect(status().isNoContent());
        mockMvc.perform(authed(post("/api/v1/workspace-invites/{token}/accept",
                        "not-a-valid-token!"), joiner))
                .andExpect(status().isNotFound());
    }

    @Test
    void inviteRoleCeilingAndAuthorizationAreEnforced() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-inv-role-owner"));
        SessionResponse admin = devSession(uniqueDisplayName("p82-inv-role-admin"));
        SessionResponse member = devSession(uniqueDisplayName("p82-inv-role-member"));
        SessionResponse outsider = devSession(uniqueDisplayName("p82-inv-outsider"));
        admin = addMember(owner, admin, "ADMIN");
        member = addMember(owner, member, "MEMBER");
        assertThat(migrator().queryForObject("""
                SELECT role FROM workspace.memberships WHERE workspace_id = ? AND user_id = ?
                """, String.class, owner.workspace().id(), admin.user().id())).isEqualTo("ADMIN");

        createInvite(member, null, null)
                .andExpect(status().isForbidden());
        createInviteIn(outsider, owner.workspace().id(), null, null)
                .andExpect(status().isForbidden());
        MvcResult adminAdmin = createInvite(admin, "ADMIN", null)
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(adminAdmin).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_ROLE_FORBIDDEN");
        createInvite(admin, "MEMBER", null).andExpect(status().isCreated());
        createInvite(owner, "ADMIN", null).andExpect(status().isCreated());
        MvcResult ownerOwner = createInvite(owner, "OWNER", null)
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(ownerOwner).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_ROLE_FORBIDDEN");

        // A token from another workspace is hidden from a manager of this workspace.
        SessionResponse foreignOwner = devSession(uniqueDisplayName("p82-inv-foreign"));
        MvcResult created = createInvite(foreignOwner, null, null)
                .andExpect(status().isCreated()).andReturn();
        UUID foreignInvite = UUID.fromString(json(created).at("/invite/id").asText());
        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        owner.workspace().id(), foreignInvite), owner))
                .andExpect(status().isNotFound());
    }

    @Test
    void inviteExpiryExhaustionAndCrossWorkspaceAcceptRules() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-inv-state-owner"));
        SessionResponse first = devSession(uniqueDisplayName("p82-inv-state-first"));
        SessionResponse second = devSession(uniqueDisplayName("p82-inv-state-second"));

        MvcResult expired = createInvite(owner, "MEMBER", 300)
                .andExpect(status().isCreated()).andReturn();
        UUID expiredId = UUID.fromString(json(expired).at("/invite/id").asText());
        migrator().update("UPDATE workspace.invites SET expires_at = now() - interval '1 minute'"
                + " WHERE id = ?", expiredId);
        MvcResult expiredResult = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept",
                                json(expired).get("token").asText()), first))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(expiredResult).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EXPIRED");

        MvcResult limited = createInvite(owner, "GUEST", 600, 1)
                .andExpect(status().isCreated()).andReturn();
        String limitedToken = json(limited).get("token").asText();
        mockMvc.perform(authed(post("/api/v1/workspace-invites/{token}/accept", limitedToken),
                        first))
                .andExpect(status().isOk());
        MvcResult exhausted = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept", limitedToken), second))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(exhausted).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EXHAUSTED");

        // An unknown token is a 404 and does not disclose existence.
        MvcResult unknown = mockMvc.perform(authed(
                        post("/api/v1/workspace-invites/{token}/accept", "a".repeat(43)), second))
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(unknown));
    }

    @Test
    void workspaceAndInviteRlsHidesOtherTenants() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-rls-owner"));
        SessionResponse other = devSession(uniqueDisplayName("p82-rls-other"));
        UUID otherInvite = UUID.fromString(json(createInvite(other, null, null)
                .andExpect(status().isCreated()).andReturn()).at("/invite/id").asText());
        mockMvc.perform(authed(get("/api/v1/workspaces/{workspaceId}/invites",
                        other.workspace().id()), owner))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(delete("/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        other.workspace().id(), otherInvite), owner))
                .andExpect(status().isForbidden());
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM workspace.invites WHERE id = ?
                """, Long.class, otherInvite)).isEqualTo(1L);
    }


    @ParameterizedTest
    @CsvSource({
            "OWNER,403",
            "SUPERUSER,400"
    })
    void inviteRoleValidationRejectsOwnerAndUnknownRoles(String role, int expectedStatus)
            throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-inv-bad-role"));
        MvcResult result = mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/invites", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("role", role))))
                .andExpect(status().is(expectedStatus)).andReturn();
        CONTRACT.assertValid("Error", json(result));
    }

    @ParameterizedTest
    @CsvSource({
            "0,600",
            "1001,600",
            "5,299",
            "5,2592001"
    })
    void inviteNumericBoundsAreValidated(int maxUses, long expiresInSeconds) throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-inv-bounds"));
        MvcResult result = mockMvc.perform(authed(post(
                        "/api/v1/workspaces/{workspaceId}/invites", owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "max_uses", maxUses,
                                "expires_in_seconds", expiresInSeconds))))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    @ParameterizedTest
    @CsvSource({
            "OWNER,manage_workspace,422,OWNER_PERMISSIONS_IMMUTABLE",
            "GUEST,manage_workspace,400,VALIDATION_FAILED",
            "MEMBER,not_a_permission,400,VALIDATION_FAILED"
    })
    void permissionMatrixRejectsInvalidCells(String role, String permission, int status,
                                             String code) throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-perm-bad"));
        MvcResult result = updatePermissions(owner, entry(role, permission, true))
                .andExpect(status().is(status)).andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo(code);
    }

    @ParameterizedTest
    @CsvSource({
            "image/png,CLEAN,200",
            "image/gif,SKIPPED,200",
            "text/plain,CLEAN,422",
            "image/png,INFECTED,423"
    })
    void avatarMimeAndScanGate(String mime, String scanStatus, int expectedStatus)
            throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-avatar-gate"));
        UUID fileId = imageAttachment(owner.user().id(), owner.workspace().id(),
                owner.chat().id(), mime, scanStatus, "READY");
        MvcResult result = setAvatar(owner, fileId).andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expectedStatus);
        if (expectedStatus != 200) {
            CONTRACT.assertValid("Error", json(result));
        }
    }

    @Test
    void workspaceNameTooLongIsRejected() throws Exception {
        SessionResponse owner = devSession(uniqueDisplayName("p82-ws-long"));
        mockMvc.perform(authed(patch("/api/v1/workspaces/{workspaceId}",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("name", "x".repeat(121)))))
                .andExpect(status().isBadRequest());
    }

    // ---------------------------------------------------------------- helpers

    private org.springframework.test.web.servlet.ResultActions setAvatar(SessionResponse actor,
                                                                         UUID fileId)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/me/avatar"), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("file_id", fileId))));
    }

    private SessionResponse addMember(SessionResponse owner, SessionResponse target,
                                      String role) throws Exception {
        mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/members",
                        owner.workspace().id()), owner)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", emailOf(target.user().id()),
                                "role", role))))
                .andExpect(status().isCreated());
        return new SessionResponse(target.accessToken(), target.expiresAt(), target.user(),
                target.device(), owner.workspace(), owner.chat());
    }

    private JsonNode permissions(SessionResponse actor) throws Exception {
        return json(mockMvc.perform(authed(get(
                        "/api/v1/workspaces/{workspaceId}/permissions", actor.workspace().id()),
                        actor))
                .andExpect(status().isOk()).andReturn());
    }

    private org.springframework.test.web.servlet.ResultActions updatePermissions(
            SessionResponse actor, Map<String, Object>... entries) throws Exception {
        return mockMvc.perform(authed(patch(
                        "/api/v1/workspaces/{workspaceId}/permissions", actor.workspace().id()),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("entries", entries))));
    }

    private org.springframework.test.web.servlet.ResultActions createInvite(SessionResponse actor,
                                                                           String role,
                                                                           Integer expires)
            throws Exception {
        return createInvite(actor, role, expires, null);
    }

    private org.springframework.test.web.servlet.ResultActions createInvite(SessionResponse actor,
                                                                           String role,
                                                                           Integer expires,
                                                                           Integer maxUses)
            throws Exception {
        return createInviteIn(actor, actor.workspace().id(), role, expires, maxUses);
    }

    private org.springframework.test.web.servlet.ResultActions createInviteIn(
            SessionResponse actor, UUID workspaceId, String role, Integer expires)
            throws Exception {
        return createInviteIn(actor, workspaceId, role, expires, null);
    }

    private org.springframework.test.web.servlet.ResultActions createInviteIn(
            SessionResponse actor, UUID workspaceId, String role, Integer expires,
            Integer maxUses) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        if (role != null) {
            body.put("role", role);
        }
        if (expires != null) {
            body.put("expires_in_seconds", expires);
        }
        if (maxUses != null) {
            body.put("max_uses", maxUses);
        }
        return mockMvc.perform(authed(post("/api/v1/workspaces/{workspaceId}/invites",
                        workspaceId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private static Map<String, Object> entry(String role, String permission, boolean allowed) {
        return new LinkedHashMap<>(Map.of("role", role, "permission", permission,
                "allowed", allowed));
    }

    private static Map<String, Object> nullable(String key, Object value) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put(key, value);
        return body;
    }

    private String emailOf(UUID userId) {
        return migrator().queryForObject(
                "SELECT email::text FROM auth.users WHERE id = ?", String.class, userId);
    }

    private UUID logoOf(UUID workspaceId) {
        return migrator().queryForObject(
                "SELECT logo_file_id FROM workspace.workspaces WHERE id = ?", UUID.class,
                workspaceId);
    }

    private UUID imageAttachment(UUID userId, UUID workspaceId, UUID chatId, String mime,
                                 String scanStatus, String status) {
        UUID uploadId = UUID.randomUUID();
        UUID attachmentId = UUID.randomUUID();
        String sha = "a".repeat(64);
        String objectKey = "p82/" + attachmentId;
        migrator().update("""
                INSERT INTO file.uploads
                       (id, workspace_id, chat_id, user_id, filename, mime_type, size_bytes,
                        sha256, status, part_size, total_parts, object_key, expires_at,
                        completed_at)
                VALUES (?, ?, ?, ?, 'avatar.png', ?, 16, ?, 'READY', 16, 1, ?, now() + interval '1 hour', now())
                """, uploadId, workspaceId, chatId, userId, mime, sha, objectKey);
        String media = mime.startsWith("image/")
                ? "{\"kind\":\"IMAGE\",\"metadata_source\":\"CLIENT\"}"
                : "{\"kind\":\"FILE\",\"metadata_source\":\"CLIENT\"}";
        migrator().update("""
                INSERT INTO file.attachments
                       (id, workspace_id, chat_id, upload_id, user_id, filename, mime_type,
                        size_bytes, sha256, object_key, status, scan_status, media)
                VALUES (?, ?, ?, ?, ?, 'avatar.png', ?, 16, ?, ?, ?, ?, CAST(? AS jsonb))
                """, attachmentId, workspaceId, chatId, uploadId, userId, mime, sha, objectKey,
                status, scanStatus, media);
        return attachmentId;
    }
}

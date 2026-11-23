package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.auth.api.dto.AuthSessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.MockMailSender;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.TestMailConfig;

/**
 * #100: email-bound workspace invitations. Real MockMvc + PostgreSQL + WireMock Keycloak and
 * a captured SMTP adapter (the same SmtpMailAdapter that talks to Mailpit in dev), so
 * registration, verification, the post-verification claim and the SMTP message are
 * exercised end-to-end.
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=invite-email-test-content-key-please-change-32",
        "krug.auth-bff.code.secret-key=invite-email-test-email-secret-key-please-change-32",
        "krug.auth-bff.cleanup.enabled=false",
        "krug.auth-bff.keycloak.admin-password=invite-email-test-admin",
        "krug.auth-bff.rate-limit.register-per-email=100",
        "krug.auth-bff.rate-limit.register-per-ip=1000",
        "krug.auth-bff.rate-limit.login-per-email=100",
        "krug.auth-bff.rate-limit.login-per-ip=1000",
        "krug.auth-bff.rate-limit.resend-per-email=100",
        "krug.auth-bff.rate-limit.resend-per-ip=1000",
        "krug.workspace-invites.accept-base-url=http://localhost:5173"
})
@ActiveProfiles("keycloak")
@Import(TestMailConfig.class)
class WorkspaceInviteEmailIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PASSWORD = "VeryStrongPass123!";
    private static final String ACCEPT_BASE = "http://localhost:5173/workspace-invite/";

    @Autowired
    private MockMailSender mail;

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
        registry.add("krug.oidc.issuer", KeycloakWireMock::issuer);
        registry.add("krug.oidc.jwk-set-uri", KeycloakWireMock::jwksUri);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
        mail.clear();
    }

    // ------------------------------------------------------- send / preview

    @Test
    void emailInviteIsMailedNormalizedPreviewedAndConsumedOnce() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("inv-owner"));
        UUID workspace = createWorkspace(owner);
        String inviteeEmail = uniqueEmail("inv-recipient");

        MvcResult created = createInvite(owner, workspace, Map.of(
                        "role", "MEMBER",
                        "email", inviteeEmail.toUpperCase()))
                .andExpect(status().isCreated()).andReturn();
        JsonNode body = json(created);
        CONTRACT.assertValid("WorkspaceInviteCreated", body);
        UUID inviteId = UUID.fromString(body.at("/invite/id").asText());
        String token = body.get("token").asText();

        assertThat(body.at("/invite/email").asText()).isEqualTo(inviteeEmail);
        assertThat(body.at("/invite/max_uses").asInt()).isEqualTo(1);
        assertThat(body.at("/invite/status").asText()).isEqualTo("ACTIVE");
        assertThat(body.get("accept_url").asText()).endsWith(token + "/accept");

        // The existing SMTP adapter receives the invitation; token/address are not in logs
        // (the adapter/model redact the body; only the recipient transport sees it).
        assertThat(mail.outboundCount()).isEqualTo(1);
        var email = mail.lastOutbound();
        assertThat(email.to()).isEqualTo(inviteeEmail);
        assertThat(email.subject()).contains("приглашение");
        assertThat(email.body()).contains(ACCEPT_BASE + token)
                .contains("MEMBER");

        Map<String, Object> stored = migrator().queryForMap("""
                SELECT token_hash, email::text AS email, max_uses, used_count
                  FROM workspace.invites WHERE id = ?
                """, inviteId);
        assertThat(String.valueOf(stored.get("token_hash"))).hasSize(64)
                .doesNotContain(token);
        assertThat(stored.get("email")).isEqualTo(inviteeEmail);
        assertThat(((Number) stored.get("max_uses")).intValue()).isEqualTo(1);
        assertThat(((Number) stored.get("used_count")).intValue()).isZero();

        // The manager list exposes metadata (including the bound address) but never a token.
        MvcResult list = mockMvc.perform(authed(owner,
                        get("/api/v1/workspaces/{workspaceId}/invites", workspace)))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("WorkspaceInviteList", json(list));
        assertThat(list.getResponse().getContentAsString())
                .doesNotContain(token).doesNotContain("token_hash");
        assertThat(json(list).at("/invites/0/email").asText()).isEqualTo(inviteeEmail);

        String auditMetadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.invite.created' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, inviteId);
        assertThat(auditMetadata).contains("\"email_bound\": true")
                .doesNotContain(inviteeEmail).doesNotContain(token);

        // Public preview: no session, no secrets, no invited address.
        MvcResult preview = mockMvc.perform(get("/api/v1/workspace-invites/{token}", token))
                .andExpect(status().isOk()).andReturn();
        JsonNode previewJson = json(preview);
        CONTRACT.assertValid("WorkspaceInvitePreview", previewJson);
        assertThat(previewJson.get("workspace_name").asText()).isNotBlank();
        assertThat(previewJson.get("role").asText()).isEqualTo("MEMBER");
        assertThat(previewJson.get("email_bound").asBoolean()).isTrue();
        assertThat(preview.getResponse().getContentAsString())
                .doesNotContain(token).doesNotContain("token_hash")
                .doesNotContain(inviteeEmail);

        // Registered matching account accepts, then a repeat is idempotent.
        TestSession invitee = verifiedSession(inviteeEmail);
        MvcResult accepted = mockMvc.perform(authed(invitee,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("WorkspaceInviteAcceptance", json(accepted));
        assertThat(json(accepted).get("already_member").asBoolean()).isFalse();
        assertThat(json(accepted).get("role").asText()).isEqualTo("MEMBER");

        MvcResult repeated = mockMvc.perform(authed(invitee,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(repeated).get("already_member").asBoolean()).isTrue();
        assertThat(usedCount(inviteId)).isEqualTo(1);
        assertThat(memberships(workspace, invitee.userId())).isEqualTo(1L);

        // The single use is consumed: preview and a third account get the distinct 410.
        MvcResult consumedPreview = mockMvc.perform(
                        get("/api/v1/workspace-invites/{token}", token))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(consumedPreview).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EXHAUSTED");
    }

    @Test
    void mismatchedAccountIsForbiddenAndDoesNotConsumeTheInvite() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("mismatch-owner"));
        UUID workspace = createWorkspace(owner);
        TestSession invited = verifiedSession(uniqueEmail("mismatch-target"));
        TestSession other = verifiedSession(uniqueEmail("mismatch-other"));

        String token = createEmailInvite(owner, workspace, invited.email(), "MEMBER");
        UUID inviteId = inviteId(token);

        MvcResult mismatch = mockMvc.perform(authed(other,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(mismatch).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EMAIL_MISMATCH");
        assertThat(usedCount(inviteId)).isZero();
        assertThat(memberships(workspace, other.userId())).isZero();

        // Still valid and still consumable by the legitimate address.
        mockMvc.perform(get("/api/v1/workspace-invites/{token}", token))
                .andExpect(status().isOk());
        mockMvc.perform(authed(invited,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk());
        assertThat(usedCount(inviteId)).isEqualTo(1);
    }

    @Test
    void revokedExpiredAndUsedInvitesKeepTheirDistinctState() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("state-owner"));
        UUID workspace = createWorkspace(owner);
        TestSession invited = verifiedSession(uniqueEmail("state-target"));

        String revokedToken = createEmailInvite(owner, workspace,
                uniqueEmail("state-revoked"), "MEMBER");
        UUID revokedId = inviteId(revokedToken);
        mockMvc.perform(authed(owner, delete(
                        "/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        workspace, revokedId)))
                .andExpect(status().isNoContent());
        MvcResult revokedPreview = mockMvc.perform(
                        get("/api/v1/workspace-invites/{token}", revokedToken))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(revokedPreview).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_REVOKED");
        MvcResult revokedAccept = mockMvc.perform(authed(invited,
                        post("/api/v1/workspace-invites/{token}/accept", revokedToken)))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(revokedAccept).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_REVOKED");
        assertThat(usedCount(revokedId)).isZero();

        String expiredToken = createEmailInvite(owner, workspace,
                uniqueEmail("state-expired"), "GUEST");
        UUID expiredId = inviteId(expiredToken);
        migrator().update("UPDATE workspace.invites SET expires_at = now() - interval '1 minute'"
                + " WHERE id = ?", expiredId);
        MvcResult expiredPreview = mockMvc.perform(
                        get("/api/v1/workspace-invites/{token}", expiredToken))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(expiredPreview).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EXPIRED");
        MvcResult expiredAccept = mockMvc.perform(authed(invited,
                        post("/api/v1/workspace-invites/{token}/accept", expiredToken)))
                .andExpect(status().isGone()).andReturn();
        assertThat(json(expiredAccept).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_EXPIRED");
        assertThat(usedCount(expiredId)).isZero();

        // An unknown token is a 404 and does not disclose existence.
        MvcResult unknown = mockMvc.perform(
                        get("/api/v1/workspace-invites/{token}", "a".repeat(43)))
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(unknown));
        assertThat(json(unknown).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_NOT_FOUND");
    }

    @Test
    void plainLinkInvitesStayEmailLessAndMultiUse() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("link-owner"));
        UUID workspace = createWorkspace(owner);
        TestSession first = verifiedSession(uniqueEmail("link-first"));
        TestSession second = verifiedSession(uniqueEmail("link-second"));

        MvcResult created = createInvite(owner, workspace, Map.of("role", "MEMBER"))
                .andExpect(status().isCreated()).andReturn();
        String token = json(created).get("token").asText();
        UUID inviteId = UUID.fromString(json(created).at("/invite/id").asText());

        // No address is stored or mailed for a link invite.
        assertThat(json(created).at("/invite/email").isNull()).isTrue();
        assertThat(mail.outboundCount()).isZero();

        MvcResult preview = mockMvc.perform(get("/api/v1/workspace-invites/{token}", token))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(preview).get("email_bound").asBoolean()).isFalse();

        mockMvc.perform(authed(first,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk());
        mockMvc.perform(authed(second,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk());
        assertThat(usedCount(inviteId)).isEqualTo(2);
    }

    // --------------------------------------------------- authorization/bounds

    @Test
    void emailInviteCreationRequiresManageInvitesAndRespectsTheRoleCeiling()
            throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("perm-owner"));
        UUID workspace = createWorkspace(owner);
        TestSession admin = verifiedSession(uniqueEmail("perm-admin"));
        TestSession member = verifiedSession(uniqueEmail("perm-member"));
        TestSession outsider = verifiedSession(uniqueEmail("perm-outsider"));
        addMember(owner, workspace, admin.email(), "ADMIN");
        addMember(owner, workspace, member.email(), "MEMBER");

        createInvite(member, workspace, emailBody(uniqueEmail("perm-a"), "MEMBER"))
                .andExpect(status().isForbidden());
        createInvite(outsider, workspace, emailBody(uniqueEmail("perm-b"), "MEMBER"))
                .andExpect(status().isForbidden());

        createInvite(admin, workspace, emailBody(uniqueEmail("perm-c"), "ADMIN"))
                .andExpect(status().isForbidden());
        createInvite(admin, workspace, emailBody(uniqueEmail("perm-d"), "MEMBER"))
                .andExpect(status().isCreated());
        createInvite(owner, workspace, emailBody(uniqueEmail("perm-e"), "ADMIN"))
                .andExpect(status().isCreated());
        MvcResult ownerOwner = createInvite(owner, workspace,
                emailBody(uniqueEmail("perm-f"), "OWNER"))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(ownerOwner).get("code").asText())
                .isEqualTo("WORKSPACE_INVITE_ROLE_FORBIDDEN");

        // An email invite is strictly single-use.
        MvcResult multi = createInvite(owner, workspace,
                Map.of("email", uniqueEmail("perm-g"), "max_uses", 2))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(multi).get("code").asText()).isEqualTo("VALIDATION_FAILED");

        MvcResult invalid = createInvite(owner, workspace,
                Map.of("email", "not-an-email"))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json(invalid).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    @Test
    void repeatedEmailInvitesToTheSameAddressAreRateLimited() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("rate-owner"));
        UUID workspace = createWorkspace(owner);
        String recipient = uniqueEmail("rate-target");

        for (int attempt = 1; attempt <= 5; attempt++) {
            createInvite(owner, workspace, emailBody(recipient, "MEMBER"))
                    .andExpect(status().isCreated());
        }
        MvcResult limited = createInvite(owner, workspace, emailBody(recipient, "MEMBER"))
                .andExpect(status().isTooManyRequests()).andReturn();
        assertThat(json(limited).get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();
    }

    // ------------------------------------------------ registration auto-claim

    @Test
    void registrationClaimsTheInviteAfterEmailVerificationIdempotently() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("claim-owner"));
        UUID workspace = createWorkspace(owner);
        String invitedEmail = uniqueEmail("claim-new");

        String token = createEmailInvite(owner, workspace, invitedEmail, "GUEST");
        UUID inviteId = inviteId(token);

        TestSession claimed = verifiedSession(invitedEmail, token);
        assertThat(memberships(workspace, claimed.userId())).isEqualTo(1L);
        assertThat(membershipRole(workspace, claimed.userId())).isEqualTo("GUEST");
        assertThat(usedCount(inviteId)).isEqualTo(1);

        String auditMetadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'workspace.invite.accepted' AND target_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, workspace);
        assertThat(auditMetadata).contains("\"claim\": \"registration\"")
                .doesNotContain(token).doesNotContain(invitedEmail);

        // Re-accept is idempotent: one membership, one consumed use, no second audit row.
        mockMvc.perform(authed(claimed,
                        post("/api/v1/workspace-invites/{token}/accept", token)))
                .andExpect(status().isOk())
                .andExpect(result -> assertThat(json(result).get("already_member").asBoolean())
                        .isTrue());
        assertThat(memberships(workspace, claimed.userId())).isEqualTo(1L);
        assertThat(usedCount(inviteId)).isEqualTo(1);
        assertThat(auditAccepted(workspace)).isEqualTo(1L);
    }

    @Test
    void failedClaimLeavesRegistrationAndTheInviteUntouched() throws Exception {
        TestSession owner = verifiedSession(uniqueEmail("fail-owner"));
        UUID workspace = createWorkspace(owner);

        // Revoked between creation and registration: verification still succeeds, no
        // membership is created and the invite row keeps its revoked state.
        String revokedEmail = uniqueEmail("fail-revoked");
        String revokedToken = createEmailInvite(owner, workspace, revokedEmail, "MEMBER");
        UUID revokedId = inviteId(revokedToken);
        mockMvc.perform(authed(owner, delete(
                        "/api/v1/workspaces/{workspaceId}/invites/{inviteId}",
                        workspace, revokedId)))
                .andExpect(status().isNoContent());

        TestSession revoked = verifiedSession(revokedEmail, revokedToken);
        assertThat(memberships(workspace, revoked.userId())).isZero();
        assertThat(usedCount(revokedId)).isZero();
        assertThat(migrator().queryForObject(
                "SELECT revoked_at IS NOT NULL FROM workspace.invites WHERE id = ?",
                Boolean.class, revokedId)).isTrue();

        // Expired token: same behaviour; the invite remains for inspection/manual share.
        String expiredEmail = uniqueEmail("fail-expired");
        String expiredToken = createEmailInvite(owner, workspace, expiredEmail, "MEMBER");
        UUID expiredId = inviteId(expiredToken);
        migrator().update("UPDATE workspace.invites SET expires_at = now() - interval '1 minute'"
                + " WHERE id = ?", expiredId);
        TestSession expired = verifiedSession(expiredEmail, expiredToken);
        assertThat(memberships(workspace, expired.userId())).isZero();
        assertThat(usedCount(expiredId)).isZero();

        // A malformed token is ignored exactly like an absent one: the registration
        // response stays 202/200, so nothing is enumerated.
        TestSession invalid = verifiedSession(uniqueEmail("fail-invalid"), "not-a-real-token");
        assertThat(memberships(workspace, invalid.userId())).isZero();
    }

    // ---------------------------------------------------------------- helpers

    private TestSession verifiedSession(String email) throws Exception {
        return verifiedSession(email, null);
    }

    private TestSession verifiedSession(String email, String inviteToken) throws Exception {
        Map<String, Object> registerBody = new LinkedHashMap<>();
        registerBody.put("email", email);
        registerBody.put("display_name", "IT user");
        registerBody.put("password", PASSWORD);
        if (inviteToken != null) {
            registerBody.put("invite_token", inviteToken);
        }
        MvcResult register = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(registerBody)))
                .andExpect(status().isAccepted()).andReturn();
        UUID verificationId = UUID.fromString(
                json(register).get("verification_id").asText());
        String code = mail.lastFor(email).code();
        MvcResult verify = mockMvc.perform(post("/api/v1/auth/verify-email")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "verification_id", verificationId.toString(),
                                "code", code))))
                .andExpect(status().isOk()).andReturn();
        AuthSessionResponse session = objectMapper.readValue(
                verify.getResponse().getContentAsString(), AuthSessionResponse.class);
        UUID deviceId = registerDevice(session.accessToken());
        return new TestSession(session.accessToken(), deviceId, session.user().id(), email);
    }

    private UUID registerDevice(String accessToken) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/devices")
                        .header("Authorization", "Bearer " + accessToken)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "IT device",
                                "platform", "WEB",
                                "app_version", "1.0"))))
                .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private UUID createWorkspace(TestSession owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(owner, post("/api/v1/workspaces"))
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", uniqueDisplayName("IT workspace"),
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void addMember(TestSession owner, UUID workspace, String email, String role)
            throws Exception {
        mockMvc.perform(authed(owner,
                        post("/api/v1/workspaces/{workspaceId}/members", workspace))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "role", role))))
                .andExpect(status().isCreated());
    }

    private ResultActions createInvite(TestSession actor, UUID workspace,
                                       Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(actor,
                        post("/api/v1/workspaces/{workspaceId}/invites", workspace))
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private String createEmailInvite(TestSession actor, UUID workspace, String email,
                                     String role) throws Exception {
        MvcResult result = createInvite(actor, workspace, emailBody(email, role))
                .andExpect(status().isCreated()).andReturn();
        return json(result).get("token").asText();
    }

    private static Map<String, Object> emailBody(String email, String role) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("role", role);
        return body;
    }

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder authed(
            TestSession session,
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder builder) {
        return builder
                .header("Authorization", "Bearer " + session.accessToken())
                .header("X-Device-Id", session.deviceId().toString());
    }

    private UUID inviteId(String token) {
        return migrator().queryForObject(
                "SELECT id FROM workspace.invites WHERE token_hash = ?", UUID.class,
                ru.krug.backend.workspace.domain.service.WorkspaceInviteTokens.hash(token));
    }

    private int usedCount(UUID inviteId) {
        Integer used = migrator().queryForObject(
                "SELECT used_count FROM workspace.invites WHERE id = ?", Integer.class,
                inviteId);
        return used == null ? -1 : used;
    }

    private long memberships(UUID workspaceId, UUID userId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, Long.class, workspaceId, userId);
        return count == null ? 0 : count;
    }

    private String membershipRole(UUID workspaceId, UUID userId) {
        return migrator().queryForObject("""
                SELECT role FROM workspace.memberships
                 WHERE workspace_id = ? AND user_id = ?
                """, String.class, workspaceId, userId);
    }

    private long auditAccepted(UUID workspaceId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'workspace.invite.accepted' AND target_id = ?
                """, Long.class, workspaceId);
        return count == null ? 0 : count;
    }

    private static String uniqueEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 12) + "@krug.test";
    }

    private record TestSession(String accessToken, UUID deviceId, UUID userId, String email) {
    }
}

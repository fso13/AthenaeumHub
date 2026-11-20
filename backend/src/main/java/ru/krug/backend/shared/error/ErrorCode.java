package ru.krug.backend.shared.error;

/**
 * Error codes from SYSTEM-ANALYSIS §7.1. Shared language between all layers.
 */
public final class ErrorCode {

    public static final String VALIDATION_FAILED = "VALIDATION_FAILED";
    public static final String UNAUTHENTICATED = "UNAUTHENTICATED";
    public static final String TOKEN_EXPIRED = "TOKEN_EXPIRED";
    public static final String FORBIDDEN = "FORBIDDEN";
    public static final String NOT_FOUND = "NOT_FOUND";
    public static final String CONFLICT = "CONFLICT";
    public static final String IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED";
    public static final String IDEMPOTENCY_IN_PROGRESS = "IDEMPOTENCY_IN_PROGRESS";
    public static final String CLIENT_MESSAGE_ID_CONFLICT = "CLIENT_MESSAGE_ID_CONFLICT";
    public static final String MESSAGE_TOO_LONG = "MESSAGE_TOO_LONG";
    public static final String SEQ_OUT_OF_RANGE = "SEQ_OUT_OF_RANGE";
    public static final String DEVICE_LIMIT_REACHED = "DEVICE_LIMIT_REACHED";
    public static final String RATE_LIMITED = "RATE_LIMITED";
    public static final String INTERNAL = "INTERNAL";

    // Realtime (E3). The WS transport maps these to close codes 4401/4403/1008.
    public static final String WS_TICKET_INVALID = "WS_TICKET_INVALID";
    public static final String WS_DEVICE_MISMATCH = "WS_DEVICE_MISMATCH";
    public static final String WS_SESSION_REVOKED = "WS_SESSION_REVOKED";
    public static final String SUBSCRIPTION_LIMIT = "SUBSCRIPTION_LIMIT";
    public static final String WS_FRAME_INVALID = "WS_FRAME_INVALID";

    // Call signalling (E13: DIRECT and GROUP mesh). Ephemeral only; no call records.
    public static final String CALL_NOT_SUPPORTED = "CALL_NOT_SUPPORTED";
    public static final String CALL_PAYLOAD_TOO_LARGE = "CALL_PAYLOAD_TOO_LARGE";

    // Files (E4-B). Codes follow SYSTEM-ANALYSIS §7.1/§12.2.
    public static final String FILE_TOO_LARGE = "FILE_TOO_LARGE";
    public static final String QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
    public static final String TOO_MANY_FILES = "TOO_MANY_FILES";
    public static final String UNSUPPORTED_TYPE = "UNSUPPORTED_TYPE";
    public static final String DANGEROUS_TYPE_BLOCKED = "DANGEROUS_TYPE_BLOCKED";
    public static final String UPLOAD_EXPIRED = "UPLOAD_EXPIRED";
    public static final String UPLOAD_NOT_FOUND = "NOT_FOUND";
    public static final String UPLOAD_STATE_CONFLICT = "CONFLICT";
    public static final String UPLOAD_LOCKED = "UPLOAD_LOCKED";
    public static final String CHUNK_CONFLICT = "CHUNK_CONFLICT";
    public static final String CHUNK_HASH_MISMATCH = "CHUNK_HASH_MISMATCH";
    public static final String CHUNK_SIZE_MISMATCH = "CHUNK_SIZE_MISMATCH";
    public static final String PART_OUT_OF_RANGE = "PART_OUT_OF_RANGE";
    public static final String INCOMPLETE_UPLOAD = "INCOMPLETE_UPLOAD";
    public static final String FILE_HASH_MISMATCH = "FILE_HASH_MISMATCH";
    public static final String MODE_NOT_SUPPORTED = "MODE_NOT_SUPPORTED";
    public static final String ATTACHMENT_NOT_READY = "ATTACHMENT_NOT_READY";
    public static final String ATTACHMENT_QUARANTINED = "ATTACHMENT_QUARANTINED";
    public static final String ATTACHMENT_DELETED = "ATTACHMENT_DELETED";
    public static final String MALWARE_DETECTED = "MALWARE_DETECTED";

    // E2EE (E7-B1 / E2EE-SPEC §4.8). No server crypto beyond public Ed25519 verification.
    public static final String INVALID_KEY_FORMAT = "INVALID_KEY_FORMAT";
    public static final String INVALID_SPK_SIGNATURE = "INVALID_SPK_SIGNATURE";
    public static final String INVALID_PREKEY = "INVALID_PREKEY";
    public static final String PREKEY_ID_CONFLICT = "PREKEY_ID_CONFLICT";
    public static final String PREKEY_LIMIT_EXCEEDED = "PREKEY_LIMIT_EXCEEDED";
    public static final String NO_PREKEYS = "NO_PREKEYS";
    public static final String UNKNOWN_DEVICE = "UNKNOWN_DEVICE";
    public static final String KEY_GENERATION_MISMATCH = "KEY_GENERATION_MISMATCH";
    public static final String ENVELOPES_REQUIRED = "ENVELOPES_REQUIRED";
    public static final String ENVELOPES_NOT_ALLOWED = "ENVELOPES_NOT_ALLOWED";
    public static final String E2EE_PLAINTEXT_FORBIDDEN = "E2EE_PLAINTEXT_FORBIDDEN";
    public static final String TOO_MANY_ENVELOPES = "TOO_MANY_ENVELOPES";
    public static final String DUPLICATE_ENVELOPE = "DUPLICATE_ENVELOPE";
    public static final String INVALID_ENVELOPE_FORMAT = "INVALID_ENVELOPE_FORMAT";
    public static final String UNSUPPORTED_ENVELOPE_VERSION = "UNSUPPORTED_ENVELOPE_VERSION";
    public static final String ENVELOPE_TOO_LARGE = "ENVELOPE_TOO_LARGE";
    public static final String PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE";
    public static final String E2EE_NO_ACTIVE_DEVICES = "E2EE_NO_ACTIVE_DEVICES";
    public static final String E2EE_NO_PEER_ENVELOPE = "E2EE_NO_PEER_ENVELOPE";
    public static final String E2EE_DISABLED = "E2EE_DISABLED";
    public static final String MODE_CHANGE_FORBIDDEN = "MODE_CHANGE_FORBIDDEN";
    public static final String IDENTITY_KEY_CONFLICT = "IDENTITY_KEY_CONFLICT";
    public static final String INVALID_IDENTITY_BINDING = "INVALID_IDENTITY_BINDING";
    public static final String NO_KEYS = "NO_KEYS";
    public static final String E2EE_LEGACY_DEVICE = "E2EE_LEGACY_DEVICE";
    public static final String VH_VERSION_UNSUPPORTED = "VH_VERSION_UNSUPPORTED";
    public static final String E2EE_GROUP_NOT_SUPPORTED = "E2EE_GROUP_NOT_SUPPORTED";
    public static final String KEY_CHANGED = "KEY_CHANGED";
    public static final String DEVICE_REVOKED = "DEVICE_REVOKED";
    public static final String INVALID_SAFETY_NUMBER_HASH = "INVALID_SAFETY_NUMBER_HASH";
    public static final String TOO_MANY_DEVICES = "TOO_MANY_DEVICES";

    // Stickers (E5-B). Codes follow docs/TASKS-E5.md and SYSTEM-ANALYSIS §7.1/§12.7.
    public static final String STICKER_NOT_FOUND = "STICKER_NOT_FOUND";
    public static final String STICKER_PACK_DISABLED = "STICKER_PACK_DISABLED";
    public static final String INVALID_STICKER_MESSAGE = "INVALID_STICKER_MESSAGE";

    // Auth BFF (docs/TASKS-AUTH-BFF.md §1). The browser never talks to Keycloak.
    public static final String INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
    public static final String EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";
    public static final String ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED";
    public static final String CODE_INVALID = "CODE_INVALID";
    public static final String CODE_EXPIRED = "CODE_EXPIRED";
    public static final String EMAIL_TAKEN = "EMAIL_TAKEN";
    public static final String REGISTRATION_CLOSED = "REGISTRATION_CLOSED";
    public static final String AUTH_UNAVAILABLE = "AUTH_UNAVAILABLE";

    // E8-B: first-run setup, platform admin and installation chat limits (R-01…R-04).
    public static final String SETUP_ALREADY_COMPLETED = "SETUP_ALREADY_COMPLETED";
    public static final String CHAT_LIMIT_REACHED = "CHAT_LIMIT_REACHED";
    public static final String SMTP_UNAVAILABLE = "SMTP_UNAVAILABLE";

    // E11-B: platform-admin actions and audit view (R-08, FR-ADM-15…FR-ADM-18).
    public static final String SELF_ACTION_FORBIDDEN = "SELF_ACTION_FORBIDDEN";
    public static final String USER_ALREADY_SUSPENDED = "USER_ALREADY_SUSPENDED";
    public static final String USER_ALREADY_ACTIVE = "USER_ALREADY_ACTIVE";
    public static final String LAST_PLATFORM_ADMIN = "LAST_PLATFORM_ADMIN";
    public static final String CHAT_ALREADY_DELETED = "CHAT_ALREADY_DELETED";

    // E12-B: workspace member management (R-09, FR-WS-4…FR-WS-7).
    public static final String USER_NOT_FOUND = "USER_NOT_FOUND";
    public static final String MEMBER_NOT_FOUND = "MEMBER_NOT_FOUND";
    public static final String MEMBER_ALREADY_EXISTS = "MEMBER_ALREADY_EXISTS";
    public static final String WORKSPACE_MEMBER_LIMIT_REACHED =
            "WORKSPACE_MEMBER_LIMIT_REACHED";
    public static final String ROLE_CHANGE_FORBIDDEN = "ROLE_CHANGE_FORBIDDEN";
    public static final String LAST_OWNER = "LAST_OWNER";

    // D1-BE1: flat threads (docs/TASKS-DASHBOARD-V1.md §3.2). Managed-only, depth 1.
    public static final String THREAD_ROOT_NOT_FOUND = "THREAD_ROOT_NOT_FOUND";
    public static final String THREAD_ROOT_DELETED = "THREAD_ROOT_DELETED";
    public static final String THREAD_NESTING_UNSUPPORTED = "THREAD_NESTING_UNSUPPORTED";
    public static final String THREADS_E2EE_UNSUPPORTED = "THREADS_E2EE_UNSUPPORTED";

    // D1-BE2: managed attachment media metadata. Client supplied values are sanitized and
    // bounded; the server never parses media bytes in this slice (D1.1).
    public static final String MEDIA_METADATA_INVALID = "MEDIA_METADATA_INVALID";

    // D1-BE3: chat settings PATCH. E2EE exposes only a name label, not a description.
    public static final String CHAT_SETTINGS_E2EE_UNSUPPORTED = "CHAT_SETTINGS_E2EE_UNSUPPORTED";

    // D1 message actions (#61-#63): reactions, edit and delete.
    // E2EE messages carry no server-visible metadata: reactions and edits are forbidden
    // rather than silently stored as plaintext. Delete remains a content-free tombstone.
    public static final String E2EE_METADATA_FORBIDDEN = "E2EE_METADATA_FORBIDDEN";
    public static final String MESSAGE_NOT_EDITABLE = "MESSAGE_NOT_EDITABLE";
    public static final String VERSION_CONFLICT = "VERSION_CONFLICT";

    // D1.1 (#69): built-in plugin catalog and per-chat toggles. No execution or marketplace;
    // E2EE chats cannot enable a server-side (MANAGED-only) plugin.
    public static final String PLUGIN_NOT_FOUND = "PLUGIN_NOT_FOUND";
    public static final String PLUGIN_NOT_AVAILABLE = "PLUGIN_NOT_AVAILABLE";
    public static final String PLUGIN_DISABLED = "PLUGIN_DISABLED";

    // D1.1 (#76): plugin actions. Every action re-checks the per-chat toggle; E2EE stays
    // managed-only. Translation has no provider by default (503) and never logs content.
    public static final String PLUGIN_NOT_ENABLED = "PLUGIN_NOT_ENABLED";
    public static final String POLL_CLOSED = "POLL_CLOSED";
    public static final String POLL_OPTION_INVALID = "POLL_OPTION_INVALID";
    public static final String POLL_STATE_INVALID = "POLL_STATE_INVALID";
    public static final String TASK_ASSIGNEE_INVALID = "TASK_ASSIGNEE_INVALID";
    public static final String MESSAGE_NOT_TRANSLATABLE = "MESSAGE_NOT_TRANSLATABLE";
    public static final String TRANSLATION_UNAVAILABLE = "TRANSLATION_UNAVAILABLE";

    // P0-2 (#80): channel settings — cover, read-only, join policy, rights, archive, pins.
    public static final String CHAT_READ_ONLY = "CHAT_READ_ONLY";
    public static final String CHAT_PERMISSION_DENIED = "CHAT_PERMISSION_DENIED";
    public static final String CHAT_COVER_INVALID = "CHAT_COVER_INVALID";
    public static final String CHAT_JOIN_CLOSED = "CHAT_JOIN_CLOSED";
    public static final String CHAT_PIN_LIMIT = "CHAT_PIN_LIMIT";

    // P0-1 (#79): channel member management and invite links.
    public static final String CHAT_MEMBERSHIP_UNSUPPORTED = "CHAT_MEMBERSHIP_UNSUPPORTED";
    public static final String INVITE_NOT_FOUND = "INVITE_NOT_FOUND";
    public static final String INVITE_REVOKED = "INVITE_REVOKED";
    public static final String INVITE_EXPIRED = "INVITE_EXPIRED";
    public static final String INVITE_EXHAUSTED = "INVITE_EXHAUSTED";

    // P0-3 (#81): workspace DLP, audit/export and session management.
    public static final String DLP_E2EE_UNSUPPORTED = "DLP_E2EE_UNSUPPORTED";
    public static final String DLP_POLICY_LIMIT = "DLP_POLICY_LIMIT";
    public static final String DLP_POLICY_NAME_TAKEN = "DLP_POLICY_NAME_TAKEN";
    public static final String DLP_BLOCKED = "DLP_BLOCKED";

    // P0-4 (#82): avatar, TOTP authenticator, workspace settings/invites/permissions.
    public static final String AVATAR_INVALID = "AVATAR_INVALID";
    public static final String WORKSPACE_LOGO_INVALID = "WORKSPACE_LOGO_INVALID";
    public static final String TWO_FACTOR_ALREADY_ENABLED = "TWO_FACTOR_ALREADY_ENABLED";
    public static final String TWO_FACTOR_NOT_SETUP = "TWO_FACTOR_NOT_SETUP";
    public static final String TWO_FACTOR_NOT_ENABLED = "TWO_FACTOR_NOT_ENABLED";
    public static final String TWO_FACTOR_CODE_INVALID = "TWO_FACTOR_CODE_INVALID";
    public static final String TWO_FACTOR_RECOVERY_CODE_INVALID =
            "TWO_FACTOR_RECOVERY_CODE_INVALID";
    public static final String TWO_FACTOR_CHALLENGE_INVALID = "TWO_FACTOR_CHALLENGE_INVALID";
    public static final String TWO_FACTOR_CHALLENGE_EXPIRED = "TWO_FACTOR_CHALLENGE_EXPIRED";
    public static final String REAUTH_FAILED = "REAUTH_FAILED";
    public static final String WORKSPACE_INVITE_NOT_FOUND = "WORKSPACE_INVITE_NOT_FOUND";
    public static final String WORKSPACE_INVITE_REVOKED = "WORKSPACE_INVITE_REVOKED";
    public static final String WORKSPACE_INVITE_EXPIRED = "WORKSPACE_INVITE_EXPIRED";
    public static final String WORKSPACE_INVITE_EXHAUSTED = "WORKSPACE_INVITE_EXHAUSTED";
    public static final String WORKSPACE_INVITE_ROLE_FORBIDDEN =
            "WORKSPACE_INVITE_ROLE_FORBIDDEN";
    public static final String WORKSPACE_PERMISSION_DENIED = "WORKSPACE_PERMISSION_DENIED";
    public static final String OWNER_PERMISSIONS_IMMUTABLE = "OWNER_PERMISSIONS_IMMUTABLE";
    public static final String PERMISSION_CHANGE_FORBIDDEN = "PERMISSION_CHANGE_FORBIDDEN";

    private ErrorCode() {
    }
}

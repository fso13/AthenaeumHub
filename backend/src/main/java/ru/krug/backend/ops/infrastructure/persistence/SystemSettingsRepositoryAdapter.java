package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.SmtpSettings;
import ru.krug.backend.ops.domain.model.SystemSettings;
import ru.krug.backend.ops.domain.repository.SystemSettingsRepository;
import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/**
 * Native singleton persistence. Keeping the mapping explicit makes it impossible to leak
 * {@code smtp_password_ciphertext} through an entity getter/serializer.
 */
@Repository
public class SystemSettingsRepositoryAdapter implements SystemSettingsRepository {

    private static final String COLUMNS = """
            setup_completed_at, smtp_host, smtp_port, smtp_username,
            smtp_password_ciphertext, smtp_from, smtp_starttls,
            array_to_string(allowed_file_extensions, ',') AS allowed_file_extensions,
            max_chats_per_user, max_chats_per_workspace, max_workspace_members,
            registration_open, updated_at, updated_by
            """;

    private final EntityManager entityManager;

    public SystemSettingsRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public SystemSettings load() {
        List<?> rows = entityManager.createNativeQuery(
                        "SELECT " + COLUMNS + " FROM ops.system_settings WHERE id = 1")
                .getResultList();
        return rows.stream().findFirst().map(SystemSettingsRepositoryAdapter::toDomain)
                .orElseThrow(() -> new IllegalStateException(
                        "ops.system_settings singleton row is missing (V22 migration)"));
    }

    @Override
    public SystemSettings loadForUpdate() {
        List<?> rows = entityManager.createNativeQuery(
                        "SELECT " + COLUMNS + " FROM ops.system_settings WHERE id = 1 FOR UPDATE")
                .getResultList();
        return rows.stream().findFirst().map(SystemSettingsRepositoryAdapter::toDomain)
                .orElseThrow(() -> new IllegalStateException(
                        "ops.system_settings singleton row is missing (V22 migration)"));
    }

    @Override
    public void save(SystemSettings settings) {
        entityManager.createNativeQuery("""
                        UPDATE ops.system_settings
                           SET setup_completed_at = ?1,
                               smtp_host = ?2,
                               smtp_port = ?3,
                               smtp_username = ?4,
                               smtp_password_ciphertext = ?5,
                               smtp_from = ?6,
                               smtp_starttls = ?7,
                               allowed_file_extensions = string_to_array(?8, ','),
                               max_chats_per_user = ?9,
                               max_chats_per_workspace = ?10,
                               max_workspace_members = ?11,
                               registration_open = ?12,
                               updated_at = ?13,
                               updated_by = ?14
                         WHERE id = 1
                        """)
                .setParameter(1, settings.setupCompletedAt() == null ? null
                        : Timestamp.from(settings.setupCompletedAt()))
                .setParameter(2, blankToNull(settings.smtp().host()))
                .setParameter(3, settings.smtp().port())
                .setParameter(4, blankToNull(settings.smtp().username()))
                .setParameter(5, settings.smtp().passwordCiphertext())
                .setParameter(6, blankToNull(settings.smtp().from()))
                .setParameter(7, settings.smtp().starttls())
                .setParameter(8, String.join(",", settings.allowedFileExtensions().values()))
                .setParameter(9, settings.maxChatsPerUser())
                .setParameter(10, settings.maxChatsPerWorkspace())
                .setParameter(11, settings.maxWorkspaceMembers())
                .setParameter(12, settings.registrationOpen())
                .setParameter(13, Timestamp.from(settings.updatedAt()))
                .setParameter(14, settings.updatedBy())
                .executeUpdate();
    }

    private static SystemSettings toDomain(Object rowObject) {
        Object[] row = (Object[]) rowObject;
        SmtpSettings smtp = new SmtpSettings(
                (String) row[1],
                row[2] == null ? null : ((Number) row[2]).intValue(),
                (String) row[3],
                (byte[]) row[4],
                (String) row[5],
                Boolean.TRUE.equals(row[6]));
        return new SystemSettings(
                instant(row[0]),
                smtp,
                allowedFileExtensions((String) row[7]),
                ((Number) row[8]).intValue(),
                ((Number) row[9]).intValue(),
                ((Number) row[10]).intValue(),
                Boolean.TRUE.equals(row[11]),
                instant(row[12]),
                (UUID) row[13]);
    }

    private static AllowedFileExtensions allowedFileExtensions(String csv) {
        if (csv == null || csv.isBlank()) {
            return AllowedFileExtensions.defaults();
        }
        List<String> values = List.of(csv.split(",", -1));
        return AllowedFileExtensions.of(values);
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value.getClass());
    }

    private static String blankToNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return value.strip();
    }
}

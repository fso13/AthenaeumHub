package ru.krug.backend.workspace.api.dto;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * {@code PATCH /workspaces/{id}}. Every field is optional; presence is tracked separately
 * from value, so {@code "description": null} / {@code "logo_file_id": null} clears the
 * field while omitting it keeps the current value. The security mode is not representable.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UpdateWorkspaceRequest {

    private String name;
    private String description;
    private UUID logoFileId;

    @JsonIgnore
    private boolean namePresent;

    @JsonIgnore
    private boolean descriptionPresent;

    @JsonIgnore
    private boolean logoPresent;

    public UpdateWorkspaceRequest() {
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
        this.namePresent = true;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
        this.descriptionPresent = true;
    }

    public UUID getLogoFileId() {
        return logoFileId;
    }

    public void setLogoFileId(UUID logoFileId) {
        this.logoFileId = logoFileId;
        this.logoPresent = true;
    }

    @JsonIgnore
    public boolean isNamePresent() {
        return namePresent;
    }

    @JsonIgnore
    public boolean isDescriptionPresent() {
        return descriptionPresent;
    }

    @JsonIgnore
    public boolean isLogoPresent() {
        return logoPresent;
    }

    @JsonIgnore
    public boolean isEmpty() {
        return !namePresent && !descriptionPresent && !logoPresent;
    }
}

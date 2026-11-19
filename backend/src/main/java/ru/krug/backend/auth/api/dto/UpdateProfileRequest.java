package ru.krug.backend.auth.api.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import jakarta.validation.constraints.Size;

/**
 * {@code PATCH /me} body. Every field is optional; presence is tracked separately from
 * value, so {@code "bio": null} clears the bio while omitting {@code bio} leaves it
 * unchanged. Unknown properties (including {@code email}/{@code password}) are ignored and
 * can never reach the update service.
 *
 * <p>A class rather than a record is intentional: Jackson does not distinguish an absent
 * record component from an explicit JSON {@code null}, which is required here for the
 * clear-vs-unchanged semantics.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class UpdateProfileRequest {

    // Bounds mirror the domain value objects and V36 constraints; the API layer must not
    // depend on auth.domain (ArchUnit). The domain remains the final semantic validator.
    @Size(max = 80)
    private String displayName;

    @Size(max = 280)
    private String bio;

    @Size(max = 32)
    private String phone;

    @JsonIgnore
    private boolean displayNamePresent;

    @JsonIgnore
    private boolean bioPresent;

    @JsonIgnore
    private boolean phonePresent;

    public UpdateProfileRequest() {
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
        this.displayNamePresent = true;
    }

    public String getBio() {
        return bio;
    }

    public void setBio(String bio) {
        this.bio = bio;
        this.bioPresent = true;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
        this.phonePresent = true;
    }

    @JsonIgnore
    public boolean isDisplayNamePresent() {
        return displayNamePresent;
    }

    @JsonIgnore
    public boolean isBioPresent() {
        return bioPresent;
    }

    @JsonIgnore
    public boolean isPhonePresent() {
        return phonePresent;
    }

    @JsonIgnore
    public boolean isEmpty() {
        return !displayNamePresent && !bioPresent && !phonePresent;
    }
}

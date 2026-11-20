package ru.krug.backend.auth.domain.model;

/**
 * Raw outcome of {@code auth.set_user_block} (#79). Unknown strings fail closed as
 * {@code FORBIDDEN}.
 */
public record UserBlockMutation(Outcome outcome) {

    public enum Outcome {
        OK, UNCHANGED, SELF, USER_NOT_FOUND, FORBIDDEN
    }

    public static UserBlockMutation parse(String value) {
        if (value == null) {
            return new UserBlockMutation(Outcome.FORBIDDEN);
        }
        try {
            return new UserBlockMutation(Outcome.valueOf(value));
        } catch (IllegalArgumentException ex) {
            return new UserBlockMutation(Outcome.FORBIDDEN);
        }
    }
}

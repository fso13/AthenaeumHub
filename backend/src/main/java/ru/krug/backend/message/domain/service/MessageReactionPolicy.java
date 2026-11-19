package ru.krug.backend.message.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Plain-text emoji validation for reactions (#61).
 *
 * <p>The set is open (clients ship new emoji faster than a migration), so the policy does
 * not enumerate emoji. It bounds the size, rejects whitespace/control/HTML brackets and
 * requires at least one pictographic base code point. ZWJ, VS16, skin-tone modifiers and
 * keycap combiners are accepted as part of a sequence.
 */
public final class MessageReactionPolicy {

    /** Longest realistic ZWJ family/flags sequence; keeps the DB value well under 32 chars. */
    static final int MAX_CODE_POINTS = 8;

    private MessageReactionPolicy() {
    }

    public static void validate(String emoji) {
        if (emoji == null || emoji.isEmpty()) {
            throw invalid("emoji must not be empty");
        }
        int codePoints = emoji.codePointCount(0, emoji.length());
        if (codePoints > MAX_CODE_POINTS) {
            throw invalid("emoji is too long");
        }
        boolean hasBase = false;
        boolean keycap = false;
        for (int offset = 0; offset < emoji.length(); ) {
            int cp = emoji.codePointAt(offset);
            offset += Character.charCount(cp);
            if (cp == 0x200D || cp == 0xFE0F || cp == 0xFE0E
                    || cp == 0x20E3 || (cp >= 0x1F3FB && cp <= 0x1F3FF)) {
                keycap |= cp == 0x20E3;
                continue;
            }
            if (isEmojiBase(cp)) {
                hasBase = true;
                continue;
            }
            if (isAsciiKeycapBase(cp) && emoji.indexOf('\u20E3') >= 0) {
                continue;
            }
            throw invalid("emoji contains a disallowed character");
        }
        if (!hasBase && !keycap) {
            throw invalid("emoji must contain an emoji code point");
        }
    }

    /** Not an exhaustive Unicode property, but covers every emoji block a chat UI sends. */
    private static boolean isEmojiBase(int cp) {
        return (cp >= 0x1F000 && cp <= 0x1FAFF)
                || (cp >= 0x2600 && cp <= 0x27BF)
                || (cp >= 0x2B00 && cp <= 0x2BFF)
                || (cp >= 0x2190 && cp <= 0x21FF)
                || (cp >= 0x2300 && cp <= 0x23FF)
                || (cp >= 0x25A0 && cp <= 0x25FF)
                || cp == 0x00A9 || cp == 0x00AE || cp == 0x203C || cp == 0x2049
                || cp == 0x2122 || cp == 0x2139 || cp == 0x3030 || cp == 0x303D
                || cp == 0x3297 || cp == 0x3299;
    }

    private static boolean isAsciiKeycapBase(int cp) {
        return cp == '#' || cp == '*' || (cp >= '0' && cp <= '9');
    }

    private static DomainException invalid(String message) {
        return DomainException.unprocessable(ErrorCode.VALIDATION_FAILED, message,
                Map.of("field", "emoji"));
    }
}

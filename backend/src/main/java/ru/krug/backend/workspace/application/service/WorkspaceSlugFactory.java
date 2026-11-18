package ru.krug.backend.workspace.application.service;

import java.text.Normalizer;
import java.util.Locale;
import java.util.UUID;

import org.springframework.stereotype.Component;

/**
 * Creates a URL-safe slug from the workspace name. A short random suffix keeps slugs
 * unique without a retry loop; the slug is part of the contract's workspace summary.
 */
@Component
public class WorkspaceSlugFactory {

    public String create(String name) {
        String base = transliterate(name == null ? "" : name.toLowerCase(Locale.ROOT))
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-+|-+$)", "");
        if (base.isBlank()) {
            base = "workspace";
        }
        if (base.length() > 40) {
            base = base.substring(0, 40).replaceAll("-+$", "");
        }
        return base + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private static String transliterate(String value) {
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKD);
        StringBuilder out = new StringBuilder(normalized.length());
        for (char c : normalized.toCharArray()) {
            out.append(switch (c) {
                case 'а' -> "a";
                case 'б' -> "b";
                case 'в' -> "v";
                case 'г' -> "g";
                case 'д' -> "d";
                case 'е', 'ё' -> "e";
                case 'ж' -> "zh";
                case 'з' -> "z";
                case 'и' -> "i";
                case 'й' -> "y";
                case 'к' -> "k";
                case 'л' -> "l";
                case 'м' -> "m";
                case 'н' -> "n";
                case 'о' -> "o";
                case 'п' -> "p";
                case 'р' -> "r";
                case 'с' -> "s";
                case 'т' -> "t";
                case 'у' -> "u";
                case 'ф' -> "f";
                case 'х' -> "h";
                case 'ц' -> "ts";
                case 'ч' -> "ch";
                case 'ш' -> "sh";
                case 'щ' -> "sch";
                case 'ъ', 'ь' -> "";
                case 'ы' -> "y";
                case 'э' -> "e";
                case 'ю' -> "yu";
                case 'я' -> "ya";
                default -> Character.isLetterOrDigit(c) ? String.valueOf(c) : "-";
            });
        }
        return out.toString();
    }
}

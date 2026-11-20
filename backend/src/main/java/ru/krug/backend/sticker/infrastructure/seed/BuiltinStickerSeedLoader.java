package ru.krug.backend.sticker.infrastructure.seed;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Loads the built-in catalog through the migration-owned SECURITY DEFINER function.
 * V14 already seeds the two packs; this runner repairs an empty catalog (for example a
 * database restored from an older dump) and is idempotent, so rolling deployments are safe.
 */
@Component
public class BuiltinStickerSeedLoader implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BuiltinStickerSeedLoader.class);

    private final JdbcTemplate jdbc;

    public BuiltinStickerSeedLoader(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void run(ApplicationArguments args) {
        jdbc.execute("SELECT sticker.ensure_builtin_catalog()");
        Integer packs = jdbc.queryForObject("""
                SELECT count(*) FROM sticker.sticker_packs WHERE builtin
                """, Integer.class);
        Integer stickers = jdbc.queryForObject("""
                SELECT count(*) FROM sticker.stickers s
                  JOIN sticker.sticker_packs p ON p.id = s.pack_id
                 WHERE p.builtin
                """, Integer.class);
        if (packs == null || packs < 1 || stickers == null || stickers < 11) {
            throw new IllegalStateException("Built-in sticker catalog is incomplete: packs="
                    + packs + " stickers=" + stickers);
        }
        log.info("sticker.builtin_catalog_ready packs={} stickers={}", packs, stickers);
    }
}

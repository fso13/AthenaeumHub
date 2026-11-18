package ru.krug.backend.sticker.infrastructure.persistence;

import org.springframework.stereotype.Component;

import ru.krug.backend.sticker.domain.model.Sticker;
import ru.krug.backend.sticker.domain.model.StickerAsset;
import ru.krug.backend.sticker.domain.model.StickerFormat;
import ru.krug.backend.sticker.domain.model.StickerId;
import ru.krug.backend.sticker.domain.model.StickerStatus;

/** Explicit JPA -> domain mapping; domain never sees Hibernate types. */
@Component
public class StickerPersistenceMapper {

    public Sticker toDomain(StickerEntity entity) {
        StickerAsset asset = new StickerAsset(entity.getUrl(),
                StickerFormat.valueOf(entity.getFormat()), entity.getWidth(),
                entity.getHeight(), entity.getSizeBytes());
        return Sticker.create(StickerId.of(entity.getId()), entity.getPackId(),
                entity.getAlt(), asset, entity.getPosition(),
                StickerStatus.valueOf(entity.getStatus()));
    }
}

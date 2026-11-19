# E5 — Stickers slice (E5-B / E5-F)

> **Цель:** встроенные стикеры как медиа-сообщения: пикер, отправка, рендер, избранное; managed-чат.  
> **Контракт:** [`contracts/openapi.yaml`](<../contracts/openapi.yaml>) — `GET /sticker-packs`, favorites, `MessageCreate.type=STICKER`, `Message.sticker`.  
> **Анализ:** [`docs/SYSTEM-ANALYSIS.md`](<SYSTEM-ANALYSIS.md>) §5, §7, §9, §12.7–12.8, §15.

## 0. Правила

| Зона | Владелец | Можно менять | Нельзя менять |
|---|---|---|---|
| `backend/**` | E5-B | всё внутри | `frontend/**`, `docs/**`, `contracts/**` |
| `frontend/**` | E5-F | всё внутри | `backend/**`, `docs/**`, `contracts/**` |

- Контракт уже расширен PM; менять нельзя; расхождения — `[BLOCKED]`.
- E5 — **managed only**, встроенные наборы. Свои наборы/загрузка/модерация — v1, отдельный срез.
- Стикер — изображение PNG/WebP/APNG ≤512 КБ, 512×512; **SVG/HTML запрещены**. Для demo-наборов допустимы сгенерированные PNG-плейсхолдеры, не SVG.
- Ключевые порты: backend 8081, frontend 5173, Keycloak 8180, PostgreSQL 5432.

## 1. E5-B — backend: built-in sticker packs + sticker messages

**Владелец:** backend-сессия  
**Оценка:** 1–2 сессии  
**Статус:** **DONE** — 249 тестов, ArchUnit 10/10, seed 2×8, live 8081

### Scope

1. **DDD-контекст `ru.krug.backend.sticker`**
   - domain: `StickerPack`, `Sticker`, `StickerId`, `PackStatus`, `StickerAsset` (format/size/dimensions), exceptions.
   - application: `ListPacksUseCase`, `FavoriteStickerUseCase`, `StickerCatalogPort` (для message), `StickerAccessPort`.
   - infrastructure: JPA adapters, seed loader, asset URL resolver.
   - api: `GET /sticker-packs`, `PUT/DELETE /stickers/{id}/favorite`.
   - ArchUnit обновить.
2. **DB/schema (V14)**
   - `sticker_packs` (id, name, cover_url, status, builtin), `stickers` (id, pack_id, alt, url, format, width, height, size_bytes, position, status), `sticker_favorites` (user_id, sticker_id).
   - Seed 2 built-in packs × 8 stickers (demo PNG placeholders):
- pack `krug` / «Сова»: `/stickers/krug/01.png` … `/stickers/krug/08.png`, cover `/stickers/krug/cover.png`;
- pack `cats` / «Коты»: `/stickers/cats/01.png` … `/stickers/cats/08.png`, cover `/stickers/cats/cover.png`.

   - RLS не нужна для built-in (глобальные), favorites — по user_id; доступ к packs — через членство в чате (проверка `chat_id`).
3. **API**
   - `GET /sticker-packs?chat_id=` — только active packs; `favorite` для текущего пользователя; 403/404 для чужого чата.
   - `PUT /stickers/{id}/favorite` → 204; `DELETE` → 204; идемпотентно; 404 неизвестный/неактивный.
   - `POST /messages` `type=STICKER`, `sticker_id`: проверить active sticker/pack; ровно один стикер; text/attachments пусты; `Message.sticker` в response; realtime payload.
   - Ошибки: 404/410 `STICKER_NOT_FOUND`, 409 `STICKER_PACK_DISABLED`, 422 `INVALID_STICKER_MESSAGE`.
4. **Тесты**
   - list packs/favorites; foreign chat; message sticker; invalid/mixed payload; realtime payload; contract schema.
   - Full suite (230 baseline) + ArchUnit 10/10.
   - Live: picker data, send sticker, history, favorite, disabled pack (seed status fixture).
5. **README**: E5 endpoints, seed, assets, managed-only, custom packs v1.

### Вне scope

Свои наборы/загрузка/модерация, AV/DLP стикеров, E2EE pack keys, маркетплейс, анимация APNG (формат допускается, но demo — PNG).

## 2. E5-F — frontend: picker, send, render, favorites

**Владелец:** frontend-сессия  
**Оценка:** 1–2 сессии  
**Статус:** **DONE** — 166 Vitest, real sticker E2E 1/1, 18 PNG, contract 22/29

### Scope

1. **Picker**
   - Кнопка-стикер в composer; панель с табами наборов, поиск по alt, recent/favorites.
   - Данные из `GET /sticker-packs?chat_id`; локальный recent (IndexedDB/localStorage? — recent только в памяти/IndexedDB; не токены).
   - Закрытие по Esc/клику вне; клавиатурная навигация; aria.
2. **Send/render**
   - `POST /messages` `{type:STICKER, sticker_id, client_message_id}`; optimistic; response merge.
   - Стикер рендерится как изображение без пузыря, с alt; reply/reactions остаются.
   - Ошибки 404/409/410/422; pack disabled; сообщение не отправляется.
3. **Favorites**
   - `PUT/DELETE /stickers/{id}/favorite`; оптимистично; откат при ошибке; favorite в пикере.
4. **Assets**
   - Built-in PNG ассеты в `frontend/public/stickers/**` (2×8 demo) или fallback; никакого SVG; `alt` обязателен.
   - Cache; `prefers-reduced-motion` не влияет на статичные PNG.
5. **Тесты**
   - MSW packs/favorites; RTL picker/send/favorite/disabled; Playwright mock sticker send; axe.
   - Contract types regen (20 paths / 22 operations / 29 schemas); `npm run check`.

### Вне scope

Свои наборы, загрузка, модерация, E2EE, анимация, маркетплейс.

### E5: результат

| Проверка | Результат |
|---|---|
| Backend E5-B | 249 тестов, ArchUnit 10/10; seed 2×8; API вручную проверен |
| Frontend E5-F | 166 Vitest, contract 22/29, stickers:check 18 PNG, build |
| Real sticker E2E | **1 passed**: picker → favorite → send STICKER → reload/history → assets |
| Disabled pack | gated `E5_DISABLED_PACK=1` — passed (409, pack скрыт, история рендерится) |
| Assets | 18 PNG 512×512, без SVG |
| Realtime | STICKER payload в `message.created` |

Оговорки: recent только локально; custom packs/upload/moderation/APNG/E2EE pack keys — v1; admin disable — SQL fixture, публичного API нет.

## 3. Acceptance (E5-AC)

| ID | Сценарий | Ожидание |
|---|---|---|
| E5-AC-01 | Пикер | Наборы, alt, recent/favorites; клавиатура |
| E5-AC-02 | Отправка | STICKER message, optimistic → server; alt |
| E5-AC-03 | История | Стикер рендерится после reload |
| E5-AC-04 | Избранное | PUT/DELETE, откат при ошибке |
| E5-AC-05 | Disabled pack | 409, отправка заблокирована |
| E5-AC-06 | Чужой чат | 403/404 |
| E5-AC-07 | Контракт | 20 paths / 22 operations / 29 schemas; SVG не используется |

## 4. Решения

| ID | Решение | Причина |
|---|---|---|
| E5-D-01 | Built-in only | MVP; свои наборы — v1 |
| E5-D-02 | PNG demo assets | SVG запрещён; финальный арт позже |
| E5-D-03 | Favorites server-side | Кросс-девайс; recent локально |
| E5-D-04 | Sticker = отдельный тип message | Без пузыря, media semantics |

## 5. Известный долг

- Свои наборы/загрузка/модерация — v1.
- E2EE pack keys — после E2EE.
- Demo PNG вместо финального арта.
- Анимация APNG не проверяется в E5.

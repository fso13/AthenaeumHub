# #61–#63 — реакции, редактирование и удаление сообщений

Статус: **DONE** (managed-only UI + store + MSW + unit/e2e + axe).
Контракт: `contracts/openapi.yaml` — **51 path / 60 operations / 91 schema**
(`npm run contract:check`), сгенерированные типы синхронизированы.

## 1. API (`src/api/endpoints.ts`, `src/api/types.ts`)

| Метод                                              | Контракт                                              | Возврат           |
| -------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| `addReaction(chatId, messageId, emoji)`            | `POST /chats/{chatId}/messages/{messageId}/reactions` | `ReactionSummary` |
| `removeReaction(chatId, messageId, emoji)`         | `DELETE .../reactions/{emoji}`                        | `204`             |
| `editMessage(chatId, messageId, {text, version?})` | `PATCH /chats/{chatId}/messages/{messageId}`          | `Message`         |
| `deleteMessage(chatId, messageId, scope)`          | `DELETE ...?scope=me\|all`                            | `204`             |

`MessageEdit`, `ReactionSummary`, `MessageDeleteScope` выведены из
`src/api/schema.d.ts`; `schema.d.ts` перегенерирован из контракта
(`npm run api:types`). Emoji кодируется как path segment ровно один раз
(ZWJ/VS16/skin-tone безопасны).

## 2. Store (`src/store/chatStore.ts`)

- `ChatSlice.reactions` живут в `ApiMessage.reactions`; агрегат `{emoji,count,me}`
  приходит с сервера.
- `addReaction` / `removeReaction` / `toggleReaction`:
  - optimistic **только для своей** реакции (`me`), `count` ±1;
  - идемпотентный POST/DELETE; ответ POST заменяет агрегат, `Math.max` защищает
    от отката конкурентного WS-инкремента;
  - ошибка откатывает optimistic-строку и кладёт `actionError` для инлайн-алерта;
  - `pendingReactions` блокирует повторный клик.
- `editMessage`:
  - только свой managed `TEXT`, не удалённый; `text` после `trim()` 1..8000;
  - передаёт `version` (optimistic lock);
  - `409 VERSION_CONFLICT`: черновик не теряется, строка перечитывается
    (`refreshMessageFromServer`), диалог показывает конфликт и кнопку
    «Взять актуальный текст»;
  - `403/404/422` остаются в диалоге с переведённой ошибкой.
- `deleteMessage(scope)`:
  - `me` — только после `204`: строка удаляется локально, e2ee-view стирается;
  - `all` — **без оптимистичного удаления**: после `204`/WS ставится tombstone
    (`text=null`, `reactions=[]`, `attachments=[]`, `sticker`, `crypto` очищены),
    decrypted view удаляется;
  - `all` для не-автора блокируется локально (`403 FORBIDDEN`) и на сервере;
  - повторный вызов идемпотентен; 403 сервера показывает ошибку и не трогает текст.
- WS (`handleRealtimeEvent`):
  - `message.reaction.changed` — `count` сервера, `me` только для `user_id == viewer`,
    `count=0` убирает чип; E2EE-кадры игнорируются;
  - `message.updated` — flat `Message`/`payload.message`, обновляет `text`,
    `version`, `edited_at`, `reactions`; E2EE-кадры игнорируются;
  - `message.deleted` (`scope=all`) — tombstone + очистка decrypted view;
    `scope=me` не публикуется и не принимается.
- Защита: E2EE → `E2EE_METADATA_FORBIDDEN` до сети; `SYSTEM`/`STICKER` →
  `MESSAGE_NOT_EDITABLE`; системные сообщения не получают action bar.
  Store — источник истины для guard'ов, UI не является единственной защитой.

## 3. UI

- `src/components/MessageActions.tsx` — hover/focus action bar:
  emoji, edit, delete, reply, thread. Reply/thread сохранены один-в-один
  (thread-кнопка не дублирует `ThreadLink` при `reply_count > 0`).
- Фиксированный набор `COMMON_REACTIONS` (10 emoji) в picker'е; чипы под
  сообщением: `aria-pressed`, count, `me` (accent), клик — toggle.
- `«изменено»` с `title`/`aria-label` полного локального времени
  (`formatDateTime`, «Изменено 19.11.2026, 13:45»).
- Edit — модальный диалог: textarea 8000, счётчик, save/cancel, ошибка,
  `aria-invalid`/`role=alert`, focus trap, Escape, возврат фокуса на trigger,
  «Взять актуальный текст» при 409.
- Delete — popover-меню: «Удалить у себя» всегда; «Удалить у всех» только
  автору; для all — `alertdialog` с подтверждением и описанием необратимости.
- Мобильные (≤760 px и `hover:none`): видимая кнопка «Ещё действия»,
  раскрывающая тот же toolbar; desktop hover/focus не изменён. 390 px
  thread-flow сохранён.
- E2EE: reaction/edit кнопки видимы, но **disabled** с честной причиной
  («Реакции недоступны в E2EE-чате» / «Редактирование недоступно в E2EE-чате»);
  delete доступен (контрактный tombstone). STICKER: edit disabled
  («Можно редактировать только текстовые сообщения»).
- Стили добавлены в конец `src/styles/app.css`; flat feed и дизайн сохранены.

## 4. MSW (`src/mocks`)

- `POST/DELETE reactions`, `PATCH message`, `DELETE message?scope=` с
  контрактными кодами: `403 FORBIDDEN` (чужой all), `409 VERSION_CONFLICT`,
  `422 E2EE_METADATA_FORBIDDEN` / `MESSAGE_NOT_EDITABLE`, `404` для
  удалённых/скрытых.
- `hiddenMessageIds` в `ChatRecord` — delete-for-me скрывает строку только
  для вызывающего (GET/threads/reactions/edit → 404).
- Live fan-out: `publishMockMessageUpdated`, `publishMockMessageDeleted`,
  `publishMockReactionChanged`; delete-for-me не публикуется.
- Записываются `reactionRequests`, `editRequests`, `deleteRequests` и
  инъекции `forceReactionError` / `forceEditError` / `forceDeleteError`.
- Seed: 🎉 4 (me) на сообщении 37, ❤️ 2 на 31; стикер истории принадлежит
  viewer'у для проверки disabled-edit.

## 5. Тесты

- `src/components/MessageActions.test.tsx` — **16** тестов:
  - реакции: seed/count/me, picker toggle, live ADDED/REMOVED другого
    пользователя, rollback 403;
  - edit: success + `«изменено»` + version, 409 с сохранением черновика и
    перечитыванием строки, серверный 403, скрытие для чужого, disabled STICKER,
    пустой ввод не уходит в API;
  - delete: me (строка исчезает после `204`), all (подтверждение, отсутствие
    оптимистичного удаления, tombstone, очистка реакций), 403 сервера,
    локальный guard не-автора;
  - E2EE: disabled reaction/edit, ни одного metadata-запроса, игнор
    `message.reaction.changed`/`message.updated`, tombstone применяется;
  - keyboard: Enter/Escape + возврат фокуса; axe с picker и edit dialog.
- `e2e/d1-msg-actions.spec.ts` — 4 Playwright-теста: picker/toggle + axe,
  edit + маркер, delete me/all без optimistic-loss, 390 px visible actions
  button + no horizontal scroll.
- Полный `npm run check` — **915** unit-тестов (84 файла), contract 60 ops /
  91 schemas; ESLint 0 errors; Prettier clean; build OK.
- D1 e2e (`npm run test:e2e:d1`): **33 passed** (29 существующих + 4 новых).

## 6. Ограничения / осознанные решения

- Picker — фиксированный набор; произвольный emoji-input не добавлен
  (контракт допускает 1..32 code points, store/API это валидируют).
- Long-press не используется: на touch видимая кнопка «Ещё действия».
- Delete-for-me синхронизируется между устройствами только через REST
  (WS `scope=me` контрактом не публикуется).
- E2EE-редактирование/реакции не реализуются клиентом и не обходятся:
  сервер отвечает `422`, UI честно disabled.
- Тексты ошибок — `describeError` (`VERSION_CONFLICT`, `MESSAGE_NOT_EDITABLE`,
  `E2EE_METADATA_FORBIDDEN`); plaintext не логируется, не попадает в
  title/aria и в E2EE-рендер.

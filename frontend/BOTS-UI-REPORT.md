# #96 — Bots UI (frontend)

> Зона: `frontend/**`. Контракт и backend не редактировались. `contracts/openapi.yaml`
> и `frontend/src/api/schema.d.ts` уже содержали additive #96-поля от backend-среза;
> эта работа потребляла их как источник истины.

## Статус

**DONE в границах frontend-среза #96** (bots MVP, `chat.write` only).

Реализованы все 9 операций контракта, workspace- и chat-настройки ботов, BOT-идентичность
в ленте, MSW-моки и тесты. Явно **не** реализовывались и не должны были: подписки на
события/webhooks, slash-команды, чтение истории ботом, `chat.read`, файлы, звонки,
загрузка/раздача аватара бота, DLP/audit bot-сообщений и переключатель `enabled=false`
установки (в API его нет).

## 1. Workspace Bots UI

`Настройки → Боты` (`SettingsPage`, вкладка `bots`) → `WorkspaceBotsCard`.

- Список ботов пространства: имя, `ACTIVE/DISABLED`, `chat.write`, дата создания и
  `token_rotated_at`. Список доступен любому ACTIVE-участнику (как `GET /workspaces/{id}/bots`).
- OWNER/ADMIN:
  - создание бота (`name` 1..80 + фиксированный scope `chat.write`);
  - «Сменить токен» — подтверждение → новый одноразовый токен; старый сразу невалиден;
  - «Отключить» / «Включить» — `PATCH status`;
  - «Удалить бота» — `DELETE` (семантика контракта: soft-disable, строка остаётся в
    списке со статусом `DISABLED`; UI перечитывает список, а не подставляет статус локально);
  - ошибки 400/403/404/422/429/503 и сеть имеют отдельные honest-сообщения.
- MEMBER/GUEST видят список и read-only-пояснение; management-кнопки не рендерятся.

Одноразовый токен показывается в `BotTokenDialog`: значение, кнопка копирования, curl-сниппет
с этим токеном и предупреждение «скопируйте сейчас». Токен существует только в памяти
`BotsStore`; закрытие окна/вкладки, смена пространства, logout и `reset()` его очищают.
Повторно показать токен нельзя — только ротация.

## 2. Chat settings → Боты

`ChatSettingsDialog` → вкладка `bots` (только GROUP; у DIRECT вкладки нет) → `ChatBotsPanel`.

- `GET /chats/{id}/bots` — установленные боты, статус (`Активен`/`Отключён`/`Неактивен`),
  дата установки, scope.
- Установка: picker только ACTIVE-ботов пространства, ещё не установленных; `POST` идемпотентен.
- Удаление из чата: подтверждение → `DELETE`; история сообщений сохраняется.
- OWNER/ADMIN канала — install/uninstall. Прочие роли видят список и read-only-пояснение.
- E2EE-канал: picker и действия скрыты, показано `422 BOT_E2EE_UNSUPPORTED`-объяснение.
- Отключённый бот остаётся видимым с честной пометкой «не может отправлять сообщения»
  (эффективный статус = `install.enabled && bot.status === 'ACTIVE'`).
- Ошибки маппятся по кодам `BOT_*` и HTTP-статусам; picker остаётся доступным для retry.

## 3. BOT-идентичность в ленте

`MessageRow` / `MessageActions`:

- бейдж `БОТ` рисуется **только** по `sender_type === 'BOT'`, не по имени. Пользователь,
  названный именем бота, бейдж не получает; бот с именем пользователя остаётся ботом.
- `sender_id=null` у бота → `mine` принудительно `false` (локальный backstop к серверному
  CHECK), «Вы» не показывается.
- аватар бота использует `bot_id` как seed (отдельного serve API аватара в MVP нет).
- редактирование и удаление (включая delete-for-me) для bot-сообщений не рендерятся;
  реакции, ответы, закрепление и переход в тред остаются.
- текст цитаты/ответа берётся из `sender_display_name` (snapshot), impersonation невозможна.

## 4. API-слой

`src/api/types.ts`:

- `Bot`, `BotStatus`, `BotScope`, `BotList`, `BotCreateRequest`, `BotToken`, `BotUpdateRequest`,
  `ChatBot`, `ChatBotList`, `ChatBotInstallRequest`, `MessageSenderType`.
- `BotUpdateRequest` локально `Omit<..., 'clear_avatar'> & { clear_avatar?: boolean }`:
  в сгенерированной схеме `default: false` делает поле required, хотя контракт разрешает
  отсутствие (та же ситуация, что `MessageCreateBody.mention_all`).

`src/api/endpoints.ts` (`ChatApi` + real implementation):

`listBots`, `createBot`, `updateBot`, `disableBot`, `rotateBotToken`, `listChatBots`,
`installChatBot`, `uninstallChatBot`. Все management-вызовы идут через `withReauth`;
`BotToken` возвращается как есть, без кэша/записи. Send-эндпоинт сознательно **не**
вызывается UI — он документирован и покрыт MSW/тестом.

## 5. Store

`src/bots/botsStore.ts`, подключён как `ChatStore.bots` (`useBotsStore`/`useBotsState`).

- Раздельные generation-счётчики для workspace- и chat-чтений: вкладка ботов грузит
  picker пространства и установленный список параллельно, один ответ не инвалидирует другой.
- Мутации обновляют строки только ответом сервера (`Bot`/`ChatBot`); `204` soft-disable
  вызывает повторное чтение.
- `reset()` вызывается из `ChatStore.reset()`/`activateWorkspace()` — токен и строки
  не переживают logout/смену пространства. `clearChatBots()` — при закрытии настроек чата.
- Токен не импортирует storage-модули и нигде не логируется.

## 6. MSW

`src/mocks/handlers.ts` покрывает все 9 операций:

| Операция                           | Проверки мока                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET/POST /workspaces/{id}/bots`   | роль OWNER/ADMIN для create, валидация name/scopes, ответ без токена                                          |
| `PATCH/DELETE .../bots/{botId}`    | 404, update полей, идемпотентный disable                                                                      |
| `POST .../bots/{botId}/token`      | ротация токена, `token_rotated_at`, старый токен → 401                                                        |
| `GET/POST/DELETE /chats/{id}/bots` | chat OWNER/ADMIN, идемпотентность, `422 BOT_DISABLED`, `422 BOT_E2EE_UNSUPPORTED`                             |
| `POST /bots/{botId}/messages`      | bot token, `Idempotency-Key`, installed+enabled, MANAGED, `sender_type=BOT`/`bot_id`/`sender_id=null`, replay |

Mock хранит credential только в серверной mock-записи; каждый ответ, кроме одноразового
`BotToken`, вырезает `token` (`botView`). Добавлены фикстуры `buildMockBots()` и
`insertMockBotMessage()`; `resetMockDb` очищает ботов, установки, idempotency и инъекции ошибок.

## 7. Тесты

| Файл                                     | Тестов | Покрытие                                                                                                                               |
| ---------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bots/botsStore.test.ts`             |      4 | token в памяти/clearToken/reset, параллельные чтения, soft-disable re-read, uninstall                                                  |
| `src/components/WorkspaceBots.test.tsx`  |      6 | create → token once → close чистит, copy token/curl, rotate + старый 401/новый 201 + BOT-ответ, MEMBER read-only, валидация + 403, axe |
| `src/components/ChatBots.test.tsx`       |      5 | install/uninstall, MEMBER read-only, E2EE, 422 BOT_DISABLED, axe                                                                       |
| `src/components/MessageRow.bot.test.tsx` |      3 | бейдж по `sender_type`, нет edit/delete, реакции/ответы, «человек с именем бота» без бейджа, send API → бейдж                          |
| **Итого в срезе**                        | **18** |                                                                                                                                        |

Дополнительно обновлены существующие фикстуры/тесты, которые конструировали `Message`
вручную: backend регенерировал `schema.d.ts`, и `sender_type` стал required
(`mocks/db.ts`, `mocks/fixtures.ts`, `mocks/handlers.ts`, `MediaMessages.test.tsx`,
`MediaPreview.test.tsx`, `domain/messages.test.ts`, `plugins/messageCards.test.ts`,
`AudioArtwork97.test.tsx`).

## 8. Проверки

Полный `npm run check` — **успешно**:

- `eslint .` — 0 errors (1 pre-existing warning в `e2ee/app/chatBridgeSupport.test.ts`);
- `prettier --check .` — чисто;
- `contract:check` — **155 operations / 204 schemas**, generated types in sync;
- `stickers:check`, `security:check` (412 files), `session-writers:check` (275 files) — passed;
- `vitest run` — **1313 passed (130 files)**, EXIT 0; из них 18 новых тестов этого среза
  (baseline на старте работы — 1285 passed);
- `tsc --noEmit && vite build` — успешно.

Контрольный повторный прогон выполнялся при `load average ≈ 54` (параллельные срезы в общем
рабочем дереве) и дал 2 таймаута по 15 s в несвязанных с ботами suite
(`FilesChat`, axe-тест `PluginActions`). Изолированный прогон этих файлов — **21/21 passed**;
к bot-срезу падения отношения не имеют.

Требование «1285+» выполнено с запасом. Axe (serious/critical) — 0 в обоих новых модальных
сценариях.

## 9. Доступность и mobile

- `role=dialog`/`aria-modal`, заголовки и `aria-describedby` у токен-модалки и confirm-диалогов.
- Escape закрывает токен-модалку, фокус возвращается на кнопку-триггер; кнопка «Готово»
  получает фокус при открытии.
- Все кнопки имеют текстовые/aria-имена; статусы — не только цветом (текстовые чипы).
- Сетка `.bot-row`/`.bot-create__fields`/`.bot-install__row` перестраивается в одну колонку
  на `max-width: 640px`; длинные токены/имена скроллятся/переносятся, без горизонтального
  раздувания страницы.
- Sova design: существующие `card`, `btn`, `chip`, `pane-sub`, `chat-settings-*`, `members-*`
  паттерны; новых зависимостей и иконок-ассетов нет (добавлен stroke-`BotIcon`).

## 10. Ограничения / следующие шаги

1. Токен не показывается повторно by design; потерян → «Сменить токен».
2. `DELETE` = soft-disable: бот остаётся в списке `DISABLED` (история/установки сохраняются).
3. Аватар бота — инициалы; serve/upload API в MVP отсутствует.
4. `enabled=false` установки через API недоступен; UI готов отобразить эффективный статус,
   если сервер начнёт его возвращать.
5. UI не отправляет сообщения от бота: только документированный curl-сниппет; MSW-тест
   подтверждает, что контракт send работает и даёт `sender_type=BOT`.
6. Нет event subscriptions/slash commands — это осознанная граница MVP #96.

## 11. Файлы

Новые:

- `frontend/src/bots/botsStore.ts`, `botsStore.test.ts`, `errors.ts`;
- `frontend/src/components/bots/WorkspaceBotsCard.tsx`, `ChatBotsPanel.tsx`, `BotTokenDialog.tsx`;
- `frontend/src/components/WorkspaceBots.test.tsx`, `ChatBots.test.tsx`, `MessageRow.bot.test.tsx`;
- `frontend/docs/BOTS.md` (curl-сниппет и правила токена).

Изменённые (frontend):

- `src/api/types.ts`, `src/api/endpoints.ts`;
- `src/store/chatStore.ts`, `src/store/ChatProvider.tsx`;
- `src/components/pages/SettingsPage.tsx`, `src/components/ChatSettingsDialog.tsx`;
- `src/components/MessageRow.tsx`, `src/components/MessageActions.tsx`, `src/components/Icons.tsx`;
- `src/i18n/ru.ts`, `src/styles/app.css`;
- `src/mocks/db.ts`, `src/mocks/fixtures.ts`, `src/mocks/handlers.ts`;
- существующие тесты/фикстуры `sender_type` (см. §7).

`frontend/scripts/check-contract.mjs` был изменён backend-срезом #96 (добавление bot-операций);
в этой работе он только приведён к Prettier, логика не менялась.

## 12. Rollback

Изменения frontend-only и аддитивны: убрать вкладку/компоненты/store/методы API/MSW-хендлеры
и тесты. Контракт при этом можно оставить: UI просто перестанет его использовать.

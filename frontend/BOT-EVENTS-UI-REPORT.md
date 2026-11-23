# #98 — Bot events & slash commands UI (frontend)

> Зона: только `frontend/**`. Backend #98 и additive-контракт уже были готовы;
> `contracts/openapi.yaml`, `frontend/src/api/schema.d.ts` и
> `frontend/scripts/check-contract.mjs` использовались как источник истины и в
> этой работе не редактировались. `schema.d.ts` уже содержал #98-операции от
> backend-среза.

## Статус

**DONE в границах frontend-среза #98.**

Реализованы настройки событий бота (https URL, подписки, команды, signing
secret, доставки, test-event) и slash-команды в композере (палитра, вызов
`POST /chats/{id}/commands`, `202`/ошибки без фальшивого сообщения). Токен
ответа `response_url` — backend-only: фронтенд его не читает, не хранит и не
использует. E2EE не поддерживается; секреты не персистятся и не логируются.

## 1. Bot settings card

`Настройки → Боты → Настроить` (`WorkspaceBotsCard` → `BotEventsDialog`,
OWNER/ADMIN). Диалог показывает всё по одному боту:

- **Webhook**: `events_url` только `https`, без логина/query/fragment;
  пустое значение очищает URL. Чекбоксы `message.created` / `app_mention`,
  отдельный переключатель «Доставка событий включена» (`events_enabled`).
  Локальная валидация: URL обязателен, если включена доставка или выбраны
  подписки; иначе — честная ошибка до сохранения.
- **Команды**: список зарегистрированных `/command` с описанием, удаление,
  добавление с проверкой `[a-z0-9][a-z0-9_-]{0,31}`, длины 1..32, описания
  1..256, уникальности и лимита 50. Сохранение — полная замена `commands[]`
  одним PATCH вместе с событиями.
- **Signing secret**: статус `has_signing_secret` + дата; создание/ротация
  `POST .../secret` с inline-подтверждением; raw-значение показывается один
  раз, копируется по кнопке и очищается при закрытии/скрытии.
- **Доставки**: `GET .../deliveries` со статусом `PENDING`/`DELIVERED`/
  `FAILED`, типом события, временем, числом попыток, HTTP-кодом и безопасной
  причиной. «Отправить тестовое событие» — `POST .../test-event`, `202` и
  автоматическое обновление списка.
- Ошибки `BOT_EVENTS_URL_INVALID`, `BOT_EVENTS_NOT_CONFIGURED`, 403/404/429/
  422/503 и сеть имеют отдельные honest-сообщения (`botEventErrorText`).

## 2. Slash commands в композере

- `ChatScreen` загружает `GET /chats/{id}/bots` для активного MANAGED-чата
  (любой ACTIVE-участник) и строит палитру из команд установленных, включённых
  и `ACTIVE` ботов. В E2EE-чате загрузки/палитры нет.
- `Composer` распознаёт ведущий `/`: палитра с фильтром по префиксу/подстроке,
  `↑/↓`, `Enter`/`Tab`, `Esc`. Ввод `/` показывает все команды; незавершённое
  имя дополняется, полностью введённая команда отправляется по Enter.
- Отправка вызывает `POST /chats/{id}/commands` (`{command,args}`) только если
  имя зарегистрировано установленным ботом. Иначе `/текст` уходит обычным
  сообщением — UI не выдумывает команду.
- `202` показывается как ephemeral-уведомление «Команда … отправлена боту …»;
  ошибки `404 BOT_COMMAND_NOT_FOUND`, `409 BOT_COMMAND_AMBIGUOUS`,
  `422 BOT_EVENTS_NOT_CONFIGURED`, E2EE, 403/429/сеть — honest-текстом.
- **Сообщение в ленту не вставляется**: ни оптимистичной строки, ни fake
  message. При ошибке черновик восстанавливается. Реальный ответ бота позже
  приходит обычным BOT-сообщением через штатный pipeline.
- `response_url`/`POST /bot-responses/{token}` во фронтенде не используются.

## 3. Секреты и приватность

- `BotToken.token` и `signing_secret` живут только в in-memory snapshot
  `BotsStore`. `splitSigningSecret()` вырезает `signing_secret` из PATCH/
  rotate-ответа до сохранения строки, поэтому повторный рендер/список его не
  показывают.
- `clearToken()`/`clearSigningSecret()`/`clearBotEventFeedback()`/`reset()`
  очищают значения; закрытие диалога очищает секрет и transient-ошибки.
- Нет `localStorage`/`sessionStorage`, нет `console.*`, нет audit/логов с
  секретом; security-guard проходит.
- В документации только placeholder-значения, не реальные секреты.

## 4. API-слой и store

`src/api/types.ts` / `endpoints.ts`:

- `BotCommand`, `BotSigningSecret`, `BotDelivery`, `BotDeliveryList`,
  `BotDeliveryAccepted`, `BotCommandInvoke`, `BotCommandAccepted`,
  `BotEventType`, `BotDeliveryStatus`;
- `rotateBotSigningSecret`, `listBotDeliveries`, `testBotEvent`,
  `invokeBotCommand` (все через `withReauth`; deliveries/secret — JWT).

`src/bots/botsStore.ts`:

- workspace: `eventsSavingId/eventsError`, `signingSecret/secretPendingId/
secretError`, `deliveries`, `testPendingId/testError/testAccepted`;
- chat: `commandPending/commandError/commandAccepted` + `clearCommandState()`;
- generation-счётчик для deliveries, чтобы ответ не «протёк» после reset;
- `saveBotEvents`, `rotateSigningSecret`, `loadBotDeliveries`, `testBotEvent`,
  `invokeBotCommand`; строки обновляются только ответом сервера.

## 5. MSW

`src/mocks/handlers.ts` покрывает #98:

| Операция                    | Что проверяет мок                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PATCH .../bots/{botId}`    | https/подписки/команды, валидация, `events_enabled`/`enabled`, одноразовая выдача `signing_secret` при активации          |
| `POST .../secret`           | OWNER/ADMIN, ротация, одноразовый raw secret                                                                              |
| `GET .../deliveries`        | manager-only, limit 1..100, content-free статусы, сортировка                                                              |
| `POST .../test-event`       | требует events URL + secret, `422 BOT_EVENTS_NOT_CONFIGURED`, `202 {delivery_id}`                                         |
| `POST /chats/{id}/commands` | member, E2EE 422, установленные/включённые/ACTIVE боты, 404/409/422, `202` без сообщения, запись `slash_command` delivery |

Фикстуры: `buildMockBots()` с events/commands/секретом (mock-only поле),
`buildMockBotDeliveries()` (`DELIVERED`/`FAILED`/`PENDING`), `resetMockDb`
очищает доставки и новые forced-errors.

## 6. Тесты

| Файл                                  |       Тестов | Покрытие                                                                                                                                   |
| ------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/BotEvents.test.tsx`   |            5 | сохранение URL/подписок/команд, one-time secret + copy, ротация без повторного показа, доставки/test-event, локальная валидация + 422, axe |
| `src/components/BotCommands.test.tsx` |            5 | палитра/выбор, `202` без сообщения, 409 + restore draft, 422, неизвестный `/` как обычное сообщение, axe                                   |
| `src/bots/commands.test.ts`           |            5 | парсинг `/name args`, незавершённый query, prefix/substring, фильтр enabled/ACTIVE, regex имени                                            |
| `src/bots/botsStore.test.ts`          | 4 (обновлён) | прежние сценарии + новые API-заглушки store                                                                                                |

Итого новых тестов среза: **15**. Полный suite: **1328 passed (133 files)** —
требование «1313+» выполнено с запасом.

Axe (serious/critical) — **0** в диалоге событий и в палитре команд.

## 7. Проверки

Полный `npm run check` — **успешно, EXIT 0**:

- `eslint .` — 0 errors (1 pre-existing warning в
  `src/e2ee/app/chatBridgeSupport.test.ts`);
- `prettier --check .` — чисто;
- `contract:check` — **160 operations / 212 schemas**, generated types in sync;
- `security:check` — 418 files, no XSS sinks, storage ограничен workspace/theme,
  нет token-логов;
- `session-writers:check` — 278 production files;
- `stickers:check` — passed;
- `vitest run` — **1328 passed (133 files)**;
- `tsc --noEmit && vite build` — успешно (только стандартное предупреждение о
  размере чанка).

## 8. Документация

`frontend/docs/BOT-EVENTS.md`: UI-сценарии, безопасность, curl для PATCH/
secret/test-event/deliveries, проверка `X-Sova-Signature` на Node и `openssl`,
envelope `slash_command`, вызов команды и одноразовый ответ через
`response_url`, таблица ошибок, MSW. `docs/BOTS.md` обновлён ссылкой на #98.

## 9. Ограничения

1. Доставки не обновляются в реальном времени: список обновляется по кнопке,
   после test-event и при открытии диалога (polling/WebSocket вне среза).
2. Команды можно добавлять/удалять, но не редактировать существующую строку —
   удалить и добавить заново (полная замена списка).
3. `response_url` сознательно отсутствует во фронтенде: ответ бота — забота его
   сервера; UI покажет только пришедшее BOT-сообщение.
4. Палитра строится по `GET /chats/{id}/bots`; при ошибке этого чтения команд
   нет, и `/текст` уйдёт обычным сообщением (сервер остаётся авторитетом).
5. Mock-статусы доставок статичны, worker/retry не эмулируются — проверяются
   форма ответа, очередь и UI-статусы.
6. E2EE-чаты не поддерживают ботов/команды: UI не предлагает палитру, сервер
   отвечает `422 BOT_E2EE_UNSUPPORTED`.

## 10. Файлы

Новые:

- `src/components/bots/BotEventsDialog.tsx`, `src/components/bots/CommandPalette.tsx`;
- `src/bots/commands.ts`, `src/bots/commands.test.ts`;
- `src/components/BotEvents.test.tsx`, `src/components/BotCommands.test.tsx`;
- `docs/BOT-EVENTS.md`;
- `BOT-EVENTS-UI-REPORT.md`.

Изменённые:

- `src/api/types.ts`, `src/api/endpoints.ts`;
- `src/bots/botsStore.ts`, `src/bots/botsStore.test.ts`, `src/bots/errors.ts`;
- `src/components/Composer.tsx`, `src/components/ChatScreen.tsx`,
  `src/components/bots/WorkspaceBotsCard.tsx`;
- `src/i18n/ru.ts`, `src/styles/app.css`;
- `src/mocks/db.ts`, `src/mocks/fixtures.ts`, `src/mocks/handlers.ts`;
- `docs/BOTS.md`.

## 11. Rollback

Frontend-only и аддитивно: убрать `BotEventsDialog`/кнопку «Настроить»,
`CommandPalette`/ветку `/` в `Composer`, методы #98 в API/store, MSW-хендлеры,
ключи i18n/CSS и тесты. Контракт можно оставить — UI просто перестанет его
использовать.
